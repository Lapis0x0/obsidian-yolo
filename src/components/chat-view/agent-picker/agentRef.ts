import {
  CLI_RUNTIME_IDS,
  type ChatRuntimeId,
  type CliRuntimeId,
} from '../../../core/cli-runtime'

/**
 * 用户面对的「Agent」：一个能对话的对象。YOLO 自定义 Agent（代码里的
 * `Assistant`）与 CLI Agent 同层，Hermes 的每个 profile 各算一个。
 *
 * Hermes 的默认 profile 用 `profileId: undefined` 表示，与
 * `CliSessionRef.profileId` 的约定一致。
 */
export type AgentRef =
  | { kind: 'assistant'; assistantId: string }
  | { kind: 'cli'; runtimeId: Exclude<CliRuntimeId, 'hermes'> }
  | { kind: 'hermes'; profileId: string | undefined }

/** 侧边栏最多钉住这么多个 Agent，再多一行放不下，也就失去了「常用」的意义。 */
export const MAX_PINNED_AGENTS = 5

/**
 * 持久化（钉住列表）用的字符串形式。前缀区分来源，id 原样拼在后面：
 * `assistant:<id>`、`cli:<runtimeId>`、`hermes:` / `hermes:<profileId>`。
 */
export const serializeAgentRef = (ref: AgentRef): string => {
  switch (ref.kind) {
    case 'assistant':
      return `assistant:${ref.assistantId}`
    case 'cli':
      return `cli:${ref.runtimeId}`
    case 'hermes':
      return `hermes:${ref.profileId ?? ''}`
  }
}

const isNonHermesCliRuntimeId = (
  value: string,
): value is Exclude<CliRuntimeId, 'hermes'> =>
  value !== 'hermes' && (CLI_RUNTIME_IDS as readonly string[]).includes(value)

/** 认不出的条目（例如来自更新版本的运行时）返回 null，调用方直接跳过。 */
export const parseAgentRef = (value: string): AgentRef | null => {
  const separator = value.indexOf(':')
  if (separator === -1) return null
  const kind = value.slice(0, separator)
  const id = value.slice(separator + 1)
  if (kind === 'assistant') {
    return id ? { kind: 'assistant', assistantId: id } : null
  }
  if (kind === 'cli') {
    return isNonHermesCliRuntimeId(id) ? { kind: 'cli', runtimeId: id } : null
  }
  if (kind === 'hermes') {
    return { kind: 'hermes', profileId: id || undefined }
  }
  return null
}

export const isSameAgentRef = (a: AgentRef, b: AgentRef): boolean =>
  serializeAgentRef(a) === serializeAgentRef(b)

/** 这个 Agent 跑在哪个运行时上。 */
export const getAgentRuntimeId = (ref: AgentRef): ChatRuntimeId => {
  switch (ref.kind) {
    case 'assistant':
      return 'yolo'
    case 'cli':
      return ref.runtimeId
    case 'hermes':
      return 'hermes'
  }
}

/** 由当前会话状态反推「正在和谁对话」。 */
export const resolveCurrentAgentRef = ({
  runtimeId,
  assistantId,
  hermesProfileId,
}: {
  runtimeId: ChatRuntimeId
  assistantId: string
  hermesProfileId: string | undefined
}): AgentRef => {
  if (runtimeId === 'yolo') return { kind: 'assistant', assistantId }
  if (runtimeId === 'hermes')
    return { kind: 'hermes', profileId: hermesProfileId }
  return { kind: 'cli', runtimeId }
}

/** 钉住 / 取消钉住；已满时钉新的不生效，返回原列表。 */
export const togglePinnedAgent = (
  pinned: readonly string[],
  ref: AgentRef,
): readonly string[] => {
  const key = serializeAgentRef(ref)
  if (pinned.includes(key)) return pinned.filter((item) => item !== key)
  if (pinned.length >= MAX_PINNED_AGENTS) return pinned
  return [...pinned, key]
}
