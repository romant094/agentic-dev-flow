// Which runtime runs the adf scripts, Claude Code or Codex, and every path and command that
// differs between them. Other code asks this module and names no home directory.
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeHome } from './superpowers.mjs'

export { claudeHome }
export const RUNTIMES = ['claude-code', 'codex']

export function runtimeHome(runtime, env = process.env) {
  return runtime === 'codex' ? env.CODEX_HOME || join(homedir(), '.codex') : claudeHome(env)
}

// The home every entry script uses unless --home names one: the home of the runtime that runs
// the scripts.
export function defaultHome(env = process.env, scriptPath = fileURLToPath(import.meta.url)) {
  return runtimeHome(detectRuntime({ env, scriptPath }), env)
}

export function cacheDir(runtime, home) {
  return join(home, 'plugins', 'cache')
}

export function sessionId(runtime, env = process.env) {
  return (runtime === 'codex' ? env.CODEX_THREAD_ID : env.CLAUDE_CODE_SESSION_ID) || null
}

export function cli(runtime) {
  return runtime === 'codex' ? 'codex' : 'claude'
}

export function installCommand(runtime, id, scope) {
  return runtime === 'codex' ? `codex plugin add ${id}` : `claude plugin install ${id} --scope ${scope}`
}

// Order: ADF_RUNTIME, the script's path under a runtime's plugin cache, CODEX_THREAD_ID, then
// claude-code. A home that is a symlink is compared resolved, as node resolves the script's own
// path.
export function detectRuntime({ env = process.env, scriptPath, homes } = {}) {
  if (RUNTIMES.includes(env.ADF_RUNTIME)) return env.ADF_RUNTIME
  if (scriptPath) {
    const real = (path) => (existsSync(path) ? realpathSync(path) : resolve(path))
    const script = real(scriptPath)
    for (const runtime of RUNTIMES) {
      const home = homes?.[runtime] ?? runtimeHome(runtime, env)
      if (script.startsWith(real(cacheDir(runtime, home)) + sep)) return runtime
    }
  }
  if (env.CODEX_THREAD_ID) return 'codex'
  return 'claude-code'
}
