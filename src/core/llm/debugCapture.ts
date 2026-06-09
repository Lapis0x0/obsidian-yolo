/* oxlint-disable no-restricted-globals — transport layer uses global fetch intentionally */
import { Platform } from 'obsidian'

import { ChatModel } from '../../types/chat-model.types'
import { ResponseUsage } from '../../types/llm/response'
import { RequestTransportMode } from '../../types/provider.types'

export type LLMDebugTransportMode =
  | Extract<RequestTransportMode, 'browser' | 'node' | 'obsidian'>
  | 'bedrock'
  | 'mcp'
  | 'web-search'
  | 'unknown'

export type LLMDebugRequestKind =
  | 'streaming'
  | 'non-streaming'
  | 'title-generation'
  | 'embedding'
  | 'unknown'

export type LLMDebugTraceSummary = {
  assistantMessageId?: string
  modelId?: string
  modelName?: string
  providerId?: string
  requestKind: LLMDebugRequestKind
  startedAt: number
  completedAt?: number
  durationMs?: number
  usage?: ResponseUsage
  generationState?: 'streaming' | 'completed' | 'aborted' | 'error'
  errorMessage?: string
  hasToolCalls?: boolean
  toolCallNames?: string[]
}

export type LLMDebugHeaders = Record<string, string>

export type LLMDebugHttpExchange = {
  id: string
  traceId: string
  transportMode: LLMDebugTransportMode
  startedAt: number
  completedAt?: number
  request: {
    url: string
    method: string
    headers: LLMDebugHeaders
    body?: string
  }
  response?: {
    status: number
    statusText: string
    headers: LLMDebugHeaders
    body?: string
    contentType?: string
    interrupted?: boolean
  }
  errorMessage?: string
}

export type LLMDebugTrace = {
  id: string
  summary: LLMDebugTraceSummary
  exchanges: LLMDebugHttpExchange[]
}

const traces = new Map<string, LLMDebugTrace>()
const activeTraceCounts = new Map<string, number>()
const activeTraceStack: string[] = []
const turnTraceIds = new Map<string, string[]>()
const conversationTraceIds = new Map<string, string[]>()
const pendingExchangeReads = new Map<string, Promise<void>>()
let traceIdsBySignal = new WeakMap<AbortSignal, string>()
let llmDebugCaptureEnabled = false

const isProbablyIos = (): boolean => {
  return Platform.isIosApp
}

const MAX_BODY_CHARS = isProbablyIos() ? 256 * 1024 : 1024 * 1024
const MAX_TOTAL_TRACE_CHARS = isProbablyIos()
  ? 8 * 1024 * 1024
  : 48 * 1024 * 1024
const MAX_JSON_STRING_CHARS = isProbablyIos() ? 8192 : 32768
const MIN_BASE64_OMIT_CHARS = 128

const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'anthropic-api-key',
  'openai-api-key',
  'x-goog-api-key',
  'x-qwen-api-key',
  'x-stainless-api-key',
  'chatgpt-account-id',
])

const SENSITIVE_JSON_KEY_PATTERN =
  /(?:^|_|-)(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|password|secret|session|cookie)(?:$|_|-)/i

const SENSITIVE_URL_PARAM_PATTERN =
  /^(key|api_key|apikey|access_token|refresh_token|id_token|token|signature|sig)$/i

// Form-urlencoded body params, used by OAuth token / refresh endpoints. Stricter
// than SENSITIVE_JSON_KEY_PATTERN: includes OAuth-specific keys like `code`
// and `client_secret` that we don't want to mass-redact across all JSON bodies.
const SENSITIVE_FORM_PARAM_PATTERN =
  /^(key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|client[_-]?assertion|code|code[_-]?verifier|password|authorization|secret|signature|sig|assertion)$/i

const FORM_URLENCODED_BODY_PATTERN = /^[A-Za-z0-9_\-.~+%&=]+$/

