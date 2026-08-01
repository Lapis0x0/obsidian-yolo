import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ChatUserMessage } from '../../types/chat'
import { generateConversationTitleText } from '../../utils/chat/generateConversationTitle'

import type { CliRuntimeScope } from './coordinator'
import { ensureCliSessionAutoTitle } from './session-title'

jest.mock('../../utils/chat/generateConversationTitle', () => ({
  AUTO_TITLE_FAILURE_COOLDOWN_MS: 5 * 60 * 1000,
  generateConversationTitleText: jest.fn(),
}))

const generateTitle = generateConversationTitleText as jest.MockedFunction<
  typeof generateConversationTitleText
>

const settings = {} as YoloSettings
const userMessage: ChatUserMessage = {
  role: 'user',
  id: 'user-1',
  content: null,
  promptContent: 'First prompt',
  mentionables: [],
}

describe('ensureCliSessionAutoTitle', () => {
  let warn: jest.SpyInstance

  beforeEach(() => {
    generateTitle.mockReset()
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warn.mockRestore()
  })

  it('resolves false instead of rejecting when the overlay cannot be read', async () => {
    const scope = {
      sessionService: {
        getOverlayTitle: jest.fn(async () => {
          throw new Error('read failed')
        }),
      },
    } as unknown as CliRuntimeScope

    await expect(
      ensureCliSessionAutoTitle({
        settings,
        language: 'en',
        scope,
        sessionRef: {
          runtimeId: 'codex',
          nativeSessionId: 'read-failure',
        },
        userMessage,
      }),
    ).resolves.toBe(false)
    expect(generateTitle).not.toHaveBeenCalled()
  })

  it('releases its in-flight ownership after an overlay write failure', async () => {
    const applyGeneratedTitle = jest
      .fn()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce({ overlayWritten: true, nativeRenamed: false })
    const scope = {
      sessionService: {
        getOverlayTitle: jest.fn(async () => null),
        applyGeneratedTitle,
      },
    } as unknown as CliRuntimeScope
    generateTitle.mockResolvedValue({ ok: true, title: 'Generated title' })
    const input = {
      settings,
      language: 'en',
      scope,
      sessionRef: {
        runtimeId: 'codex' as const,
        nativeSessionId: 'write-failure',
      },
      userMessage,
    }

    await expect(ensureCliSessionAutoTitle(input)).resolves.toBe(false)
    await expect(ensureCliSessionAutoTitle(input)).resolves.toBe(true)
    expect(generateTitle).toHaveBeenCalledTimes(2)
  })

  it('does not let skipped callers release another generation lock', async () => {
    let resolveGeneration!: (value: { ok: true; title: string }) => void
    generateTitle.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGeneration = resolve
        }),
    )
    const scope = {
      sessionService: {
        getOverlayTitle: jest.fn(async () => null),
        applyGeneratedTitle: jest.fn(async () => ({
          overlayWritten: true as const,
          nativeRenamed: false,
        })),
      },
    } as unknown as CliRuntimeScope
    const input = {
      settings,
      language: 'en',
      scope,
      sessionRef: {
        runtimeId: 'codex' as const,
        nativeSessionId: 'concurrent-generation',
      },
      userMessage,
    }

    const first = ensureCliSessionAutoTitle(input)
    await Promise.resolve()
    await expect(ensureCliSessionAutoTitle(input)).resolves.toBe(false)
    await expect(ensureCliSessionAutoTitle(input)).resolves.toBe(false)
    expect(generateTitle).toHaveBeenCalledTimes(1)

    resolveGeneration({ ok: true, title: 'Generated title' })
    await expect(first).resolves.toBe(true)
  })
})
