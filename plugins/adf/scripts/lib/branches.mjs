// The host's branch policy, kept in the registry under `branches` and set by /adf:init:
//
//   "branches": { "integration": "develop", "protected": ["main"] }
//
// `integration` is the branch a change forks from by default and is merged back into.
// `protected` lists the other branches nobody commits or pushes to directly, a release branch
// for example. The integration branch is always protected.
import { execFileSync } from 'node:child_process'
import { readRegistry, REGISTRY_PATH, writeRegistry } from './registry.mjs'

const isName = (value) => typeof value === 'string' && value.trim() !== '' && !/\s/.test(value)

export function validateBranches(branches) {
  const errors = []
  if (!isName(branches?.integration)) errors.push('branches.integration must name a branch')
  if (branches?.protected !== undefined) {
    if (!Array.isArray(branches.protected) || !branches.protected.every(isName)) {
      errors.push('branches.protected must be a list of branch names')
    }
  }
  return errors
}

// The policy with the integration branch folded into the protected list, or null when the
// host has not set one.
export function readBranches(root) {
  const branches = readRegistry(root)?.branches
  if (!branches || validateBranches(branches).length > 0) return null
  return {
    integration: branches.integration,
    protected: [...new Set([branches.integration, ...(branches.protected ?? [])])]
  }
}

export function requireBranches(root) {
  const branches = readBranches(root)
  if (!branches) throw new Error(`${REGISTRY_PATH} sets no branches; run /adf:init`)
  return branches
}

export function isProtected(branches, name) {
  return branches.protected.includes(name)
}

export function setBranches(root, { integration, protected: others = [] }) {
  const registry = readRegistry(root)
  if (!registry) throw new Error('this project has no ADF registry; run /adf:init first')
  const branches = { integration, protected: others.filter((name) => name !== integration) }
  const errors = validateBranches(branches)
  if (errors.length > 0) throw new Error(errors.join('; '))
  writeRegistry(root, { ...registry, branches })
  return readBranches(root)
}

// The remote's default branch, the usual integration branch: `origin/HEAD` without the
// remote's name. Null when the host has no remote or the ref is not set.
export function detectIntegration(root) {
  try {
    const ref = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return ref.replace(/^origin\//, '') || null
  } catch {
    return null
  }
}