const DATA_URL_BASE64_PATTERN =
  /(data:[^,\s"']+;base64,)([A-Za-z0-9+/_=-]{16,})/gi
const BASE64_PAYLOAD_PATTERN = /^[A-Za-z0-9+/_=-]+$/

const createTraceId = (): string => {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return `llm-debug-${Date.now()}-${random}`
}

const createExchangeId = (): string => {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return `llm-http-${Date.now()}-${random}`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export function setLLMDebugCaptureEnabled(enabled: boolean): void {
  llmDebugCaptureEnabled = enabled
  if (!enabled) {
    activeTraceCounts.clear()
    activeTraceStack.length = 0
    turnTraceIds.clear()
    conversationTraceIds.clear()
    pendingExchangeReads.clear()
    traceIdsBySignal = new WeakMap<AbortSignal, string>()
    traces.clear()
  }
}

export function isLLMDebugCaptureEnabled(): boolean {
  return llmDebugCaptureEnabled
}

export function createLLMDebugTrace({
  assistantMessageId,
  model,
  requestKind,
}: {
  assistantMessageId?: string
  model?: ChatModel
  requestKind?: LLMDebugRequestKind
}): LLMDebugTrace {
  const trace: LLMDebugTrace = {
    id: createTraceId(),
    summary: {
      assistantMessageId,
      modelId: model?.id,
      modelName: model?.name ?? model?.model,
      providerId: model?.providerId,
      requestKind: requestKind ?? 'unknown',
      startedAt: Date.now(),
    },
    exchanges: [],
  }
  traces.set(trace.id, trace)
  enforceMemoryBudget()
  return trace
}

export function updateLLMDebugTrace(
  traceId: string | undefined,
  patch: Partial<LLMDebugTraceSummary>,
): void {
  if (!traceId) {
    return
  }

  const trace = traces.get(traceId)
  if (!trace) {
    return
  }

  trace.summary = {
    ...trace.summary,
    ...patch,
  }
}

function createTurnTraceKey({
  conversationId,
  sourceUserMessageId,
}: {
  conversationId: string
  sourceUserMessageId: string
}): string {
  return `${conversationId}:${sourceUserMessageId}`
}

function appendTraceId(
  map: Map<string, string[]>,
  key: string,
  traceId: string,
): void {
  const existing = map.get(key) ?? []
  if (existing.includes(traceId)) {
    return
  }
  map.set(key, [...existing, traceId])
}

export function registerLLMDebugTraceForTurn({
  conversationId,
  sourceUserMessageId,
  traceId,
}: {
  conversationId: string
  sourceUserMessageId: string
  traceId: string
}): void {
  const key = createTurnTraceKey({ conversationId, sourceUserMessageId })
  appendTraceId(turnTraceIds, key, traceId)
  appendTraceId(conversationTraceIds, conversationId, traceId)
}

export function getLLMDebugTraceIdsForTurn({
  conversationId,
  sourceUserMessageId,
}: {
  conversationId: string
  sourceUserMessageId: string
}): string[] {
  return (
    turnTraceIds.get(
      createTurnTraceKey({ conversationId, sourceUserMessageId }),
    ) ?? []
  )
}

export function getLLMDebugTraceIdsForConversation({
  conversationId,
}: {
  conversationId: string
}): string[] {
  return conversationTraceIds.get(conversationId) ?? []
}

export function getLLMDebugTrace(traceId: string): LLMDebugTrace | null {
  return traces.get(traceId) ?? null
}

export function getLLMDebugTraces(traceIds: string[]): LLMDebugTrace[] {
  const seen = new Set<string>()
  const result: LLMDebugTrace[] = []
  for (const traceId of traceIds) {
    if (seen.has(traceId)) {
      continue
    }
    seen.add(traceId)
    const trace = getLLMDebugTrace(traceId)
    if (trace) {
      result.push(trace)
    }
  }
  return result
}

export function hasLLMDebugTrace(traceId: string | undefined): boolean {
  return Boolean(traceId && traces.has(traceId))
}

export function bindLLMDebugTraceToSignal(
  traceId: string | undefined,
  signal: AbortSignal | null | undefined,
): void {
  if (!traceId || !signal || !traces.has(traceId)) {
    return
  }
  traceIdsBySignal.set(signal, traceId)
}

export function inheritLLMDebugTraceSignal({
  source,
  target,
}: {
  source: AbortSignal | null | undefined
  target: AbortSignal | null | undefined
}): void {
  if (!target) {
    return
  }

  const traceId = resolveLLMDebugTraceId({ signal: source })
  bindLLMDebugTraceToSignal(traceId ?? undefined, target)
}

export async function runWithLLMDebugTrace<T>(
  traceId: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!traceId || !traces.has(traceId)) {
    return run()
  }

  activeTraceCounts.set(traceId, (activeTraceCounts.get(traceId) ?? 0) + 1)
  activeTraceStack.push(traceId)
  try {
    return await run()
  } finally {
    const stackIndex = activeTraceStack.lastIndexOf(traceId)
    if (stackIndex >= 0) {
      activeTraceStack.splice(stackIndex, 1)
    }
    const nextCount = (activeTraceCounts.get(traceId) ?? 1) - 1
    if (nextCount > 0) {
      activeTraceCounts.set(traceId, nextCount)
    } else {
      activeTraceCounts.delete(traceId)
    }
  }
}

function getUnambiguousActiveTraceId(): string | null {
  const activeTraceIds = getActiveTraceIdsNewestFirst()

  if (activeTraceIds.length !== 1) {
    return null
  }

  return activeTraceIds[0] ?? null
}

function getActiveTraceIdsNewestFirst(): string[] {
  const activeTraceIds: string[] = []
  const seen = new Set<string>()
  for (let index = activeTraceStack.length - 1; index >= 0; index -= 1) {
    const traceId = activeTraceStack[index]
    if (
      !seen.has(traceId) &&
      traces.has(traceId) &&
      (activeTraceCounts.get(traceId) ?? 0) > 0
    ) {
      seen.add(traceId)
      activeTraceIds.push(traceId)
    }
  }

  return activeTraceIds
}

function findActiveTraceIdByKind(
  requestKind: LLMDebugRequestKind,
): string | null {
  const candidates = getActiveTraceIdsNewestFirst().filter((traceId) => {
    const trace = traces.get(traceId)
    return trace?.summary.requestKind === requestKind
  })

  if (candidates.length !== 1) {
    return null
  }

  return candidates[0] ?? null
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { aborted?: unknown }).aborted === 'boolean' &&
    typeof (value as { addEventListener?: unknown }).addEventListener ===
      'function'
  )
}

