/**
 * Reject hard-coded UI copy in the plugin's own sources.
 *
 * Mirrors DSH's `verify-client-ui-i18n` gate: locale dictionaries are the only
 * files allowed to own translated text, and presentation code receives its copy
 * through the locale translator. The check is syntax-aware (TypeScript AST), so
 * comments, class names, and structural ids never trip it.
 *
 * Scope: `src/client/**` (except the `locales/` dictionaries and the CSS bundle,
 * whose template is a stylesheet) plus `src/shared/**`. Model-facing strings
 * already live in English with stable codes and are not UI copy.
 *
 * Usage: `npm run verify:i18n` (part of `npm run check`).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { checkoutRoot } from './toolchain.mjs'

/** Repository root. */
const ROOT = resolve(import.meta.dirname, '..')

/** Lowest number of files the discovery must find before it is trusted. */
const MINIMUM_SOURCES = 20

/** Copy-bearing JSX attribute names. */
const COPY_ATTRIBUTES = new Set([
  'alt', 'aria-description', 'aria-label', 'aria-valuetext', 'placeholder', 'title',
])

/**
 * Non-copy literals kept on purpose: the legacy on-disk default-space title,
 * migrated to the neutral marker on read. It is data, never display copy.
 */
const ALLOWED = new Map([
  ['src/shared/model.ts', '默认空间'],
])

/** Files whose string literals are not UI copy. */
function excluded(file) {
  const normalized = file.replaceAll('\\', '/')
  return normalized.includes('/locales/')
    || normalized.endsWith('/styles.ts')
}

/**
 * Read the checkout's TypeScript compiler (this project intentionally carries no
 * npm dependencies; the compiler is borrowed like the rest of the toolchain).
 * @returns the TypeScript module.
 */
async function loadTypeScript() {
  const entry = join(checkoutRoot(), 'node_modules', 'typescript', 'lib', 'typescript.js')
  return (await import(pathToFileURL(entry).href)).default
}

/** CJK ranges that mark authored copy. */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/u

/**
 * Find hard-coded copy in one source file.
 * @param ts - the TypeScript compiler module.
 * @param file - repository-relative path, used in diagnostics.
 * @param sourceText - the file contents.
 * @returns one diagnostic per offending literal.
 */
export function findCopyViolations(ts, file, sourceText) {
  if (excluded(file)) return []
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const violations = []
  const report = (node, text, reason) => {
    const value = text.replace(/\s+/g, ' ').trim()
    if (value === '' || !CJK.test(value)) return
    if (ALLOWED.get(file) === value) return
    const position = source.getLineAndCharacterOfPosition(node.getStart(source))
    violations.push({
      file,
      line: position.line + 1,
      column: position.character + 1,
      reason,
      text: value.length <= 80 ? value : `${value.slice(0, 77)}...`,
    })
  }
  const visit = (node) => {
    if (ts.isJsxText(node)) report(node, node.text, 'JSX text')
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source)
      if (COPY_ATTRIBUTES.has(name) && node.initializer !== undefined) {
        if (ts.isStringLiteral(node.initializer)) report(node.initializer, node.initializer.text, `${name} attribute`)
        else if (ts.isJsxExpression(node.initializer) && node.initializer.expression !== undefined
          && (ts.isStringLiteral(node.initializer.expression)
            || ts.isNoSubstitutionTemplateLiteral(node.initializer.expression))) {
          report(node.initializer.expression, node.initializer.expression.text, `${name} attribute`)
        }
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const isImport = node.parent !== undefined
        && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent))
      const isType = node.parent !== undefined && ts.isLiteralTypeNode(node.parent)
      if (!isImport && !isType) report(node, node.text, 'string literal')
    }
    if (ts.isTemplateExpression(node)) {
      report(node, [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(''), 'template literal')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

/** Walk the gated source tree. */
function sourceFiles() {
  const files = []
  const walk = (directory) => {
    for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
      const child = `${directory}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === 'locales') continue
        walk(child)
      } else if (/\.(ts|tsx)$/u.test(entry.name)) files.push(child)
    }
  }
  walk('src/client')
  walk('src/shared')
  return files.sort()
}

/** Compare every gated source against the locale-owned-copy rule. */
async function main() {
  const ts = await loadTypeScript()
  const files = sourceFiles()
  if (files.length < MINIMUM_SOURCES) {
    throw new Error(`verify:i18n: discovery narrowed to ${String(files.length)} file(s); expected at least ${String(MINIMUM_SOURCES)}.`)
  }
  const violations = files.flatMap(file => findCopyViolations(ts, file, readFileSync(join(ROOT, file), 'utf8')))
  if (violations.length > 0) {
    console.error(`verify:i18n: ${String(violations.length)} hard-coded UI string(s):`)
    for (const violation of violations) {
      console.error(`  ${violation.file}:${String(violation.line)}:${String(violation.column)} ${violation.reason}: ${JSON.stringify(violation.text)}`)
    }
    process.exitCode = 1
    return
  }
  console.log(`verify:i18n: ${String(files.length)} source file(s) take their UI copy from the locale dictionaries.`)
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  await main()
}

export { main as verifyLocaleOwnedCopy }
