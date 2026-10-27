/**
 * Locate the DSH toolchain this project builds with.
 *
 * This plugin carries no npm dependencies. The bundler (tsdown), the compiler
 * (tsc), and React's type declarations are therefore borrowed from a DSH source
 * checkout (`DSH_CHECKOUT`) and from a directory holding a React install
 * (`DSH_TYPES_ROOT`); a published artifact needs neither.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Candidate DSH source checkouts, in preference order. */
const CHECKOUT_CANDIDATES = [
  process.env.DSH_CHECKOUT,
].filter(Boolean)

/** Candidate directories holding an `@types/react` install. */
const TYPES_CANDIDATES = [
  process.env.DSH_TYPES_ROOT,
].filter(Boolean)

/**
 * Packages the render tests need at runtime.
 *
 * The plugin itself never installs React — the browser takes it from the
 * loader's module table. The test process, however, has to import a real React
 * to render the panel, so the runtime is linked in beside the type packages.
 */
const RUNTIME_PACKAGES = ['react', 'react-dom', 'scheduler']

/**
 * Resolve the DSH checkout that supplies tsdown and tsc.
 * @returns {string} the checkout root.
 */
export function checkoutRoot() {
  for (const root of CHECKOUT_CANDIDATES) {
    if (existsSync(join(root, 'node_modules', 'tsdown', 'dist', 'run.mjs'))) return root
  }
  throw new Error(`dsh toolchain: no checkout with node_modules/tsdown found; set DSH_CHECKOUT (tried ${CHECKOUT_CANDIDATES.join(', ')})`)
}

/** Absolute path of the tsdown CLI entry. */
export function tsdownEntry() {
  return join(checkoutRoot(), 'node_modules', 'tsdown', 'dist', 'run.mjs')
}

/** Absolute path of the TypeScript compiler entry. */
export function tscEntry() {
  return join(checkoutRoot(), 'node_modules', 'typescript', 'bin', 'tsc')
}

/**
 * Link React's and Node's type declarations into this project.
 *
 * `tsc` resolves `import 'react'` through `node_modules/@types/react`, so the
 * symlinks below are what make typechecking possible without a registry. The
 * Host half also uses Node builtins (`node:fs/promises`, `node:os`, ...), whose
 * declarations come from `@types/node`; it is linked only when the chosen types
 * root provides it, because the browser half itself needs no Node types.
 * @returns {string} the directory the types were linked from.
 */
export function ensureTypes() {
  const modules = join(PROJECT_ROOT, 'node_modules')
  for (const root of TYPES_CANDIDATES) {
    const react = join(root, '@types', 'react', 'package.json')
    const csstype = join(root, 'csstype', 'package.json')
    if (!existsSync(react) || !existsSync(csstype)) continue
    mkdirSync(join(modules, '@types'), { recursive: true })
    link(join(root, '@types', 'react'), join(modules, '@types', 'react'))
    link(join(root, 'csstype'), join(modules, 'csstype'))
    for (const name of RUNTIME_PACKAGES) link(join(root, name), join(modules, name))
    const nodeTypes = join(root, '@types', 'node')
    if (existsSync(join(nodeTypes, 'package.json'))) link(nodeTypes, join(modules, '@types', 'node'))
    return root
  }
  throw new Error(`dsh toolchain: no @types/react found; set DSH_TYPES_ROOT (tried ${TYPES_CANDIDATES.join(', ')})`)
}

/** Replace one symlink idempotently. */
function link(target, path) {
  rmSync(path, { recursive: true, force: true })
  symlinkSync(target, path, 'dir')
}
