import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

export type McpTool = Tool
export type McpToolCallResult = CallToolResult
export type McpClient = Client

const nonEmptyStringSchema = z.string().min(1)
const headersSchema = z.record(z.string(), z.string())

const createUrlSchema = (allowedProtocols: string[]) =>
  z
    .string()
    .url()
    .refine((urlString) => {
      const url = new URL(urlString)
      return allowedProtocols.includes(url.protocol)
    })

export const mcpServerStdioParametersLegacySchema = z
  .object({
    command: nonEmptyStringSchema,
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  })
  .strict()

export const mcpServerStdioParametersSchema = z
  .object({
    transport: z.literal('stdio'),
    command: nonEmptyStringSchema,
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  })
  .strict()

export const mcpServerHttpParametersSchema = z
  .object({
    transport: z.literal('http'),
    url: createUrlSchema(['http:', 'https:']),
    headers: headersSchema.optional(),
  })
  .strict()

export const mcpServerSseParametersSchema = z
  .object({
    transport: z.literal('sse'),
    url: createUrlSchema(['http:', 'https:']),
    headers: headersSchema.optional(),
  })
  .strict()

export const mcpServerWsParametersSchema = z
  .object({
    transport: z.literal('ws'),
    url: createUrlSchema(['ws:', 'wss:']),
  })
  .strict()

const mcpServerCanonicalParametersSchema = z.discriminatedUnion('transport', [
  mcpServerStdioParametersSchema,
  mcpServerHttpParametersSchema,
  mcpServerSseParametersSchema,
  mcpServerWsParametersSchema,
])

const mcpServerRawParametersSchema = z.union([
  mcpServerCanonicalParametersSchema,
  mcpServerStdioParametersLegacySchema,
])

export const mcpServerParametersSchema = mcpServerRawParametersSchema.transform(
  (value) => {
    if ('transport' in value) {
      return value
    }

    return {
      transport: 'stdio' as const,
      ...value,
    }
  },
)

export type McpServerParameters = z.infer<typeof mcpServerParametersSchema>

type McpServerInputRecord = Record<string, unknown>

const MCP_PARAMETER_KEYS = new Set([
  'transport',
  'command',
  'url',
  'args',
  'env',
  'headers',
  'cwd',
])

function isRecord(value: unknown): value is McpServerInputRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasParameterLikeFields(value: McpServerInputRecord): boolean {
  return Object.keys(value).some((key) => MCP_PARAMETER_KEYS.has(key))
}

function normalizeSingleMcpServerParameters(
  value: unknown,
): McpServerParameters {
  if (!isRecord(value)) {
    return mcpServerParametersSchema.parse(value)
  }

  if (isRecord(value.parameters)) {
    return normalizeSingleMcpServerParameters(value.parameters)
  }

  if (hasParameterLikeFields(value)) {
    const normalized: McpServerInputRecord = { ...value }
    delete normalized.id
    delete normalized.name
    return mcpServerParametersSchema.parse(normalized)
  }

  return mcpServerParametersSchema.parse(value)
}

export function getMcpServerNamesFromInput(value: unknown): string[] {
  if (!isRecord(value)) {
    return []
  }

  const mcpServersValue = value.mcpServers
  if (!isRecord(mcpServersValue)) {
    return []
  }

  return Object.keys(mcpServersValue)
}

export function normalizeMcpServerParameters({
  value,
  serverName,
}: {
  value: unknown
  serverName?: string
}): McpServerParameters {
  if (!isRecord(value)) {
    return normalizeSingleMcpServerParameters(value)
  }

  const mcpServersValue = value.mcpServers
  if (!isRecord(mcpServersValue)) {
    return normalizeSingleMcpServerParameters(value)
  }

  const serverEntries = Object.entries(mcpServersValue)
  if (serverEntries.length === 0) {
    throw new Error('"mcpServers" cannot be empty.')
  }

  const trimmedServerName = serverName?.trim()
  if (trimmedServerName && trimmedServerName.length > 0) {
    const targetServerValue = mcpServersValue[trimmedServerName]
    if (targetServerValue !== undefined) {
      return normalizeSingleMcpServerParameters(targetServerValue)
    }

    if (serverEntries.length === 1) {
      return normalizeSingleMcpServerParameters(serverEntries[0][1])
    }

    throw new Error(
      `Cannot find server "${trimmedServerName}" in "mcpServers". Available: ${serverEntries
        .map(([name]) => name)
        .join(', ')}`,
    )
  }

  if (serverEntries.length === 1) {
    return normalizeSingleMcpServerParameters(serverEntries[0][1])
  }

  throw new Error(
    `Multiple servers found in "mcpServers". Please set Name to one of: ${serverEntries
      .map(([name]) => name)
      .join(', ')}`,
  )
}

export const mcpServerToolOptionsSchema = z.record(
  z.string(),
  z.object({
    disabled: z.boolean().optional(),
    allowAutoExecution: z.boolean().optional(),
  }),
)

export const mcpServerConfigSchema = z.object({
  id: z.string(),
  parameters: mcpServerParametersSchema,
  enabled: z.boolean(),
  toolOptions: mcpServerToolOptionsSchema,
})
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>

export enum McpServerStatus {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Error = 'error',
}

export type McpServerState = {
  name: string
  config: McpServerConfig
} & (
  | {
      status: McpServerStatus.Connecting | McpServerStatus.Disconnected
    }
  | {
      status: McpServerStatus.Connected
      client: McpClient
      tools: McpTool[]
    }
  | {
      status: McpServerStatus.Error
      error: Error
    }
)
