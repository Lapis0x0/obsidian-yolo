import type { McpTool } from '../../../../types/mcp.types'
import type { LLMProviderApiType } from '../../../../types/provider.types'
import type { I18nText } from '../../types'

/**
 * `invoke_tool` is a protocol-internal tool, not a user-authorized capability
 * — same status as `load_tool_schemas` (see that file's own note). It is the
 * single registered entry point for every tool that is *not* in the request's
 * `tools` field: those live in the system-prompt `<tool_catalog>` as bare
 * names, so the prefix cost of a deferred tool is its name rather than its
 * whole schema.
 *
 * It never goes through `defineTool`/`CAPABILITIES`, has no approval tier of
 * its own, and must never appear in the settings page. Approval, workspace
 * scope, blocked terminal prefixes and every other per-tool policy are
 * evaluated against the *unwrapped* call: the gateway rewrites an
 * `invoke_tool` request into the real tool's request before any of those run,
 * so no policy ever sees this wrapper. That ordering is the security
 * invariant — a check that ran against `invoke_tool` would be checking the
 * envelope instead of the letter.
 */
export const INVOKE_TOOL_NAME = 'invoke_tool'

export const INVOKE_TOOL_CHAT_LABEL: I18nText = {
  key: 'settings.agent.builtinInvokeToolLabel',
  fallback: 'Invoke Tool',
}

/**
 * Gemini's OpenAPI subset strips `additionalProperties`, which would leave the
 * `arguments` object with no way to carry real fields. Only there do we fall
 * back to a JSON-encoded string. Every other provider gets the native object
 * form, which models fill in markedly more reliably than JSON-inside-JSON.
 */
const isGeminiApiType = (apiType?: LLMProviderApiType | null): boolean =>
  apiType === 'gemini'

export const buildInvokeToolArgumentsSchema = (
  apiType?: LLMProviderApiType | null,
): Record<string, unknown> =>
  isGeminiApiType(apiType)
    ? {
        type: 'string',
        description:
          "JSON-encoded object of the target tool's arguments, matching the schema returned by yolo_local__load_tool_schemas.",
      }
    : {
        type: 'object',
        additionalProperties: true,
        description:
          "The target tool's arguments, matching the schema returned by yolo_local__load_tool_schemas.",
      }

export function getInvokeTool(apiType?: LLMProviderApiType | null): McpTool {
  return {
    name: INVOKE_TOOL_NAME,
    description:
      'Call a tool listed in <tool_catalog>. Load its schema with yolo_local__load_tool_schemas first, then pass the tool name exactly as the catalog spells it.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: {
          type: 'string',
          description:
            'Fully-qualified tool name, copied verbatim from <tool_catalog>.',
        },
        arguments: buildInvokeToolArgumentsSchema(apiType),
      },
      required: ['tool_name', 'arguments'],
    },
  }
}

export type InvokeToolUnwrapResult =
  | { ok: true; toolName: string; args: Record<string, unknown> }
  | { ok: false; error: string }

const MAX_SUGGESTIONS = 3

/**
 * Edit distance, rather than the subsequence scoring `fuzzysort` does: the
 * failure this serves is "the model typed a name one or two characters off"
 * (`notion__notion_search` for `notion__notion-search`), which is exactly what
 * Levenshtein measures. Typeahead-style subsequence matching answers a
 * different question and ranks unrelated names too generously here.
 */
const editDistance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[b.length]
}

/**
 * Names close to what the model asked for. Reported back so it can correct
 * itself in one round-trip.
 *
 * Deliberately advisory, never applied: real tool names sit at tiny edit
 * distances from each other while meaning entirely different things
 * (`trash_message` vs `trash_thread`), so auto-correcting a typo would turn a
 * spelling slip into a wrong action — and would hide the fact that the model
 * misread the catalog.
 */
export const suggestToolNames = (
  requested: string,
  knownToolNames: readonly string[],
): string[] => {
  // Scales with name length so a long FQN tolerates a couple of slips while a
  // short name does not collect unrelated neighbours.
  const threshold = Math.max(2, Math.floor(requested.length / 4))
  return knownToolNames
    .map((name) => ({ name, distance: editDistance(requested, name) }))
    .filter((entry) => entry.distance <= threshold)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.name)
}

export const unwrapInvokeToolArguments = ({
  args,
  apiType,
  knownToolNames,
}: {
  args: Record<string, unknown>
  apiType?: LLMProviderApiType | null
  /** Every tool this agent may call, for the unknown-name suggestion list. */
  knownToolNames: readonly string[]
}): InvokeToolUnwrapResult => {
  const rawName = args.tool_name
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    return {
      ok: false,
      error:
        'invoke_tool requires "tool_name" to be the fully-qualified name of a tool listed in <tool_catalog>.',
    }
  }
  const toolName = rawName.trim()

  if (!knownToolNames.includes(toolName)) {
    const suggestions = suggestToolNames(toolName, knownToolNames)
    const hint =
      suggestions.length > 0
        ? ` Did you mean: ${suggestions.join(', ')}?`
        : ' Check <tool_catalog> for the exact spelling.'
    return {
      ok: false,
      error: `No tool named "${toolName}" is available.${hint}`,
    }
  }

  const rawArgs = args.arguments
  if (isGeminiApiType(apiType)) {
    if (typeof rawArgs !== 'string') {
      return {
        ok: false,
        error: `On this provider, invoke_tool's "arguments" must be a JSON-encoded string; received ${typeof rawArgs}.`,
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(rawArgs)
    } catch (error) {
      return {
        ok: false,
        error: `invoke_tool received invalid JSON in "arguments": ${error instanceof Error ? error.message : String(error)}.`,
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        error: `invoke_tool expected "arguments" to encode an object, received ${Array.isArray(parsed) ? 'an array' : typeof parsed}.`,
      }
    }
    return { ok: true, toolName, args: parsed as Record<string, unknown> }
  }

  // A tool that legitimately takes no arguments is a normal case, so an
  // omitted `arguments` is treated as `{}` rather than as an error; the real
  // schema's own `required` list is what rejects a genuinely missing field.
  if (rawArgs === undefined || rawArgs === null) {
    return { ok: true, toolName, args: {} }
  }
  if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return {
      ok: false,
      error: `invoke_tool expected "arguments" to be an object, received ${Array.isArray(rawArgs) ? 'an array' : typeof rawArgs}.`,
    }
  }
  return { ok: true, toolName, args: rawArgs as Record<string, unknown> }
}
