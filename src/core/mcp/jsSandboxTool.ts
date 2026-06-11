import { App, FileSystemAdapter, MarkdownView, TFile } from 'obsidian'

import type { JsSandboxSettings } from '../../settings/schema/setting.types'
import { McpTool } from '../../types/mcp.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { collectWikilinkPaths } from '../../utils/llm/annotate-wikilinks'

import { buildJsSandboxToolDescription } from './jsSandboxSettings'

export const JS_SANDBOX_TOOL_NAME = 'js_eval'

const SANDBOX_CHANNEL = 'yolo-js-sandbox-v1'
export const JS_SANDBOX_DEFAULT_TIMEOUT_MS = 3000
export const JS_SANDBOX_MIN_TIMEOUT_MS = 100
// Absolute hard ceiling — agents may not exceed this even if configured
// higher. Keeps a single runaway run from monopolizing the main thread
// indefinitely on slow / mobile devices.
export const JS_SANDBOX_HARD_MAX_TIMEOUT_MS = 60000
const READY_TIMEOUT_MS = 3000
// Default cap on the serialized JSON result returned to the LLM. The host
// keeps this conservative so a single tool call doesn't accidentally blow
// the model's context window. The user may raise it per-agent up to the
// hard ceiling below.
export const JS_SANDBOX_DEFAULT_OUTPUT_MAX_BYTES = 50 * 1024
// Hard ceiling on the tool result size. 2 MiB strikes a balance between
// "useful for paste-sized payloads" and "won't OOM smaller models if the
// agent pipes a raw fetch body straight back".
export const JS_SANDBOX_HARD_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
export const JS_SANDBOX_MIN_OUTPUT_BYTES = 1024

// Fetch defaults live here (rather than in localFileTools) so the
// LLM-facing description can quote the same numbers the proxy enforces.
export const JS_SANDBOX_FETCH_DEFAULT_MAX_CONCURRENT = 3
// 10 MiB — comfortable for typical scrape / API response bodies without
// silently blowing past the per-tool output cap.
export const JS_SANDBOX_FETCH_DEFAULT_MAX_RESPONSE_KB = 10 * 1024
// 1 GiB hard ceiling. Anything larger would risk freezing the renderer
// while postMessage shuttles the response back across the iframe boundary.
export const JS_SANDBOX_FETCH_HARD_MAX_RESPONSE_KB = 1024 * 1024
export const JS_SANDBOX_FETCH_MIN_RESPONSE_KB = 1
export const JS_SANDBOX_FETCH_HARD_MAX_CONCURRENT = 32
export const JS_SANDBOX_FETCH_MIN_CONCURRENT = 1

// Vault read defaults / hard cap. Range mirrors fetch — large vault files
// can blow through the model context just as easily as oversized HTTP
// bodies, so the same ceiling applies.
export const JS_SANDBOX_VAULT_READ_DEFAULT_MAX_KB = 10 * 1024
export const JS_SANDBOX_VAULT_READ_HARD_MAX_KB = 1024 * 1024
export const JS_SANDBOX_VAULT_READ_MIN_KB = 1

type JsonRecord = Record<string, unknown>

export type JsSandboxBinaryReadResult = {
  base64: string
  mimeType: string
  byteLength: number
}

export type JsSandboxFetchResponse = {
  ok: boolean
  status: number
  statusText?: string
  headers: Record<string, string>
  body: ArrayBuffer
  byteLength: number
}

export type JsSandboxProxyHandlers = {
  vaultReadText?: (path: string) => Promise<string | null>
  vaultReadBinary?: (path: string) => Promise<JsSandboxBinaryReadResult | null>
  vaultReadConfig?: { maxKb: number }
  hostFetch?: (
    url: string,
    init?: Record<string, unknown>,
  ) => Promise<JsSandboxFetchResponse>
  fetchConfig?: {
    fetchMode: 'whitelist' | 'blacklist'
    fetchDomains: string[]
    maxConcurrent: number
    maxResponseKb: number
  }
  dbQuery?: (
    method: 'search' | 'find' | 'get',
    params: Record<string, unknown>,
  ) => Promise<unknown>
}

type JsSandboxCaps = {
  allowFetch: boolean
  allowVaultRead: boolean
  allowDbQuery: boolean
  allowExternalScripts: boolean
}

type JsSandboxVariables = {
  $now: string
  $isoDate: string
  $note: {
    path: string
    basename: string
    frontmatter: JsonRecord
  } | null
  $content: string | null
  $selection: string | null
  $vault: {
    name: string
    adapter: {
      basePath: string | null
    }
  }
  $links: string[]
  $tags: string[]
  _caps?: JsSandboxCaps
}

type JsSandboxRunResult =
  | {
      ok: true
      json: string
    }
  | {
      ok: false
      error: string
      stack?: string
    }

type FetchQuota = {
  maxConcurrent: number
  maxResponseKb: number
  activeCount: number
  totalBytes: number
}

type PendingRun = {
  resolve: (result: JsSandboxRunResult) => void
  reject: (error: Error) => void
  cleanup: () => void
  proxyHandlers?: JsSandboxProxyHandlers
  fetchQuota?: FetchQuota
}

type JsSandboxCspPolicy = {
  allowFetch: boolean
  allowExternalScripts: boolean
}

type JsSandboxToolCallResult =
  | {
      status: ToolCallResponseStatus.Success
      text: string
    }
  | {
      status: ToolCallResponseStatus.Error
      error: string
    }
  | {
      status: ToolCallResponseStatus.Aborted
    }

