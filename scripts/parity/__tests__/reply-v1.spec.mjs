// lib/reply-v1.mjs `replyBodies`: the file a Bash heredoc writes is the redirect of the heredoc's
// own command, not a file descriptor's redirect or another command's earlier on the line.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replyBodies } from '../lib/reply-v1.mjs'

const bash = (command) => ({ message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })
const paths = (command) => replyBodies(bash(command)).map((b) => b.path)

test('a heredoc after a command with a stderr redirect writes the file its own `>` names', () => {
  assert.deepEqual(paths("git log 2>/dev/null | head -5; cd /w; cat > replies/T37-review.json <<'E'\n{}\nE"), ['replies/T37-review.json'])
})

test('the last `>` before the heredoc wins; a redirect after the marker is taken when none comes before', () => {
  assert.deepEqual(paths("echo a > a.txt; cat > b.json <<'E'\n{}\nE"), ['b.json'])
  assert.deepEqual(paths("cat <<'E' > c.json\n{}\nE"), ['c.json'])
  assert.deepEqual(paths("cat >> d.json <<E\n{}\nE"), ['d.json'])
  assert.deepEqual(paths("x &>/dev/null; cat 2>&1 <<'E'\n{}\nE"), [null])
})
