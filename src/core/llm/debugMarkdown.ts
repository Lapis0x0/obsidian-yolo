import {
  LLMDebugHttpExchange,
  LLMDebugTrace,
  getLinkedLLMDebugTraceIds,
  omitBase64DebugData,
  redactJsonLike,
} from './debugCapture'

const JSON_CODE_FENCE = '```json'
const TEXT_CODE_FENCE = '```text'
const COST_KEY_PATTERN = /cost|price|fee|spend|spent|charge|billing/i
const EMBEDDING_TEXT_EDGE_CHARS = 100
const EMBEDDING_ARRAY_EDGE_ITEMS = 12

type CostEntry = {
  label: string
  amount?: number
  isTotalAmount: boolean
}

function formatUsage(usage: LLMDebugTrace['summary']['usage']): string {
  if (!usage) {
    return 'unknown'
  }

  const parts = [
    `input ${usage.prompt_tokens}`,
    `output ${usage.completion_tokens}`,
    `total ${usage.total_tokens}`,
  ]

  if (usage.cache_read_input_tokens) {
    parts.push(`cache read ${usage.cache_read_input_tokens}`)
  }
  if (usage.cache_creation_input_tokens) {
    parts.push(`cache write ${usage.cache_creation_input_tokens}`)
  }

  return parts.join(', ')
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

function formatLocalDateTime(timestamp: number | undefined): string {
  if (typeof timestamp !== 'number') {
    return 'unknown'
  }
  return new Date(timestamp).toLocaleString()
}

function formatDurationMs(durationMs: number | undefined): string {
  if (typeof durationMs !== 'number') {
    return 'unknown'
  }
  return `${(durationMs / 1000).toFixed(1)}s`
}

function hasToolCalls(trace: LLMDebugTrace): boolean {
  if (trace.summary.hasToolCalls) {
    return true
  }
  return trace.exchanges.some((exchange) => {
    const body = `${exchange.request.body ?? ''}\n${exchange.response?.body ?? ''}`
    return /tool_calls|tool_use|functionCall|function_call|toolUse/i.test(body)
  })
}

function formatTitleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function formatGenerationState(
  state: LLMDebugTrace['summary']['generationState'],
): string {
  return state ? formatTitleCase(state) : 'unknown'
}

type JsonParseResult =
  | {
      ok: true
      value: unknown
    }
  | {
      ok: false
    }

function tryParseJson(raw: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false }
  }
}

function codeBlock(content: string, language: 'json' | 'text'): string {
  const fence = language === 'json' ? JSON_CODE_FENCE : TEXT_CODE_FENCE
  return `${fence}\n${content.replace(/```/g, '`\\`\\`')}\n\`\`\``
}

function isProbablyStreamingBody(
  body: string | undefined,
  contentType: string | undefined,
): boolean {
  if (!body) {
    return false
  }
  return (
    contentType?.toLowerCase().includes('text/event-stream') === true ||
    /^data:\s*/m.test(body)
  )
}

function compactJson(value: unknown): string {
  return JSON.stringify(omitBase64DebugData(redactJsonLike(value))) ?? ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getJsonCandidates(raw: string | undefined): unknown[] {
  if (!raw) {
    return []
  }

  const candidates: unknown[] = []
  const parsed = tryParseJson(raw)
  if (parsed.ok) {
    candidates.push(parsed.value)
  }

  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim()
    const dataMatch = trimmed.match(/^data:\s*(.*)$/)
    const payload = dataMatch ? dataMatch[1].trim() : trimmed
    if (!payload || payload === '[DONE]') {
      return
    }
    const lineParsed = tryParseJson(payload)
    if (lineParsed.ok) {
      candidates.push(lineParsed.value)
    }
  })

  return candidates
}

function normalizeCostKey(key: string): string {
  return key.replace(/[\s_-]/g, '').toLowerCase()
}

function formatCostValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Math.abs(value) > 0 && Math.abs(value) < 0.01) {
      return value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
    }
    return String(value)
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim()
  }
  return null
}

function parseCostAmount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value !== 'string') {
    return undefined
  }

  const match = value.trim().match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/i)
  if (!match) {
    return undefined
  }
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : undefined
}

function formatCostAmount(value: number): string {
  if (Math.abs(value) > 0 && Math.abs(value) < 0.01) {
    return value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
  }
  return String(Number(value.toPrecision(12)))
}

function collectCostEntriesFromValue(
  value: unknown,
  path: string[] = [],
  entries: CostEntry[] = [],
): CostEntry[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectCostEntriesFromValue(item, [...path, String(index)], entries),
    )
    return entries
  }

  if (!isRecord(value)) {
    return entries
  }

  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key]
    const normalizedKey = normalizeCostKey(key)
    const inCostContext = path.some((part) =>
      COST_KEY_PATTERN.test(normalizeCostKey(part)),
    )
    const costValue =
      COST_KEY_PATTERN.test(normalizedKey) || inCostContext
        ? formatCostValue(child)
        : null
    if (costValue !== null) {
      entries.push({
        label: `${nextPath.join('.')}: ${costValue}`,
        amount: parseCostAmount(child),
        isTotalAmount:
          /total/i.test(normalizedKey) ||
          normalizedKey === 'cost' ||
          normalizedKey === 'amount' ||
          /totalcost|costtotal/i.test(nextPath.map(normalizeCostKey).join('.')),
      })
      continue
    }
    collectCostEntriesFromValue(child, nextPath, entries)
  }

  return entries
}

function selectCostAmount(entries: CostEntry[]): number | undefined {
  const numericEntries = entries.filter(
    (entry): entry is CostEntry & { amount: number } =>
      typeof entry.amount === 'number',
  )
  if (numericEntries.length === 0) {
    return undefined
  }

  const totalEntries = numericEntries.filter((entry) => entry.isTotalAmount)
  return (totalEntries.length > 0 ? totalEntries : numericEntries).reduce(
    (total, entry) => total + entry.amount,
    0,
  )
}

