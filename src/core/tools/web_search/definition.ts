import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { isWebSearchToolReady, runWebSearch } from '../../web-search'
import { defineTool } from '../define'
import { formatJsonResult, getOptionalTextArg, getTextArg } from '../tool-args'

// Schema copied verbatim from the `web_search` entry in `getLocalFileTools()`
// (`src/core/mcp/localFileTools.ts`).
const WEB_SEARCH_MCP_TOOL: Omit<McpTool, 'name'> = {
  description:
    'Search the web for up-to-date or specific information using the configured search provider. ' +
    'Returns { answer?, items: [{ id, title, url, text }] }. ' +
    'When citing a fact taken from a result, append `[citation,domain](id)` immediately after the sentence; ' +
    'example: "The capital of France is Paris. [citation,example.com](abc123)".',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language search query.',
      },
      topic: {
        type: 'string',
        enum: ['general', 'news', 'finance'],
        description:
          'Optional topic hint. Some providers (e.g. Tavily) use this to bias results; others ignore it.',
      },
    },
    required: ['query'],
  },
}

export const webSearchDefinition = defineTool({
  name: 'web_search',
  getMcpTool: () => WEB_SEARCH_MCP_TOOL,
  // Provider-readiness gate, ported verbatim from `isLocalToolEnabled`
  // (`src/core/mcp/mcpManager.ts`) — the one pre-existing genuine
  // `isAvailable` use case (master.md §3.1b: "provider 维度——现成，纯搬运").
  // `web_scrape` deliberately has NO such gate: it falls back to the generic
  // static-HTML scraper when no provider is configured (see
  // `web_scrape/definition.ts`'s doc comment).
  isAvailable: (ctx) =>
    ctx.settings ? isWebSearchToolReady(ctx.settings.webSearch) : false,
  chatLabel: {
    key: 'settings.agent.builtinWebSearchLabel',
    fallback: 'Web Search',
  },
  contextPrunable: true,
  // Ported verbatim from the `case 'web_search'` branch of
  // `callLocalFileTool` (`src/core/mcp/localFileTools.ts`), minus the abort
  // check / workspace-scope / YOLO-data-root guards and the outer try/catch
  // that normalizes thrown errors to an Error-status result — those are
  // dispatcher responsibilities (master.md §3.4), not tool semantics.
  execute: async (args, ctx) => {
    const { settings, signal } = ctx
    if (!settings) {
      throw new Error('Web search is unavailable: settings not loaded.')
    }
    const query = getTextArg(args, 'query').trim()
    if (!query) {
      throw new Error('query cannot be empty.')
    }
    const topic = getOptionalTextArg(args, 'topic')?.trim() || undefined
    const result = await runWebSearch({
      settings: settings.webSearch,
      query,
      topic,
      signal,
    })
    const itemsWithIndex = result.items.map((it, idx) => ({
      id: it.id,
      index: idx + 1,
      title: it.title,
      url: it.url,
      text: it.text,
    }))
    return {
      status: ToolCallResponseStatus.Success,
      text: formatJsonResult({
        tool: 'web_search',
        provider: result.providerName,
        answer: result.answer,
        items: itemsWithIndex,
      }),
    }
  },
})
