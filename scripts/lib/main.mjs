// Whether this module is the script node was started with. Node runs the main module from its
// real path, while argv[1] keeps the path as typed: through a symlink (a macOS temporary
// directory, a linked checkout) or in another letter case (Windows, macOS) the two differ, and
// a plain comparison would skip the CLI without a word. Both sides are resolved by the system.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function isMain(url) {
  if (!process.argv[1]) return false
  try {
    return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(url))
  } catch {
    return false
  }
}