const JS_SANDBOX_WORKER_SCRIPT = String.raw`
const CHANNEL = 'yolo-js-sandbox-v1'
const HTML_PARSE_MAX_INPUT_BYTES = 2 * 1024 * 1024
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function deepFreeze(value) {
  if (
    !value ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    Object.isFrozen(value)
  ) {
    return value
  }
  Object.freeze(value)
  for (const key of Object.keys(value)) {
    deepFreeze(value[key])
  }
  return value
}

function assertArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(name + ' must be an array.')
  }
  return value
}

function assertFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(name + ' must be a finite number.')
  }
  return value
}

function toFiniteNumbers(values, name) {
  assertArray(values, name)
  return values.map((value, index) =>
    assertFiniteNumber(value, name + '[' + index + ']')
  )
}

function getPathValue(value, path) {
  if (typeof path === 'function') {
    return path(value)
  }
  if (typeof path !== 'string' || path.trim() === '') {
    return value
  }
  return path.split('.').reduce((current, part) => {
    if (current === null || current === undefined) {
      return undefined
    }
    return current[part]
  }, value)
}

function flattenJson(value, prefix, output) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      output.push({ path: prefix, value: [] })
      return output
    }
    value.forEach((item, index) => {
      flattenJson(item, prefix ? prefix + '[' + index + ']' : '[' + index + ']', output)
    })
    return output
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) {
      output.push({ path: prefix, value: {} })
      return output
    }
    for (const [key, item] of entries) {
      flattenJson(item, prefix ? prefix + '.' + key : key, output)
    }
    return output
  }
  output.push({ path: prefix, value })
  return output
}

function parseIsoDate(value, name) {
  if (typeof value !== 'string') {
    throw new Error(name + ' must be an ISO date string.')
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) {
    throw new Error(name + ' must use YYYY-MM-DD.')
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (Number.isNaN(date.getTime())) {
    throw new Error(name + ' is not a valid date.')
  }
  return date
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10)
}

function assertMatrix(matrix, name) {
  assertArray(matrix, name)
  if (matrix.length === 0) {
    throw new Error(name + ' must not be empty.')
  }
  const width = Array.isArray(matrix[0]) ? matrix[0].length : 0
  if (width === 0) {
    throw new Error(name + ' rows must not be empty.')
  }
  return matrix.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== width) {
      throw new Error(name + ' must be a rectangular matrix.')
    }
    return row.map((value, colIndex) =>
      assertFiniteNumber(value, name + '[' + rowIndex + '][' + colIndex + ']')
    )
  })
}

function applyModulo(value, modulo) {
  if (modulo === undefined || modulo === null) {
    return value
  }
  const mod = assertFiniteNumber(modulo, 'modulo')
  if (mod <= 0) {
    throw new Error('modulo must be positive.')
  }
  return ((value % mod) + mod) % mod
}

function matrixIdentity(size) {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error('size must be a positive integer.')
  }
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => (row === col ? 1 : 0))
  )
}

function matrixMultiply(a, b, options) {
  const left = assertMatrix(a, 'a')
  const right = assertMatrix(b, 'b')
  if (left[0].length !== right.length) {
    throw new Error('a columns must equal b rows.')
  }
  const modulo = options && typeof options === 'object' ? options.modulo : undefined
  return left.map((row) =>
    right[0].map((_, colIndex) => {
      let sum = 0
      for (let i = 0; i < right.length; i += 1) {
        sum = applyModulo(sum + row[i] * right[i][colIndex], modulo)
      }
      return applyModulo(sum, modulo)
    })
  )
}

function getStringByteLength(value) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length
  }
  return value.length
}

function normalizeHtmlInput(markup) {
  const html = String(markup ?? '')
  const byteLength = getStringByteLength(html)
  if (byteLength > HTML_PARSE_MAX_INPUT_BYTES) {
    throw new Error(
      '$utils.html input exceeds ' + HTML_PARSE_MAX_INPUT_BYTES +
      ' bytes. Pass a smaller HTML fragment or narrow the fetched response first.'
    )
  }
  return html
}

function createSandboxHtmlUtils() {
  return {
    extract(markup, options) {
      return proxyCall('html_extract', { html: normalizeHtmlInput(markup), options })
    },
    select(markup, selector, options) {
      return proxyCall('html_select', {
        html: normalizeHtmlInput(markup),
        selector,
        options
      })
    }
  }
}

function createSandboxUtils(options) {
  const json = {
    flatten(value) {
      return flattenJson(value, '', [])
    },
    groupBy(items, key) {
      return assertArray(items, 'items').reduce((acc, item) => {
        const groupKey = String(getPathValue(item, key))
        if (!acc[groupKey]) acc[groupKey] = []
        acc[groupKey].push(item)
        return acc
      }, {})
    },
    countBy(items, key) {
      return assertArray(items, 'items').reduce((acc, item) => {
        const groupKey = String(getPathValue(item, key))
        acc[groupKey] = (acc[groupKey] || 0) + 1
        return acc
      }, {})
    }
  }

  const text = {
    markdownHeadings(markdown) {
      return String(markdown ?? '')
        .split('\n')
        .map((line, index) => {
          const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
          return match
            ? { level: match[1].length, text: match[2].trim(), line: index + 1 }
            : null
        })
        .filter(Boolean)
    },
    tasks(markdown) {
      return String(markdown ?? '')
        .split('\n')
        .map((line, index) => {
          const match = line.match(/^(\s*)[-*+]\s+\[([ xX-])\]\s+(.*)$/)
          if (!match) return null
          const marker = match[2]
          return {
            checked: marker.toLowerCase() === 'x',
            status: marker === '-' ? 'partial' : marker.toLowerCase() === 'x' ? 'done' : 'todo',
            text: match[3],
            indent: match[1].length,
            line: index + 1
          }
        })
        .filter(Boolean)
    },
    wikilinks(markdown) {
      const regex = /(?<!!)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g
      const results = []
      let match
      while ((match = regex.exec(String(markdown ?? ''))) !== null) {
        results.push({ target: match[1].trim(), alias: match[2] ? match[2].trim() : null })
      }
      return results
    }
  }

  const stats = {
    sum(values) {
      return toFiniteNumbers(values, 'values').reduce((sum, value) => sum + value, 0)
    },
    mean(values) {
      const numbers = toFiniteNumbers(values, 'values')
      return numbers.length === 0 ? null : stats.sum(numbers) / numbers.length
    },
    median(values) {
      const numbers = toFiniteNumbers(values, 'values').sort((a, b) => a - b)
      if (numbers.length === 0) return null
      const middle = Math.floor(numbers.length / 2)
      return numbers.length % 2
        ? numbers[middle]
        : (numbers[middle - 1] + numbers[middle]) / 2
    },
    percentile(values, p) {
      const numbers = toFiniteNumbers(values, 'values').sort((a, b) => a - b)
      const percentile = assertFiniteNumber(p, 'p')
      if (numbers.length === 0) return null
      if (percentile < 0 || percentile > 100) {
        throw new Error('p must be between 0 and 100.')
      }
      const index = (percentile / 100) * (numbers.length - 1)
      const lower = Math.floor(index)
      const upper = Math.ceil(index)
      if (lower === upper) return numbers[lower]
      return numbers[lower] + (numbers[upper] - numbers[lower]) * (index - lower)
    },
    stdev(values, sample) {
      const numbers = toFiniteNumbers(values, 'values')
      if (numbers.length === 0) return null
      if (sample && numbers.length < 2) return null
      const mean = stats.mean(numbers)
      const denominator = sample ? numbers.length - 1 : numbers.length
      const variance =
        numbers.reduce((sum, value) => sum + (value - mean) ** 2, 0) / denominator
      return Math.sqrt(variance)
    }
  }

  const matrix = {
    identity: matrixIdentity,
    multiply: matrixMultiply,
    pow(value, exponent, options) {
      if (!Number.isInteger(exponent) || exponent < 0) {
        throw new Error('exponent must be a non-negative integer.')
      }
      const base = assertMatrix(value, 'matrix')
      if (base.length !== base[0].length) {
        throw new Error('matrix must be square.')
      }
      let result = matrixIdentity(base.length)
      let factor = base
      let power = exponent
      while (power > 0) {
        if (power % 2 === 1) {
          result = matrixMultiply(result, factor, options)
        }
        power = Math.floor(power / 2)
        if (power > 0) {
          factor = matrixMultiply(factor, factor, options)
        }
      }
      return result
    }
  }

  const date = {
    addDays(isoDate, days) {
      const source = parseIsoDate(isoDate, 'isoDate')
      source.setUTCDate(source.getUTCDate() + assertFiniteNumber(days, 'days'))
      return formatIsoDate(source)
    },
    diffDays(a, b) {
      return Math.round((parseIsoDate(a, 'a') - parseIsoDate(b, 'b')) / 86400000)
    },
    today() {
      return new Date().toISOString().slice(0, 10)
    }
  }

  const utils = { json, text, stats, matrix, date }
  if (options && options.includeHtml) {
    // HTML parsing is coupled to network/fetch mode: it is mainly for fetched
    // web pages, and keeping it conditional avoids advertising extra surface
    // to agents that cannot retrieve remote HTML in the first place.
    utils.html = createSandboxHtmlUtils()
  }

  return deepFreeze(utils)
}

const SANDBOX_UTILS = createSandboxUtils({ includeHtml: false })
const SANDBOX_UTILS_WITH_HTML = createSandboxUtils({ includeHtml: true })

function disableAmbientCapabilities(allowScripts, allowFetch) {
  // allowScripts is the "full power" switch: once the model can pull in and
  // execute arbitrary remote code, any extra restriction we keep is theatre.
  // Skip the lockdown entirely — every ambient capability stays unlocked
  // (fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon,
  // importScripts, Worker, SharedWorker, indexedDB, caches), because real
  // libraries depend on them. This pairs with skipping
  // freezeBuiltinPrototypes() below: external-script mode is the explicit
  // high-risk compatibility tradeoff, not partial isolation. The host
  // already forces approval for any agent that enables this flag.
  if (allowScripts) {
    return
  }
  // Default: full lockdown.
  const blocked = [
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'importScripts',
    'Worker',
    'SharedWorker',
    'indexedDB',
    'caches',
    'sendBeacon',
  ]
  // When allowFetch is on, drop every network primitive from the blocked
  // list so the model can call browser-native fetch / XHR / WebSocket /
  // EventSource / sendBeacon and get real Response objects. Script-loading
  // (importScripts / Worker) and storage (indexedDB / caches) stay locked.
  if (allowFetch) {
    const networkPrimitives = new Set([
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'EventSource',
      'sendBeacon',
    ])
    for (let i = blocked.length - 1; i >= 0; i -= 1) {
      if (networkPrimitives.has(blocked[i])) {
        blocked.splice(i, 1)
      }
    }
  }
  const targets = [globalThis]
  // Also lock the prototype chain to prevent bypass via Object.getPrototypeOf(self).fetch.call(self, ...)
  try {
    const proto = Object.getPrototypeOf(globalThis)
    if (proto && proto !== globalThis) targets.push(proto)
  } catch {
    // ignore
  }
  for (const target of targets) {
    for (const key of blocked) {
      try {
        Object.defineProperty(target, key, {
          configurable: false,
          enumerable: false,
          writable: false,
          value: undefined
        })
      } catch {
        try {
          target[key] = undefined
        } catch {
          // Lockdown failed — notify the host so the run can be aborted
          self.postMessage({ channel: CHANNEL, type: 'lockdown_failed', key })
        }
      }
    }
  }
}

// Proxy infrastructure: allows user code to call back to the host for
// capabilities that aren't available inside the Worker directly.
let proxyIdCounter = 0
let activeRunToken = null
const proxyPending = new Map()

function proxyCall(cap, payload) {
  return new Promise((resolve, reject) => {
    const proxyId = 'p' + (++proxyIdCounter)
    proxyPending.set(proxyId, { resolve, reject })
    self.postMessage({
      channel: CHANNEL,
      token: activeRunToken,
      type: 'proxy_req',
      proxyId,
      cap,
      payload
    })
  })
}

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.channel !== CHANNEL || data.type !== 'proxy_res') return
  const pending = proxyPending.get(data.proxyId)
  if (!pending) return
  proxyPending.delete(data.proxyId)
  if (data.error) {
    pending.reject(new Error(data.error))
  } else {
    pending.resolve(data.value)
  }
})

function buildScope(rawVars) {
  const caps = rawVars && rawVars._caps ? rawVars._caps : {}
  const vaultBase = rawVars ? rawVars.$vault ?? null : null
  const hostFetchAllowed = Boolean(caps.allowFetch || caps.allowExternalScripts)

  const scope = {
    $now: rawVars && typeof rawVars.$now === 'string'
      ? new Date(rawVars.$now)
      : new Date(),
    $isoDate: rawVars && typeof rawVars.$isoDate === 'string'
      ? rawVars.$isoDate
      : new Date().toISOString().slice(0, 10),
    $note: rawVars ? rawVars.$note ?? null : null,
    $content: rawVars ? rawVars.$content ?? null : null,
    $selection: rawVars ? rawVars.$selection ?? null : null,
    $vault: vaultBase ? {
      ...vaultBase,
      readText: caps.allowVaultRead
        ? (path) => proxyCall('vault_read_text', { path })
        : undefined,
      readBinary: caps.allowVaultRead
        ? (path) => proxyCall('vault_read_binary', { path })
        : undefined
    } : null,
    $links: Array.isArray(rawVars && rawVars.$links) ? rawVars.$links : [],
    $tags: Array.isArray(rawVars && rawVars.$tags) ? rawVars.$tags : [],
    $utils: hostFetchAllowed ? SANDBOX_UTILS_WITH_HTML : SANDBOX_UTILS,
    $db: caps.allowDbQuery ? {
      search: (query, limit) => proxyCall('db_query', { method: 'search', query, limit }),
      find: (keyword, limit) => proxyCall('db_query', { method: 'find', keyword, limit }),
      get: (path) => proxyCall('db_query', { method: 'get', path })
    } : undefined,
    $fetch: hostFetchAllowed ? hostFetch : undefined
  }
  // Network fetch: when network or external scripts are allowed, do NOT
  // shadow the global so user code resolves to browser-native fetch. When
  // disallowed, inject undefined to override any prototype-chain leak.
  if (!caps.allowFetch && !caps.allowExternalScripts) {
    scope.fetch = undefined
  }
  return scope
}

function headersToPlainObject(headers) {
  if (!headers) {
    return undefined
  }
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const result = {}
    headers.forEach((value, key) => {
      result[key] = value
    })
    return result
  }
  if (Array.isArray(headers)) {
    const result = {}
    for (const pair of headers) {
      if (Array.isArray(pair) && pair.length >= 2) {
        result[String(pair[0])] = String(pair[1])
      }
    }
    return result
  }
  if (typeof headers === 'object') {
    const result = {}
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null) {
        result[key] = String(value)
      }
    }
    return result
  }
  return undefined
}

async function bodyToHostFetchBody(body) {
  if (body === undefined || body === null) {
    return undefined
  }
  if (typeof body === 'string' || body instanceof ArrayBuffer) {
    return body
  }
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return await body.arrayBuffer()
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return String(body)
  }
  throw new Error('$fetch body must be a string, ArrayBuffer, typed array, Blob, or URLSearchParams.')
}

async function normalizeHostFetchArgs(input, init) {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request
  const url = isRequest
    ? input.url
    : input instanceof URL
      ? input.href
      : String(input ?? '')
  const options = init && typeof init === 'object' ? init : {}
  const method = typeof options.method === 'string'
    ? options.method
    : isRequest
      ? input.method
      : undefined
  const headers = headersToPlainObject(
    options.headers !== undefined
      ? options.headers
      : isRequest
        ? input.headers
        : undefined
  )
  const hasInitBody = Object.prototype.hasOwnProperty.call(options, 'body')
  const requestBody =
    !hasInitBody &&
    isRequest &&
    input.method !== 'GET' &&
    input.method !== 'HEAD'
      ? await input.arrayBuffer()
      : undefined
  const rawBody = hasInitBody ? options.body : requestBody
  const isUrlEncodedBody =
    typeof URLSearchParams !== 'undefined' && rawBody instanceof URLSearchParams
  const body = await bodyToHostFetchBody(rawBody)
  const contentType =
    typeof options.contentType === 'string'
      ? options.contentType
      : isUrlEncodedBody
        ? 'application/x-www-form-urlencoded;charset=UTF-8'
        : undefined
  return {
    url,
    init: {
      ...(method ? { method } : {}),
      ...(headers ? { headers } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(contentType ? { contentType } : {})
    }
  }
}

async function hostFetch(input, init) {
  const request = await normalizeHostFetchArgs(input, init)
  const result = await proxyCall('host_fetch', request)
  return new Response(result.body, {
    status: result.status,
    statusText: result.statusText || '',
    headers: result.headers || {}
  })
}

function wrapTrailingExpressionAsReturn(code) {
  // Body mode is used when expression mode (return await (CODE)) failed with
  // a SyntaxError — typically because the code has multiple statements.
  // Without an explicit \`return\`, the final expression value is discarded
  // and the model sees \`null\`. Try to detect a trailing bare expression and
  // wrap it in \`return\` so the natural REPL-style behavior works.
  if (/(^|\n)\s*return\b/.test(code)) {
    return code
  }
  const trimmed = code.replace(/\s+$/, '')
  if (trimmed.length === 0) {
    return code
  }
  // Walk back through any trailing single-line comments to find the last
  // statement boundary. We intentionally do NOT try to balance braces or
  // parse multi-line constructs — if it's complex enough that simple regex
  // splitting can't find the boundary, fall through and accept that the
  // user must use explicit \`return\`.
  const lastSemi = trimmed.lastIndexOf(';')
  const lastBrace = trimmed.lastIndexOf('}')
  const boundary = Math.max(lastSemi, lastBrace)
  const head = boundary >= 0 ? trimmed.slice(0, boundary + 1) : ''
  const tail = boundary >= 0 ? trimmed.slice(boundary + 1) : trimmed
  const tailTrimmed = tail.trim()
  if (tailTrimmed.length === 0) {
    return code
  }
  if (
    /^(if|else|for|while|do|switch|try|catch|finally|break|continue|throw|return|function|class|var|let|const|import|export)\b/.test(
      tailTrimmed
    )
  ) {
    return code
  }
  return head + ' return (' + tailTrimmed + ');\n'
}

async function runInScope(code, rawVars) {
  const scope = buildScope(rawVars)
  const names = Object.keys(scope)
  const values = names.map((name) => scope[name])

  try {
    const expressionFn = new AsyncFunction(
      ...names,
      '"use strict";\nreturn await (' + code + ');'
    )
    return await expressionFn(...values)
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error
    }
    const wrapped = wrapTrailingExpressionAsReturn(code)
    if (wrapped !== code) {
      try {
        const wrappedFn = new AsyncFunction(...names, '"use strict";\n' + wrapped)
        return await wrappedFn(...values)
      } catch (innerError) {
        if (!(innerError instanceof SyntaxError)) {
          throw innerError
        }
        // fall through to plain body mode
      }
    }
    const bodyFn = new AsyncFunction(...names, '"use strict";\n' + code)
    return await bodyFn(...values)
  }
}

function serializeResult(value) {
  if (typeof value === 'undefined') {
    // Most common cause: multi-statement code without an explicit return.
    // Wrapping the silent undefined with a hint saves the model from
    // staring at a bare null and guessing whether the run failed,
    // returned nothing intentionally, or just forgot the return statement.
    return JSON.stringify({
      result: null,
      hint: 'Script returned undefined. Multi-statement code needs an explicit "return <expr>" on the final value. Single-expression code is auto-returned.'
    })
  }
  const json = JSON.stringify(value)
  if (typeof json !== 'string') {
    throw new Error('not serializable')
  }
  return json
}

function errorPayload(error) {
  if (error && typeof error === 'object') {
    return {
      error: error.message ? String(error.message) : String(error),
      stack: typeof error.stack === 'string' ? error.stack : undefined
    }
  }
  return { error: String(error) }
}

// Freeze built-in prototypes BEFORE user code runs so prototype pollution
// (e.g. Object.prototype.toJSON = () => 'fake') cannot corrupt serializeResult
// or fool the host/LLM with falsified output. Only built-in prototypes are
// frozen — user-defined classes and own properties remain fully mutable.
// External script mode deliberately skips this: many UMD/browser libraries
// patch prototypes during startup, and enabling that mode is already the
// explicit high-risk compatibility tradeoff.
function freezeBuiltinPrototypes() {
  const protos = [
    Object.prototype,
    Array.prototype,
    Number.prototype,
    String.prototype,
    Boolean.prototype,
    Date.prototype,
    RegExp.prototype,
    Error.prototype,
    Function.prototype,
    typeof Map !== 'undefined' && Map.prototype,
    typeof Set !== 'undefined' && Set.prototype,
    typeof WeakMap !== 'undefined' && WeakMap.prototype,
    typeof WeakSet !== 'undefined' && WeakSet.prototype,
    typeof Promise !== 'undefined' && Promise.prototype,
    typeof Symbol !== 'undefined' && Symbol.prototype,
    typeof BigInt !== 'undefined' && BigInt.prototype,
    typeof ArrayBuffer !== 'undefined' && ArrayBuffer.prototype,
    typeof DataView !== 'undefined' && DataView.prototype,
    typeof Uint8Array !== 'undefined' && Object.getPrototypeOf(Uint8Array.prototype),
  ]
  for (const proto of protos) {
    if (proto && typeof proto === 'object') {
      try { Object.freeze(proto) } catch { /* best-effort */ }
    }
  }
}

// Lockdown is deferred to the first run message so we can read _caps from
// data.vars — once Object.defineProperty(..., { configurable: false }) is
// applied, we cannot selectively unlock script-loading primitives later.
// The worker is single-use (terminated after the run completes), so this
// only fires once per Worker instance.
let lockdownApplied = false

self.addEventListener('message', async (event) => {
  const data = event.data
  if (!data || data.channel !== CHANNEL || data.type !== 'run') {
    return
  }

  const caps = (data.vars && data.vars._caps) || {}
  if (!lockdownApplied) {
    const allowExternalScripts = Boolean(caps.allowExternalScripts)
    disableAmbientCapabilities(
      allowExternalScripts,
      Boolean(caps.allowFetch),
    )
    if (!allowExternalScripts) {
      freezeBuiltinPrototypes()
    } else {
      // UMD/browser bundles probe typeof window !== "undefined" to decide
      // where to attach exports. In a classic Worker, window is absent, so
      // the probe fails and the bundle silently drops its exports — caller
      // code then sees a ReferenceError when reaching for e.g. Algebrite.
      // Aliasing window to self lets the probe succeed without exposing
      // any new capability (self.fetch / self.document etc. are unchanged).
      // Libraries that actually touch DOM still fail, but with a precise
      // TypeError on window.document.* instead of an opaque importScripts
      // load error.
      self.window = self
    }
    lockdownApplied = true
  }

  const token = data.token
  activeRunToken = token
  const post = (payload) => {
    self.postMessage({ ...payload, channel: CHANNEL, token })
  }

  try {
    const result = await runInScope(String(data.code ?? ''), data.vars)
    post({ type: 'result', json: serializeResult(result) })
  } catch (error) {
    try {
      post({ type: 'result', json: JSON.stringify(errorPayload(error)) })
    } catch {
      post({
        type: 'result',
        json: JSON.stringify({ error: 'not serializable' })
      })
    }
  } finally {
    activeRunToken = null
  }
})
`

