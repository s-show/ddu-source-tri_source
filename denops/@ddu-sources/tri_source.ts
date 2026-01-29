import { ensure, is } from "@core/unknownutil";
import type { ActionData } from "@shougo/ddu-kind-file";
import {
  BaseSource,
  type GatherArguments,
  type OnInitArguments,
} from "@shougo/ddu-vim/source";
import type { Item, ItemHighlight } from "@shougo/ddu-vim/types";
import { SEPARATOR as pathsep } from "@std/path/constants";
import { deadline } from "@std/async/deadline";
import { abortable } from "@std/async/abortable";
import { join } from "@std/path/join";
import { resolve } from "@std/path/resolve";
import { relative } from "@std/path/relative";
import type { Denops } from "@denops/std";

// ---------------------------------------------------------------------------
// Inline helpers (replacing @shougo/ddu-vim/utils imports)
// ---------------------------------------------------------------------------

type TreePath = string | string[];

function treePath2Filename(treePath: TreePath): string {
  return typeof treePath === "string" ? treePath : treePath.join(pathsep);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Params = {
  enableBuffer: boolean;
  enableMr: boolean;
  enableFileRec: boolean;
  ignoredDirectories: string[];
  chunkSize: number;
  expandSymbolicLink: boolean;
  mrKind: string;
  bufferOrderby: string;
  dedup: boolean;
  showSourcePrefix: boolean;
};

type SourceTag = "buf" | "mru" | "mrw" | "mrr" | "mrd" | "rec";

type BufInfo = {
  bufnr: number;
  changed: boolean;
  lastused: number;
  listed: boolean;
  name: string;
};

type GetBufInfoReturn = {
  currentDir: string;
  alternateBufNr: number;
  buffers: BufInfo[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(
  word: string,
  path: string,
  tag: SourceTag,
  showPrefix: boolean,
  isDirectory: boolean,
): Item<ActionData> {
  const prefix = `[${tag}] `;
  const display = showPrefix ? `${prefix}${word}` : undefined;
  const highlights: ItemHighlight[] | undefined = showPrefix
    ? [{
      name: `ddu_tri_source_${tag}`,
      hl_group: `DduTriSource_${tag}`,
      col: 1,
      width: prefix.length,
    }]
    : undefined;

  return {
    word,
    display,
    highlights,
    action: { path, isDirectory },
  };
}

function normalizePath(p: string): string {
  // Normalize for dedup comparison – lowercase on case-insensitive OS is
  // intentionally omitted to keep it simple and predictable.
  return p.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Sub-source: Buffer
// ---------------------------------------------------------------------------

async function gatherBuffer(
  denops: Denops,
  bufNr: number,
  orderby: string,
  seen: Set<string>,
  dedup: boolean,
  showPrefix: boolean,
): Promise<Item<ActionData>[]> {
  const { currentDir, alternateBufNr, buffers } = await denops.call(
    "ddu#source#tri_source#getbufinfo",
  ) as GetBufInfoReturn;

  const sorted = buffers
    .filter((b) => b.listed)
    .sort((a, b) => {
      if (orderby === "desc") {
        if (a.bufnr === bufNr) return 1;
        if (b.bufnr === bufNr) return -1;
        return Number(BigInt(b.lastused) - BigInt(a.lastused));
      }
      return Number(BigInt(a.lastused) - BigInt(b.lastused));
    });

  const items: Item<ActionData>[] = [];

  for (const buf of sorted) {
    const { bufnr, changed, name } = buf;

    // Skip unnamed and terminal buffers
    if (name === "") continue;
    const uBufType = await denops.call("getbufvar", bufnr, "&buftype");
    const bufType = typeof uBufType === "string" ? uBufType : "";
    if (bufType === "terminal") continue;

    const absPath = normalizePath(name);
    if (dedup) {
      if (seen.has(absPath)) continue;
      seen.add(absPath);
    }

    const isCurrent = bufNr === bufnr;
    const isAlternate = alternateBufNr === bufnr;
    const isModified = changed;

    const curMarker = isCurrent ? "%" : "";
    const altMarker = isAlternate ? "#" : "";
    const modMarker = isModified ? "+" : " ";
    const bufnrStr = String(bufnr).padStart(2, " ");
    const bufMark = `${curMarker}${altMarker}`.padStart(2, " ");

    const relPath = relative(currentDir, name);
    const displayName = relPath.startsWith("..") ? name : relPath;
    const word = `${bufnrStr} ${bufMark} ${modMarker} ${displayName}`;

    items.push(
      makeItem(word, name, "buf", showPrefix, false),
    );
  }

  return items;
}

// ---------------------------------------------------------------------------
// Sub-source: MRU (vim-mr)
// ---------------------------------------------------------------------------

async function gatherMr(
  denops: Denops,
  mrKind: string,
  seen: Set<string>,
  dedup: boolean,
  showPrefix: boolean,
): Promise<Item<ActionData>[]> {
  const isDir = new Set(["mrr", "mrd"]);

  let result: string[];
  try {
    result = ensure(
      await deadline(
        denops.dispatch("mr", `${mrKind}:list`),
        1000,
      ),
      is.ArrayOf(is.String),
    );
  } catch (e: unknown) {
    if (e instanceof DOMException) {
      console.error(
        "[ddu-source-tri_source] Failed to call vim-mr. Check 'runtimepath' and plugin version.",
      );
    } else {
      console.error("[ddu-source-tri_source]", e);
    }
    return [];
  }

  const items: Item<ActionData>[] = [];
  for (const path of result) {
    const norm = normalizePath(path);
    if (dedup) {
      if (seen.has(norm)) continue;
      seen.add(norm);
    }
    items.push(
      makeItem(path, path, mrKind as SourceTag, showPrefix, isDir.has(mrKind)),
    );
  }
  return items;
}

// ---------------------------------------------------------------------------
// Sub-source: file_rec (recursive file walk)
// ---------------------------------------------------------------------------

async function* walkFiles(
  root: string,
  ignoredDirectories: string[],
  signal: AbortSignal,
  chunkSize: number,
  expandSymbolicLink: boolean,
): AsyncGenerator<Item<ActionData>[]> {
  const inner = async function* (
    dir: string,
  ): AsyncGenerator<Item<ActionData>[]> {
    let chunk: Item<ActionData>[] = [];
    try {
      for await (const entry of abortable(Deno.readDir(dir), signal)) {
        const abspath = join(dir, entry.name);
        const stat = await readStat(abspath, expandSymbolicLink);

        if (stat === null) continue;

        if (!stat.isDirectory) {
          const n = chunk.push({
            word: relative(root, abspath),
            action: { path: abspath, isDirectory: false },
          });
          if (n >= chunkSize) {
            yield chunk;
            chunk = [];
          }
        } else if (ignoredDirectories.includes(entry.name)) {
          continue;
        } else if (
          stat.isSymlink && stat.isDirectory &&
          abspath.includes(await Deno.realPath(abspath))
        ) {
          // Looped symlink
          continue;
        } else {
          yield* inner(abspath);
        }
      }
      if (chunk.length) {
        yield chunk;
      }
    } catch (e: unknown) {
      if (e instanceof Deno.errors.PermissionDenied) {
        return;
      }
      throw e;
    }
  };
  yield* inner(root);
}

async function readStat(
  path: string,
  expandSymbolicLink: boolean,
): Promise<Deno.FileInfo | null> {
  try {
    const stat = await Deno.lstat(path);
    if (stat.isSymlink && expandSymbolicLink) {
      return { ...(await Deno.stat(path)), isSymlink: true };
    }
    return stat;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main Source
// ---------------------------------------------------------------------------

export class Source extends BaseSource<Params> {
  override kind = "file";

  override async onInit(args: OnInitArguments<Params>): Promise<void> {
    await args.denops.cmd(
      `highlight default DduTriSource_buf ctermfg=Green guifg=#98c379`,
    );
    // Register highlights for all mr.vim kinds with the same default color
    for (const kind of ["mru", "mrw", "mrr", "mrd"]) {
      await args.denops.cmd(
        `highlight default DduTriSource_${kind} ctermfg=Yellow guifg=#e5c07b`,
      );
    }
    await args.denops.cmd(
      `highlight default DduTriSource_rec ctermfg=Blue guifg=#61afef`,
    );
  }

  override gather(
    args: GatherArguments<Params>,
  ): ReadableStream<Item<ActionData>[]> {
    const abortController = new AbortController();
    const seen = new Set<string>();
    const {
      enableBuffer,
      enableMr,
      enableFileRec,
      ignoredDirectories,
      chunkSize,
      expandSymbolicLink,
      mrKind,
      bufferOrderby,
      dedup,
      showSourcePrefix,
    } = args.sourceParams;

    return new ReadableStream({
      async start(controller) {
        try {
          // 1. Buffer list
          if (enableBuffer) {
            const bufItems = await gatherBuffer(
              args.denops,
              args.context.bufNr,
              bufferOrderby,
              seen,
              dedup,
              showSourcePrefix,
            );
            if (bufItems.length > 0) {
              controller.enqueue(bufItems);
            }
          }

          // 2. MRU list
          if (enableMr) {
            const mrItems = await gatherMr(
              args.denops,
              mrKind,
              seen,
              dedup,
              showSourcePrefix,
            );
            if (mrItems.length > 0) {
              controller.enqueue(mrItems);
            }
          }

          // 3. file_rec (streaming)
          if (enableFileRec) {
            const root = treePath2Filename(
              args.sourceOptions.path.length !== 0
                ? args.sourceOptions.path
                : args.context.path,
            );
            const resolvedRoot = resolve(root, root);

            let enqueueSize = chunkSize;
            let pendingItems: Item<ActionData>[] = [];

            for await (
              const chunk of walkFiles(
                resolvedRoot,
                ignoredDirectories,
                abortController.signal,
                chunkSize,
                expandSymbolicLink,
              )
            ) {
              const filtered = dedup
                ? chunk.filter((item) => {
                  const actionPath = (item.action as ActionData).path;
                  if (!actionPath) return true;
                  const p = normalizePath(actionPath);
                  if (seen.has(p)) return false;
                  seen.add(p);
                  return true;
                })
                : chunk;

              if (showSourcePrefix) {
                for (const item of filtered) {
                  const prefix = "[rec] ";
                  item.display = `${prefix}${item.word}`;
                  item.highlights = [{
                    name: "ddu_tri_source_rec",
                    hl_group: "DduTriSource_rec",
                    col: 1,
                    width: prefix.length,
                  }];
                }
              }

              pendingItems = [...pendingItems, ...filtered];
              if (pendingItems.length >= enqueueSize) {
                enqueueSize = 10 * chunkSize;
                controller.enqueue(pendingItems);
                pendingItems = [];
              }
            }
            if (pendingItems.length > 0) {
              controller.enqueue(pendingItems);
            }
          }
        } catch (e: unknown) {
          if (e instanceof Error && e.name.includes("AbortReason")) {
            // Ignore abort
          } else {
            console.error(e);
          }
        } finally {
          controller.close();
        }
      },

      cancel(reason): void {
        abortController.abort(reason);
      },
    });
  }

  override params(): Params {
    return {
      enableBuffer: true,
      enableMr: true,
      enableFileRec: true,
      ignoredDirectories: [".git"],
      chunkSize: 1000,
      expandSymbolicLink: false,
      mrKind: "mru",
      bufferOrderby: "desc",
      dedup: true,
      showSourcePrefix: true,
    };
  }
}
