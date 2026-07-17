import { parseToolName } from '../../../core/mcp/tool-name-utils'
import {
  type ToolCallRequest,
  getToolCallArgumentsObject,
} from '../../../types/tool-call.types'

/**
 * Approval-block summary for a subagent tool call. Returned shape:
 *   { label, detail }
 *   - label: short tool name shown as the row title (e.g. "fs_edit", "terminal_command")
 *   - detail: single-line argument summary (file path, command, query, …),
 *            truncated to ~80 chars so the approval block stays compact.
 *
 * We deliberately avoid rendering the full JSON args; the detail modal still
 * exposes everything for users who need to dig deeper.
 */
export type SubagentApprovalSummary = {
  label: string
  detail?: string
}

const truncate = (text: string, max = 80): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1)}…`
}

const stringArg = (
  args: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = args?.[key]
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined
}

export function buildSubagentApprovalSummary(
  request: ToolCallRequest,
): SubagentApprovalSummary {
  let toolShortName = request.name
  try {
    toolShortName = parseToolName(request.name).toolName
  } catch {
    // Use the raw FQN as the label fallback.
  }

  const args = getToolCallArgumentsObject(request.arguments) ?? undefined
  const summary: SubagentApprovalSummary = { label: toolShortName }

  switch (toolShortName) {
    case 'fs_edit':
    case 'fs_read':
    case 'fs_list':
    case 'fs_create':
    case 'fs_delete':
    case 'fs_move':
    case 'fs_copy': {
      const path = stringArg(args, 'path') ?? stringArg(args, 'target')
      if (path) summary.detail = truncate(path)
      break
    }
    case 'fs_search': {
      const query = stringArg(args, 'query')
      const scope = stringArg(args, 'scope')
      if (query)
        summary.detail = truncate(scope ? `${scope} | ${query}` : query)
      else if (scope) summary.detail = scope
      break
    }
    case 'terminal_command': {
      const command = stringArg(args, 'command')
      if (command) summary.detail = truncate(command)
      break
    }
    case 'js_eval': {
      const code = stringArg(args, 'code')
      const language = stringArg(args, 'language')
      if (code) {
        summary.detail = truncate(language ? `${language} | ${code}` : code)
      } else if (language) {
        summary.detail = language
      }
      break
    }
    case 'web_search':
    case 'rag_search': {
      const query = stringArg(args, 'query')
      if (query) summary.detail = truncate(query)
      break
    }
    case 'web_scrape':
    case 'web_fetch': {
      const url = stringArg(args, 'url')
      if (url) summary.detail = truncate(url)
      break
    }
    default: {
      // Unknown / external tool: surface the first non-empty string argument
      // so the user has at least one identifying piece of information.
      if (args) {
        for (const value of Object.values(args)) {
          if (typeof value === 'string' && value.trim().length > 0) {
            summary.detail = truncate(value)
            break
          }
        }
      }
    }
  }

  return summary
}
