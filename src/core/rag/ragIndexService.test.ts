import { BackgroundActivityRegistry } from '../background/backgroundActivityRegistry'

import { RagIndexBusyError, RagIndexService } from './ragIndexService'

const waitForNextTick = async () =>
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('RagIndexService', () => {
  it('restores interrupted running state as failed on initialize', async () => {
    const saved: Record<string, string> = {
      smtcmp_rag_index_run: JSON.stringify({
        runId: 'old-run',
        status: 'running',
        mode: 'incremental',
        trigger: 'auto',
      }),
    }

    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn((key: string) => saved[key] ?? null),
        saveLocalStorage: jest.fn((key: string, value: string) => {
          saved[key] = value
        }),
      } as never,
      getRagEngine: jest.fn(),
      activityRegistry: new BackgroundActivityRegistry(),
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()

    expect(service.getSnapshot()).toMatchObject({
      status: 'failed',
      failureKind: 'unknown',
    })
  })

  it('publishes progress and blocks concurrent runs', async () => {
    let resolveRun: () => void = () => undefined
    const updateVaultIndex = jest.fn().mockImplementation(
      async (
        _options: unknown,
        onProgress?: (progress: {
          type: 'indexing'
          indexProgress: {
            completedChunks: number
            totalChunks: number
            totalFiles: number
            completedFiles: number
            currentFile: string
          }
        }) => void,
      ) => {
        onProgress?.({
          type: 'indexing',
          indexProgress: {
            completedChunks: 1,
            totalChunks: 2,
            totalFiles: 1,
            completedFiles: 0,
            currentFile: 'foo.md',
          },
        })
        await new Promise<void>((resolve) => {
          resolveRun = resolve
        })
      },
    )
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(null),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()
    const firstRun = service.runIndex({ reindexAll: false, trigger: 'manual' })

    await waitForNextTick()
    expect(service.getSnapshot()).toMatchObject({
      status: 'running',
      currentFile: 'foo.md',
      completedChunks: 1,
    })

    await expect(
      service.runIndex({ reindexAll: false, trigger: 'manual' }),
    ).rejects.toBeInstanceOf(RagIndexBusyError)

    resolveRun()
    await firstRun

    expect(service.getSnapshot()).toMatchObject({
      status: 'completed',
    })
  })
})
