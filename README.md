# Conversation Tree (dsh-conversation-tree)

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-conversation-tree.svg)](https://www.npmjs.com/package/dsh-conversation-tree)
[![license](https://img.shields.io/npm/l/dsh-conversation-tree.svg)](LICENSE)

DeepSeek Harness client plugin: adds a collapsible, resizable **Conversation Tree band** to the left of the conversation column, organizing conversations by «Workspace → topic → conversation» and opening the real sessions in place.

The product's conversation column, header, Chat/Trajectory tabs, right sidebar and composer all keep rendering exactly as before — the tree only reserves a band on the left and overlays it; it never replaces product UI.

## Install

Requires DSH `>=0.2.1-rc.3` (see `engines.dsh` in `package.json`).

```sh
dsh plugin --profile web add dsh-conversation-tree
```

Or in DSH: **Plugins → Discover → Index sources**, and add this plugin's market index:

```
https://chriswang.github.io/dsh-plugins-index/index.json
```

Restart the app after installing. The band starts collapsed: a 28×28 icon appears in the conversation column header — click it to expand the tree.

## Usage

- **Entries**: the persistent «Conversation Tree» row in the sidebar's panel rows, or the icon in the conversation header while the band is collapsed.
- **Collapse / expand**: both entries expand one way; collapse with the «⇤» control in the band's own top bar. The collapsed state is remembered.
- **Width**: drag the band's right edge; minimum 320px. The conversation column keeps its own minimum width and is never squeezed away.
- **Organization**: Workspaces are the first level, topics are nodes, conversations hang under nodes; multiple «spaces» are supported, each with its own tree.
- **Spaces**: the band's second row is the «All spaces › current space» breadcrumb — the whole bar is one control; the root segment shows the all-spaces rollup, the current segment the space's own status, with the chevron at the end. With a single space the current segment shows just its name; with a blank session the row falls back to the first-row button.
- **Search**: the in-band search field (opened on demand) searches topic titles/descriptions, indexed conversation titles, and conversation bodies; the body index is built on demand inside the Host process.
- **Open a conversation**: uses the product's own navigation; the tree highlight, the product's current session and the right sidebar always stay on the same conversation.

## Data and persistence

- The authoritative document is stored by the Host half: `$DSH_HOME/conversation-map/map.json`, read and written through the `/conversation-map` RPC channel with optimistic revision locking.
- The browser keeps only a migration backup; when upgrading from older versions the browser-local document is not merged, only backed up under the `localStorage` key `dsh.conversation-map.v1.host-backup`.
- When the Host half is unavailable (for example in a CLI environment) the plugin degrades to a browser-local mode and shows «Local mode» in the band.

## UI language

- UI copy ships in **Simplified Chinese and English** (`src/client/locales/`), registered with DSH's client locale service. It follows **Settings → General → Language** and switches live — no restart, no language-specific builds.
- Plugin Manager metadata (title/description) comes from `locale/zh.json` / `locale/en.json`, so the plugin is readable in the plugin list before it is activated.
- **Not translated on purpose**: model-facing tool descriptions/prompts stay English, and user data (Workspace names, topic titles, conversation titles) renders verbatim — the same rule DSH applies to authored data.
- Additional languages can be added later through the DSH locale service (a language pack) without rebuilding this plugin.

## Model tools

The plugin registers 9 tools so the model can read and write the tree directly:

| Tool | Purpose |
| --- | --- |
| `map_list_workspaces` | List Workspaces |
| `map_get_state` | Read the current document (Workspaces, nodes, spaces, conversation filing) |
| `map_plan_goal` | Create a goal + strategy + task structure in one call |
| `map_create_nodes` | Create nodes |
| `map_update_nodes` | Rename / re-describe nodes |
| `map_move_nodes` | Re-parent or reorder nodes |
| `map_move_session` | File a conversation under a node, or rename/move it |
| `map_attach_sessions` | Attach existing conversations to a node |
| `map_delete_nodes` | Delete nodes (including their subtrees) |

## Known limitations

- **Depends on public product DOM contracts**: the frame-level `shell.overlay` slot (the band), the `[data-slot="main.conversation"] > div` anchor (the reserved `padding-left`), the conversation header's leading seat (the collapsed entry), and the frame's `data-sidebar-collapsed` marker. If the product changes these structures the band degrades to a "temporarily unavailable" notice instead of covering the conversation column; the persistent panel-row entry keeps working.
- **Single left-band slot**: coordinates with other band plugins through the public `html[data-dsh-band-owner]` attribute; while another band owns the edge this plugin does not duplicate its entry in the conversation header (the panel row still works).
- **Limited drag scope**: re-parent a node through the `⋯` menu; topics cannot be dragged. Spaces cannot be reordered by dragging.
- **No cross-Workspace conversation moves**: the Host ordering only applies within one Workspace.
- **Single writer**: when the same `$DSH_HOME` is written by several processes, the last writer wins.
- **Search scope**: topic titles/descriptions, indexed conversation titles, and conversation bodies (user/assistant text only, no system prompts or tool calls); no fuzzy matching, segmentation or pinyin.
- **UI copy is bilingual (zh/en)** and follows the DSH language setting; the plugin does not ship a language of its own.

## Build from source

What is published to npm is prebuilt (`lib/`); installing needs no build. Building from source requires a DSH source checkout, because this project intentionally carries no npm dependencies: the bundler (tsdown) and type declarations (tsc, React types) are borrowed from that checkout.

```sh
export DSH_CHECKOUT=/path/to/deepseek-harness
export DSH_TYPES_ROOT=/path/to/node_modules   # a directory containing @types/react, optional
npm run build      # emits lib/index.js and lib/client.js
npm test           # node --test
npm run check      # typecheck + test
```

## License

MIT, see [LICENSE](LICENSE).
