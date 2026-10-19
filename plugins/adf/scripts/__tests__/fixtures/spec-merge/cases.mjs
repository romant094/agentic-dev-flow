// The spec-merge fixture cases, shared by specs-merge.spec.mjs and freeze.mjs. Each directory
// holds delta.md, main.md (absent for a new capability) and what openspec 1.5.0's
// buildUpdatedSpec made of them: expected.md, or error.txt for a refusal. The directory name is
// the capability. A name ending in -crlf is read with CRLF line endings, which git would not keep.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CASES_DIR = dirname(fileURLToPath(import.meta.url))
export const CHANGE = 'fixture-change'
// The Purpose line of openspec's skeleton for CHANGE.
export const OPENSPEC_PURPOSE = `TBD - created by archiving change ${CHANGE}. Update Purpose after archive.`

export const listCases = () => readdirSync(CASES_DIR).filter((name) => statSync(join(CASES_DIR, name)).isDirectory()).sort()

const read = (name, file, crlf) => {
  const path = join(CASES_DIR, name, file)
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  return crlf ? text.replace(/\r?\n/g, '\r\n') : text
}

// { name, deltaText, mainText | null, expected | null, error | null }
export function loadCase(name) {
  const crlf = name.endsWith('-crlf')
  return {
    name,
    deltaText: read(name, 'delta.md', crlf),
    mainText: read(name, 'main.md', crlf),
    expected: read(name, 'expected.md', false),
    error: read(name, 'error.txt', false)?.replace(/\n$/, '') ?? null
  }
}

// openspec's own result for a case: { rebuilt } or { error }. `dist` is the openspec package's
// dist directory (for example <global node_modules>/@fission-ai/openspec/dist).
export async function openspecBuild(dist, name) {
  const { buildUpdatedSpec } = await import(pathToFileURL(join(dist, 'core', 'specs-apply.js')).href)
  const c = loadCase(name)
  const dir = join(mkdtempSync(join(tmpdir(), 'adf-openspec-')), name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'delta.md'), c.deltaText)
  if (c.mainText !== null) writeFileSync(join(dir, 'main.md'), c.mainText)
  try {
    const built = await buildUpdatedSpec({ source: join(dir, 'delta.md'), target: join(dir, 'main.md'), exists: c.mainText !== null }, CHANGE, { silent: true })
    return { rebuilt: built.rebuilt }
  } catch (error) {
    return { error: error.message }
  }
}
