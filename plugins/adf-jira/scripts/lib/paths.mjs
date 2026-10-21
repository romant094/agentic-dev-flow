// The shortest route through the discovered workflow graph, breadth first. Three answers:
// `path` (the hops; empty when already at the target), `unreachable`, and `unknown` when the
// search crossed a status whose transitions were never sampled.
export function solvePath(graph, from, to, unsampledStatuses) {
  const unsampled = new Set(unsampledStatuses ?? [])

  if (!(from in graph)) {
    return unsampled.has(from) ? { kind: 'unknown', unsampled: [from] } : { kind: 'unreachable' }
  }
  if (from === to) return { kind: 'path', transitions: [] }

  const visited = new Set([from])
  const queue = [{ status: from, path: [] }]

  while (queue.length > 0) {
    const { status, path } = queue.shift()
    for (const transition of graph[status] ?? []) {
      if (transition.to === to) return { kind: 'path', transitions: [...path, transition] }
      if (visited.has(transition.to)) continue
      visited.add(transition.to)
      queue.push({ status: transition.to, path: [...path, transition] })
    }
  }

  const visitedUnsampled = [...visited].filter((status) => unsampled.has(status))
  if (visitedUnsampled.length > 0) return { kind: 'unknown', unsampled: visitedUnsampled }
  return { kind: 'unreachable' }
}
