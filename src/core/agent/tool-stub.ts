import type { McpTool } from '../../types/mcp.types'
import type { LLMProviderApiType } from '../../types/provider.types'

/**
 * Maximum length of the stub description registered in the `tools` field.
 * Kept short because every byte counts toward the frozen cache prefix; the
 * full description is delivered later via `yolo_local__load_tool_schemas` results.
 */
const STUB_DESCRIPTION_MAX_CHARS = 200

const STUB_DESCRIPTION_SUFFIX =
  ' ON-DEMAND: Before calling this tool, call yolo_local__load_tool_schemas with {"servers":["<server>"]} to load its full schema.'

const truncateDescription = (description: string | undefined): string => {
  const raw = (description ?? '').trim()
  if (raw.length === 0) {
    return STUB_DESCRIPTION_SUFFIX.trim()
  }
  const maxRawLength = STUB_DESCRIPTION_MAX_CHARS
  if (raw.length <= maxRawLength) {
    return `${raw}${STUB_DESCRIPTION_SUFFIX}`
  }
  return `${raw.slice(0, maxRawLength - 3)}...${STUB_DESCRIPTION_SUFFIX}`
}

/**
 * Synthetic argument name used to smuggle the real tool arguments through
 * Gemini's restricted OpenAPI schema. Gemini's sanitizer strips
 * `additionalProperties`, so we can't keep the stub schema fully open. The
 * gateway parses `args_json` back into the real arguments before dispatch.
 */
export const GEMINI_STUB_ARGS_JSON_FIELD = 'args_json'

const isGeminiApiType = (apiType?: LLMProviderApiType | null): boolean => {
  return apiType === 'gemini'
}

/**
 * Build the stub `inputSchema` that the registered tool exposes to the LLM
 * before its real schema has been disclosed via `load_tool_schemas`.
 *
 * Anthropic / OpenAI Responses / OpenAI Chat Completions accept the open
 * `{additionalProperties: true}` form, which lets the model send arbitrary
 * arguments once it has learned the real schema from `load_tool_schemas` output.
 *
 * Gemini's OpenAPI subset removes `additionalProperties`, so we fall back to a
 * single string field carrying the JSON-encoded real arguments.
 */
export const buildStubInputSchema = (
  apiType?: LLMProviderApiType | null,
): McpTool['inputSchema'] => {
  if (isGeminiApiType(apiType)) {
    return {
      type: 'object',
      properties: {
        [GEMINI_STUB_ARGS_JSON_FIELD]: {
          type: 'string',
          description:
            'JSON-encoded object of the real tool arguments. Use this only after yolo_local__load_tool_schemas has returned the full schema for this tool; the contents must match that schema.',
        },
      },
      required: [GEMINI_STUB_ARGS_JSON_FIELD],
    }
  }

  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  }
}

/**
 * Convert a real MCP tool definition into the stub form that is safe to
 * register in the LLM request's `tools` field for an entire conversation. The
 * stub keeps the tool name stable (so `tools` hashes consistently across
 * turns) while withholding the full input schema until disclosure.
 */
export const buildToolStub = (
  tool: McpTool,
  apiType?: LLMProviderApiType | null,
): McpTool => {
  return {
    ...tool,
    description: truncateDescription(tool.description),
    inputSchema: buildStubInputSchema(apiType),
  }
}

/**
 * True when the Gemini-style stub schema is in use. Callers (gateway) use
 * this to decide whether to unpack `args_json` before validating + dispatching.
 */
export const isGeminiStubApiType = (
  apiType?: LLMProviderApiType | null,
): boolean => {
  return isGeminiApiType(apiType)
}
