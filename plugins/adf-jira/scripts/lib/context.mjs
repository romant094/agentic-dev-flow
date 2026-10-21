// What a script a skill runs needs before it calls Jira: the project (the main checkout of the
// working directory), the registry config, and the env resolved inside this process.
import { homedir } from 'node:os'
import { mainCheckout, normalizeConfig, readRegistryConfig } from './config.mjs'
import { resolveEnv } from './env.mjs'

export function loadConfig({ cwd = process.cwd(), run } = {}) {
  const projectDir = mainCheckout(cwd, run)
  const { config, errors } = normalizeConfig(readRegistryConfig(projectDir))
  if (errors.length > 0) throw new Error(`The adf-jira entry of .claude/adf-extensions.json is invalid: ${errors.join('; ')}.`)
  return { projectDir, config }
}

export function loadContext({ cwd = process.cwd(), home = homedir(), processEnv = process.env, run } = {}) {
  const { projectDir, config } = loadConfig({ cwd, run })
  const { env, sources, files } = resolveEnv({ projectDir, homeDir: home, processEnv, envFile: config.envFile, config })
  return { projectDir, config, env, sources, files }
}
