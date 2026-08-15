// Proves the ported `web_search` / `web_scrape` `execute()` implementations
// (src/core/tools/web_search/definition.ts, web_scrape/definition.ts) behave
// identically to the still-present `case 'web_search'` / `case 'web_scrape'`
// branches of `callLocalFileTool` they were copied from — per D6 batch 5's
// exit condition. Also proves `web_search`'s `isAvailable` matches the
// provider-readiness gate ported from `mcpManager.ts`'s `isLocalToolEnabled`,
// and that `web_scrape` has no such gate (master.md §3.1b).
//
// `callLocalFileTool` is NOT the delegation boundary (D6a fix) — see
// context-tools-equivalence.test.ts's doc comment for the full explanation.
// `registry.test.ts`'s `isBuiltinToolName` coverage is what proves these
// tools actually route through the new path at the real call site.

jest.mock('obsidian')

jest.mock('../web-search', () => {
  const actual = jest.requireActual('../web-search')
  return {
    ...actual,
    runWebSearch: jest.fn(),
    runWebScrape: jest.fn(),
  }
})

import { App } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { callLocalFileTool, getLocalFileTools } from '../mcp/localFileTools'
import { runWebScrape, runWebSearch } from '../web-search'

import { executeBuiltinTool } from './dispatcher'
import type { ToolContext } from './types'
import { webScrapeDefinition } from './web_scrape/definition'
import { webSearchDefinition } from './web_search/definition'

const app = {} as App

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return { app, ...overrides }
}

const buildSettings = (
  overrides?: Partial<YoloSettings['webSearch']>,
): YoloSettings =>
  ({
    webSearch: {
      providers: [],
      common: { resultSize: 5, scrapeTimeoutMs: 10_000 },
      ...overrides,
    },
  }) as unknown as YoloSettings

afterEach(() => {
  ;(runWebSearch as jest.Mock).mockReset()
  ;(runWebScrape as jest.Mock).mockReset()
})

describe('web_search execute() vs callLocalFileTool', () => {
  it('same result for a successful search', async () => {
    ;(runWebSearch as jest.Mock).mockResolvedValue({
      answer: 'Paris',
      items: [{ id: 'abc123', title: 'France', url: 'https://x', text: 't' }],
      providerName: 'Tavily',
    })
    const settings = buildSettings()
    const args = { query: 'capital of France' }

    const oldResult = await callLocalFileTool({
      app,
      settings,
      toolName: 'web_search',
      args,
    })
    const newResult = await webSearchDefinition.execute(
      args,
      makeCtx({ settings }),
    )

    expect(newResult).toEqual(oldResult)
    expect(oldResult.status).toBe(ToolCallResponseStatus.Success)
    if (oldResult.status === ToolCallResponseStatus.Success) {
      expect(oldResult.text).toContain('"provider": "Tavily"')
    }
  })

  it('empty query: old wraps to an Error result, new throws for the dispatcher to normalize', async () => {
    const settings = buildSettings()
    const args = { query: '   ' }

    const oldResult = await callLocalFileTool({
      app,
      settings,
      toolName: 'web_search',
      args,
    })
    expect(oldResult).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'query cannot be empty.',
    })

    await expect(
      webSearchDefinition.execute(args, makeCtx({ settings })),
    ).rejects.toThrow('query cannot be empty.')
    expect(runWebSearch).not.toHaveBeenCalled()
  })

  it('missing settings: old wraps to an Error result, new throws for the dispatcher to normalize', async () => {
    const args = { query: 'x' }

    const oldResult = await callLocalFileTool({
      app,
      toolName: 'web_search',
      args,
    })
    expect(oldResult).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'Web search is unavailable: settings not loaded.',
    })

    await expect(webSearchDefinition.execute(args, makeCtx())).rejects.toThrow(
      'Web search is unavailable: settings not loaded.',
    )
  })
})