type ExtractedCosts = {
  entries: string[]
  sourceCount: number
  totalAmount?: number
}

function collectCostsFromBody(body: string | undefined): ExtractedCosts {
  const seen = new Set<string>()
  const costs: string[] = []
  let totalAmount: number | undefined
  for (const candidate of getJsonCandidates(body)) {
    const candidateEntries = collectCostEntriesFromValue(candidate)
    const candidateAmount = selectCostAmount(candidateEntries)
    if (typeof candidateAmount === 'number') {
      totalAmount = candidateAmount
    }
    for (const entry of candidateEntries) {
      if (!seen.has(entry.label)) {
        seen.add(entry.label)
        costs.push(entry.label)
      }
    }
  }
  return {
    entries: costs,
    sourceCount: costs.length > 0 ? 1 : 0,
    ...(typeof totalAmount === 'number' ? { totalAmount } : {}),
  }
}

function collectTraceCosts(
  trace: LLMDebugTrace,
  exchanges: LLMDebugHttpExchange[] = trace.exchanges,
): ExtractedCosts {
  const seen = new Set<string>()
  const costs: string[] = []
  let sourceCount = 0
  let totalAmount = 0
  let hasAmount = false

  for (const exchange of exchanges) {
    const attemptCosts = collectCostsFromBody(exchange.response?.body)
    if (attemptCosts.entries.length > 0) {
      sourceCount += 1
    }
    if (typeof attemptCosts.totalAmount === 'number') {
      totalAmount += attemptCosts.totalAmount
      hasAmount = true
    }
    for (const entry of attemptCosts.entries) {
      if (!seen.has(entry)) {
        seen.add(entry)
        costs.push(entry)
      }
    }
  }

  return {
    entries: costs,
    sourceCount,
    ...(hasAmount ? { totalAmount } : {}),
  }
}

function formatCostSummary(
  costs: ExtractedCosts,
  sourceSingular: string,
): string {
  if (costs.entries.length === 0) {
    return `not found (from ${pluralize(0, sourceSingular)})`
  }
  const sourceText = pluralize(costs.sourceCount, sourceSingular)
  if (typeof costs.totalAmount === 'number') {
    return `${formatCostAmount(costs.totalAmount)} (from ${sourceText})`
  }
  return `found but not numeric (from ${sourceText})`
}

function numberFromRecord(
  record: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }
  return undefined
}

function collectUsageRecords(value: unknown, records: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectUsageRecords(item, records))
    return records
  }

  if (!isRecord(value)) {
    return records
  }

  const prompt =
    numberFromRecord(value, ['prompt_tokens', 'input_tokens']) ??
    (isRecord(value.usage)
      ? numberFromRecord(value.usage, ['prompt_tokens', 'input_tokens'])
      : undefined)
  const completion =
    numberFromRecord(value, ['completion_tokens', 'output_tokens']) ??
    (isRecord(value.usage)
      ? numberFromRecord(value.usage, ['completion_tokens', 'output_tokens'])
      : undefined)
  const total =
    numberFromRecord(value, ['total_tokens']) ??
    (isRecord(value.usage)
      ? numberFromRecord(value.usage, ['total_tokens'])
      : undefined)

  if (
    typeof prompt === 'number' ||
    typeof completion === 'number' ||
    typeof total === 'number'
  ) {
    records.push(
      [
        typeof prompt === 'number' ? `input ${prompt}` : null,
        typeof completion === 'number' ? `output ${completion}` : null,
        typeof total === 'number' ? `total ${total}` : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(', '),
    )
  }

  for (const child of Object.values(value)) {
    collectUsageRecords(child, records)
  }

  return records
}

function collectUsageFromBody(body: string | undefined): string | null {
  const seen = new Set<string>()
  const usages: string[] = []
  for (const candidate of getJsonCandidates(body)) {
    for (const usage of collectUsageRecords(candidate)) {
      if (!seen.has(usage)) {
        seen.add(usage)
        usages.push(usage)
      }
    }
  }
  return usages.at(-1) ?? null
}

type ExtractedStreamingStrings = {
  content: string[]
  reasoning: string[]
  contentFallback: string[]
  reasoningFallback: string[]
  toolCalls: string[]
  toolCallDeltas: Map<string, ExtractedToolCallDraft>
  toolCallFallback: string[]
}

type ExtractedToolCallDraft = {
  name?: string
  argumentsText: string
}

