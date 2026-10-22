// Preloaded into each process tracker-plugins.spec.mjs starts, by NODE_OPTIONS=--import: when
// ADF_FAKE_JIRA names a JSON file, the global fetch becomes adf-jira's in-memory fake Jira
// (adf-jira/scripts/__tests__/fake-jira.mjs), loaded from that file and saved back after each
// request, so one fake Jira outlives every provider process the core starts. adf-jira's
// tracker.mjs reaches Jira only through the global fetch it passes to lib/tracker.mjs, so the
// real plugin runs unchanged and nothing reaches the network. The file holds { issues,
// comments, calls }.
import { readFileSync, writeFileSync } from 'node:fs'
import { fakeJira } from '../../../adf-jira/scripts/__tests__/fake-jira.mjs'

const file = process.env.ADF_FAKE_JIRA
if (file) {
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  const jira = fakeJira({ issues: saved.issues, comments: saved.comments })
  globalThis.fetch = async (url, init) => {
    try {
      return await jira.fetch(url, init)
    } finally {
      writeFileSync(file, JSON.stringify({ issues: jira.store, comments: jira.comments, calls: [...saved.calls, ...jira.calls] }))
    }
  }
}