const JS_SANDBOX_IFRAME_SCRIPT = String.raw`
const CHANNEL = 'yolo-js-sandbox-v1'
const WORKER_SCRIPT = ${JSON.stringify(JS_SANDBOX_WORKER_SCRIPT)}
const HTML_PARSE_MAX_INPUT_BYTES = 2 * 1024 * 1024
const workers = new Map()

function postToParent(payload) {
  parent.postMessage({ ...payload, channel: CHANNEL }, '*')
}

function cleanupWorker(reqId) {
  const entry = workers.get(reqId)
  if (!entry) return
  workers.delete(reqId)
  try {
    entry.worker.terminate()
  } catch {
    // ignore
  }
}

function clampInteger(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value)
    ? Math.floor(value)
    : fallback
  return Math.min(max, Math.max(min, number))
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function truncateString(value, maxChars) {
  const text = String(value || '')
  const limit = Math.max(0, Math.floor(Number(maxChars) || 0))
  if (text.length <= limit) return text
  if (limit === 0) return ''
  if (limit <= 3) return '.'.repeat(limit)
  return Array.from(text).slice(0, limit - 3).join('') + '...'
}

function resolveHtmlUrl(value, baseUrl) {
  const raw = String(value || '').trim()
  if (!raw) return raw
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') return raw
  try {
    return new URL(raw, baseUrl).href
  } catch {
    return raw
  }
}

function getStringByteLength(value) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length
  }
  return value.length
}

function getPayloadOptions(payload) {
  return payload && payload.options && typeof payload.options === 'object'
    ? payload.options
    : {}
}

function parseHtmlDocument(payload) {
  if (typeof DOMParser !== 'function') {
    throw new Error('DOMParser is not available in this JavaScript sandbox.')
  }
  const html = String(payload.html || '')
  if (getStringByteLength(html) > HTML_PARSE_MAX_INPUT_BYTES) {
    throw new Error(
      '$utils.html input exceeds ' + HTML_PARSE_MAX_INPUT_BYTES +
      ' bytes. Pass a smaller HTML fragment or narrow the fetched response first.'
    )
  }
  return new DOMParser().parseFromString(html, 'text/html')
}

function collectElementAttrs(element, baseUrl) {
  const attrs = Object.create(null)
  for (const attr of Array.from(element.attributes || [])) {
    attrs[attr.name] = truncateString(attr.value, 1000)
  }
  if (attrs.href) attrs.href = resolveHtmlUrl(attrs.href, baseUrl)
  if (attrs.src) attrs.src = resolveHtmlUrl(attrs.src, baseUrl)
  return attrs
}

function elementToSummary(element, options) {
  const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl : ''
  const textMaxChars = clampInteger(options.textMaxChars, 4000, 200, 20000)
  const result = {
    tag: element.tagName.toLowerCase(),
    text: truncateString(normalizeWhitespace(element.textContent), textMaxChars),
    attrs: collectElementAttrs(element, baseUrl)
  }
  if (options.includeHtml === true) {
    result.html = truncateString(
      element.outerHTML || '',
      clampInteger(options.htmlMaxChars, 8000, 500, 50000)
    )
  }
  return result
}

function getDocumentBaseUrl(document, options) {
  const fallback = typeof options.baseUrl === 'string' ? options.baseUrl.trim() : ''
  const base = document.querySelector('base[href]')
  const baseHref = base ? String(base.getAttribute('href') || '').trim() : ''
  if (!baseHref) return fallback
  if (fallback) {
    try {
      return new URL(baseHref, fallback).href
    } catch {
      return fallback
    }
  }
  try {
    return new URL(baseHref).href
  } catch {
    return ''
  }
}

function extractPageText(document, maxChars) {
  const source = document.body || document.documentElement
  if (!source) return ''
  // Scripts/styles never execute through DOMParser, but removing noisy nodes
  // gives models the page text they usually wanted from an HTML scrape. The
  // parsed document is single-use, so mutate it instead of cloning the body.
  source
    .querySelectorAll('script,style,noscript,svg,canvas,template')
    .forEach((node) => node.remove())
  return truncateString(normalizeWhitespace(source.textContent), maxChars)
}

function collectItems(document, selector, limit, mapElement) {
  const results = []
  for (const element of document.querySelectorAll(selector)) {
    const item = mapElement(element)
    if (item) {
      results.push(item)
      if (results.length >= limit) break
    }
  }
  return results
}

function extractHtmlPage(payload) {
  const options = getPayloadOptions(payload)
  const document = parseHtmlDocument(payload)
  const baseUrl = getDocumentBaseUrl(document, options)
  const maxItems = clampInteger(options.maxItems, 100, 1, 500)
  const maxTextChars = clampInteger(options.maxTextChars, 20000, 1000, 100000)
  const meta = Object.create(null)

  for (const node of Array.from(
    document.querySelectorAll('meta[name],meta[property]')
  )) {
    const key = node.getAttribute('name') || node.getAttribute('property')
    const content = node.getAttribute('content')
    if (key && content && meta[key] === undefined) {
      meta[key] = truncateString(content, 2000)
    }
  }

  const headings = collectItems(
    document,
    'h1,h2,h3,h4,h5,h6',
    maxItems,
    (node) => {
      const text = truncateString(normalizeWhitespace(node.textContent), 1000)
      return text
        ? {
            level: Number(node.tagName.slice(1)),
            text
          }
        : null
    }
  )

  const links = collectItems(document, 'a[href]', maxItems, (node) => {
    const href = resolveHtmlUrl(node.getAttribute('href') || '', baseUrl)
    return href
      ? {
          text: truncateString(normalizeWhitespace(node.textContent), 1000),
          href
        }
      : null
  })

  const images = collectItems(document, 'img[src]', maxItems, (node) => {
    const src = resolveHtmlUrl(node.getAttribute('src') || '', baseUrl)
    return src
      ? {
          alt: truncateString(node.getAttribute('alt') || '', 1000),
          src
        }
      : null
  })

  return {
    title: normalizeWhitespace(document.querySelector('title')?.textContent),
    lang: document.documentElement?.getAttribute('lang') || null,
    text: extractPageText(document, maxTextChars),
    meta,
    headings,
    links,
    images
  }
}

function selectHtmlElements(payload) {
  const options = getPayloadOptions(payload)
  const selector = typeof payload.selector === 'string' ? payload.selector : ''
  if (!selector.trim()) {
    throw new Error('selector must be a non-empty CSS selector.')
  }
  const document = parseHtmlDocument(payload)
  const baseUrl = getDocumentBaseUrl(document, options)
  const limit = clampInteger(options.limit, 50, 1, 200)
  const results = []
  for (const element of document.querySelectorAll(selector)) {
    results.push(elementToSummary(element, { ...options, baseUrl }))
    if (results.length >= limit) break
  }
  return results
}

function sendWorkerProxyResponse(entry, proxyId, value, error) {
  entry.worker.postMessage({
    channel: CHANNEL,
    type: 'proxy_res',
    proxyId,
    value,
    error
  })
}

function handleLocalProxyRequest(entry, payload) {
  if (payload.cap !== 'html_extract' && payload.cap !== 'html_select') {
    return false
  }
  if (!entry.allowHtml) {
    sendWorkerProxyResponse(
      entry,
      payload.proxyId,
      undefined,
      '$utils.html is not enabled'
    )
    return true
  }
  try {
    const value =
      payload.cap === 'html_extract'
        ? extractHtmlPage(payload.payload || {})
        : selectHtmlElements(payload.payload || {})
    sendWorkerProxyResponse(entry, payload.proxyId, value)
  } catch (error) {
    sendWorkerProxyResponse(
      entry,
      payload.proxyId,
      undefined,
      error && error.message ? String(error.message) : String(error)
    )
  }
  return true
}

function startRun(data) {
  if (typeof Worker !== 'function' || typeof Blob !== 'function') {
    postToParent({
      type: 'error',
      reqId: data.reqId,
      message: 'Sandbox worker is not available.'
    })
    return
  }

  const token =
    Math.random().toString(36).slice(2) + Date.now().toString(36)
  let worker
  try {
    const blob = new Blob([WORKER_SCRIPT], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    worker = new Worker(url)
    URL.revokeObjectURL(url)
  } catch (error) {
    postToParent({
      type: 'error',
      reqId: data.reqId,
      message: error && error.message ? String(error.message) : String(error)
    })
    return
  }

  const caps = (data.vars && data.vars._caps) || {}
  workers.set(data.reqId, {
    worker,
    token,
    allowHtml: Boolean(caps.allowFetch || caps.allowExternalScripts)
  })

  worker.onmessage = (event) => {
    const payload = event.data
    const entry = workers.get(data.reqId)
    if (
      !entry ||
      !payload ||
      payload.channel !== CHANNEL ||
      payload.token !== entry.token
    ) {
      return
    }
    // Proxy request from Worker → forward to parent host, keep worker alive.
    if (payload.type === 'proxy_req') {
      if (handleLocalProxyRequest(entry, payload)) {
        return
      }
      postToParent({
        type: 'proxy_req',
        reqId: data.reqId,
        proxyId: payload.proxyId,
        cap: payload.cap,
        payload: payload.payload
      })
      return
    }
    // Lockdown failure notification — forward without terminating the worker.
    if (payload.type === 'lockdown_failed') {
      postToParent({ type: 'lockdown_failed', reqId: data.reqId, key: payload.key })
      return
    }
    cleanupWorker(data.reqId)
    postToParent({
      type: payload.type,
      reqId: data.reqId,
      json: payload.json,
      message: payload.message,
      stack: payload.stack
    })
  }

  worker.onerror = (event) => {
    cleanupWorker(data.reqId)
    postToParent({
      type: 'error',
      reqId: data.reqId,
      message: event.message || 'Sandbox worker failed.'
    })
  }

  worker.postMessage({
    channel: CHANNEL,
    type: 'run',
    token,
    code: data.code,
    vars: data.vars
  })
}

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.channel !== CHANNEL) return
  if (data.type === 'run') {
    startRun(data)
  } else if (data.type === 'cancel') {
    cleanupWorker(data.reqId)
  } else if (data.type === 'proxy_res') {
    // Proxy response from host → forward to the correct worker.
    const entry = workers.get(data.reqId)
    if (!entry) return
    entry.worker.postMessage({
      channel: CHANNEL,
      type: 'proxy_res',
      proxyId: data.proxyId,
      value: data.value,
      error: data.error
    })
  }
})

postToParent({ type: 'ready' })
`

