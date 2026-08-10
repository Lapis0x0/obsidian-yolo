import type { App } from 'obsidian'

import type { AssistantWorkspaceScope } from '../../../types/assistant.types'
import type { VaultSearchStructuredOutcome } from '../../mcp/vaultSearchService'
import type { AggregatedSearchResult } from '../../search/searchResultAggregation'

import { createVaultBashSearch } from './vaultBashSearch'

const mockRunVaultSearchStructured = jest.fn<
  Promise<VaultSearchStructuredOutcome>,
  [unknown]
>()

jest.mock('../../mcp/vaultSearchService', () => ({
  runVaultSearchStructured: (options: unknown) =>
    mockRunVaultSearchStructured(options),
}))

const app = {} as App

const successOutcome = (
  results: AggregatedSearchResult[],
  fallbackReason?: string,
): VaultSearchStructuredOutcome => ({
  status: 'success',
  requestedMode: 'hybrid',
  effectiveMode: fallbackReason ? 'keyword' : 'hybrid',
  fallbackReason,
  scope: 'content',
  query: 'q',
  path: '',
  results,
})

describe('createVaultBashSearch', () => {
  beforeEach(() => {
    mockRunVaultSearchStructured.mockReset()
  })

  it('runs a hybrid search and flattens content groups into per-snippet entries', async () => {
    mockRunVaultSearchStructured.mockResolvedValue(
      successOutcome([
        {
          kind: 'content_group',
          path: 'notes/a.md',
          source: 'hybrid',
          score: 1,
          hitCount: 2,
          snippets: [
            { startLine: 3, endLine: 5, snippet: 'one', source: 'hybrid' },
            { line: 9, snippet: 'two', source: 'hybrid' },
          ],
        },
        { kind: 'file', path: 'notes/b.md', source: 'keyword' },
      ]),
    )
    const search = createVaultBashSearch({ app })

    const outcome = await search({ query: 'q', maxResults: 20 })

    expect(mockRunVaultSearchStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { query: 'q', path: undefined, maxResults: 20, mode: 'hybrid' },
      }),
    )
    expect(outcome).toEqual({
      status: 'success',
      notice: undefined,
      results: [
        {
          kind: 'content',
          path: 'notes/a.md',
          startLine: 3,
          endLine: 5,
          page: undefined,
          snippet: 'one',
        },
        {
          kind: 'content',
          path: 'notes/a.md',
          startLine: 9,
          endLine: undefined,
          page: undefined,
          snippet: 'two',
        },
        { kind: 'file', path: 'notes/b.md' },
      ],
    })
  })

  it('caps flattened entries at maxResults', async () => {
    mockRunVaultSearchStructured.mockResolvedValue(
      successOutcome([
        {
          kind: 'content_group',
          path: 'a.md',
          source: 'hybrid',
          score: 1,
          hitCount: 3,
          snippets: [
            { line: 1, snippet: 's1', source: 'hybrid' },
            { line: 2, snippet: 's2', source: 'hybrid' },
            { line: 3, snippet: 's3', source: 'hybrid' },
          ],
        },
      ]),
    )
    const search = createVaultBashSearch({ app })

    const outcome = await search({ query: 'q', maxResults: 2 })
    expect(outcome.status).toBe('success')
    if (outcome.status === 'success') {
      expect(outcome.results).toHaveLength(2)
    }
  })

  it('surfaces the keyword fallback reason as a notice', async () => {
    mockRunVaultSearchStructured.mockResolvedValue(
      successOutcome(
        [{ kind: 'file', path: 'a.md', source: 'keyword' }],
        'RAG is not enabled. Fell back to keyword search.',
      ),
    )
    const search = createVaultBashSearch({ app })

    const outcome = await search({ query: 'q', maxResults: 20 })
    expect(outcome.status).toBe('success')
    if (outcome.status === 'success') {
      expect(outcome.notice).toContain('Fell back to keyword search')
    }
  })

  it('enforces workspace scope on both the scope argument and result paths', async () => {
    const workspaceScope: AssistantWorkspaceScope = {
      enabled: true,
      include: ['notes'],
      exclude: [],
    }
    const search = createVaultBashSearch({ app, workspaceScope })

    const denied = await search({
      query: 'q',
      scopePath: 'private',
      maxResults: 20,
    })
    expect(denied).toEqual({
      status: 'error',
      message: "path is outside the allowed workspace scope: 'private'",
    })
    expect(mockRunVaultSearchStructured).not.toHaveBeenCalled()

    mockRunVaultSearchStructured.mockResolvedValue(
      successOutcome([
        { kind: 'file', path: 'notes/in.md', source: 'keyword' },
        { kind: 'file', path: 'private/out.md', source: 'keyword' },
      ]),
    )
    const outcome = await search({ query: 'q', maxResults: 20 })
    expect(outcome.status).toBe('success')
    if (outcome.status === 'success') {
      expect(outcome.results).toEqual([{ kind: 'file', path: 'notes/in.md' }])
    }
  })

  it('maps aborted and error outcomes to search errors', async () => {
    mockRunVaultSearchStructured.mockResolvedValueOnce({ status: 'aborted' })
    const search = createVaultBashSearch({ app })
    expect(await search({ query: 'q', maxResults: 20 })).toEqual({
      status: 'error',
      message: 'aborted',
    })

    mockRunVaultSearchStructured.mockResolvedValueOnce({
      status: 'error',
      error: 'Path not found: nope',
    })
    expect(
      await search({ query: 'q', scopePath: 'nope', maxResults: 20 }),
    ).toEqual({ status: 'error', message: 'Path not found: nope' })
  })
})
