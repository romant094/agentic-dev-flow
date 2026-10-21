// Jira Server REST v2 over the global fetch. The token goes as a bearer header and is never
// printed; a failure carries Jira's own messages and the status.
export class JiraError extends Error {
  constructor(status, messages) {
    super(`Jira responded ${status}: ${messages.join('; ') || '(no message)'}`)
    this.name = 'JiraError'
    this.status = status
    this.messages = messages
  }
}

const PAGE_SIZE = 50

export class JiraClient {
  #env
  #fetch

  constructor(env, fetchImpl = globalThis.fetch) {
    this.#env = env
    this.#fetch = fetchImpl
  }

  async get(path) {
    return this.#request('GET', path)
  }

  async post(path, body) {
    return this.#request('POST', path, body)
  }

  async put(path, body) {
    return this.#request('PUT', path, body)
  }

  async search(jql, fields, maxResults) {
    if (maxResults !== undefined) {
      const page = await this.post('/rest/api/2/search', { jql, fields, startAt: 0, maxResults })
      return page.issues ?? []
    }

    const collected = []
    let startAt = 0
    for (;;) {
      const page = await this.post('/rest/api/2/search', { jql, fields, startAt, maxResults: PAGE_SIZE })
      const issues = page.issues ?? []
      if (issues.length === 0) return collected
      collected.push(...issues)
      if (collected.length >= page.total) return collected
      startAt += issues.length
    }
  }

  async #request(method, path, body) {
    const response = await this.#fetch(`${this.#env.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#env.pat}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })

    if (!response.ok) throw new JiraError(response.status, await extractMessages(response))
    if (response.status === 204) return undefined
    const text = await response.text()
    if (text === '') return undefined
    return JSON.parse(text)
  }
}

async function extractMessages(response) {
  const text = await response.text()
  try {
    const payload = JSON.parse(text)
    return [...(payload.errorMessages ?? []), ...Object.values(payload.errors ?? {})]
  } catch {
    const trimmed = text.trim()
    if (trimmed === '') return []
    return [trimmed.slice(0, 200)]
  }
}