export function getJsSandboxTool(settings?: JsSandboxSettings | null): McpTool {
  const effectiveTimeoutCap = clampAgentTimeoutCap(settings?.timeoutMs)
  const effectiveTimeoutDefault = Math.min(
    JS_SANDBOX_DEFAULT_TIMEOUT_MS,
    effectiveTimeoutCap,
  )
  return {
    name: JS_SANDBOX_TOOL_NAME,
    description: buildJsSandboxToolDescription(settings ?? {}),
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript code to execute.',
        },
        timeoutMs: {
          type: 'number',
          description: `Optional per-call timeout in milliseconds (default ${effectiveTimeoutDefault}, max ${effectiveTimeoutCap}). Raise for long-running probes; values above the max are silently clamped.`,
        },
      },
      required: ['code'],
    },
  }
}

export function resolveJsSandboxOutputMaxBytes(
  configuredKb?: number | null,
): number {
  if (
    typeof configuredKb !== 'number' ||
    !Number.isFinite(configuredKb) ||
    configuredKb <= 0
  ) {
    return JS_SANDBOX_DEFAULT_OUTPUT_MAX_BYTES
  }
  const requested = Math.floor(configuredKb) * 1024
  return Math.min(
    JS_SANDBOX_HARD_MAX_OUTPUT_BYTES,
    Math.max(JS_SANDBOX_MIN_OUTPUT_BYTES, requested),
  )
}

