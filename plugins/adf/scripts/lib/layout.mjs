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
// The planning guide and the default path of the review prompt.
export const PLANNING_FILE = `${ROOT}/planning.md`
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
