import type { RequestTool } from '../../types/llm/request'
import type { McpTool } from '../../types/mcp.types'
import { estimateJsonTokens } from '../../utils/llm/contextTokenEstimate'

import { getToolName } from './tool-name-utils'

const MAX_CACHED_TOOL_SCHEMAS = 512

// Keyed by the exact model-facing one-tool payload. The Map is insertion-ordered
// so a hit can refresh its LRU position and catalog churn remains bounded.
const schemaCostByFingerprint = new Map<string, Promise<number>>()

export const buildMcpToolTokenPayload = (
  tools: readonly McpTool[],
): RequestTool[] =>
  tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        ...tool.inputSchema,
        properties: tool.inputSchema.properties ?? {},
      },
    },
  }))

const touch = (fingerprint: string, pending: Promise<number>): void => {
  schemaCostByFingerprint.delete(fingerprint)
  schemaCostByFingerprint.set(fingerprint, pending)
  while (schemaCostByFingerprint.size > MAX_CACHED_TOOL_SCHEMAS) {
    const oldest = schemaCostByFingerprint.keys().next().value as
      | string
      | undefined
    if (oldest === undefined) break
    schemaCostByFingerprint.delete(oldest)
  }
}

/**
 * Return the cached standalone cost for one exact FQN schema. Server budgets
 * intentionally sum these standalone costs: that keeps enabled-tool subsets
 * composable without tokenizing every possible agent selection. It differs
 * from tokenizing one server array only by small JSON separator/bracket
 * overhead, while settings and runtime use this same definition exactly.
 */
export const getMcpToolSchemaTokenCost = (
  tool: McpTool,
  estimator: (value: unknown) => Promise<number> = estimateJsonTokens,
): Promise<number> => {
  const payload = buildMcpToolTokenPayload([tool])
  const fingerprint = JSON.stringify(payload)
  const cached = schemaCostByFingerprint.get(fingerprint)
  if (cached) {
    touch(fingerprint, cached)
    return cached
  }

  const pending = estimator(payload).catch((error) => {
    if (schemaCostByFingerprint.get(fingerprint) === pending) {
      schemaCostByFingerprint.delete(fingerprint)
    }
    throw error
  })
  touch(fingerprint, pending)
  return pending
}

/**
 * Start tokenizer work as soon as a connect-time catalog exists. This is
 * deliberately fire-and-forget: plugin/MCP startup never waits, while a first
 * consumer racing the prewarm awaits the same cached inflight promises.
 */
export const prewarmMcpServerToolTokenCosts = (
  serverName: string,
  tools: readonly McpTool[],
): void => {
  void Promise.all(
    tools.map((tool) =>
      getMcpToolSchemaTokenCost({
        ...tool,
        name: getToolName(serverName, tool.name),
      }),
    ),
  ).catch((error) => {
    console.warn(
      `[YOLO] Failed to prewarm MCP schema token costs for ${serverName}`,
      error,
    )
  })
}
