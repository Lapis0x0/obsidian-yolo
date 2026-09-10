jest.mock('obsidian')

import { FileSystemAdapter } from 'obsidian'
import type { App } from 'obsidian'

import type { YoloSettings } from '../../../settings/schema/setting.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import type { VaultSearchStructuredOutcome } from '../../mcp/vaultSearchService'
import type { AggregatedSearchResult } from '../../search/searchResultAggregation'
import type { ToolContext } from '../types'

import { vaultSearchDefinition } from './definition'

const mockRunVaultSearchStructured = jest.fn<
  Promise<VaultSearchStructuredOutcome>,
  [{ args: Record<string, unknown> }]
>()

jest.mock('../../mcp/vaultSearchService', () => ({
  runVaultSearchStructured: (options: { args: Record<string, unknown> }) =>
    mockRunVaultSearchStructured(options),
}))

const VAULT = '/Users/me/vault'

const app = (() => {
  const adapter = new FileSystemAdapter()
  adapter.getBasePath = () => VAULT
  return { vault: { adapter } } as unknown as App
})()

const ctx = { app } as ToolContext

const successOutcome = (
  results: AggregatedSearchResult[],
  fallbackReason?: string,
): VaultSearchStructuredOutcome => ({
  status: 'success',
  requestedMode: 'hybrid',
  effectiveMode: fallbackReason ? 'keyword' : 'hybrid',
  fallbackReason,
  scope: fallbackReason ? 'all' : 'content',
  query: 'q',
  path: '',
  results,
})

const parseResult = (text: string): Record<string, unknown> =>
  JSON.parse(text) as Record<string, unknown>

describe('vault_search', () => {
  beforeEach(() => {
    mockRunVaultSearchStructured.mockReset()
    mockRunVaultSearchStructured.mockResolvedValue(successOutcome([]))
  })

  it('runs a hybrid search and passes a vault-relative path through unchanged', async () => {
    await vaultSearchDefinition.execute(
      { query: 'q', path: 'notes', maxResults: 5 },
      ctx,
    )

    expect(mockRunVaultSearchStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        args: {
          query: 'q',
          path: 'notes',
          maxResults: 5,
          mode: 'hybrid',
          knowledgeBase: undefined,
        },
      }),
    )
  })

  it('converts an absolute path inside the vault to a vault-relative one', async () => {
    await vaultSearchDefinition.execute(
      { query: 'q', path: `${VAULT}/notes/a.md` },
      ctx,
    )

    expect(mockRunVaultSearchStructured.mock.calls[0][0].args.path).toBe(
      'notes/a.md',
    )
  })

  it('treats the vault root itself as no path scope at all', async () => {
    await vaultSearchDefinition.execute({ query: 'q', path: VAULT }, ctx)

    expect(mockRunVaultSearchStructured.mock.calls[0][0].args.path).toBe(
      undefined,
    )
  })

  it('rejects an absolute path outside the vault instead of searching the whole vault', async () => {
    await expect(
      vaultSearchDefinition.execute({ query: 'q', path: '/etc' }, ctx),
    ).rejects.toThrow(/outside the vault/)
    expect(mockRunVaultSearchStructured).not.toHaveBeenCalled()
  })

  it('reports the keyword fallback as a successful result rather than an error', async () => {
    mockRunVaultSearchStructured.mockResolvedValue(
      successOutcome(
        [{ kind: 'file', path: 'notes/a.md', source: 'keyword' }],
        'No embedding model is configured. Fell back to keyword search.',
      ),
    )

    const result = await vaultSearchDefinition.execute({ query: 'q' }, ctx)

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    const payload = parseResult(
      (result as { status: ToolCallResponseStatus.Success; text: string }).text,
    )
    expect(payload.effectiveMode).toBe('keyword')
    expect(payload.fallbackReason).toContain('Fell back to keyword search')
    expect(payload.results).toHaveLength(1)
  })

  it('drops a result the workspace scope does not allow, even though the service already filters', async () => {
    mockRunVaultSearchStructured.mockResolvedValue(
      successOutcome([
        { kind: 'file', path: 'allowed/a.md', source: 'keyword' },
        { kind: 'file', path: 'secret/b.md', source: 'keyword' },
      ]),
    )

    const result = await vaultSearchDefinition.execute({ query: 'q' }, {
      app,
      workspaceScope: { enabled: true, include: ['allowed'], exclude: [] },
      settings: {} as YoloSettings,
    } as ToolContext)

    const payload = parseResult(
      (result as { status: ToolCallResponseStatus.Success; text: string }).text,
    )
    expect(payload.results).toEqual([
      { kind: 'file', path: 'allowed/a.md', source: 'keyword' },
    ])
  })

  it('refuses a scope path the workspace scope excludes before running a search', async () => {
    const result = await vaultSearchDefinition.execute(
      { query: 'q', path: 'secret' },
      {
        app,
        workspaceScope: { enabled: true, include: ['allowed'], exclude: [] },
        settings: {} as YoloSettings,
      } as ToolContext,
    )

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    expect(mockRunVaultSearchStructured).not.toHaveBeenCalled()
  })
})
