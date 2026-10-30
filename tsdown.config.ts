/**
 * Build config for the conversation-map plugin bundle.
 *
 * Two artifacts land in `lib/`: the Host half the Loader imports (`index.js`)
 * and the browser half the module system serves (`client.js`). The client half
 * is a closure factory — `window.__ModuleLoader__.load({id, factory})` — so its
 * imports resolve through the loader's module table instead of a bundler
 * import map. The specifiers below are the platform seed table; anything else
 * must be added to `dsh.client.external` and be a loaded client row.
 */

/** Specifiers the client bundle must leave as `require` calls. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Stable plugin id stamped into the module-loader handoff. */
const PLUGIN_ID = 'dsh-conversation-tree'

export default [
  {
    name: `${PLUGIN_ID}/views`,
    // Node-consumable copies of the view components, so the render tests can
    // exercise the real panel instead of a re-implementation. Not part of the
    // browser bundle: the plugin's `files` list omits them.
    entry: {
      panel: 'src/client/MapPanel.tsx',
      entries: 'src/client/Entries.tsx',
      view: 'src/client/ViewToggle.tsx',
      status: 'src/client/StatusRollup.tsx',
      locale: 'src/client/locale.tsx',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'neutral',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      neverBundle: ['react', 'react/jsx-runtime', 'react-dom'],
    },
  },
  {
    name: `${PLUGIN_ID}/model`,
    // Node-consumable logic: the view tests exercise the real model, and the
    // sidebar-collapse controller is pure enough to drive from a test double.
    entry: {
      model: 'src/shared/model.ts',
      search: 'src/shared/search.ts',
      time: 'src/shared/time.ts',
      copy: 'src/shared/copy.ts',
      locales: 'src/client/locales/index.ts',
      display: 'src/client/display.ts',
      'error-text': 'src/client/error-text.ts',
      persistence: 'src/shared/persistence.ts',
      'view-state': 'src/shared/view-state.ts',
      'mode-memory': 'src/shared/mode-memory.ts',
      'status-rollup': 'src/shared/status-rollup.ts',
      'status-ledger': 'src/client/status-ledger.ts',
      'completion-watch': 'src/client/completion-watch.ts',
      'map-store': 'src/client/map-store.ts',
      'band-owner': 'src/client/band-owner.ts',
      'band-slot': 'src/client/band-slot.ts',
      'session-restore': 'src/client/session-restore.ts',
      'sidebar-collapse': 'src/client/sidebar-collapse.ts',
      'row-drag': 'src/client/row-drag.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'neutral',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    name: `${PLUGIN_ID}/host-internals`,
    // Host-side store and node operations, emitted as neutral ESM so the Node
    // unit tests can exercise the authoritative document and the tool ops
    // without booting a DSH client. Not part of the browser bundle.
    entry: {
      'host-store': 'src/host/store.ts',
      'host-ops': 'src/host/ops.ts',
      'host-rpc': 'src/host/rpc.ts',
      'host-tools': 'src/host/tools.ts',
      'host-prompt': 'src/host/prompt.ts',
      'host-session-text': 'src/host/session-text.ts',
      'host-search-index': 'src/host/search-index.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    name: `${PLUGIN_ID}/host`,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    name: `${PLUGIN_ID}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    deps: {
      neverBundle: CLIENT_EXTERNALS,
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
]
