// Shared JS sandbox limits. This leaf module is consumed by both the
// settings/description layer and the Worker executor.
export const JS_SANDBOX_DEFAULT_TIMEOUT_MS = 3000
export const JS_SANDBOX_MIN_TIMEOUT_MS = 100
export const JS_SANDBOX_HARD_MAX_TIMEOUT_MS = 60000

export const JS_SANDBOX_DEFAULT_OUTPUT_MAX_BYTES = 50 * 1024
export const JS_SANDBOX_HARD_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
export const JS_SANDBOX_MIN_OUTPUT_BYTES = 1024

export const JS_SANDBOX_FETCH_DEFAULT_MAX_CONCURRENT = 3
export const JS_SANDBOX_FETCH_DEFAULT_MAX_RESPONSE_KB = 10 * 1024
export const JS_SANDBOX_FETCH_HARD_MAX_RESPONSE_KB = 1024 * 1024
export const JS_SANDBOX_FETCH_MIN_RESPONSE_KB = 1
export const JS_SANDBOX_FETCH_HARD_MAX_CONCURRENT = 32
export const JS_SANDBOX_FETCH_MIN_CONCURRENT = 1

export const JS_SANDBOX_VAULT_READ_DEFAULT_MAX_KB = 10 * 1024
export const JS_SANDBOX_VAULT_READ_HARD_MAX_KB = 1024 * 1024
export const JS_SANDBOX_VAULT_READ_MIN_KB = 1
export const JS_SANDBOX_VAULT_LIST_MAX_ENTRIES = 100_000

export const JS_SANDBOX_BROWSER_READ_DEFAULT_MAX_KB = 10 * 1024
export const JS_SANDBOX_BROWSER_READ_HARD_MAX_KB = 1024 * 1024
export const JS_SANDBOX_BROWSER_READ_MIN_KB = 1

export const JS_SANDBOX_DB_QUERY_DEFAULT_MAX_LIMIT = 20
export const JS_SANDBOX_DB_QUERY_HARD_MAX_LIMIT = 100
export const JS_SANDBOX_DB_QUERY_DEFAULT_REQUEST_LIMIT = 10

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
