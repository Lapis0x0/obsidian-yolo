import type { App } from 'obsidian'

import type { ChatMessage } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import type {
  CliSessionIndexEntry,
  CliSessionIndexStore,
} from './session-index'
import { getCliSessionIndexKey } from './session-index'
import { CliSessionService } from './session-service'

const app = {} as App

class MemoryIndex implements CliSessionIndexStore {
  entries = new Map<string, CliSessionIndexEntry>()

  async list(): Promise<CliSessionIndexEntry[]> {
    return [...this.entries.values()]
  }

  async get(ref: Parameters<CliSessionIndexStore['get']>[0]) {
    return this.entries.get(getCliSessionIndexKey(ref)) ?? null
  }

  async upsert(entry: CliSessionIndexEntry): Promise<void> {
    this.entries.set(getCliSessionIndexKey(entry), entry)
  }

  async update(
    ref: Parameters<CliSessionIndexStore['update']>[0],
    mutator: Parameters<CliSessionIndexStore['update']>[1],
  ): Promise<CliSessionIndexEntry> {
    const next = mutator(await this.get(ref))
    await this.upsert(next)
    return next
  }

  async remove(ref: Parameters<CliSessionIndexStore['remove']>[0]) {
    return this.entries.delete(getCliSessionIndexKey(ref))
  }
}