function getFetchSignal(
  input: RequestInfo | URL,
  init?: RequestInit,
): AbortSignal | undefined {
  if (isAbortSignal(init?.signal)) {
    return init.signal
  }

  const request = input instanceof Request ? input : null
  return isAbortSignal(request?.signal) ? request.signal : undefined
}

function resolveLLMDebugTraceId({
  traceId,
  signal,
}: {
  traceId?: string
  signal?: AbortSignal | null
}): string | null {
  if (traceId && traces.has(traceId)) {
    return traceId
  }

  const signalTraceId = signal ? traceIdsBySignal.get(signal) : undefined
  if (signalTraceId && traces.has(signalTraceId)) {
    return signalTraceId
  }

  // Last-resort support for SDK fetches that do not forward AbortSignal. This
  // is intentionally disabled when more than one trace is active, because the
  // process-wide stack cannot safely distinguish concurrent async requests.
  const activeTraceId = getUnambiguousActiveTraceId()
  return activeTraceId && traces.has(activeTraceId) ? activeTraceId : null
}

function isTitleGenerationDebugRequest(
  request: LLMDebugHttpExchange['request'],
): boolean {
  return /title generator|conversation title|generate a concise conversation title|User first message:/i.test(
    request.body ?? '',
  )
}

function isEmbeddingDebugRequest(
  request: LLMDebugHttpExchange['request'],
): boolean {
  const url = request.url.toLowerCase()
  if (/(^|[/_-])(embeddings?|embed|embd)(?:[/?#_-]|$)/i.test(url)) {
    return true
  }

  const body = request.body ?? ''
  return /embed|embedding|embd/i.test(body) && /"input"\s*:/i.test(body)
}

function resolveLLMDebugTraceIdForRequest(
  request: LLMDebugHttpExchange['request'],
): string | null {
  if (isTitleGenerationDebugRequest(request)) {
    return findActiveTraceIdByKind('title-generation')
  }

  // Embedding requests are only attributed to an explicit embedding-kind trace
  // bound by signal or run context. We deliberately do not fall back to the
  // active conversation trace: background RAG / index maintenance embeddings
  // may overlap with a chat turn and would otherwise leak unrelated vault text
  // into the user's exported debug log.
  if (isEmbeddingDebugRequest(request)) {
    return findActiveTraceIdByKind('embedding')
  }

  return null
}

function truncateDebugText(value: string, maxChars = MAX_BODY_CHARS): string {
  if (value.length <= maxChars) {
    return value
  }

  const headChars = Math.floor(maxChars * 0.65)
  const tailChars = Math.max(0, maxChars - headChars)
  const omittedChars = value.length - maxChars
  return [
    value.slice(0, headChars),
    '',
    `[OMITTED debug capture string: ${omittedChars} chars]`,
    '',
    value.slice(value.length - tailChars),
  ].join('\n')
}

function omittedBase64Placeholder(encodedLength: number): string {
  return `[OMITTED base64 data: ${encodedLength} chars]`
}

function isLikelyBase64Payload(value: string): boolean {
  const normalized = value.trim()
  if (normalized.length < MIN_BASE64_OMIT_CHARS) {
    return false
  }
  if (!BASE64_PAYLOAD_PATTERN.test(normalized)) {
    return false
  }
  return normalized.length % 4 === 0 || /={1,2}$/.test(normalized)
}

function omitBase64InString(value: string): string {
  const withDataUrlsOmitted = value.replace(
    DATA_URL_BASE64_PATTERN,
    (_match, prefix: string, encoded: string) =>
      `${prefix}${omittedBase64Placeholder(encoded.length)}`,
  )

  if (
    withDataUrlsOmitted === value &&
    isLikelyBase64Payload(withDataUrlsOmitted)
  ) {
    return omittedBase64Placeholder(withDataUrlsOmitted.trim().length)
  }

  return withDataUrlsOmitted
}

export function omitBase64DebugData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => omitBase64DebugData(item))
  }

  if (typeof value === 'string') {
    const base64Omitted = omitBase64InString(value)
    if (base64Omitted !== value) {
      return base64Omitted
    }
    if (value.length <= MAX_JSON_STRING_CHARS) {
      return value
    }
    const headChars = Math.floor(MAX_JSON_STRING_CHARS * 0.65)
    const tailChars = MAX_JSON_STRING_CHARS - headChars
    const omittedChars = value.length - MAX_JSON_STRING_CHARS
    return [
      value.slice(0, headChars),
      `[OMITTED long JSON string: ${omittedChars} chars]`,
      value.slice(value.length - tailChars),
    ].join('\n')
  }

  if (!isRecord(value)) {
    return value
  }

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    result[key] = omitBase64DebugData(child)
  }
  return result
}