function createExtractedStreamingStrings(): ExtractedStreamingStrings {
  return {
    content: [],
    reasoning: [],
    contentFallback: [],
    reasoningFallback: [],
    toolCalls: [],
    toolCallDeltas: new Map(),
    toolCallFallback: [],
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

function formatToolCallNameAndArguments({
  name,
  argumentsText,
}: {
  name?: string
  argumentsText?: string
}): string | null {
  const parts: string[] = []
  if (name?.trim()) {
    parts.push(`name: ${name.trim()}`)
  }
  if (argumentsText?.trim()) {
    parts.push(`arguments: ${argumentsText.trim()}`)
  }
  return parts.length > 0 ? parts.join('\n') : null
}

function getToolCallDraftKey(
  value: Record<string, unknown>,
  path: string[] = [],
): string {
  const candidateKeys = [
    value.id,
    value.item_id,
    value.call_id,
    value.index,
    value.output_index,
  ]
  for (const key of candidateKeys) {
    if (typeof key === 'string' || typeof key === 'number') {
      return String(key)
    }
  }
  return path.length > 0 ? path.join('.') : 'tool-call'
}

function updateToolCallDraft(
  result: ExtractedStreamingStrings,
  key: string,
  {
    name,
    argumentsDelta,
  }: {
    name?: string
    argumentsDelta?: string
  },
): void {
  const existing = result.toolCallDeltas.get(key) ?? { argumentsText: '' }
  result.toolCallDeltas.set(key, {
    name: name ?? existing.name,
    argumentsText: `${existing.argumentsText}${argumentsDelta ?? ''}`,
  })
}

function fillToolCallDraftArguments(
  result: ExtractedStreamingStrings,
  key: string,
  argumentsText: string,
): void {
  const existing = result.toolCallDeltas.get(key) ?? { argumentsText: '' }
  result.toolCallDeltas.set(key, {
    ...existing,
    argumentsText: existing.argumentsText || argumentsText,
  })
}

function collectToolCallDelta(
  value: Record<string, unknown>,
  result: ExtractedStreamingStrings,
  path: string[] = [],
): boolean {
  const fn = isRecord(value.function) ? value.function : value
  const name = typeof fn.name === 'string' ? fn.name : undefined
  const argumentsText =
    typeof fn.arguments === 'string'
      ? fn.arguments
      : typeof value.arguments === 'string'
        ? value.arguments
        : undefined

  if (!name && !argumentsText) {
    return false
  }

  updateToolCallDraft(result, getToolCallDraftKey(value, path), {
    name,
    argumentsDelta: argumentsText,
  })
  return true
}

function collectToolCallSnapshot(
  value: Record<string, unknown>,
  result: ExtractedStreamingStrings,
  target: 'toolCalls' | 'toolCallFallback',
): void {
  if (value.type === 'function_call') {
    const formatted = formatToolCallNameAndArguments({
      name: typeof value.name === 'string' ? value.name : undefined,
      argumentsText:
        typeof value.arguments === 'string' ? value.arguments : undefined,
    })
    if (formatted) {
      result[target].push(formatted)
    }
    return
  }

  const fn = value.function
  if (!isRecord(fn)) {
    return
  }

  const formatted = formatToolCallNameAndArguments({
    name: typeof fn.name === 'string' ? fn.name : undefined,
    argumentsText: typeof fn.arguments === 'string' ? fn.arguments : undefined,
  })
  if (formatted) {
    result[target].push(formatted)
  }
}

function collectResponsesOutputItemSnapshot(
  item: Record<string, unknown>,
  result: ExtractedStreamingStrings,
): void {
  if (item.type === 'function_call') {
    collectToolCallSnapshot(item, result, 'toolCallFallback')
    return
  }

  if (item.type === 'reasoning' && Array.isArray(item.summary)) {
    for (const summary of item.summary) {
      if (isRecord(summary) && typeof summary.text === 'string') {
        result.reasoningFallback.push(summary.text)
      }
    }
    return
  }

  if (!Array.isArray(item.content)) {
    return
  }

  for (const part of item.content) {
    if (!isRecord(part)) {
      continue
    }
    if (
      (part.type === 'output_text' || part.type === 'refusal') &&
      typeof part.text === 'string'
    ) {
      result.contentFallback.push(part.text)
    }
  }
}

function collectResponsesSnapshot(
  response: Record<string, unknown>,
  result: ExtractedStreamingStrings,
): void {
  if (!Array.isArray(response.output)) {
    return
  }

  for (const item of response.output) {
    if (isRecord(item)) {
      collectResponsesOutputItemSnapshot(item, result)
    }
  }
}

function collectKnownStreamingEventDelta(
  value: Record<string, unknown>,
  result: ExtractedStreamingStrings,
): boolean {
  const eventType = typeof value.type === 'string' ? value.type : ''
  if (!eventType.startsWith('response.')) {
    return false
  }

  const delta = value.delta

  if (
    typeof delta === 'string' &&
    delta.length > 0 &&
    (eventType === 'response.output_text.delta' ||
      eventType === 'response.refusal.delta')
  ) {
    result.content.push(delta)
    return true
  }

  if (
    typeof delta === 'string' &&
    delta.length > 0 &&
    (eventType === 'response.reasoning.delta' ||
      eventType === 'response.reasoning_text.delta' ||
      eventType === 'response.reasoning_summary_text.delta')
  ) {
    result.reasoning.push(delta)
    return true
  }

  if (eventType === 'response.output_text.done') {
    if (typeof value.text === 'string') {
      result.contentFallback.push(value.text)
    }
    return true
  }

  if (eventType === 'response.reasoning_summary_text.done') {
    if (typeof value.text === 'string') {
      result.reasoningFallback.push(value.text)
    }
    return true
  }

  if (eventType === 'response.output_item.done' && isRecord(value.item)) {
    collectResponsesOutputItemSnapshot(value.item, result)
    return true
  }

  if (eventType === 'response.output_item.added' && isRecord(value.item)) {
    collectToolCallDelta(value.item, result, ['response.output_item.added'])
    return true
  }

  if (
    eventType === 'response.function_call_arguments.delta' &&
    typeof delta === 'string' &&
    delta.length > 0
  ) {
    updateToolCallDraft(result, getToolCallDraftKey(value), {
      argumentsDelta: delta,
    })
    return true
  }

  if (
    eventType === 'response.function_call_arguments.done' &&
    typeof value.arguments === 'string'
  ) {
    fillToolCallDraftArguments(
      result,
      getToolCallDraftKey(value),
      value.arguments,
    )
    return true
  }

  if (
    (eventType === 'response.completed' ||
      eventType === 'response.incomplete') &&
    isRecord(value.response)
  ) {
    collectResponsesSnapshot(value.response, result)
    return true
  }

  return true
}

function collectStringAtPaths(
  value: unknown,
  path: string[] = [],
  result: ExtractedStreamingStrings = createExtractedStreamingStrings(),
): ExtractedStreamingStrings {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectStringAtPaths(item, [...path, String(index)], result),
    )
    return result
  }

  if (!isRecord(value)) {
    return result
  }

  if (collectKnownStreamingEventDelta(value, result)) {
    return result
  }

  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key]
    if (key === 'tool_calls' && Array.isArray(child)) {
      child.forEach((toolCall, index) => {
        if (isRecord(toolCall)) {
          collectToolCallDelta(toolCall, result, [...nextPath, String(index)])
          collectToolCallSnapshot(toolCall, result, 'toolCalls')
        }
      })
      continue
    }
    if (typeof child === 'string' && child.length > 0) {
      const parent = path.at(-1)
      if (
        key === 'content' ||
        key === 'text' ||
        key === 'output_text' ||
        (key === 'delta' && parent === 'text_delta')
      ) {
        result.content.push(child)
      } else if (
        key === 'reasoning' ||
        key === 'thinking' ||
        key === 'reasoning_content'
      ) {
        result.reasoning.push(child)
      }
      continue
    }
    collectStringAtPaths(child, nextPath, result)
  }

  return result
}