describe('CliSessionService', () => {
  it('records only the known native reference and YOLO display metadata', async () => {
    const index = new MemoryIndex()
    const service = new CliSessionService({ app, indexStore: index })
    const ref = {
      runtimeId: 'claude-code' as const,
      nativeSessionId: 'session-1',
      sessionPathHint: '/native/session-1.jsonl',
    }

    await service.recordOpenedSession({
      ref,
      messages: [],
      compactionBoundaries: [],
    })
    await service.rememberConfiguration(ref, {
      modelId: 'sonnet',
      reasoningEffort: 'high',
    })
    await service.rememberContextUsage(ref, {
      promptTokens: 12_000,
      maxContextTokens: 200_000,
      cacheHitRate: 0.75,
    })

    await expect(index.get(ref)).resolves.toEqual({
      runtimeId: 'claude-code',
      nativeSessionId: 'session-1',
      sessionPathHint: '/native/session-1.jsonl',
      modelId: 'sonnet',
      reasoningEffort: 'high',
      lastCacheHitRate: 0.75,
    })

    await expect(service.restoreSessionOverlay(ref, [])).resolves.toMatchObject(
      {
        lastCacheHitRate: 0.75,
      },
    )
  })

  it('restores YOLO-authored display content without storing the transcript', async () => {
    const index = new MemoryIndex()
    const service = new CliSessionService({ app, indexStore: index })
    const ref = { runtimeId: 'codex' as const, nativeSessionId: 'thread-1' }
    const transport = '<current_time>now</current_time>\n\n在吗'
    const content = {
      root: { children: [], type: 'root', version: 1 },
    } as never

    await service.recordUserDisplay(
      ref,
      transport,
      {
        role: 'user',
        id: 'local-user',
        content,
        promptContent: null,
        mentionables: [],
      },
      { modelId: 'gpt-5.6', reasoningEffort: 'high' },
    )

    await expect(
      service.restoreUserDisplays(ref, [
        {
          role: 'user',
          id: 'native-user',
          content: null,
          promptContent: transport,
          mentionables: [],
        },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'native-user',
        content,
        promptContent: null,
      }),
    ])

    await expect(
      service.restoreSessionOverlay(ref, [
        {
          role: 'user',
          id: 'native-user',
          content: null,
          promptContent: transport,
          mentionables: [],
        },
      ]),
    ).resolves.toMatchObject({
      turnConfigurationByUserMessageId: {
        'native-user': {
          modelId: 'gpt-5.6',
          reasoningEffort: 'high',
        },
      },
    })
  })

  it('restores Codex display content by client id when native history rewrites the transport text', async () => {
    const index = new MemoryIndex()
    const service = new CliSessionService({ app, indexStore: index })
    const ref = { runtimeId: 'codex' as const, nativeSessionId: 'thread-1' }
    const content = {
      root: { children: [], type: 'root', version: 1 },
    } as never

    await service.recordUserDisplay(
      ref,
      'transport before provider normalization',
      {
        role: 'user',
        id: 'local-user-id',
        content,
        promptContent: null,
        mentionables: [],
      },
    )

    await expect(
      service.restoreUserDisplays(ref, [
        {
          role: 'user',
          id: 'codex-user-client-local-user-id',
          content: null,
          promptContent: 'different native history representation',
          mentionables: [],
        },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'codex-user-client-local-user-id',
        content,
        promptContent: null,
      }),
    ])
  })

  it('hides YOLO environment context when no display overlay is available', async () => {
    const service = new CliSessionService({
      app,
      indexStore: new MemoryIndex(),
    })
    const ref = { runtimeId: 'codex' as const, nativeSessionId: 'thread-1' }

    await expect(
      service.restoreUserDisplays(ref, [
        {
          role: 'user',
          id: 'codex-user-client-missing-overlay',
          content: null,
          promptContent:
            '<yolo_environment_context>\n<context>hidden</context>\n' +
            '</yolo_environment_context>\n\nVisible message',
          mentionables: [],
        },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ promptContent: 'Visible message' }),
    ])
  })

  it('keeps repeated identical prompts bound to their own turn configuration', async () => {
    const index = new MemoryIndex()
    const service = new CliSessionService({ app, indexStore: index })
    const ref = { runtimeId: 'codex' as const, nativeSessionId: 'thread-1' }
    const transport = '继续'
    const firstContent = {
      root: { children: [], type: 'root', version: 1 },
    } as never
    const secondContent = {
      root: { children: [], direction: 'ltr', type: 'root', version: 1 },
    } as never

    await service.recordUserDisplay(
      ref,
      transport,
      {
        role: 'user',
        id: 'local-first',
        content: firstContent,
        promptContent: null,
        mentionables: [],
      },
      { modelId: 'gpt-5.6', reasoningEffort: 'high' },
    )
    await service.recordUserDisplay(
      ref,
      transport,
      {
        role: 'user',
        id: 'local-second',
        content: secondContent,
        promptContent: null,
        mentionables: [],
      },
      { modelId: 'gpt-5.6-mini', reasoningEffort: 'low' },
    )

    const restored = await service.restoreSessionOverlay(ref, [
      {
        role: 'user',
        id: 'native-first',
        content: null,
        promptContent: transport,
        mentionables: [],
      },
      {
        role: 'user',
        id: 'native-second',
        content: null,
        promptContent: transport,
        mentionables: [],
      },
    ])

    expect(restored.messages).toEqual([
      expect.objectContaining({ id: 'native-first', content: firstContent }),
      expect.objectContaining({ id: 'native-second', content: secondContent }),
    ])
    expect(restored.turnConfigurationByUserMessageId).toEqual({
      'native-first': { modelId: 'gpt-5.6', reasoningEffort: 'high' },
      'native-second': { modelId: 'gpt-5.6-mini', reasoningEffort: 'low' },
    })
    await expect(index.get(ref)).resolves.toMatchObject({
      turnOverlays: [
        { userMessage: { id: 'native-first' } },
        { userMessage: { id: 'native-second' } },
      ],
    })
  })

  it('removes only YOLO metadata for a deleted history record', async () => {
    const index = new MemoryIndex()
    const service = new CliSessionService({ app, indexStore: index })
    const ref = { runtimeId: 'codex' as const, nativeSessionId: 'thread-1' }
    await index.upsert(ref)

    await expect(service.removeOverlay(ref)).resolves.toBe(true)
    await expect(index.get(ref)).resolves.toBeNull()
  })

  it('restores persisted turn edit summaries onto native tool results', async () => {
    const index = new MemoryIndex()
    const service = new CliSessionService({ app, indexStore: index })
    const ref = {
      runtimeId: 'claude-code' as const,
      nativeSessionId: 'session-1',
    }
    await service.recordTurnEditSummary(ref, 'user-1', {
      files: [
        {
          path: 'src/a.ts',
          addedLines: 2,
          removedLines: 1,
          operation: 'edit',
          undoStatus: 'unavailable',
        },
      ],
      totalFiles: 1,
      totalAddedLines: 2,
      totalRemovedLines: 1,
      undoStatus: 'unavailable',
    })
    const messages: ChatMessage[] = [
      {
        role: 'user',
        id: 'user-1',
        content: null,
        promptContent: 'edit it',
        mentionables: [],
      },
      {
        role: 'assistant',
        id: 'assistant-1',
        content: '',
        toolCallRequests: [{ id: 'tool-1', name: 'Edit' }],
      },
      {
        role: 'tool',
        id: 'tool-message-1',
        toolCalls: [
          {
            request: { id: 'tool-1', name: 'Edit' },
            response: {
              status: ToolCallResponseStatus.Success,
              data: { type: 'text', text: 'done' },
            },
          },
        ],
      },
    ]

    const restored = await service.restoreUserDisplays(ref, messages)

    expect(restored[2]).toMatchObject({
      role: 'tool',
      toolCalls: [
        {
          response: {
            data: {
              metadata: {
                editSummary: { totalFiles: 1 },
              },
            },
          },
        },
      ],
    })
  })

  it('moves YOLO overlays when a provider rewrite changes native session id', async () => {
    const index = new MemoryIndex()
    const service = new CliSessionService({ app, indexStore: index })
    const previousRef = {
      runtimeId: 'claude-code' as const,
      nativeSessionId: 'session-old',
    }
    const nextRef = {
      runtimeId: 'claude-code' as const,
      nativeSessionId: 'session-new',
    }
    await service.rememberConfiguration(previousRef, {
      modelId: 'sonnet',
      reasoningEffort: 'high',
    })
    await service.recordUserDisplay(previousRef, 'keep', {
      role: 'user',
      id: 'user-keep',
      content: null,
      promptContent: 'keep',
      mentionables: [],
    })
    await service.recordUserDisplay(previousRef, 'discard', {
      role: 'user',
      id: 'user-discard',
      content: null,
      promptContent: 'discard',
      mentionables: [],
    })

    await service.rebindOverlay(previousRef, nextRef, ['user-discard'])
    await service.rebindOverlay(previousRef, nextRef, ['user-discard'])

    await expect(index.get(nextRef)).resolves.toMatchObject({
      runtimeId: 'claude-code',
      nativeSessionId: 'session-new',
      modelId: 'sonnet',
      reasoningEffort: 'high',
      turnOverlays: [{ userMessage: { id: 'user-keep' } }],
    })
  })
})