function redactFormUrlencodedBody(body: string): string | null {
  if (!body.includes('=')) {
    return null
  }
  if (!FORM_URLENCODED_BODY_PATTERN.test(body)) {
    return null
  }
  try {
    const params = new URLSearchParams(body)
    let touched = false
    const redacted = new URLSearchParams()
    for (const [key, value] of params.entries()) {
      if (SENSITIVE_FORM_PARAM_PATTERN.test(key)) {
        redacted.append(key, maskSecret(value))
        touched = true
      } else {
        redacted.append(key, value)
      }
    }
    return touched ? redacted.toString() : body
  } catch {
    return null
  }
}

function prepareBodyForStorage(body: string | undefined): string | undefined {
  if (body === undefined) {
    return undefined
  }

  try {
    const parsed = JSON.parse(body)
    const compacted = JSON.stringify(
      omitBase64DebugData(redactJsonLike(parsed)),
    )
    return truncateDebugText(compacted ?? '')
  } catch {
    const formRedacted = redactFormUrlencodedBody(body)
    if (formRedacted !== null) {
      return truncateDebugText(omitBase64InString(formRedacted))
    }
    return truncateDebugText(omitBase64InString(body))
  }
}

function estimateHeadersChars(headers: LLMDebugHeaders | undefined): number {
  if (!headers) {
    return 0
  }
  return Object.entries(headers).reduce(
    (total, [key, value]) => total + key.length + value.length,
    0,
  )
}