describe('web_scrape execute() vs callLocalFileTool', () => {
  it('same result for a successful scrape', async () => {
    ;(runWebScrape as jest.Mock).mockResolvedValue({
      url: 'https://x',
      title: 'X',
      content: 'body',
      providerName: 'Generic',
    })
    const settings = buildSettings()
    const args = { url: 'https://x' }

    const oldResult = await callLocalFileTool({
      app,
      settings,
      toolName: 'web_scrape',
      args,
    })
    const newResult = await webScrapeDefinition.execute(
      args,
      makeCtx({ settings }),
    )

    expect(newResult).toEqual(oldResult)
    expect(oldResult.status).toBe(ToolCallResponseStatus.Success)
  })

  it('empty url: old wraps to an Error result, new throws for the dispatcher to normalize', async () => {
    const settings = buildSettings()
    const args = { url: '' }

    const oldResult = await callLocalFileTool({
      app,
      settings,
      toolName: 'web_scrape',
      args,
    })
    expect(oldResult).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'url cannot be empty.',
    })

    await expect(
      webScrapeDefinition.execute(args, makeCtx({ settings })),
    ).rejects.toThrow('url cannot be empty.')
    expect(runWebScrape).not.toHaveBeenCalled()
  })
})

describe('executeBuiltinTool (dispatcher) vs callLocalFileTool end-to-end', () => {
  it('matches for a successful web_search call', async () => {
    ;(runWebSearch as jest.Mock).mockResolvedValue({
      items: [],
      providerName: 'Tavily',
    })
    const settings = buildSettings()
    const args = { query: 'x' }

    const oldResult = await callLocalFileTool({
      app,
      settings,
      toolName: 'web_search',
      args,
    })
    const newResult = await executeBuiltinTool(
      'web_search',
      args,
      makeCtx({ settings }),
    )

    expect(newResult).toEqual(oldResult)
  })

  it('matches for a successful web_scrape call', async () => {
    ;(runWebScrape as jest.Mock).mockResolvedValue({
      url: 'https://x',
      content: 'c',
      providerName: 'Generic',
    })
    const settings = buildSettings()
    const args = { url: 'https://x' }

    const oldResult = await callLocalFileTool({
      app,
      settings,
      toolName: 'web_scrape',
      args,
    })
    const newResult = await executeBuiltinTool(
      'web_scrape',
      args,
      makeCtx({ settings }),
    )

    expect(newResult).toEqual(oldResult)
  })
})

describe('web_search / web_scrape static schema (getMcpTool)', () => {
  it('matches the still-live getLocalFileTools() projection (drift guard)', () => {
    const liveTools = getLocalFileTools()

    const liveWebSearch = liveTools.find((tool) => tool.name === 'web_search')
    expect(liveWebSearch).toBeDefined()
    const { name: _n1, ...liveWebSearchRest } = liveWebSearch!
    expect(webSearchDefinition.getMcpTool({})).toEqual(liveWebSearchRest)

    const liveWebScrape = liveTools.find((tool) => tool.name === 'web_scrape')
    expect(liveWebScrape).toBeDefined()
    const { name: _n2, ...liveWebScrapeRest } = liveWebScrape!
    expect(webScrapeDefinition.getMcpTool({})).toEqual(liveWebScrapeRest)
  })
})

describe('web_search isAvailable — provider readiness (master.md §3.1b)', () => {
  it('is available when a search provider is configured', () => {
    const settings = buildSettings({
      providers: [{ id: 'p1', name: 'Tavily' }],
      defaultProviderId: 'p1',
    } as never)

    expect(webSearchDefinition.isAvailable?.({ settings })).toBe(true)
  })

  it('is unavailable when no search provider is configured', () => {
    const settings = buildSettings({ providers: [] })

    expect(webSearchDefinition.isAvailable?.({ settings })).toBe(false)
  })

  it('is unavailable when settings are missing entirely', () => {
    expect(webSearchDefinition.isAvailable?.({})).toBe(false)
  })
})

describe('web_scrape has no isAvailable gate (master.md §3.1b)', () => {
  it('declares no isAvailable at all — always available regardless of provider config', () => {
    expect(webScrapeDefinition.isAvailable).toBeUndefined()
  })
})
