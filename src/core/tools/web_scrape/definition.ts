import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { runWebScrape } from '../../web-search'
import { defineTool } from '../define'
import { formatJsonResult, getTextArg } from '../tool-args'

// Schema copied verbatim from the `web_scrape` entry in `getLocalFileTools()`
// (`src/core/mcp/localFileTools.ts`).
const WEB_SCRAPE_MCP_TOOL: Omit<McpTool, 'name'> = {
  description:
    'Fetch the full content of a single web page (markdown when the provider supports it). ' +
    'Use this only when search snippets are insufficient. Returns { url, title?, content }.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Absolute http(s) URL to fetch.',
      },
    },
    required: ['url'],
  },
}

export const webScrapeDefinition = defineTool({
  name: 'web_scrape',
  getMcpTool: () => WEB_SCRAPE_MCP_TOOL,
  // Deliberately no `isAvailable` — unlike `web_search`, `web_scrape` does
  // NOT gate on a configured search provider: `runWebScrape` falls back to
  // the generic static-HTML scraper (`core/web-search/genericScrape.ts`)
  // when no provider is configured, so it stays usable either way. Ported
  // verbatim from `isLocalToolEnabled`'s comment in
  // `src/core/mcp/mcpManager.ts` (master.md §3.1b).
  chatLabel: {
    key: 'settings.agent.builtinWebScrapeLabel',
    fallback: 'Web Scrape',
  },
  contextPrunable: true,
  // Ported verbatim from the `case 'web_scrape'` branch of
  // `callLocalFileTool` (`src/core/mcp/localFileTools.ts`), minus the abort
  // check / workspace-scope / YOLO-data-root guards and the outer try/catch
  // that normalizes thrown errors to an Error-status result — those are
  // dispatcher responsibilities (master.md §3.4), not tool semantics.
  execute: async (args, ctx) => {
    const { settings, signal } = ctx
    if (!settings) {
      throw new Error('Web scrape is unavailable: settings not loaded.')
    }
    const url = getTextArg(args, 'url').trim()
    if (!url) {
      throw new Error('url cannot be empty.')
    }
    const result = await runWebScrape({
      settings: settings.webSearch,
      url,
      signal,
    })
    return {
      status: ToolCallResponseStatus.Success,
      text: formatJsonResult({
        tool: 'web_scrape',
        provider: result.providerName,
        url: result.url,
        title: result.title,
        content: result.content,
      }),
    }
  },
})