function extractStreamingReadableParts(body: string | undefined): {
  content: string
  reasoning: string
  toolCalls: string
} | null {
  const candidates = getJsonCandidates(body)
  if (candidates.length === 0) {
    return null
  }

  const extracted = createExtractedStreamingStrings()
  for (const candidate of candidates) {
    collectStringAtPaths(candidate, [], extracted)
  }

  const deltaToolCalls = Array.from(extracted.toolCallDeltas.values())
    .map((toolCall) => formatToolCallNameAndArguments(toolCall))
    .filter((toolCall): toolCall is string => Boolean(toolCall))
  const joinedContent =
    extracted.content.length > 0
      ? extracted.content.join('')
      : extracted.contentFallback.join('')
  const joinedReasoning =
    extracted.reasoning.length > 0
      ? extracted.reasoning.join('')
      : extracted.reasoningFallback.join('\n\n')
  const joinedToolCalls =
    deltaToolCalls.length > 0
      ? deltaToolCalls.join('\n\n')
      : extracted.toolCalls.length > 0
        ? extracted.toolCalls.join('\n\n')
        : extracted.toolCallFallback.join('\n\n')
  if (!joinedContent && !joinedReasoning && !joinedToolCalls) {
    return null
  }

  return {
    content: joinedContent,
    reasoning: joinedReasoning,
    toolCalls: joinedToolCalls,
  }
}

function getRequestRecord(
  exchange: LLMDebugHttpExchange,
): Record<string, unknown> | null {
  if (!exchange.request.body) {
    return null
  }
  const parsed = tryParseJson(exchange.request.body)
  return parsed.ok && isRecord(parsed.value) ? parsed.value : null
}

function abbreviateEmbeddingText(text: string): string {
  if (text.length <= EMBEDDING_TEXT_EDGE_CHARS * 2) {
    return text
  }

  const omittedChars = text.length - EMBEDDING_TEXT_EDGE_CHARS * 2
  return `${text.slice(0, EMBEDDING_TEXT_EDGE_CHARS)}[OMITTED embedding input string: ${omittedChars} chars]${text.slice(-EMBEDDING_TEXT_EDGE_CHARS)}`
}

function formatEmbeddingArrayEdge(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Number(value.toPrecision(6)))
  }
  if (typeof value === 'string') {
    return value
  }
  return JSON.stringify(value) ?? String(value)
}

function abbreviateEmbeddingArray(values: unknown[]): unknown {
  if (values.length <= EMBEDDING_ARRAY_EDGE_ITEMS * 2) {
    return values.map((item) => abbreviateEmbeddingInputValue(item))
  }

  const prefix = values
    .slice(0, EMBEDDING_ARRAY_EDGE_ITEMS)
    .map(formatEmbeddingArrayEdge)
    .join(', ')
  const suffix = values
    .slice(-EMBEDDING_ARRAY_EDGE_ITEMS)
    .map(formatEmbeddingArrayEdge)
    .join(', ')
  return `${prefix}, [OMITTED ...], ${suffix}`
}

function abbreviateEmbeddingInputValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return abbreviateEmbeddingText(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => abbreviateEmbeddingInputValue(item))
  }
  if (!isRecord(value)) {
    return value
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      abbreviateEmbeddingInputValue(child),
    ]),
  )
}

function abbreviateEmbeddingPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => abbreviateEmbeddingPayload(item))
  }
  if (!isRecord(value)) {
    return value
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      const normalizedKey = key.toLowerCase()
      if (normalizedKey === 'input') {
        return [key, abbreviateEmbeddingInputValue(child)]
      }
      if (normalizedKey === 'embedding') {
        return [
          key,
          Array.isArray(child)
            ? abbreviateEmbeddingArray(child)
            : abbreviateEmbeddingInputValue(child),
        ]
      }
      return [key, abbreviateEmbeddingPayload(child)]
    }),
  )
}

function abbreviateEmbeddingBody(body: string | undefined): string | null {
  if (!body) {
    return null
  }

  const parsed = tryParseJson(body)
  if (!parsed.ok || !isRecord(parsed.value)) {
    return null
  }

  // Keep embedding inputs short so saving this debug note does not trigger
  // another large embedding pass over the captured source text.
  const abbreviated = abbreviateEmbeddingPayload(parsed.value)
  return JSON.stringify(
    omitBase64DebugData(redactJsonLike(abbreviated)),
    null,
    2,
  )
}

function getRequestModel(exchange: LLMDebugHttpExchange): string | null {
  const requestRecord = getRequestRecord(exchange)
  const model = requestRecord?.model
  return typeof model === 'string' && model.trim() ? model.trim() : null
}

