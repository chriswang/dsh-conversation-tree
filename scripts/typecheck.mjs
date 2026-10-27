/**
 * Typecheck the plugin against React's types and the local toolchain.
 *
 * There is no typecheck against DSH's own client contracts: those packages'
 * declarations are only reachable from a DSH source checkout, and pulling their
 * transitive React types is what this project deliberately avoids.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureTypes, tscEntry } from './toolchain.mjs'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

ensureTypes()

const result = spawnSync(process.execPath, [tscEntry(), '--noEmit', '-p', 'tsconfig.json'], {
  cwd: PROJECT_ROOT,
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