function estimateExchangeChars(exchange: LLMDebugHttpExchange): number {
  return (
    exchange.id.length +
    exchange.traceId.length +
    exchange.transportMode.length +
    exchange.request.url.length +
    exchange.request.method.length +
    estimateHeadersChars(exchange.request.headers) +
    (exchange.request.body?.length ?? 0) +
    (exchange.response?.statusText.length ?? 0) +
    estimateHeadersChars(exchange.response?.headers) +
    (exchange.response?.body?.length ?? 0) +
    (exchange.response?.contentType?.length ?? 0) +
    (exchange.response?.interrupted ? 11 : 0) +
    (exchange.errorMessage?.length ?? 0)
  )
}

function estimateTraceChars(trace: LLMDebugTrace): number {
  return (
    trace.id.length +
    (trace.summary.assistantMessageId?.length ?? 0) +
    (trace.summary.modelId?.length ?? 0) +
    (trace.summary.modelName?.length ?? 0) +
    (trace.summary.providerId?.length ?? 0) +
    (trace.summary.errorMessage?.length ?? 0) +
    (trace.summary.toolCallNames?.join('').length ?? 0) +
    trace.exchanges.reduce(
      (total, exchange) => total + estimateExchangeChars(exchange),
      0,
    )
  )
}

function enforceMemoryBudget(): void {
  let total = 0
  for (const trace of traces.values()) {
    total += estimateTraceChars(trace)
  }

  if (total <= MAX_TOTAL_TRACE_CHARS) {
    return
  }

  const activeTraceIds = new Set(activeTraceCounts.keys())
  for (const [traceId, trace] of traces.entries()) {
    if (total <= MAX_TOTAL_TRACE_CHARS) {
      return
    }
    if (activeTraceIds.has(traceId)) {
      continue
    }
    total -= estimateTraceChars(trace)
    unregisterTraceId(traceId)
    for (const exchange of trace.exchanges) {
      pendingExchangeReads.delete(exchange.id)
    }
    traces.delete(traceId)
  }
}

function unregisterTraceId(traceId: string): void {
  for (const [key, traceIds] of turnTraceIds.entries()) {
    const nextTraceIds = traceIds.filter((id) => id !== traceId)
    if (nextTraceIds.length > 0) {
      turnTraceIds.set(key, nextTraceIds)
    } else {
      turnTraceIds.delete(key)
    }
  }
  for (const [key, traceIds] of conversationTraceIds.entries()) {
    const nextTraceIds = traceIds.filter((id) => id !== traceId)
    if (nextTraceIds.length > 0) {
      conversationTraceIds.set(key, nextTraceIds)
    } else {
      conversationTraceIds.delete(key)
    }
  }
}