function isEmbeddingExchange(
  trace: LLMDebugTrace,
  exchange: LLMDebugHttpExchange,
): boolean {
  if (trace.summary.requestKind === 'embedding') {
    return true
  }

  const url = exchange.request.url.toLowerCase()
  if (/(^|[/_-])(embeddings?|embed|embd)(?:[/?#_-]|$)/i.test(url)) {
    return true
  }

  const requestRecord = getRequestRecord(exchange)
  const model =
    typeof requestRecord?.model === 'string' ? requestRecord.model : ''
  if (/embed|embedding|embd/i.test(model)) {
    return true
  }

  return (
    Boolean(requestRecord) &&
    Array.isArray(requestRecord?.input) &&
    !Array.isArray(requestRecord?.messages) &&
    /embed|embedding|embd/i.test(exchange.request.body ?? '')
  )
}

function isTitleGenerationTrace(trace: LLMDebugTrace): boolean {
  return trace.summary.requestKind === 'title-generation'
}

function isSubLlmTrace(trace: LLMDebugTrace): boolean {
  return trace.summary.requestKind === 'sub-llm'
}

function isOtherRequestTrace(trace: LLMDebugTrace): boolean {
  return (
    isTitleGenerationTrace(trace) || trace.summary.requestKind === 'embedding'
  )
}

function isUnrelatedConversationExchange(
  trace: LLMDebugTrace,
  exchange: LLMDebugHttpExchange,
): boolean {
  if (isSubLlmTrace(trace)) {
    return false
  }
  return (
    isEmbeddingExchange(trace, exchange) ||
    isTitleGenerationTrace(trace) ||
    isTitleGenerationRequest(exchange)
  )
}

function formatStreamingBody(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(\s*data:\s*)(.*)$/)
      if (!match) {
        const parsed = tryParseJson(line.trim())
        return parsed.ok ? compactJson(parsed.value) : line
      }

      const payload = match[2].trim()
      if (!payload || payload === '[DONE]') {
        return line
      }

      const parsed = tryParseJson(payload)
      if (!parsed.ok) {
        return line
      }

      return `${match[1]}${compactJson(parsed.value)}`
    })
    .join('\n')
}

function formatBody({
  body,
  contentType,
  streaming,
  embeddingRequest,
}: {
  body: string | undefined
  contentType?: string
  streaming?: boolean
  embeddingRequest?: boolean
}): {
  content: string
  language: 'json' | 'text'
  formatted: boolean
  formatNote?: string
  rawLabel?: boolean
} {
  if (!body) {
    return { content: '(empty)', language: 'text', formatted: false }
  }

  if (embeddingRequest) {
    const abbreviated = abbreviateEmbeddingBody(body)
    if (abbreviated) {
      return {
        content: abbreviated,
        language: 'json',
        formatted: true,
        formatNote: '(pretty-printed)',
      }
    }
  }

  if (streaming || isProbablyStreamingBody(body, contentType)) {
    return {
      content: formatStreamingBody(body),
      language: 'json',
      formatted: true,
      formatNote: '(streaming JSON data lines compacted)',
      rawLabel: true,
    }
  }

  const parsed = tryParseJson(body)
  if (parsed.ok) {
    return {
      content:
        JSON.stringify(
          omitBase64DebugData(redactJsonLike(parsed.value)),
          null,
          2,
        ) ?? '',
      language: 'json',
      formatted: true,
      formatNote: '(pretty-printed)',
    }
  }

  const bodyWithBase64Omitted = omitBase64DebugData(body)
  return {
    content:
      typeof bodyWithBase64Omitted === 'string' ? bodyWithBase64Omitted : body,
    language: 'text',
    formatted: false,
  }
}

function formatBodyBlock(
  body: ReturnType<typeof formatBody>,
  options: { raw?: boolean } = {},
): string[] {
  const label = body.rawLabel
    ? 'Body (Raw Stream):'
    : options.raw
      ? 'Body (Raw):'
      : 'Body:'
  return [
    label,
    codeBlock(body.content, body.language),
    ...(body.formatNote ? [body.formatNote] : []),
  ]
}

function formatHeaders(headers: Record<string, string>): string {
  return Object.keys(headers).length > 0 ? JSON.stringify(headers, null, 2) : ''
}

function formatHeaderBlock(headers: Record<string, string>): string {
  const formatted = formatHeaders(headers)
  return codeBlock(formatted, formatted ? 'json' : 'text')
}

function requestHasTools(value: Record<string, unknown> | null): boolean {
  return Boolean(value && Array.isArray(value.tools) && value.tools.length > 0)
}

function getToolNameFromExchange(
  exchange: LLMDebugHttpExchange,
): string | null {
  if (!exchange.request.url.startsWith('mcp://')) {
    return null
  }

  try {
    const url = new URL(exchange.request.url)
    const rawName = `${url.host}${url.pathname}`.replace(/^\/+/, '')
    return rawName ? decodeURIComponent(rawName) : null
  } catch {
    return exchange.request.url.slice('mcp://'.length) || null
  }
}

function isTitleGenerationRequest(exchange: LLMDebugHttpExchange): boolean {
  const body = exchange.request.body ?? ''
  return /title generator|conversation title|generate a concise conversation title|User first message:/i.test(
    body,
  )
}

function extractNonStreamingReadableParts(
  body: string | undefined,
  category: string,
): {
  content: string
  reasoning: string
  toolCalls: string
} | null {
  const candidates = getJsonCandidates(body)
  if (candidates.length === 0) {
    return null
  }

  const extracted = createExtractedStreamingStrings()
  for (const candidate of candidates) {
    collectStringAtPaths(candidate, [], extracted)
    if (
      category === 'Title generation request' &&
      isRecord(candidate) &&
      typeof candidate.title === 'string'
    ) {
      extracted.contentFallback.push(candidate.title)
    }
  }

  const content =
    extracted.content.length > 0
      ? uniqueStrings(extracted.content).join('')
      : uniqueStrings(extracted.contentFallback).join('\n\n')
  const reasoning =
    extracted.reasoning.length > 0
      ? uniqueStrings(extracted.reasoning).join('')
      : uniqueStrings(extracted.reasoningFallback).join('\n\n')
  const toolCalls =
    extracted.toolCalls.length > 0
      ? uniqueStrings(extracted.toolCalls).join('\n\n')
      : uniqueStrings(extracted.toolCallFallback).join('\n\n')

  if (!content && !reasoning && !toolCalls) {
    return null
  }

  return { content, reasoning, toolCalls }
}

