/**
 * Build every artifact of the conversation-map bundle.
 *
 * Emits `lib/index.js` (Host half), `lib/client.js` (the module-loader factory
 * the browser half is served from), and the neutral `lib/model.js` +
 * `lib/persistence.js` the tests consume.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureTypes, tsdownEntry } from './toolchain.mjs'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

ensureTypes()

const result = spawnSync(process.execPath, [tsdownEntry()], { cwd: PROJECT_ROOT, stdio: 'inherit' })
process.exit(result.status ?? 1)
