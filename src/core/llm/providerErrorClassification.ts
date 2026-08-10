/**
 * Providers do not agree on an error envelope, so there is no reliable way to
 * pull "the message" out of an arbitrary body. Instead of guessing which field
 * holds it, classify over the whole text — the signal we need (`invalid_api_key`,
 * `insufficient_balance`, `context_length_exceeded`, …) is present regardless of
 * how deeply the provider nested it.
 */
export type ProviderErrorCategory =
  | 'auth'
  | 'region'
  | 'model'
  | 'quota'
  | 'rateLimit'
  | 'contextLength'
  | 'payload'
  | 'content'
  | 'mcp'
  | 'stream'
  | 'network'
  | 'proxy'
  | 'server'
  | 'deprecated'
  | 'knowledge'
  | 'parse'
  | 'unknown'

export type ProviderErrorClassificationInput = {
  message?: string
  status?: number
  responseBody?: string
  finishReason?: string
}

const isQuotaSignal = (text: string): boolean =>
  text.includes('quota') ||
  text.includes('insufficient_balance') ||
  text.includes('insufficient balance') ||
  text.includes('insufficient_credit') ||
  text.includes('insufficient credit') ||
  text.includes('billing') ||
  text.includes('payment')

const isMcpSignal = (text: string): boolean =>
  text.includes('mcp server') ||
  text.includes('mcp connection') ||
  text.includes('mcp error') ||
  text.includes('mcp timeout') ||
  text.includes('mcp transport') ||
  text.includes('mcp client') ||
  text.startsWith('mcp:') ||
  text.startsWith('[mcp]') ||
  text.includes('mcp_')

export const classifyProviderError = ({
  message,
  status,
  responseBody,
  finishReason,
}: ProviderErrorClassificationInput): ProviderErrorCategory => {
  switch (finishReason?.toLowerCase()) {
    case 'content-filter':
    case 'content_filter':
    case 'safety':
    case 'recitation':
      return 'content'
  }

  const text = [message, responseBody]
    .filter((part): part is string => Boolean(part))
    .join('\n')
    .toLowerCase()
  if (!text && status === undefined) return 'unknown'

  // Geo-blocks are usually served as HTTP 403, so region signals must win over auth.
  if (
    text.includes('unsupported_country') ||
    text.includes('country, region') ||
    text.includes('country/region') ||
    text.includes('region not supported') ||
    text.includes('not available in your region') ||
    text.includes('not available in your country') ||
    text.includes('not available in your location') ||
    text.includes('not available in your area') ||
    (text.includes('territory') &&
      (status === 403 || text.includes('unsupported')))
  ) {
    return 'region'
  }

  if (
    status === 401 ||
    status === 403 ||
    text.includes('invalid_api_key') ||
    text.includes('authentication') ||
    text.includes('unauthorized') ||
    text.includes('forbidden')
  ) {
    return 'auth'
  }

  if (
    status === 404 ||
    text.includes('model_not_found') ||
    text.includes('model not found') ||
    (text.includes('model with id') && text.includes('not found')) ||
    text.includes('model does not exist')
  ) {
    return 'model'
  }

  // Explicit billing signals win over the HTTP 429 rate-limit default.
  if (status === 402 || isQuotaSignal(text)) {
    return 'quota'
  }

  if (
    status === 429 ||
    text.includes('rate_limit') ||
    text.includes('rate limit') ||
    text.includes('too many requests')
  ) {
    return 'rateLimit'
  }

  if (
    text.includes('context_length_exceeded') ||
    text.includes('too many tokens') ||
    text.includes('maximum context length') ||
    text.includes('context window') ||
    text.includes('prompt is too long') ||
    text.includes('input is too long')
  ) {
    return 'contextLength'
  }

  if (
    status === 413 ||
    text.includes('payload too large') ||
    text.includes('request entity too large')
  ) {
    return 'payload'
  }

  // Content-filter signals are provider-specific and do not consistently use HTTP 400.
  if (
    text.includes('content_filter') ||
    text.includes('content_policy') ||
    text.includes('prohibited_content') ||
    text.includes('responsible_ai') ||
    text.includes('output_blocked') ||
    text.includes('safety') ||
    text.includes('recitation') ||
    text.includes('blocked by safety')
  ) {
    return 'content'
  }

  // Feature-specific failures must win over the generic network classification.
  if (isMcpSignal(text)) {
    return 'mcp'
  }

  // Require a transport-failure phrase rather than matching every mention of streaming.
  if (
    text.includes('econnreset') ||
    text.includes('connection reset') ||
    text.includes('stream interrupted') ||
    text.includes('stream closed') ||
    text.includes('stream aborted') ||
    text.includes('stream ended unexpectedly') ||
    text.includes('premature close') ||
    text.includes('socket hang up')
  ) {
    return 'stream'
  }

  if (
    text.includes('econnrefused') ||
    text.includes('etimedout') ||
    text.includes('timeout') ||
    text.includes('network') ||
    text.includes('fetch failed') ||
    text.includes('enotfound')
  ) {
    return 'network'
  }

  if (
    text.includes('proxy') ||
    text.includes('socks') ||
    text.includes('certificate') ||
    text.includes('self-signed') ||
    text.includes('unable_to_verify_leaf_signature')
  ) {
    return 'proxy'
  }

  if (
    status === 529 ||
    (status !== undefined && status >= 500) ||
    text.includes('overloaded') ||
    text.includes('overload')
  ) {
    return 'server'
  }

  // Require a model-specific phrase so a deprecated parameter does not look
  // like a retired model.
  if (
    (text.includes('deprecated') && text.includes('model')) ||
    text.includes('model has been retired') ||
    text.includes('model is retired') ||
    text.includes('model has been sunset') ||
    text.includes('decommission')
  ) {
    return 'deprecated'
  }

  if (
    text.includes('embedding') ||
    text.includes('vectorize') ||
    text.includes('knowledge base')
  ) {
    return 'knowledge'
  }

  if (
    text.includes('unexpected token') ||
    text.includes('invalid response') ||
    text.includes('parse error') ||
    text.includes('failed to parse') ||
    text.includes('json parse') ||
    text.includes('invalid json') ||
    text.includes('malformed json')
  ) {
    return 'parse'
  }

  return 'unknown'
}