function redactedPlaceholder(value?: string): string {
  const trimmed = value?.trim() ?? ''
  if (trimmed.length <= 8) {
    return '[REDACTED ****]'
  }

  const prefixLength = Math.min(6, Math.floor(trimmed.length / 3))
  const suffixLength = Math.min(4, trimmed.length - prefixLength)
  return `[REDACTED ${trimmed.slice(0, prefixLength)}****${trimmed.slice(
    trimmed.length - suffixLength,
  )}]`
}

function maskSecret(value: string): string {
  const trimmed = value.trim()
  return redactedPlaceholder(trimmed)
}

function redactHeaderValue(key: string, value: string): string {
  const lower = key.toLowerCase()
  if (!SENSITIVE_HEADER_KEYS.has(lower)) {
    return value
  }

  const bearerMatch = value.match(/^(Bearer\s+)(.+)$/i)
  if (bearerMatch) {
    return `${bearerMatch[1]}${maskSecret(bearerMatch[2])}`
  }

  return maskSecret(value)
}

function headersToRecord(headers?: HeadersInit | null): LLMDebugHeaders {
  if (!headers) {
    return {}
  }

  const result: LLMDebugHeaders = {}
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = redactHeaderValue(key, value)
    })
    return result
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key] = redactHeaderValue(key, String(value))
    }
    return result
  }

  for (const [key, value] of Object.entries(headers)) {
    result[key] = redactHeaderValue(key, String(value))
  }
  return result
}

function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    const redactedValues: string[] = []
    for (const [key, value] of Array.from(url.searchParams.entries())) {
      if (SENSITIVE_URL_PARAM_PATTERN.test(key)) {
        const redactedValue = maskSecret(value)
        url.searchParams.set(key, redactedValue)
        redactedValues.push(redactedValue)
      }
    }
    let serialized = url.toString()
    for (const redactedValue of redactedValues) {
      serialized = serialized.replace(
        encodeURIComponent(redactedValue).replace(/%20/g, '+'),
        redactedValue,
      )
    }
    return serialized
  } catch {
    return rawUrl
  }
}

async function bodyToDebugString(
  body: BodyInit | null | undefined,
): Promise<string | undefined> {
  if (body == null) {
    return undefined
  }

  if (typeof body === 'string') {
    return body
  }

  if (body instanceof URLSearchParams) {
    return body.toString()
  }

  if (body instanceof Blob) {
    return await body.text()
  }

  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body)
  }

  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    )
  }

  return '[Unsupported request body type]'
}

async function buildDebugRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<LLMDebugHttpExchange['request']> {
  const request = input instanceof Request ? input : null
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : request
          ? request.url
          : ''
  const method = init?.method ?? request?.method ?? 'GET'
  const headers = headersToRecord(init?.headers ?? request?.headers)
  const body =
    typeof init?.body !== 'undefined'
      ? await bodyToDebugString(init.body)
      : request && request.method !== 'GET' && request.method !== 'HEAD'
        ? '[Request body is unavailable without consuming the live request]'
        : undefined

  return {
    url: redactUrl(url),
    method,
    headers,
    body: prepareBodyForStorage(body),
  }
}

function completeExchange(
  exchangeId: string,
  patch: Partial<LLMDebugHttpExchange>,
): void {
  for (const trace of traces.values()) {
    const exchange = trace.exchanges.find((item) => item.id === exchangeId)
    if (exchange) {
      Object.assign(exchange, patch)
      enforceMemoryBudget()
      return
    }
  }
}

