// The two hooks of the ADF contract (version 1.6) this plugin provides: `provision` and
// `verify-check`. runOperation validates the payload the core writes, { root, config, input },
// and returns the exit code and the result object.
import { provision } from './provision.mjs'
import { migrationOrder } from './migration-order.mjs'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isText = (value) => typeof value === 'string' && value.trim() !== ''
const isTextList = (value) => Array.isArray(value) && value.every((v) => typeof v === 'string')
const refused = (error) => ({ state: 'refused', error })

// Unknown fields are ignored: a later minor version of the contract may add optional ones.
function validateConfig(config) {
  if (config.schema !== undefined && !isText(config.schema)) return 'config.schema must be a directory'
  if (config.ownClientWhen !== undefined && !(isTextList(config.ownClientWhen) && config.ownClientWhen.every(isText))) {
    return 'config.ownClientWhen must be a list of paths or globs'
  }
  if (config.seed !== undefined && typeof config.seed !== 'boolean') return 'config.seed must be true or false'
  if (config.env !== undefined) {
    if (!isObject(config.env)) return 'config.env must be { file, key }'
    if (config.env.file !== undefined && !isText(config.env.file)) return 'config.env.file must be a path'
    if (config.env.key !== undefined && !isText(config.env.key)) return 'config.env.key must be a variable name'
  }
  return null
}

function validateBase(base) {
  if (!isObject(base) || !isText(base.ref)) return 'input.base must be { ref, commit } with a ref'
  return null
}

function validateProvision(input) {
  if (!isText(input.worktree)) return 'input.worktree is required'
  if (!isText(input.main)) return 'input.main is required'
  if (!isTextList(input.files)) return 'input.files must be a list of paths'
  return null
}

function verifyCheck({ run, root, config, input }) {
  const problem = validateBase(input.base)
  if (problem) return refused(problem)
  if (input.head !== undefined && input.head !== null && !isText(input.head)) return refused('input.head must be a commit or a ref')
  const check = migrationOrder({ run, root, schema: config.schema ?? 'prisma', base: input.base, head: input.head ?? 'HEAD' })
  return { state: 'done', checks: [check] }
}

function provisionHook(ctx) {
  const problem = validateProvision(ctx.input)
  if (problem) return refused(`${problem}; nothing was changed.`)
  return provision(ctx)
}

export const OPERATIONS = { provision: provisionHook, 'verify-check': verifyCheck }

export function runOperation(operation, payload, ctx) {
  try {
    if (!Object.hasOwn(OPERATIONS, operation)) {
      return { code: 1, result: refused(`unknown operation "${operation}", expected ${Object.keys(OPERATIONS).join(', ')}`) }
    }
    if (!isObject(payload)) return { code: 1, result: refused('the input must be a JSON object') }
    const { root, config = {}, input = {} } = payload
    if (!isText(root)) return { code: 1, result: refused('root is required') }
    if (!isObject(config)) return { code: 1, result: refused('config must be an object') }
    if (!isObject(input)) return { code: 1, result: refused('input must be an object') }
    const problem = validateConfig(config)
    if (problem) return { code: 1, result: refused(problem) }
    const result = OPERATIONS[operation]({ ...ctx, root, config, input })
    return { code: result.state === 'refused' ? 1 : 0, result }
  } catch (error) {
    return { code: 1, result: refused(error.message) }
  }
}
