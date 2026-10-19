// The JSON replies of every agent role: a schema file read from disk, the reply text parsed
// (one surrounding ```json fence tolerated and reported), and the reply validated under the
// subset of JSON Schema draft 2020-12 implemented here. A schema must use no other keyword:
// unknownKeywords names any it does.
import { readFileSync } from 'node:fs'

export const readSchema = (path) => JSON.parse(readFileSync(path, 'utf8'))

const KNOWN = new Set(['$schema', '$id', 'title', 'description', 'type', 'additionalProperties', 'required', 'properties', '$defs', 'items', '$ref', 'enum', 'const', 'pattern', 'minLength', 'minItems', 'minimum', 'allOf', 'if', 'then'])

// The keywords of a schema this validator does not implement; a schema must use none.
export function unknownKeywords(schema, path = '$') {
  if (schema === null || typeof schema !== 'object') return []
  const out = []
  for (const [key, value] of Object.entries(schema)) {
    if (!KNOWN.has(key)) out.push(`${path}.${key}`)
    if (key === 'properties' || key === '$defs') for (const [name, sub] of Object.entries(value)) out.push(...unknownKeywords(sub, `${path}.${key}.${name}`))
    else if (key === 'allOf') value.forEach((sub, i) => out.push(...unknownKeywords(sub, `${path}.allOf[${i}]`)))
    else if (['items', 'if', 'then'].includes(key)) out.push(...unknownKeywords(value, `${path}.${key}`))
  }
  return out
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const TYPES = {
  object: isObject,
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  integer: Number.isInteger,
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null
}

// The errors of `value` under the subset of JSON Schema draft 2020-12 the review schemas use.
export function validateJson(schema, value, path = '$', root = schema) {
  if (schema.$ref) return validateJson(root.$defs[schema.$ref.replace('#/$defs/', '')], value, path, root)
  const errors = []
  if (schema.type) {
    const types = [].concat(schema.type)
    if (!types.some((t) => TYPES[t](value))) return [`${path}: expected ${types.join(' or ')}`]
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join(', ')}`)
  if (Object.hasOwn(schema, 'const') && value !== schema.const) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`)
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push(`${path}: must not be empty`)
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: "${value}" does not match ${schema.pattern}`)
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be at least ${schema.minimum}`)
  if (Array.isArray(value) && schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: must hold at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`)
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => errors.push(...validateJson(schema.items, item, `${path}[${i}]`, root)))
  if (isObject(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}: ${key} is required`)
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) errors.push(...validateJson(schema.properties[key], item, `${path}.${key}`, root))
      else if (schema.additionalProperties === false) errors.push(`${path}: ${key} is not allowed`)
    }
  }
  for (const sub of schema.allOf ?? []) {
    if (!sub.if) errors.push(...validateJson(sub, value, path, root))
    else if (validateJson(sub.if, value, path, root).length === 0 && sub.then) errors.push(...validateJson(sub.then, value, path, root))
  }
  return errors
}

// A reply's JSON. One surrounding ```json fence is tolerated and reported.
export function parseReply(text) {
  const trimmed = String(text ?? '').trim()
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed)
  try {
    return { reply: JSON.parse(fence ? fence[1] : trimmed), fenced: Boolean(fence), errors: [] }
  } catch (error) {
    return { reply: null, fenced: Boolean(fence), errors: [`not JSON: ${error.message}`] }
  }
}