function isCompactionSummaryRequest(exchange: LLMDebugHttpExchange): boolean {
  const body = exchange.request.body ?? ''
  return /summarizing a conversation|conversation_transcript|context_compaction/i.test(
    body,
  )
}

function exchangeHasToolCallOutput(exchange: LLMDebugHttpExchange): boolean {
  const body = `${exchange.request.body ?? ''}\n${exchange.response?.body ?? ''}`
  return /tool_calls|tool_use|functionCall|function_call|toolUse/i.test(body)
}

function getExchangeCategory(
  trace: LLMDebugTrace,
  exchange: LLMDebugHttpExchange,
): string {
  if (isEmbeddingExchange(trace, exchange)) {
    return 'Embedding request'
  }
  if (isSubLlmTrace(trace)) {
    return 'Sub LLM request'
  }
  if (isTitleGenerationTrace(trace)) {
    return 'Title generation request'
  }
  if (exchange.transportMode === 'mcp') {
    const toolName = getToolNameFromExchange(exchange)
    return toolName ? `Tool request - ${toolName}` : 'Tool request'
  }
  if (exchange.transportMode === 'web-search') {
    return 'Tool request - web search'
  }
  if (isTitleGenerationRequest(exchange)) {
    return 'Title generation request'
  }
  if (isCompactionSummaryRequest(exchange)) {
    return 'Compaction summary request'
  }

  const requestRecord = getRequestRecord(exchange)
  if (requestHasTools(requestRecord) || exchangeHasToolCallOutput(exchange)) {
    return 'Main LLM request with tools'
  }
  if (requestRecord && Array.isArray(requestRecord.messages)) {
    return 'Main LLM request'
  }

  return 'HTTP request'
}

function isLlmTransportExchange(exchange: LLMDebugHttpExchange): boolean {
  return (
    exchange.transportMode !== 'mcp' && exchange.transportMode !== 'web-search'
  )
}

function formatAttemptProviderLines(
  trace: LLMDebugTrace,
  exchange: LLMDebugHttpExchange,
  endpointProvider: string | null,
): string[] {
  if (isLlmTransportExchange(exchange)) {
    const requestModel = getRequestModel(exchange)
    if (isEmbeddingExchange(trace, exchange) && endpointProvider) {
      return [
        `- Provider: ${endpointProvider}`,
        `- Model: ${requestModel ?? formatTraceModel(trace)}`,
      ]
    }
    return [
      `- Provider: ${trace.summary.providerId ?? 'unknown'}`,
      `- Model: ${requestModel ?? formatTraceModel(trace)}`,
      ...(endpointProvider ? [`- Endpoint: ${endpointProvider}`] : []),
    ]
  }

  if (exchange.transportMode === 'web-search' && endpointProvider) {
    return [`- Provider: ${endpointProvider}`]
  }

  return []
}

function formatExchangeStatus(exchange: LLMDebugHttpExchange): string {
  if (exchange.response) {
    return `${exchange.response.status} ${exchange.response.statusText}`.trim()
  }
  if (exchange.errorMessage) {
    return 'error'
  }
  return 'pending'
}

function getEndpointProvider(exchange: LLMDebugHttpExchange): string | null {
  try {
    const host = new URL(exchange.request.url).host
    if (!host) {
      return null
    }
    if (/generativelanguage\.googleapis\.com/i.test(host)) {
      return `Google Gemini (${host})`
    }
    if (/api\.x\.ai/i.test(host)) {
      return `xAI Grok (${host})`
    }
    if (/api\.tavily\.com/i.test(host)) {
      return `Tavily (${host})`
    }
    if (/api\.bing\.microsoft\.com/i.test(host)) {
      return `Bing (${host})`
    }
    if (/r\.jina\.ai|s\.jina\.ai/i.test(host)) {
      return `Jina (${host})`
    }
    if (/open\.bigmodel\.cn/i.test(host)) {
      return `Zhipu (${host})`
    }
    return host
  } catch {
    return null
  }
}

function formatTraceModel(trace: LLMDebugTrace): string {
  return trace.summary.modelName
    ? `${trace.summary.modelName}${
        trace.summary.modelId ? ` (${trace.summary.modelId})` : ''
      }`
    : (trace.summary.modelId ?? 'unknown')
}

function isStreamingExchange(exchange: LLMDebugHttpExchange): boolean {
  return isProbablyStreamingBody(
    exchange.response?.body,
    exchange.response?.contentType,
  )
}

