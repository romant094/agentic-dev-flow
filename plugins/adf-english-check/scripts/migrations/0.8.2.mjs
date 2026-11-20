// Config migration 0.8.2 (#26): the flow's directory moved from openspec/ to adf/. Every glob of
// `include` and `exclude` that starts with `openspec/` starts with `adf/` instead; any other glob,
// and every other key, stays as it is. /adf:update runs it (the core's lib/migrate.mjs) when the
// plugin moves past 0.8.1.
import { FLOW_ROOT, LEGACY_FLOW_ROOT } from '../lib/english.mjs'

const moved = (glob) => (typeof glob === 'string' && glob.startsWith(`${LEGACY_FLOW_ROOT}/`) ? `${FLOW_ROOT}/${glob.slice(LEGACY_FLOW_ROOT.length + 1)}` : glob)

export default function migrate(config) {
  const out = { ...config }
  for (const key of ['include', 'exclude']) {
    if (Array.isArray(config[key])) out[key] = [...new Set(config[key].map(moved))]
  }
  return out
}