function unknownToDebugBody(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value === 'string') {
    return prepareBodyForStorage(value)
  }
  try {
    const compacted = JSON.stringify(omitBase64DebugData(redactJsonLike(value)))
    return truncateDebugText(compacted ?? '')
  } catch {
    if (value === null) {
      return 'null'
    }
    if (typeof value === 'object' || typeof value === 'function') {
      return '[Unserializable debug value]'
    }
    if (typeof value === 'symbol') {
      return prepareBodyForStorage(
        value.description ? `Symbol(${value.description})` : 'Symbol()',
      )
    }
    if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return prepareBodyForStorage(value.toString())
    }
    return '[Unserializable debug value]'
  }
}

function wrapDebugCaptureError(action: string, error: unknown): Error {
  const wrapped = new Error(
    `LLM debug capture failed while ${action}.`,
  ) as Error & {
    cause?: unknown
  }
  wrapped.cause = error
  return wrapped
}

async function readResponseBodyForDebug(response: Response): Promise<{
  body?: string
  errorMessage?: string
  interrupted?: boolean
}> {
  if (!response.body) {
    try {
      return {
        body: prepareBodyForStorage(await response.text()),
      }
    } catch (error) {
      return {
        interrupted: true,
        errorMessage: error instanceof Error ? error.message : String(error),
      }
    }
  }

  if (typeof response.body.getReader !== 'function') {
    try {
      return {
        body: prepareBodyForStorage(await response.text()),
      }
    } catch (error) {
      return {
        interrupted: true,
        errorMessage: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let body = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        body += decoder.decode()
        return {
          body: prepareBodyForStorage(body),
        }
      }
      body += decoder.decode(value, { stream: true })
    }
  } catch (error) {
    body += decoder.decode()
    return {
      body: prepareBodyForStorage(body),
      interrupted: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    }
  } finally {
    reader.releaseLock()
  }
}

