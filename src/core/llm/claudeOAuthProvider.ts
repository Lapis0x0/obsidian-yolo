import type { Options } from '@yolo/claude-agent-sdk-runtime'

import { ChatModel } from '../../types/chat-model.types'
import {
  LLMOptions,
  LLMRequestNonStreaming,
  LLMRequestStreaming,
  NativeToolPolicy,
  RequestMessage,
} from '../../types/llm/request'
import {
  LLMResponseNonStreaming,
  LLMResponseStreaming,
} from '../../types/llm/response'
import { ProviderSession } from '../../types/provider-session.types'
import { LLMProvider } from '../../types/provider.types'
import { loadClaudeAgentSdk } from '../cli-runtime/claude/sdk-loader'
import { isCliRuntimeAvailable } from '../cli-runtime/desktop'

import { parseUserMessageContent } from './anthropic'
import { BaseLLMProvider } from './base'
import { getClaudeSdkVaultPath } from './claude-sdk/host'
import { ClaudeTurnMapper } from './claude-sdk/messageMapping'
import {
  ClaudeSessionSpec,
  claudeSdkSessionPool,
} from './claude-sdk/sessionPool'
import {
  LLMAPIKeyNotSetException,
  LLMProviderNotConfiguredException,
} from './exception'

/**
 * Tools a `read-only` turn may use.
 *
 * Not the empty set: Ask mode's promise is "do not change my vault", not "do
 * not look at it" — a Claude that cannot read the notes being discussed is
 * worse than YOLO's own Ask mode, which can.
 */
const READ_ONLY_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
]

/**
 * Claude Code's OAuth quota, consumed through the Claude Agent SDK.
 *
 * The SDK is the only sanctioned way to spend a `claude setup-token` token, so
 * this provider does not speak HTTP at all: `query()` drives a `claude`
 * subprocess, and the subprocess runs Claude Code's own agent loop with its
 * own tools. That is the deliberate shape — YOLO's tool gateway does not
 * participate, and the tools the subprocess runs arrive back as
 * `providerToolRun` receipts rather than as `tool_calls` for YOLO to execute a
 * second time.
 *
 * Conversation history, compaction and resume/fork all live inside the SDK,
 * which keeps its own transcript on disk. YOLO persists only a
 * `ProviderSession` pointing at it (see `LLMOptions.session`), the same way it
 * does for CLI runtimes.
 */
export class ClaudeOAuthProvider extends BaseLLMProvider<LLMProvider> {
  constructor(provider: LLMProvider) {
    super(provider)
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    const stream = await this.streamResponse(
      model,
      { ...request, stream: true },
      options,
    )

    let content = ''
    let reasoning = ''
    let finishReason: string | null = null
    let usage: LLMResponseNonStreaming['usage']
    let id = ''

    // Tool runs are dropped here on purpose. They are positional — a run
    // belongs between two parts of the answer — and a non-streaming response
    // is a single finished message with nowhere to put them. Callers that
    // need to see the provider's work stream instead.
    for await (const chunk of stream) {
      id ||= chunk.id
      if (chunk.usage) usage = chunk.usage
      const choice = chunk.choices[0]
      if (!choice) continue
      if (choice.delta.content) content += choice.delta.content
      if (choice.delta.reasoning) reasoning += choice.delta.reasoning
      if (choice.finish_reason) finishReason = choice.finish_reason
    }

    return {
      id,
      model: model.model,
      object: 'chat.completion',
      ...(usage ? { usage } : {}),
      choices: [
        {
          finish_reason: finishReason,
          message: {
            role: 'assistant',
            content,
            ...(reasoning ? { reasoning } : {}),
          },
        },
      ],
    }
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    if (!isCliRuntimeAvailable()) {
      throw new LLMProviderNotConfiguredException(
        'Claude runs a local subprocess and is only available on desktop.',
      )
    }
    const oauthToken = this.provider.apiKey?.trim()
    if (!oauthToken) {
      throw new LLMAPIKeyNotSetException(
        `Claude OAuth token is missing. Connect your Claude account in settings (${this.provider.id}).`,
      )
    }

    const vaultPath = getClaudeSdkVaultPath()
    const sdk = await loadClaudeAgentSdk()
    const { resolveClaudeProcessSupport } = await import(
      '../cli-runtime/claude/process'
    )
    const processSupport = await resolveClaudeProcessSupport({ oauthToken })

    const policy: NativeToolPolicy = options?.nativeToolPolicy ?? 'read-only'
    const systemPrompt = extractSystemPrompt(request.messages)
    const accessor = options?.session
    const stored = await accessor?.read()
    const usableSession =
      stored && stored.providerId === this.provider.id ? stored : undefined

    const startupFingerprint = JSON.stringify([policy, systemPrompt])
    const spec: ClaudeSessionSpec = {
      key: usableSession?.nativeSessionId
        ? `session:${usableSession.nativeSessionId}`
        : `turn:${accessor?.turnId ?? Math.random().toString(36)}`,
      model: model.model,
      startupFingerprint,
      ...resolveResumeTarget(usableSession, accessor?.parentTurnId),
    }

    const buildOptions = (resolved: ClaudeSessionSpec): Options => ({
      cwd: vaultPath,
      pathToClaudeCodeExecutable: processSupport.cliPath,
      env: processSupport.env,
      spawnClaudeCodeProcess: processSupport.spawnClaudeCodeProcess,
      includePartialMessages: true,
      model: resolved.model,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...toolOptionsFor(policy),
      ...(resolved.resume
        ? {
            resume: resolved.resume,
            ...(resolved.resumeAt
              ? { resumeSessionAt: resolved.resumeAt, forkSession: true }
              : {}),
          }
        : {}),
    })

    const session = await claudeSdkSessionPool.acquire({
      sdk,
      processSupport,
      spec,
      buildOptions,
    })

    // A brand-new session has none of the conversation that came before it.
    // That only happens when a conversation reaches this provider without a
    // session of its own — a fresh chat, or one whose earlier turns ran on a
    // different model. Carrying the earlier turns in with the first message is
    // a one-time handover, not a second copy of the history: from here on the
    // SDK's own transcript is the only one that grows.
    const handover =
      spec.resume === undefined ? renderPriorTurns(request.messages) : undefined
    const content = buildTurnContent(request.messages, handover)

    return this.consume({
      session,
      content,
      model,
      spec,
      accessor,
      stored: usableSession,
      options,
    })
  }

