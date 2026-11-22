import { Menu } from 'obsidian'
import { useMemo } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { isDefaultAssistantId } from '../../../core/agent/default-assistant'
import type { CliRuntimeScope } from '../../../core/cli-runtime'
import { useAgentDisplay } from '../agent-picker/AgentPicker'
import {
  type AgentRef,
  parseAgentRef,
  serializeAgentRef,
  togglePinnedAgent,
} from '../agent-picker/agentRef'

/**
 * 钉住的 Agent 能不能显示：Agent 被删了、或这台设备上没有 CLI 运行时，就不
 * 显示，但不从设置里删掉——换回桌面端或重建同名 Agent 后它还在。
 */
function useVisiblePinnedAgents(cliAvailable: boolean): AgentRef[] {
  const { settings } = useSettings()
  const pinned = settings.chatOptions.pinnedAgents
  const assistants = settings.assistants
  return useMemo(() => {
    const refs: AgentRef[] = []
    for (const value of pinned ?? []) {
      const ref = parseAgentRef(value)
      if (!ref) continue
      if (ref.kind === 'assistant') {
        const exists = (assistants ?? []).some((assistant) =>
          isDefaultAssistantId(ref.assistantId)
            ? isDefaultAssistantId(assistant.id)
            : assistant.id === ref.assistantId,
        )
        if (!exists) continue
      } else if (!cliAvailable) {
        continue
      }
      refs.push(ref)
    }
    return refs
  }, [assistants, cliAvailable, pinned])
}

function PinnedAgentButton({
  agent,
  cliRuntimeScope,
  compact,
  onStart,
}: {
  agent: AgentRef
  cliRuntimeScope: CliRuntimeScope | undefined
  compact: boolean
  onStart: (ref: AgentRef) => void
}) {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()
  const display = useAgentDisplay(agent, cliRuntimeScope)
  const label = t(
    'chat.agentPicker.newChatWith',
    'New chat with {name}',
  ).replace('{name}', display.name)

  const unpin = () => {
    const pinned = settings.chatOptions.pinnedAgents ?? []
    const next = togglePinnedAgent(pinned, agent)
    void setSettings({
      ...settings,
      chatOptions: { ...settings.chatOptions, pinnedAgents: [...next] },
    }).catch((error: unknown) => {
      console.error('Failed to unpin agent', error)
    })
  }

  return (
    <button
      type="button"
      className={`yolo-chat-sidebar-pinned-agent${compact ? ' is-compact' : ''}`}
      aria-label={label}
      onClick={() => onStart(agent)}
      onContextMenu={(event) => {
        event.preventDefault()
        const menu = new Menu()
        menu.addItem((item) =>
          item
            .setTitle(label)
            .setIcon('square-pen')
            .onClick(() => onStart(agent)),
        )
        menu.addItem((item) =>
          item
            .setTitle(t('chat.agentPicker.unpinShort', 'Unpin'))
            .setIcon('pin-off')
            .onClick(unpin),
        )
        menu.showAtMouseEvent(event.nativeEvent)
      }}
    >
      <span
        className={`yolo-chat-sidebar-pinned-agent-icon is-${
          agent.kind === 'assistant' ? 'yolo' : 'cli'
        }`}
      >
        {display.icon}
      </span>
      {compact ? null : (
        <span className="yolo-chat-sidebar-pinned-agent-name">
          {/* 一行只有 48px：CLI 的名字取第一个词（Claude Code → Claude），
              完整名字在 aria-label 里 */}
          {agent.kind === 'assistant'
            ? display.name
            : display.name.split(' ')[0]}
        </span>
      )}
    </button>
  )
}

/**
 * 侧边栏「新对话」下方的一行常用 Agent：点一下用它开新对话，右键取消钉住。
 * 没钉任何 Agent 时整行不出现。窄轨里只剩图标，竖着排。
 */
export function PinnedAgents({
  cliRuntimeScope,
  compact,
  onStart,
}: {
  cliRuntimeScope: CliRuntimeScope | undefined
  compact: boolean
  onStart: (ref: AgentRef) => void
}) {
  const agents = useVisiblePinnedAgents(cliRuntimeScope !== undefined)
  if (agents.length === 0) return null
  return (
    <div className={`yolo-chat-sidebar-pinned${compact ? ' is-compact' : ''}`}>
      {agents.map((agent) => (
        <PinnedAgentButton
          key={serializeAgentRef(agent)}
          agent={agent}
          cliRuntimeScope={cliRuntimeScope}
          compact={compact}
          onStart={onStart}
        />
      ))}
    </div>
  )
}
