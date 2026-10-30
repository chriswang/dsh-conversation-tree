/**
 * Build every artifact of the conversation-map bundle.
 *
 * Emits `lib/index.js` (Host half), `lib/client.js` (the module-loader factory
 * the browser half is served from), and the neutral `lib/model.js` +
 * `lib/persistence.js` the tests consume.
 *
 * The output directory is wiped first: tsdown runs several entry groups into the
 * same `lib/`, disables its own clean pass, and emits content-hashed shared
 * chunks. Without the wipe, every rebuild leaves the previous run's chunks
 * behind and the published package silently carries dead files.
 */
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureTypes, tsdownEntry } from './toolchain.mjs'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

ensureTypes()

rmSync(resolve(PROJECT_ROOT, 'lib'), { recursive: true, force: true })

const result = spawnSync(process.execPath, [tsdownEntry()], { cwd: PROJECT_ROOT, stdio: 'inherit' })
process.exit(result.status ?? 1)