  private async *consume({
    session,
    content,
    model,
    spec,
    accessor,
    stored,
    options,
  }: {
    session: Awaited<ReturnType<typeof claudeSdkSessionPool.acquire>>
    content: ReturnType<typeof buildTurnContent>
    model: ChatModel
    spec: ClaudeSessionSpec
    accessor: LLMOptions['session']
    stored: ProviderSession | undefined
    options?: LLMOptions
  }): AsyncGenerator<LLMResponseStreaming> {
    const mapper = new ClaudeTurnMapper(
      `claude-sdk-${Date.now().toString(36)}`,
      model.model,
    )
    const onAbort = () => {
      void session.interrupt().catch(() => {})
    }
    options?.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      for await (const message of session.turn(content)) {
        const chunk = mapper.map(message)
        if (chunk) yield chunk
      }

      const { sessionId, lastUuid, error } = mapper.observation
      if (sessionId) {
        session.sessionId = sessionId
        if (accessor) {
          accessor.write({
            providerId: this.provider.id,
            nativeSessionId: sessionId,
            anchors: {
              ...(stored?.anchors ?? {}),
              ...(lastUuid ? { [accessor.turnId]: lastUuid } : {}),
            },
            tipTurnId: accessor.turnId,
          })
        }
      }
      if (error) throw new Error(error)
    } finally {
      options?.signal?.removeEventListener('abort', onAbort)
      claudeSdkSessionPool.release(spec.key)
    }
  }

  getEmbedding(
    _model: string,
    _text: string,
    _options?: { dimensions?: number },
  ): Promise<number[]> {
    throw new LLMProviderNotConfiguredException(
      'Claude Code does not provide an embedding API.',
    )
  }
}

const toolOptionsFor = (policy: NativeToolPolicy): Partial<Options> => {
  switch (policy) {
    case 'read-only':
      return { tools: READ_ONLY_TOOLS, permissionMode: 'default' }
    case 'edit':
      return {
        tools: { type: 'preset', preset: 'claude_code' },
        permissionMode: 'acceptEdits',
      }
    case 'unrestricted':
      return {
        tools: { type: 'preset', preset: 'claude_code' },
        permissionMode: 'bypassPermissions',
        // The SDK refuses `bypassPermissions` without this acknowledgement.
        allowDangerouslySkipPermissions: true,
      }
  }
}

/**
 * Where in the native session this turn continues from.
 *
 * The tip is the common case. Anything else means YOLO's history branched —
 * an edited or regenerated message — so the native transcript, still on its
 * original branch, has to fork at the matching anchor. A parent with no anchor
 * at all is a conversation whose native session no longer describes it, and
 * starting fresh is the only honest answer.
 */
export const resolveResumeTarget = (
  session: ProviderSession | undefined,
  parentTurnId: string | undefined,
): Pick<ClaudeSessionSpec, 'resume' | 'resumeAt'> => {
  if (!session) return {}
  if (parentTurnId === session.tipTurnId) {
    return { resume: session.nativeSessionId }
  }
  const anchor = parentTurnId ? session.anchors[parentTurnId] : undefined
  if (anchor) {
    return { resume: session.nativeSessionId, resumeAt: anchor }
  }
  return {}
}

const extractSystemPrompt = (
  messages: RequestMessage[],
): string | undefined => {
  const parts = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .filter((content) => content.trim().length > 0)
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

/** The turn's own message — always the trailing user message. */
const buildTurnContent = (
  messages: RequestMessage[],
  handover: string | undefined,
) => {
  const last = [...messages]
    .reverse()
    .find(
      (message): message is Extract<RequestMessage, { role: 'user' }> =>
        message.role === 'user',
    )
  const content = last ? parseUserMessageContent(last) : '(no message provided)'
  if (!handover) return content
  const preface = { type: 'text' as const, text: handover }
  return typeof content === 'string'
    ? [preface, { type: 'text' as const, text: content }]
    : [preface, ...content]
}

/**
 * Everything before the turn's own message, as plain text.
 *
 * Only ever used to seed a session that has no transcript to resume. The SDK
 * takes over from the next turn, so this never competes with its history.
 */
const renderPriorTurns = (messages: RequestMessage[]): string | undefined => {
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user')
  const prior = messages
    .slice(0, lastUserIndex < 0 ? messages.length : lastUserIndex)
    .filter(
      (message) => message.role === 'user' || message.role === 'assistant',
    )
    .map((message) => {
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((part) =>
                part.type === 'text' ? part.text : `[${part.type}]`,
              )
              .join('\n')
      return text.trim().length > 0
        ? `<turn role="${message.role}">\n${text}\n</turn>`
        : undefined
    })
    .filter((turn): turn is string => turn !== undefined)

  if (prior.length === 0) return undefined
  return `<conversation_history>\n${prior.join('\n')}\n</conversation_history>`
}
