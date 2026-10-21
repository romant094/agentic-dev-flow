// The three-layer project profile: discovered.json (API facts, personal, never committed),
// conventions.md (team agreements, committed) and local.md (personal practice, never
// committed), in the registry config's `profileDir`.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const DEFAULT_PROFILE_DIR = join('.claude', 'jira', 'profile')
export const MAX_AGE_DAYS = 7

export function profilePaths(projectDir, profileDir = DEFAULT_PROFILE_DIR) {
  const dir = join(projectDir, profileDir)
  return {
    dir,
    discovered: join(dir, 'discovered.json'),
    conventions: join(dir, 'conventions.md'),
    local: join(dir, 'local.md')
  }
}

export function readDiscovered(projectDir, profileDir) {
  try {
    return JSON.parse(readFileSync(profilePaths(projectDir, profileDir).discovered, 'utf8'))
  } catch {
    return null
  }
}

export function writeDiscovered(projectDir, facts, profileDir) {
  const path = profilePaths(projectDir, profileDir).discovered
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(facts, null, 2)}\n`, 'utf8')
}

export function isStale(facts, now, maxAgeDays) {
  const ageMs = now.getTime() - new Date(facts.discoveredAt).getTime()
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000
}

export function describeSources(sources) {
  return sources
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((s) => `  ${s.key.padEnd(24)} ${s.layer.padEnd(8)} ${s.length} chars`)
    .join('\n')
}

// Whether git ignores a path in the project. Outside a repository nothing is ignored, so a
// personal file there is refused like an unignored one.
export function isIgnored(projectDir, path, run = gitCheckIgnore) {
  return run(projectDir, path)
}

function gitCheckIgnore(projectDir, path) {
  try {
    execFileSync('git', ['-C', projectDir, 'check-ignore', '-q', path], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
