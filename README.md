# ddu-source-tri_source

Combined three file sources for ddu.vim.

This source gathers items from three sub-sources in a single list:

1. **Buffer list** - Currently open listed buffers
2. **MRU list** - Most recently used files (via [mr.vim](https://github.com/lambdalisue/vim-mr))
3. **File recursive** - Files under the current directory (recursive)

Items are collected in this order. Duplicates are removed by default so that
each file appears only once (buffer > MRU > file\_rec).

Each item is prefixed with a tag (`[buf]`, `[mru]`, `[rec]`) to indicate its
origin, with distinct highlight colors. The MRU tag reflects the `mrKind`
parameter (e.g. `[mrw]`, `[mrr]`, `[mrd]`).

## Required

### denops.vim

https://github.com/vim-denops/denops.vim

### ddu.vim

https://github.com/Shougo/ddu.vim

### ddu-kind-file

https://github.com/Shougo/ddu-kind-file

## Optional

### mr.vim

https://github.com/lambdalisue/vim-mr

Required when the MRU source is enabled (default). If not installed, set
`enableMr` to `v:false`.

## Configuration

```vim
" Basic usage
call ddu#start(#{ sources: [#{ name: 'tri_source' }] })

" Disable MRU source (if mr.vim is not installed)
call ddu#start(#{
      \   sources: [#{
      \     name: 'tri_source',
      \     params: #{ enableMr: v:false },
      \   }],
      \ })

" Change base path
call ddu#custom#patch_global('sourceOptions', #{
      \   tri_source: #{ path: expand("~") },
      \ })

" Hide source prefix tags
call ddu#start(#{
      \   sources: [#{
      \     name: 'tri_source',
      \     params: #{ showSourcePrefix: v:false },
      \   }],
      \ })
```

## Params

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `enableBuffer` | boolean | `v:true` | Enable the buffer list source |
| `enableMr` | boolean | `v:true` | Enable the MRU source (requires mr.vim) |
| `enableFileRec` | boolean | `v:true` | Enable the recursive file list source |
| `ignoredDirectories` | string[] | `[".git"]` | Directory names to ignore in file\_rec |
| `chunkSize` | number | `1000` | Chunk size for file\_rec streaming |
| `expandSymbolicLink` | boolean | `v:false` | Follow symbolic links in file\_rec |
| `mrKind` | string | `"mru"` | Kind for mr.vim (`"mru"`, `"mrw"`, `"mrr"`, `"mrd"`). Also used as prefix tag |
| `bufferOrderby` | string | `"desc"` | Buffer sort order (`"desc"` or `"asc"`) |
| `dedup` | boolean | `v:true` | Remove duplicate files across sources |
| `showSourcePrefix` | boolean | `v:true` | Show `[buf]`/`[mru]`/`[rec]` prefix tags |

## Highlights

The following highlight groups are defined with `highlight default` and can be
overridden:

| Group | Applied to | Default color |
|-------|-----------|---------------|
| `DduTriSource_buf` | `[buf]` prefix | Green (`#98c379`) |
| `DduTriSource_mru` | `[mru]` prefix | Yellow (`#e5c07b`) |
| `DduTriSource_mrw` | `[mrw]` prefix | Yellow (`#e5c07b`) |
| `DduTriSource_mrr` | `[mrr]` prefix | Yellow (`#e5c07b`) |
| `DduTriSource_mrd` | `[mrd]` prefix | Yellow (`#e5c07b`) |
| `DduTriSource_rec` | `[rec]` prefix | Blue (`#61afef`) |

## License

MIT