function formatExchange(
  trace: LLMDebugTrace,
  exchange: LLMDebugHttpExchange,
  index: number,
  stepIndex?: number,
): string {
  const isEmbedding = isEmbeddingExchange(trace, exchange)
  const requestBody = formatBody({
    body: exchange.request.body,
    embeddingRequest: isEmbedding,
  })
  const responseBody = formatBody({
    body: exchange.response?.body,
    contentType: exchange.response?.contentType,
    embeddingRequest: isEmbedding,
    streaming: exchange.response?.contentType
      ?.toLowerCase()
      .includes('text/event-stream'),
  })
  const hasResponseBody =
    typeof exchange.response?.body === 'string' &&
    exchange.response.body.length > 0
  const status = formatExchangeStatus(exchange)
  const category = getExchangeCategory(trace, exchange)
  const endpointProvider = getEndpointProvider(exchange)
  const usage = collectUsageFromBody(exchange.response?.body)
  const costs = collectCostsFromBody(exchange.response?.body)
  const extractedStreamingParts = isProbablyStreamingBody(
    exchange.response?.body,
    exchange.response?.contentType,
  )
    ? extractStreamingReadableParts(exchange.response?.body)
    : null
  const extractedNonStreamingParts =
    !extractedStreamingParts && hasResponseBody
      ? extractNonStreamingReadableParts(exchange.response?.body, category)
      : null
  const duration =
    typeof exchange.completedAt === 'number'
      ? exchange.completedAt - exchange.startedAt
      : undefined
  const headingNumber =
    stepIndex === undefined ? `${index + 1}` : `${stepIndex + 1}.${index + 1}`

  return [
    `### #${headingNumber} - ${category}`,
    ...(isEmbedding
      ? [
          '',
          'Note: This embedding request was captured during the turn, but it was not initiated by the chat response itself.',
        ]
      : []),
    '',
    `- Category: ${category}`,
    `- Streaming: ${isStreamingExchange(exchange) ? 'true' : 'false'}`,
    ...formatAttemptProviderLines(trace, exchange, endpointProvider),
    `- Transport: ${exchange.transportMode}`,
    `- Started: ${formatLocalDateTime(exchange.startedAt)}`,
    `- Completed: ${formatLocalDateTime(exchange.completedAt)}`,
    `- Duration: ${formatDurationMs(duration)}`,
    `- Status: ${status}`,
    `- Usage: ${usage ?? 'unknown'}`,
    `- Cost: ${formatCostSummary(costs, 'response')}`,
    ...(exchange.response?.interrupted
      ? ['- Response body: interrupted; captured body may be partial']
      : []),
    '',
    '#### Request',
    '',
    '- URL:',
    codeBlock(exchange.request.url, 'text'),
    `- Method: ${exchange.request.method}`,
    '',
    'Headers:',
    formatHeaderBlock(exchange.request.headers),
    '',
    ...formatBodyBlock(requestBody),
    '',
    '#### Response',
    '',
    ...(exchange.response
      ? [
          `- Status: ${status}`,
          '',
          'Headers:',
          formatHeaderBlock(exchange.response.headers),
          '',
          ...(exchange.response.interrupted
            ? [
                'Note: Response body read was interrupted; the body below is whatever was captured before the interruption.',
                '',
              ]
            : []),
          ...(!hasResponseBody
            ? [
                exchange.response.interrupted
                  ? 'No response body was captured before the interruption.'
                  : 'No response body received.',
                '',
              ]
            : []),
          ...(extractedStreamingParts
            ? [
                'Reasoning (Extracted):',
                codeBlock(
                  extractedStreamingParts.reasoning || '(empty)',
                  'text',
                ),
                '',
                'Content (Extracted):',
                codeBlock(extractedStreamingParts.content || '(empty)', 'text'),
                '',
                ...(extractedStreamingParts.toolCalls
                  ? [
                      'Tool Calls (Extracted):',
                      codeBlock(extractedStreamingParts.toolCalls, 'text'),
                      '',
                    ]
                  : []),
                ...formatBodyBlock(responseBody, { raw: true }),
              ]
            : extractedNonStreamingParts
              ? [
                  ...(extractedNonStreamingParts.reasoning
                    ? [
                        'Reasoning (Extracted):',
                        codeBlock(extractedNonStreamingParts.reasoning, 'text'),
                        '',
                      ]
                    : []),
                  'Content (Extracted):',
                  codeBlock(
                    extractedNonStreamingParts.content || '(empty)',
                    'text',
                  ),
                  '',
                  ...(extractedNonStreamingParts.toolCalls
                    ? [
                        'Tool Calls (Extracted):',
                        codeBlock(extractedNonStreamingParts.toolCalls, 'text'),
                        '',
                      ]
                    : []),
                  ...formatBodyBlock(responseBody, { raw: true }),
                ]
              : hasResponseBody
                ? formatBodyBlock(responseBody, { raw: true })
                : ['Body:', codeBlock('', 'text')]),
        ]
      : ['No response received.', '', 'Body:', codeBlock('', 'text')]),
    '',
    ...(exchange.errorMessage
      ? ['#### Error Information', '', codeBlock(exchange.errorMessage, 'text')]
      : []),
  ].join('\n')
}

function getTraceOnlyOtherRequestCategory(trace: LLMDebugTrace): string {
  if (isTitleGenerationTrace(trace)) {
    return 'Title generation request'
  }
  if (trace.summary.requestKind === 'embedding') {
    return 'Embedding request'
  }
  return 'Other request'
}

function formatTraceOnlyOtherRequest(
  trace: LLMDebugTrace,
  index: number,
): string {
  const summary = trace.summary
  const category = getTraceOnlyOtherRequestCategory(trace)
  const model = summary.modelName
    ? `${summary.modelName}${summary.modelId ? ` (${summary.modelId})` : ''}`
    : (summary.modelId ?? 'unknown')

  return [
    `### #${index + 1} - ${category}`,
    '',
    `- Category: ${category}`,
    `- Provider: ${summary.providerId ?? 'unknown'}`,
    `- Model: ${model}`,
    `- State: ${formatGenerationState(summary.generationState)}`,
    `- Started: ${formatLocalDateTime(summary.startedAt)}`,
    `- Completed: ${formatLocalDateTime(summary.completedAt)}`,
    `- Duration: ${formatDurationMs(summary.durationMs)}`,
    `- Status: ${summary.generationState ?? 'unknown'}`,
    `- Usage: ${formatUsage(summary.usage)}`,
    ...(summary.errorMessage ? [`- Error: ${summary.errorMessage}`] : []),
    '',
    '#### Attempt',
    '',
    '(No HTTP exchange was captured.)',
  ].join('\n')
}

type DebugSectionExchange = {
  trace: LLMDebugTrace
  exchange: LLMDebugHttpExchange
}