export function formatJsSandboxToolText(
  json: string,
  options?: { maxBytes?: number },
): string {
  let formatted = json
  try {
    formatted = JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    // The worker should only return JSON, but keep the formatter defensive.
  }

  const maxBytes =
    options?.maxBytes && options.maxBytes > 0
      ? options.maxBytes
      : JS_SANDBOX_DEFAULT_OUTPUT_MAX_BYTES
  if (getByteLength(formatted) <= maxBytes) {
    return formatted
  }

  // Reserve a small slice for the truncation envelope so the JSON wrapper
  // itself stays within budget.
  const prefixBytes = Math.max(1024, Math.floor(maxBytes * 0.95))
  return JSON.stringify(
    {
      warning: `Output exceeded ${maxBytes} bytes and was truncated.`,
      truncated: true,
      originalBytes: getByteLength(formatted),
      jsonPrefix: formatted.slice(0, prefixBytes),
    },
    null,
    2,
  )
}

export async function callJsSandboxTool({
  app,
  args,
  signal,
  jsSandboxSettings,
  proxyHandlers,
}: {
  app: App
  args: Record<string, unknown>
  signal?: AbortSignal
  jsSandboxSettings?: JsSandboxSettings
  proxyHandlers?: JsSandboxProxyHandlers
}): Promise<JsSandboxToolCallResult> {
  if (signal?.aborted) {
    return { status: ToolCallResponseStatus.Aborted }
  }

  const code = args.code
  if (typeof code !== 'string') {
    return {
      status: ToolCallResponseStatus.Error,
      error: 'code must be a string.',
    }
  }

  try {
    const timeoutMs = resolveJsSandboxTimeoutMs(
      args,
      jsSandboxSettings?.timeoutMs,
    )
    const vars = await buildJsSandboxVariables(app, jsSandboxSettings)
    const result = await getSharedJsSandboxRunner().run({
      code,
      vars,
      timeoutMs,
      signal,
      proxyHandlers,
    })

    const outputMaxBytes = resolveJsSandboxOutputMaxBytes(
      jsSandboxSettings?.outputMaxKb,
    )

    if (!result.ok) {
      return {
        status: ToolCallResponseStatus.Success,
        text: formatJsSandboxToolText(
          JSON.stringify({
            error: result.error,
            ...(result.stack ? { stack: result.stack } : {}),
          }),
          { maxBytes: outputMaxBytes },
        ),
      }
    }

    return {
      status: ToolCallResponseStatus.Success,
      text: formatJsSandboxToolText(result.json, { maxBytes: outputMaxBytes }),
    }
  } catch (error) {
    if (signal?.aborted) {
      return { status: ToolCallResponseStatus.Aborted }
    }

    return {
      status: ToolCallResponseStatus.Error,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function disposeJsSandbox(): void {
  sharedRunner?.dispose()
  sharedRunner = null
}

function resolveJsSandboxTimeoutMs(
  args: Record<string, unknown>,
  agentCapMs?: number,
): number {
  const cap = clampAgentTimeoutCap(agentCapMs)
  const value = args.timeoutMs
  if (value === undefined || value === null) {
    return Math.min(JS_SANDBOX_DEFAULT_TIMEOUT_MS, cap)
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('timeoutMs must be a finite number.')
  }
  return Math.min(cap, Math.max(JS_SANDBOX_MIN_TIMEOUT_MS, Math.floor(value)))
}

function clampAgentTimeoutCap(agentCapMs?: number): number {
  if (
    typeof agentCapMs !== 'number' ||
    !Number.isFinite(agentCapMs) ||
    agentCapMs <= 0
  ) {
    return JS_SANDBOX_HARD_MAX_TIMEOUT_MS
  }
  return Math.min(
    JS_SANDBOX_HARD_MAX_TIMEOUT_MS,
    Math.max(JS_SANDBOX_MIN_TIMEOUT_MS, Math.floor(agentCapMs)),
  )
}

async function buildJsSandboxVariables(
  app: App,
  config?: JsSandboxSettings,
): Promise<JsSandboxVariables> {
  const now = new Date()
  const file = app.workspace.getActiveFile()
  const cache = file ? app.metadataCache.getFileCache(file) : null
  const frontmatter = sanitizeFrontmatter(cache?.frontmatter)
  const content = file ? await readFileText(app, file) : null
  const selection = file ? getActiveMarkdownSelection(app, file) : null
  const basePath = getVaultBasePath(app)
  const tags = collectTags(cache?.tags, frontmatter)
  const links =
    file && content
      ? collectWikilinkPaths(app, content, file.path).map((item) => item.link)
      : []

  const _caps: JsSandboxCaps = {
    allowFetch: config?.allowFetch ?? false,
    allowVaultRead: config?.allowVaultRead ?? false,
    allowDbQuery: config?.allowDbQuery ?? false,
    allowExternalScripts: config?.allowExternalScripts ?? false,
  }

  return deepCloneJson({
    $now: now.toISOString(),
    $isoDate: now.toISOString().slice(0, 10),
    $note: file
      ? {
          path: file.path,
          basename: file.basename,
          frontmatter,
        }
      : null,
    $content: content,
    $selection: selection,
    $vault: {
      name: app.vault.getName(),
      adapter: {
        basePath: basePath ?? null,
      },
    },
    $links: links,
    $tags: tags,
    _caps,
  })
}

function getSharedJsSandboxRunner(): JsSandboxRunner {
  if (!sharedRunner) {
    sharedRunner = new JsSandboxRunner()
  }
  return sharedRunner
}

let sharedRunner: JsSandboxRunner | null = null

class JsSandboxRunner {
  private iframe: HTMLIFrameElement | null = null
  private iframeCspKey: string | null = null
  private isListening = false
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private pendingRuns = new Map<string, PendingRun>()
  private messageHandler = (event: MessageEvent) => {
    this.handleMessage(event)
  }

  async run({
    code,
    vars,
    timeoutMs,
    signal,
    proxyHandlers,
  }: {
    code: string
    vars: JsSandboxVariables
    timeoutMs: number
    signal?: AbortSignal
    proxyHandlers?: JsSandboxProxyHandlers
  }): Promise<JsSandboxRunResult> {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      throw new Error(
        'JS isolated execution is only available in a browser context.',
      )
    }
    if (signal?.aborted) {
      throw createAbortError()
    }

    await this.ensureReady(getJsSandboxCspPolicy(vars))

    const targetWindow = this.iframe?.contentWindow
    if (!targetWindow) {
      throw new Error('JS isolated execution iframe is not available.')
    }

    const reqId = createRequestId()
    const startedAt = Date.now()
    let timeoutId: number | null = null

    return await new Promise<JsSandboxRunResult>((resolve, reject) => {
      const cleanup = () => {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId)
          timeoutId = null
        }
        signal?.removeEventListener('abort', onAbort)
        this.pendingRuns.delete(reqId)
      }

      const finishTimeout = () => {
        cleanup()
        this.cancelRun(reqId)
        resolve({
          ok: true,
          json: JSON.stringify({
            error: `Execution timed out after ${timeoutMs} ms.`,
          }),
        })
      }

      const scheduleTimeout = () => {
        const elapsed = Date.now() - startedAt
        const remaining = timeoutMs - elapsed
        if (remaining <= 0) {
          finishTimeout()
          return
        }
        timeoutId = window.setTimeout(scheduleTimeout, Math.min(remaining, 250))
      }

      const onAbort = () => {
        cleanup()
        this.cancelRun(reqId)
        reject(createAbortError())
      }

      const fetchQuota: FetchQuota | undefined = proxyHandlers?.fetchConfig
        ? {
            maxConcurrent: proxyHandlers.fetchConfig.maxConcurrent,
            maxResponseKb: proxyHandlers.fetchConfig.maxResponseKb,
            activeCount: 0,
            totalBytes: 0,
          }
        : undefined

      this.pendingRuns.set(reqId, {
        resolve: (result) => {
          cleanup()
          resolve(result)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
        cleanup,
        proxyHandlers,
        fetchQuota,
      })

      signal?.addEventListener('abort', onAbort, { once: true })
      scheduleTimeout()

      try {
        targetWindow.postMessage(
          {
            channel: SANDBOX_CHANNEL,
            type: 'run',
            reqId,
            code,
            vars,
          },
          '*',
        )
      } catch (error) {
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  dispose(): void {
    for (const [reqId, pending] of this.pendingRuns) {
      this.cancelRun(reqId)
      pending.cleanup()
      pending.reject(new Error('JS isolated execution disposed.'))
    }
    this.pendingRuns.clear()
    if (typeof window !== 'undefined' && this.isListening) {
      window.removeEventListener('message', this.messageHandler)
      this.isListening = false
    }
    this.iframe?.remove()
    this.iframe = null
    this.iframeCspKey = null
    this.readyPromise = null
    this.readyResolve = null
  }

  private ensureReady(policy: JsSandboxCspPolicy): Promise<void> {
    const cspKey = getJsSandboxCspKey(policy)
    if (this.readyPromise && this.iframeCspKey === cspKey) {
      return this.readyPromise
    }

    if (this.pendingRuns.size > 0) {
      throw new Error(
        'Cannot reload JS isolated execution while another run is active.',
      )
    }

    this.iframe?.remove()
    this.iframe = null
    this.iframeCspKey = null
    this.readyPromise = null
    this.readyResolve = null

    if (!this.isListening) {
      window.addEventListener('message', this.messageHandler)
      this.isListening = true
    }
    const iframe = document.createElement('iframe')
    // Keep this iframe without allow-same-origin: the null/opaque origin is a
    // deliberate part of the isolation boundary. WebGPU probing showed that
    // top-level Obsidian and top-level Workers expose navigator.gpu, while this
    // sandbox and its Worker do not. Adding allow="webgpu" alone did not restore
    // it; adding allow-same-origin did. Do not trade away the origin boundary
    // just to expose WebGPU without a separate high-risk mode/design review.
    iframe.setAttribute('sandbox', 'allow-scripts')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.hidden = true
    iframe.srcdoc = buildSandboxHtml(policy)
    this.iframe = iframe
    this.iframeCspKey = cspKey

    this.readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false
      const timeoutId = window.setTimeout(() => {
        if (settled) {
          return
        }
        settled = true
        this.readyResolve = null
        reject(new Error('Timed out while initializing JS isolated execution.'))
      }, READY_TIMEOUT_MS)
      this.readyResolve = () => {
        if (settled) {
          return
        }
        settled = true
        window.clearTimeout(timeoutId)
        this.readyResolve = null
        resolve()
      }
    })

    document.body.appendChild(iframe)
    return this.readyPromise
  }

  private handleMessage(event: MessageEvent): void {
    if (event.source !== this.iframe?.contentWindow) {
      return
    }
    const data = event.data as
      | {
          channel?: string
          type?: string
          reqId?: string
          json?: string
          message?: string
          stack?: string
          proxyId?: string
          cap?: string
          payload?: Record<string, unknown>
          key?: string
        }
      | undefined
    if (!data || data.channel !== SANDBOX_CHANNEL) {
      return
    }

    if (data.type === 'ready') {
      this.readyResolve?.()
      return
    }

    if (!data.reqId) {
      return
    }
    const pending = this.pendingRuns.get(data.reqId)

    // Worker failed to lock down an ambient capability — abort this run immediately
    // to avoid executing user code in a partially-secured environment.
    if (data.type === 'lockdown_failed') {
      if (pending) {
        this.pendingRuns.delete(data.reqId)
        pending.resolve({
          ok: false,
          error: `Isolated execution lockdown failed for capability "${data.key ?? 'unknown'}". Execution aborted for safety.`,
        })
      }
      return
    }
    if (!pending) {
      return
    }

    if (data.type === 'proxy_req' && data.proxyId && data.cap) {
      void this.handleProxyRequest(
        data.reqId,
        data.proxyId,
        data.cap,
        data.payload ?? {},
        pending,
      )
      return
    }

    if (data.type === 'result') {
      if (typeof data.json !== 'string') {
        pending.resolve({ ok: false, error: 'not serializable' })
        return
      }
      pending.resolve({ ok: true, json: data.json })
      return
    }

    if (data.type === 'error') {
      pending.resolve({
        ok: false,
        error: data.message ?? 'Isolated execution failed.',
        stack: data.stack,
      })
    }
  }

  private sendProxyResponse(
    reqId: string,
    proxyId: string,
    value: unknown,
    error?: string,
  ): void {
    this.iframe?.contentWindow?.postMessage(
      {
        channel: SANDBOX_CHANNEL,
        type: 'proxy_res',
        reqId,
        proxyId,
        value,
        error,
      },
      '*',
    )
  }

  private async handleProxyRequest(
    reqId: string,
    proxyId: string,
    cap: string,
    payload: Record<string, unknown>,
    pending: PendingRun,
  ): Promise<void> {
    const handlers = pending.proxyHandlers
    try {
      if (cap === 'vault_read_text') {
        if (!handlers?.vaultReadText) {
          this.sendProxyResponse(
            reqId,
            proxyId,
            undefined,
            'vault read is not enabled',
          )
          return
        }
        const path = typeof payload.path === 'string' ? payload.path : ''
        const result = await handlers.vaultReadText(path)
        this.sendProxyResponse(reqId, proxyId, result)
        return
      }

      if (cap === 'vault_read_binary') {
        if (!handlers?.vaultReadBinary) {
          this.sendProxyResponse(
            reqId,
            proxyId,
            undefined,
            'vault read is not enabled',
          )
          return
        }
        const path = typeof payload.path === 'string' ? payload.path : ''
        const result = await handlers.vaultReadBinary(path)
        this.sendProxyResponse(reqId, proxyId, result)
        return
      }

      if (cap === 'host_fetch') {
        if (!handlers?.hostFetch) {
          this.sendProxyResponse(
            reqId,
            proxyId,
            undefined,
            '$fetch is not enabled',
          )
          return
        }
        const quota = pending.fetchQuota
        if (quota) {
          if (quota.activeCount >= quota.maxConcurrent) {
            this.sendProxyResponse(
              reqId,
              proxyId,
              undefined,
              '$fetch concurrent limit exceeded',
            )
            return
          }
          quota.activeCount++
        }
        try {
          const url = typeof payload.url === 'string' ? payload.url : ''
          const init =
            payload.init && typeof payload.init === 'object'
              ? (payload.init as Record<string, unknown>)
              : undefined
          const result = await handlers.hostFetch(url, init)
          if (quota) {
            quota.totalBytes += result.byteLength
            if (quota.totalBytes > quota.maxResponseKb * 1024) {
              this.sendProxyResponse(
                reqId,
                proxyId,
                undefined,
                '$fetch response size limit exceeded',
              )
              return
            }
          }
          this.sendProxyResponse(reqId, proxyId, result)
        } finally {
          if (quota) {
            quota.activeCount--
          }
        }
        return
      }

      if (cap === 'db_query') {
        if (!handlers?.dbQuery) {
          this.sendProxyResponse(
            reqId,
            proxyId,
            undefined,
            '$db is not enabled',
          )
          return
        }
        const method = payload.method as 'search' | 'find' | 'get'
        const result = await handlers.dbQuery(method, payload)
        this.sendProxyResponse(reqId, proxyId, result)
        return
      }

      this.sendProxyResponse(
        reqId,
        proxyId,
        undefined,
        `unknown capability: ${cap}`,
      )
    } catch (error) {
      this.sendProxyResponse(
        reqId,
        proxyId,
        undefined,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private cancelRun(reqId: string): void {
    this.iframe?.contentWindow?.postMessage(
      {
        channel: SANDBOX_CHANNEL,
        type: 'cancel',
        reqId,
      },
      '*',
    )
  }
}

function getJsSandboxCspPolicy(vars: JsSandboxVariables): JsSandboxCspPolicy {
  return {
    allowFetch: Boolean(vars._caps?.allowFetch),
    allowExternalScripts: Boolean(vars._caps?.allowExternalScripts),
  }
}

function getJsSandboxCspKey(policy: JsSandboxCspPolicy): string {
  return [
    policy.allowFetch ? 'fetch' : 'no-fetch',
    policy.allowExternalScripts ? 'scripts' : 'no-scripts',
  ].join('|')
}

function buildSandboxHtml(policy: JsSandboxCspPolicy): string {
  const script = JS_SANDBOX_IFRAME_SCRIPT.replace(/<\/script/gi, '<\\/script')
  // CSP: 'unsafe-eval' is required — this tool's whole purpose is to evaluate
  // LLM-generated JavaScript via `new AsyncFunction(...)` inside the Worker.
  // The Worker inherits the iframe's CSP, so without `'unsafe-eval'`
  // every run errors with "Refused to evaluate a string as JavaScript".
  //
  // Rebuild the iframe when an Agent's enabled capabilities need a different
  // CSP. The default policy stays locked down; network and remote script
  // sources are opened only for agents that explicitly opted in.
  const allowNetwork = policy.allowFetch || policy.allowExternalScripts
  const scriptSrc = policy.allowExternalScripts
    ? "'unsafe-inline' 'unsafe-eval' blob: https: http:"
    : "'unsafe-inline' 'unsafe-eval' blob:"
  const workerSrc = policy.allowExternalScripts ? 'blob: https: http:' : 'blob:'
  const connectSrc = allowNetwork ? '* blob: data:' : "'none'"
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scriptSrc}; worker-src ${workerSrc}; child-src ${workerSrc}; connect-src ${connectSrc};">`
  return `<!doctype html><html><head><meta charset="utf-8">${csp}</head><body><script>${script}</script></body></html>`
}

function createRequestId(): string {
  return `js_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`
}

function createAbortError(): Error {
  const error = new Error('Tool call aborted.')
  error.name = 'AbortError'
  return error
}

function getByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length
  }
  return value.length
}

function getVaultBasePath(app: App): string | undefined {
  const adapter = app.vault.adapter
  if (adapter instanceof FileSystemAdapter) {
    return adapter.getBasePath()
  }
  const maybeAdapter = adapter as { basePath?: unknown; getBasePath?: unknown }
  if (typeof maybeAdapter.getBasePath === 'function') {
    const value = maybeAdapter.getBasePath()
    return typeof value === 'string' ? value : undefined
  }
  return typeof maybeAdapter.basePath === 'string'
    ? maybeAdapter.basePath
    : undefined
}

async function readFileText(app: App, file: TFile): Promise<string | null> {
  try {
    const vault = app.vault as {
      cachedRead?: (file: TFile) => Promise<string>
      read: (file: TFile) => Promise<string>
    }
    return vault.cachedRead
      ? await vault.cachedRead(file)
      : await vault.read(file)
  } catch {
    return null
  }
}

function getActiveMarkdownSelection(app: App, file: TFile): string | null {
  const view =
    app.workspace
      .getLeavesOfType('markdown')
      .map((leaf) => (leaf.view instanceof MarkdownView ? leaf.view : null))
      .find((candidate): candidate is MarkdownView => {
        return candidate?.file?.path === file.path
      }) ?? null
  const selection = view?.editor?.getSelection?.()
  return selection && selection.length > 0 ? selection : null
}

function sanitizeFrontmatter(
  frontmatter: Record<string, unknown> | null | undefined,
): JsonRecord {
  if (!frontmatter) {
    return {}
  }
  const sanitized: JsonRecord = {}
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === 'position') {
      continue
    }
    sanitized[key] = value
  }
  return deepCloneJson(sanitized)
}

function collectTags(
  inlineTags:
    | Array<{
        tag?: string
      }>
    | undefined,
  frontmatter: JsonRecord,
): string[] {
  const tags = new Set<string>()
  for (const item of inlineTags ?? []) {
    addTag(tags, item.tag)
  }
  addFrontmatterTags(tags, frontmatter.tags)
  addFrontmatterTags(tags, frontmatter.tag)
  return [...tags].sort((a, b) => a.localeCompare(b))
}

function addFrontmatterTags(tags: Set<string>, value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach((item) => addTag(tags, item))
    return
  }
  if (typeof value === 'string') {
    value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => addTag(tags, item))
  }
}

function addTag(tags: Set<string>, value: unknown): void {
  if (typeof value !== 'string') {
    return
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return
  }
  tags.add(trimmed.startsWith('#') ? trimmed : `#${trimmed}`)
}

function deepCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
