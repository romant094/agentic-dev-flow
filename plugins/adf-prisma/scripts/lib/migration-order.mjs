// The `migration-order` check of the `verify-check` hook.
//
// Prisma applies migrations in lexicographic order of their directory names, which are
// creation timestamps. Two branches that author migrations independently are applied in merge
// order on the developer's database and in timestamp order on every fresh one (CI, production,
// a new worktree). That is harmless while they touch different tables, and a production-only
// divergence when they do not.
//
// The remedy is for the branch merged later to recreate its migration so that its timestamp is
// last. This check reports the precondition. It never fetches and never rewrites anything.
//
// Every git call goes through the injected `run(cmd, args, opts)`, which returns
// { status, stdout, stderr }.

export const CHECK_ID = 'migration-order'
export const TITLE = 'Prisma migration order'
const LOCK_FILE = 'migration_lock.toml'

// `baseRefMissing`: the comparison ref does not exist. That is the one case this check exists
// to catch and cannot answer; reading it as "the base gained nothing" would turn every such
// failure into a pass.
export function migrationOrderVerdict({ branchMigrations, baseMigrations, baseRefMissing = false }) {
  if (baseRefMissing) return { ok: false, added: [], blockedBy: null, refMissing: true }

  const added = branchMigrations.filter((m) => !baseMigrations.includes(m)).sort()
  if (added.length === 0) return { ok: true, added: [], blockedBy: null }

  const gained = baseMigrations.filter((m) => !branchMigrations.includes(m)).sort()
  const newestGained = gained.at(-1) ?? null
  if (!newestGained) return { ok: true, added, blockedBy: null }

  return added[0] < newestGained ? { ok: false, added, blockedBy: newestGained } : { ok: true, added, blockedBy: null }
}

export function passLine(verdict, ref) {
  return verdict.added.length === 0
    ? `the branch adds no migration (compared against ${ref})`
    : `the branch's migrations (${verdict.added.join(', ')}) sort after everything ${ref} gained`
}

const git = (run, root, args) => run('git', args, { cwd: root })

const refExists = (run, root, ref) => git(run, root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0

// The migration directories at a commit. A tree without the directory is an empty list; a ref
// that does not exist is answered by refExists, so it is never mistaken for "nothing gained".
export function migrationsAt(run, root, ref, dir) {
  const listed = git(run, root, ['ls-tree', '-d', '--name-only', `${ref}:${dir}`])
  if (listed.status !== 0) return null
  return listed.stdout
    .split('\n')
    .map((line) => line.replace(/\/$/, '').trim())
    .filter((line) => line && line !== LOCK_FILE)
}

const check = (verdict, summary, text) => ({ id: CHECK_ID, title: TITLE, verdict, summary, text })

export function migrationOrder({ run, root, schema, base, head }) {
  const dir = `${schema}/migrations`
  const ref = base.ref
  const commit = typeof base.commit === 'string' && base.commit ? ` (${base.commit} when the change began)` : ''

  if (!refExists(run, root, ref)) return refMissing(ref, commit)
  // An unreadable head would read as "the branch adds nothing", a pass it did not earn.
  if (!refExists(run, root, head)) return check('fail', `${head} does not exist in this repository`, `The branch head ${head} does not resolve to a commit, so its migrations cannot be read.`)

  const branchMigrations = migrationsAt(run, root, head, dir) ?? []
  const baseMigrations = migrationsAt(run, root, ref, dir) ?? []
  if (branchMigrations.length === 0 && baseMigrations.length === 0) {
    return check('pass', 'no Prisma migrations', `Neither ${head} nor ${ref} has a migration in ${dir}.`)
  }

  const verdict = migrationOrderVerdict({ branchMigrations, baseMigrations })
  if (verdict.ok) {
    const line = passLine(verdict, ref)
    return check('pass', line, `${line[0].toUpperCase()}${line.slice(1)}. The base was not fetched: ${ref} is compared as it is in this repository.`)
  }
  return check(
    'fail',
    `${verdict.added[0]} sorts before ${verdict.blockedBy}, which ${ref} gained`,
    [
      `This branch adds ${verdict.added.join(', ')}, but ${ref} gained ${verdict.blockedBy}, which sorts later.`,
      'On a fresh database the branch migration would apply first; on the developer\'s database it applies last.',
      'Recreate the migration so that its timestamp is last: remove its directory, run `prisma migrate reset`, then `prisma migrate dev`.',
      'This check changed nothing and fetched nothing.'
    ].join('\n')
  )
}

function refMissing(ref, commit) {
  return check(
    'fail',
    `${ref} does not exist in this repository`,
    [
      `${ref}${commit} does not exist in this repository, so there is nothing to compare the branch's migrations against.`,
      'This check cannot pass without it, and it does not fetch. Restore the ref (fetch it yourself, or point the change at the right base) and run verify again.'
    ].join('\n')
  )
}