function buildLinkedSubLlmTraceMap(sortedTraces: LLMDebugTrace[]): {
  groupedChildTraceIds: Set<string>
  childTracesByParent: Map<string, LLMDebugTrace[]>
} {
  const traceById = new Map(sortedTraces.map((trace) => [trace.id, trace]))
  const groupedChildTraceIds = new Set<string>()
  const childTracesByParent = new Map<string, LLMDebugTrace[]>()

  for (const trace of sortedTraces) {
    if (isSubLlmTrace(trace) || isOtherRequestTrace(trace)) {
      continue
    }
    const linkedChildTraces = getLinkedLLMDebugTraceIds([trace.id])
      .map((traceId) => traceById.get(traceId))
      .filter(
        (childTrace): childTrace is LLMDebugTrace =>
          childTrace !== undefined && isSubLlmTrace(childTrace),
      )
      .sort((a, b) => a.summary.startedAt - b.summary.startedAt)

    if (linkedChildTraces.length === 0) {
      continue
    }
    childTracesByParent.set(trace.id, linkedChildTraces)
    for (const childTrace of linkedChildTraces) {
      groupedChildTraceIds.add(childTrace.id)
    }
  }

  return { groupedChildTraceIds, childTracesByParent }
}

export function buildLLMDebugMarkdown(traces: LLMDebugTrace[]): string {
  const createdAt = new Date().toLocaleString()
  const sortedTraces = [...traces].sort(
    (a, b) => a.summary.startedAt - b.summary.startedAt,
  )
  const { groupedChildTraceIds, childTracesByParent } =
    buildLinkedSubLlmTraceMap(sortedTraces)
  const otherRequestEntries: Array<{
    trace: LLMDebugTrace
    exchange?: LLMDebugHttpExchange
  }> = []
  const sections: string[] = []
  let stepIndex = 0

  for (const trace of sortedTraces) {
    if (groupedChildTraceIds.has(trace.id)) {
      continue
    }
    const summary = trace.summary
    const model = summary.modelName
      ? `${summary.modelName}${summary.modelId ? ` (${summary.modelId})` : ''}`
      : (summary.modelId ?? 'unknown')
    const sortedExchanges = [...trace.exchanges].sort(
      (a, b) => a.startedAt - b.startedAt,
    )
    const relatedExchanges = sortedExchanges.filter((exchange) => {
      if (isUnrelatedConversationExchange(trace, exchange)) {
        otherRequestEntries.push({ trace, exchange })
        return false
      }
      return true
    })
    const sectionExchangeEntries: DebugSectionExchange[] = [
      ...relatedExchanges.map((exchange) => ({ trace, exchange })),
      ...(childTracesByParent.get(trace.id) ?? []).flatMap((childTrace) =>
        [...childTrace.exchanges]
          .sort((a, b) => a.startedAt - b.startedAt)
          .map((exchange) => ({ trace: childTrace, exchange })),
      ),
    ].sort((a, b) => a.exchange.startedAt - b.exchange.startedAt)
    if (isOtherRequestTrace(trace)) {
      continue
    }
    const hasOnlyUnrelatedExchanges =
      sortedExchanges.length > 0 &&
      relatedExchanges.length === 0 &&
      sectionExchangeEntries.length === 0
    if (hasOnlyUnrelatedExchanges) {
      continue
    }

    const currentStepIndex = stepIndex
    stepIndex += 1
    const toolNames = summary.toolCallNames?.filter(Boolean) ?? []
    const costs = collectTraceCosts(
      trace,
      sectionExchangeEntries.map((entry) => entry.exchange),
    )

    sections.push(
      [
        `## Step #${currentStepIndex + 1}`,
        '',
        `- Scope: step ${currentStepIndex + 1} within this chat turn`,
        `- Model: ${model}`,
        `- Provider: ${summary.providerId ?? 'unknown'}`,
        `- State: ${formatGenerationState(summary.generationState)}`,
        `- Started: ${formatLocalDateTime(summary.startedAt)}`,
        `- Completed: ${formatLocalDateTime(summary.completedAt)}`,
        `- Usage: ${formatUsage(summary.usage)}`,
        `- Cost: ${formatCostSummary(costs, 'attempt')}`,
        `- Duration: ${formatDurationMs(summary.durationMs)}`,
        ...(toolNames.length > 0
          ? [`- Tool calls: ${toolNames.join(', ')}`]
          : hasToolCalls({
                ...trace,
                exchanges: sectionExchangeEntries.map(
                  (entry) => entry.exchange,
                ),
              })
            ? ['- Tool calls: detected']
            : []),
        ...(summary.errorMessage ? [`- Error: ${summary.errorMessage}`] : []),
        '',
        ...(sectionExchangeEntries.length > 0
          ? sectionExchangeEntries.map(
              ({ trace: entryTrace, exchange }, exchangeIndex) =>
                formatExchange(
                  entryTrace,
                  exchange,
                  exchangeIndex,
                  currentStepIndex,
                ),
            )
          : [
              `### #${currentStepIndex + 1}.1 - No HTTP exchange captured`,
              '',
              '(No HTTP exchange was captured.)',
            ]),
      ].join('\n'),
    )
  }

  const unrelatedSections =
    otherRequestEntries.length > 0
      ? [
          ...(sections.length > 0 ? [''] : []),
          '## Other Requests',
          '',
          'These requests were captured during this debug window, but they are not part of the main chat response itself.',
          '',
          ...otherRequestEntries.map(({ trace, exchange }, index) =>
            exchange
              ? formatExchange(trace, exchange, index)
              : formatTraceOnlyOtherRequest(trace, index),
          ),
        ]
      : []

  return [
    `# LLM Debug Trace (one chat turn)`,
    '',
    'This file captures the LLM/network/tool transport activity associated with one chat turn. Each Step is one main LLM-facing request within that turn, and each numbered item is a captured transport operation under that Step. Sub-LLM items are grouped under the main step that triggered them. You can save this note and ask AI to analyze it later.',
    '',
    'Markers beginning with `OMITTED` are added to prevent this debug report from becoming too long.',
    '',
    `Generated: ${createdAt}`,
    '',
    ...sections,
    ...unrelatedSections,
  ]
    .join('\n')
    .trim()
}
