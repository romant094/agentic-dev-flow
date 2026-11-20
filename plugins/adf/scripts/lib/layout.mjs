// The flow's committed directory in a host project and every path under it, in one place: every
// script joins, quotes and filters these paths through this module, so a rename of the
// directory is one line here. `LEGACY_ROOT` is the directory of the earlier releases; only the
// readers of past commits (`isFlowPath`) and the migration (`lib/flow-migrate.mjs`) name it.
export const ROOT = 'openspec'
export const LEGACY_ROOT = 'openspec'

// The changes: one directory per change, the archived ones under `archive/`.
export const CHANGES_DIR = `${ROOT}/changes`
export const ARCHIVE = 'archive'
export const ARCHIVE_DIR = `${CHANGES_DIR}/${ARCHIVE}`
// The main specs: `<SPECS_DIR>/<capability>/spec.md`.
export const SPECS_DIR = `${ROOT}/specs`
// The project's own guidance for the artifacts: the project context and one rule file per
// artifact.
export const CONTEXT_FILE = `${ROOT}/context.md`
export const RULES_DIR = `${ROOT}/rules`
// The project's settings (values the scripts read, lib/settings.mjs), the project's planning
// guide (prose for the plan and verify agents), and the default path of the review prompt.
export const SETTINGS_FILE = `${ROOT}/settings.json`
export const GUIDE_FILE = `${ROOT}/guide.md`
export const REVIEW_PROMPT = `${ROOT}/review-prompt.md`
// The metadata file of a change an earlier flow created (the openspec CLI's), still in flight.
export const ORIGIN_META_FILE = '.openspec.yaml'

// The Conventional Commits scope of the flow's own record commits.
export const COMMIT_SCOPE = 'openspec'

// A path under the flow's directory, relative to the project root.
export const flowPath = (file) => `${ROOT}/${file}`
// A change's directory, or one file of it, relative to the project root.
export const changePath = (change, file) => (file === undefined ? `${CHANGES_DIR}/${change}` : `${CHANGES_DIR}/${change}/${file}`)
// A capability's main spec, relative to the project root.
export const specPath = (capability) => `${SPECS_DIR}/${capability}/spec.md`

// ---------------------------------------------------------------- history

// The roots a past commit may hold the flow's files under: the current one and the legacy one.
// Live code reads only ROOT; the readers of past commits (the retrospective's window, the main
// specs at an old base, a change's proposal time, the path filters over a commit range) use
// these, so a range that spans the move of the directory reads the same as one that does not.
export const FLOW_ROOTS = [...new Set([ROOT, LEGACY_ROOT])]

// The path below `<root>/<under>/` for whichever flow root it lies under, or null for any other
// path; `under` '' takes the whole root.
export function flowRelative(path, under = '', roots = FLOW_ROOTS) {
  for (const root of roots) {
    const prefix = under ? `${root}/${under}/` : `${root}/`
    if (path.startsWith(prefix)) return path.slice(prefix.length)
  }
  return null
}

// Whether a path lies under `<root>/<under>/` of either flow root.
export const isFlowPath = (path, under = '', roots = FLOW_ROOTS) => flowRelative(path, under, roots) !== null