export async function captureLLMDebugOperation<T>({
  traceId: explicitTraceId,
  signal,
  transportMode,
  url,
  method = 'POST',
  requestHeaders,
  requestBody,
  responseContentType,
  run,
  getResponseBody,
  getResponseHeaders,
  getResponseStatus,
  getResponseStatusText,
}: {
  traceId?: string
  signal?: AbortSignal | null
  transportMode: LLMDebugTransportMode
  url: string
  method?: string
  requestHeaders?: HeadersInit | null
  requestBody?: unknown
  responseContentType?: string
  run: () => Promise<T>
  getResponseBody?: (result: T) => unknown
  getResponseHeaders?: (result: T) => LLMDebugHeaders | HeadersInit | undefined
  getResponseStatus?: (result: T) => number | undefined
  getResponseStatusText?: (result: T) => string | undefined
}): Promise<T> {
  const traceId = resolveLLMDebugTraceId({
    traceId: explicitTraceId,
    signal,
  })
  if (!llmDebugCaptureEnabled || !traceId) {
    return run()
  }

  const trace = traces.get(traceId)
  if (!trace) {
    return run()
  }

  const exchangeId = createExchangeId()
  let requestBodyForDebug: string | undefined
  try {
    requestBodyForDebug = unknownToDebugBody(requestBody)
  } catch (error) {
    throw wrapDebugCaptureError('serializing request body', error)
  }

  const exchange: LLMDebugHttpExchange = {
    id: exchangeId,
    traceId,
    transportMode,
    startedAt: Date.now(),
    request: {
      url: redactUrl(url),
      method,
      headers: headersToRecord(requestHeaders),
      body: requestBodyForDebug,
    },
  }
  trace.exchanges.push(exchange)
  enforceMemoryBudget()

  try {
    const result = await run()
    const responseHeaders = getResponseHeaders?.(result)
    let responseBodyForDebug: string | undefined
    try {
      responseBodyForDebug = unknownToDebugBody(
        getResponseBody ? getResponseBody(result) : result,
      )
    } catch (error) {
      throw wrapDebugCaptureError('serializing response body', error)
    }
    completeExchange(exchangeId, {
      completedAt: Date.now(),
      response: {
        status: getResponseStatus?.(result) ?? 200,
        statusText: getResponseStatusText?.(result) ?? 'OK',
        headers: responseHeaders
          ? headersToRecord(responseHeaders as HeadersInit)
          : {},
        contentType: responseContentType,
        body: responseBodyForDebug,
      },
    })
    return result
  } catch (error) {
    completeExchange(exchangeId, {
      completedAt: Date.now(),
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

export function createLLMDebugFetch(
  baseFetch: typeof fetch,
  transportMode: LLMDebugTransportMode,
): typeof fetch {
  return async (input, init) => {
    let traceId = resolveLLMDebugTraceId({
      signal: getFetchSignal(input, init),
    })
    let debugRequest: LLMDebugHttpExchange['request'] | null = null
    if (llmDebugCaptureEnabled && !traceId) {
      try {
        debugRequest = await buildDebugRequest(input, init)
      } catch (error) {
        throw wrapDebugCaptureError('reading request body', error)
      }
      traceId = resolveLLMDebugTraceIdForRequest(debugRequest)
    }

    if (!llmDebugCaptureEnabled || !traceId) {
      return baseFetch(input, init)
    }

    const trace = traces.get(traceId)
    if (!trace) {
      return baseFetch(input, init)
    }

    const exchangeId = createExchangeId()
    const exchange: LLMDebugHttpExchange = {
      id: exchangeId,
      traceId,
      transportMode,
      startedAt: Date.now(),
      request:
        debugRequest ??
        (await buildDebugRequest(input, init).catch((error) => {
          throw wrapDebugCaptureError('reading request body', error)
        })),
    }
    trace.exchanges.push(exchange)
    enforceMemoryBudget()

    try {
      const response = await baseFetch(input, init)
      const cloned = response.clone()
      const contentType = cloned.headers.get('content-type') ?? undefined
      completeExchange(exchangeId, {
        completedAt: Date.now(),
        response: {
          status: response.status,
          statusText: response.statusText,
          headers: headersToRecord(response.headers),
          contentType,
        },
      })

      const bodyReadPromise = readResponseBodyForDebug(cloned)
        .then((bodyResult) => {
          completeExchange(exchangeId, {
            response: {
              status: response.status,
              statusText: response.statusText,
              headers: headersToRecord(response.headers),
              contentType,
              body: bodyResult.body,
              interrupted: bodyResult.interrupted,
            },
            ...(bodyResult.errorMessage
              ? { errorMessage: bodyResult.errorMessage }
              : {}),
          })
        })
        .catch((error) => {
          completeExchange(exchangeId, {
            errorMessage:
              error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => {
          pendingExchangeReads.delete(exchangeId)
        })

      pendingExchangeReads.set(exchangeId, bodyReadPromise)
      void bodyReadPromise

      return response
    } catch (error) {
      completeExchange(exchangeId, {
        completedAt: Date.now(),
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}

export async function flushLLMDebugTraceReads(
  traceIds: string[],
): Promise<void> {
  const pendingReads: Promise<void>[] = []
  const seenExchangeIds = new Set<string>()

  for (const traceId of traceIds) {
    const trace = traces.get(traceId)
    if (!trace) {
      continue
    }
    for (const exchange of trace.exchanges) {
      if (seenExchangeIds.has(exchange.id)) {
        continue
      }
      seenExchangeIds.add(exchange.id)
      const pendingRead = pendingExchangeReads.get(exchange.id)
      if (pendingRead) {
        pendingReads.push(pendingRead)
      }
    }
  }

  if (pendingReads.length > 0) {
    await Promise.allSettled(pendingReads)
  }
}

export function redactJsonLike(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonLike(item))
  }

  if (!isRecord(value)) {
    return value
  }

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_JSON_KEY_PATTERN.test(key)) {
      result[key] =
        typeof child === 'string' ? maskSecret(child) : redactedPlaceholder()
    } else {
      result[key] = redactJsonLike(child)
    }
  }
  return result
}
