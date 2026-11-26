import * as Popover from '@radix-ui/react-popover'
import {
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  Cpu,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  Wrench,
} from 'lucide-react'
import {
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import { useApp } from '../../../contexts/app-context'
import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import { getAssistantModelDisplayLabel } from '../../../core/agent/assistant-model'
import { isDefaultAssistantId } from '../../../core/agent/default-assistant'
import { countEnabledVisibleAssistantTools } from '../../../core/agent/tool-display-count'
import {
  CLI_RUNTIME_DESCRIPTORS,
  type CliRuntimeScope,
  type HermesProfile,
  getCliRuntimeDescriptor,
} from '../../../core/cli-runtime'
import { toModuleToolSetEnablement } from '../../../core/modules/moduleToolSetRegistry'
import { countEnabledAssistantSkills } from '../../../core/skills/skillPolicy'
import { useLiteSkillEntries } from '../../../hooks/useLiteSkillEntries'
import type { Assistant } from '../../../types/assistant.types'
import type { McpTool } from '../../../types/mcp.types'
import { renderAssistantIcon } from '../../../utils/assistant-icon'
import { openPluginSettingsTab } from '../../../utils/openPluginSettingsTab'
import { YoloPopoverContent } from '../../common/popover'
import { AssistantsModal } from '../../settings/modals/AssistantsModal'

import {
  type AgentRef,
  MAX_PINNED_AGENTS,
  isSameAgentRef,
  serializeAgentRef,
  togglePinnedAgent,
} from './agentRef'

/**
 * Mirrors `HERMES_DEFAULT_PROFILE_ID` (core/cli-runtime/hermes/profiles.ts),
 * which is desktop-only and cannot be imported into the mobile bundle graph.
 */
const DEFAULT_HERMES_PROFILE_ID = 'default'

/** Keep the model slug, drop the vendor prefix. */
const toModelLabel = (model: string): string =>
  model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model

type AgentPickerProps = {
  /** 当前正在对话的 Agent，菜单里打勾；新建对话入口不传。 */
  current?: AgentRef
  onPick: (ref: AgentRef) => void
  /** 不传则不列 CLI Agent（移动端、或 CLI 运行时不可用）。 */
  cliRuntimeScope?: CliRuntimeScope
  triggerClassName: string
  triggerContent: ReactNode
  /** 触发按钮的可访问名：只有图标时才需要，有可见文字时不传。 */
  triggerLabel?: string
  align?: 'start' | 'end'
}

/**
 * 整个产品唯一的选 Agent 组件。YOLO 自定义 Agent 与 CLI Agent 放在同一个
 * 菜单里，按来源分组；Hermes 的每个 profile 各算一个 Agent，在 Hermes 行下
 * 展开。每行悬停出现图钉，钉住的 Agent 出现在侧边栏「新对话」下方。
 *
 * 选中之后做什么由调用方决定：头部是切换当前对话的 Agent，侧边栏是用它开
 * 一个新对话。
 */
export function AgentPicker({
  current,
  onPick,
  cliRuntimeScope,
  triggerClassName,
  triggerContent,
  triggerLabel,
  align = 'start',
}: AgentPickerProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const app = useApp()
  const plugin = usePlugin()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hermesExpanded, setHermesExpanded] = useState(false)
  const [hermesProfiles, setHermesProfiles] = useState<
    readonly HermesProfile[]
  >([])
  const [availableTools, setAvailableTools] = useState<McpTool[]>([])
  const skillEntries = useLiteSkillEntries(app, { settings })
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  // Module tool sets: same registry `useSyncExternalStore` pattern as
  // `Chat.tsx`'s module chat mode subscription, reduced to what
  // `countEnabledVisibleAssistantTools` needs so the per-agent tool count
  // matches what the agent editor and chat runtime resolve.
  const moduleToolSetRegistry = plugin.getModuleToolSetRegistry()
  const moduleToolSetSnapshot = useSyncExternalStore(
    moduleToolSetRegistry.subscribe,
    moduleToolSetRegistry.getSnapshot,
  )
  const moduleToolSetEnablement = useMemo(
    () => toModuleToolSetEnablement(moduleToolSetSnapshot),
    [moduleToolSetSnapshot],
  )

  useEffect(() => {
    if (!open) return
    let mounted = true
    let requestId = 0
    let unsubscribe: (() => void) | undefined

    void plugin
      .getMcpManager()
      .then((manager) => {
        if (!mounted) return
        const refreshAvailableTools = () => {
          const currentRequestId = ++requestId
          void manager
            .listAvailableTools()
            .then((tools) => {
              if (mounted && currentRequestId === requestId) {
                setAvailableTools(tools)
              }
            })
            .catch((error: unknown) => {
              console.error(
                'Failed to load available tools for agent picker',
                error,
              )
            })
        }
        unsubscribe = manager.subscribeServersChange(refreshAvailableTools)
        refreshAvailableTools()
      })
      .catch((error: unknown) => {
        console.error('Failed to initialize agent picker tools', error)
      })

    return () => {
      mounted = false
      requestId += 1
      unsubscribe?.()
    }
  }, [open, plugin])

  // Hermes profile 是本机发现的，每次打开重新列一次
  useEffect(() => {
    if (!open || !cliRuntimeScope) return
    let cancelled = false
    void cliRuntimeScope
      .listHermesProfiles()
      .then((profiles) => {
        if (!cancelled) setHermesProfiles(profiles)
      })
      .catch((error: unknown) => {
        console.error('[YOLO] Failed to list Hermes profiles', error)
      })
    return () => {
      cancelled = true
    }
  }, [cliRuntimeScope, open])

  const pinned = settings.chatOptions.pinnedAgents ?? []
  const isPinned = (ref: AgentRef) => pinned.includes(serializeAgentRef(ref))
  const pinsFull = pinned.length >= MAX_PINNED_AGENTS

  const togglePin = (ref: AgentRef) => {
    const next = togglePinnedAgent(pinned, ref)
    if (next === pinned) return
    void setSettings({
      ...settings,
      chatOptions: { ...settings.chatOptions, pinnedAgents: [...next] },
    }).catch((error: unknown) => {
      console.error('Failed to update pinned agents', error)
    })
  }

  const isCurrent = (ref: AgentRef): boolean => {
    if (!current) return false
    // 默认 Agent 有新旧两种 id，任一都算同一个
    if (current.kind === 'assistant' && ref.kind === 'assistant') {
      return isDefaultAssistantId(current.assistantId)
        ? isDefaultAssistantId(ref.assistantId)
        : current.assistantId === ref.assistantId
    }
    return isSameAgentRef(current, ref)
  }

  const pick = (ref: AgentRef) => {
    setOpen(false)
    onPick(ref)
  }

  const normalizedQuery = query.trim().toLowerCase()
  const matches = (label: string) =>
    !normalizedQuery || label.toLowerCase().includes(normalizedQuery)

  const assistants = (settings.assistants ?? []).filter((assistant) =>
    matches(assistant.name),
  )
  const cliRows = cliRuntimeScope
    ? CLI_RUNTIME_DESCRIPTORS.filter((descriptor) =>
        matches(t(descriptor.labelKey, descriptor.defaultLabel)),
      )
    : []
  const hermesProfileRows =
    hermesProfiles.length > 1
      ? hermesProfiles.filter(
          (profile) =>
            matches(profile.displayName) ||
            matches(t('sidebar.runtimeSelector.hermesLabel', 'Hermes')),
        )
      : []
  // 搜索时 profile 命中就自动展开，不用再点一下
  const showHermesProfiles =
    hermesProfileRows.length > 0 && (hermesExpanded || normalizedQuery !== '')

  const renderPinButton = (ref: AgentRef, name: string) => {
    const pinnedNow = isPinned(ref)
    if (!pinnedNow && pinsFull) {
      return (
        <button
          type="button"
          className="yolo-agent-picker-pin is-disabled"
          aria-disabled="true"
          aria-label={t(
            'chat.agentPicker.pinLimit',
            'Up to {count} pinned agents — unpin one first',
          ).replace('{count}', String(MAX_PINNED_AGENTS))}
          onClick={(event) => event.stopPropagation()}
        >
          <Pin size={13} />
        </button>
      )
    }
    return (
      <button
        type="button"
        className={`yolo-agent-picker-pin${pinnedNow ? ' is-pinned' : ''}`}
        aria-pressed={pinnedNow}
        aria-label={(pinnedNow
          ? t('chat.agentPicker.unpin', 'Unpin {name}')
          : t('chat.agentPicker.pin', 'Pin {name} to the sidebar')
        ).replace('{name}', name)}
        onClick={(event) => {
          event.stopPropagation()
          togglePin(ref)
        }}
      >
        {pinnedNow ? <PinOff size={13} /> : <Pin size={13} />}
      </button>
    )
  }

  const renderAssistantMeta = (assistant: Assistant) => {
    const followDefaultLabel = t(
      'settings.agent.followDefaultModel',
      'Follow default model',
    )
    const rawModelId = getAssistantModelDisplayLabel(
      assistant.modelId,
      followDefaultLabel,
    )
    const modelLabel =
      rawModelId === followDefaultLabel ? rawModelId : toModelLabel(rawModelId)
    const toolCount = countEnabledVisibleAssistantTools(
      assistant,
      availableTools,
      moduleToolSetEnablement,
    )
    const skillCount = countEnabledAssistantSkills({
      assistant,
      skills: skillEntries,
      disabledSkillNames: settings.skills?.disabledSkillIds,
    })
    return (
      <div className="yolo-assistant-selector-item-meta">
        {modelLabel && (
          <span className="yolo-assistant-selector-meta-chip">
            <Cpu size={10} />
            <span>{modelLabel}</span>
          </span>
        )}
        <span className="yolo-assistant-selector-meta-chip">
          <Wrench size={10} />
          <span>
            {t('settings.agent.toolsCount', '{count} tools').replace(
              '{count}',
              String(toolCount),
            )}
          </span>
        </span>
        <span className="yolo-assistant-selector-meta-chip">
          <BookOpen size={10} />
          <span>
            {t('settings.agent.skillsCount', '{count} skills').replace(
              '{count}',
              String(skillCount),
            )}
          </span>
        </span>
      </div>
    )
  }

  const renderRow = ({
    key,
    ref,
    name,
    icon,
    meta,
    trailing,
    onSelect,
    nested,
  }: {
    key: string
    ref: AgentRef | null
    name: string
    icon: ReactNode
    meta?: ReactNode
    trailing?: ReactNode
    onSelect: () => void
    nested?: boolean
  }) => {
    const active = ref ? isCurrent(ref) : false
    return (
      <li
        key={key}
        className={`yolo-assistant-selector-row${nested ? ' yolo-agent-picker-row--nested' : ''}`}
      >
        <div
          className={`yolo-assistant-selector-item ${active ? 'selected' : ''}`}
        >
          <button
            type="button"
            className="yolo-assistant-selector-item-main"
            onClick={onSelect}
          >
            <div className="yolo-assistant-selector-item-icon">{icon}</div>
            <div className="yolo-assistant-selector-item-content">
              <div className="yolo-assistant-selector-item-name-row">
                <span className="yolo-assistant-selector-item-name">
                  {name}
                </span>
                {active && (
                  <Check
                    size={11}
                    className="yolo-assistant-selector-item-check"
                  />
                )}
              </div>
              {meta}
            </div>
          </button>
          <div className="yolo-assistant-selector-item-actions">
            {ref ? renderPinButton(ref, name) : null}
            {trailing}
          </div>
        </div>
      </li>
    )
  }

  const hermesLabel = t('sidebar.runtimeSelector.hermesLabel', 'Hermes')

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setQuery('')
          setHermesExpanded(false)
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          ref={triggerRef}
          className={triggerClassName}
          data-state={open ? 'open' : 'closed'}
          aria-label={triggerLabel}
        >
          {triggerContent}
        </button>
      </Popover.Trigger>

      <YoloPopoverContent
        anchorRef={triggerRef}
        variant="default"
        minWidth={300}
        maxHeight={520}
        align={align}
        className="yolo-assistant-selector-content yolo-assistant-selector-content--palette yolo-agent-picker"
        sideOffset={8}
      >
        <div className="yolo-agent-picker-search">
          <Search size={13} />
          <input
            type="search"
            value={query}
            autoFocus
            placeholder={t('chat.agentPicker.search', 'Search agents')}
            aria-label={t('chat.agentPicker.search', 'Search agents')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ul className="yolo-assistant-selector-list yolo-model-select-list yolo-scrollbar-autohide">
          {assistants.length > 0 ? (
            <li className="yolo-agent-picker-group" aria-hidden="true">
              {t('chat.agentPicker.yoloGroup', 'YOLO')}
            </li>
          ) : null}
          {assistants.map((assistant) => {
            const ref: AgentRef = {
              kind: 'assistant',
              assistantId: assistant.id,
            }
            return renderRow({
              key: serializeAgentRef(ref),
              ref,
              name: assistant.name,
              icon: renderAssistantIcon(assistant.icon, 14),
              meta: renderAssistantMeta(assistant),
              onSelect: () => pick(ref),
              trailing: (
                <button
                  type="button"
                  className="yolo-assistant-selector-action-btn"
                  aria-label={t('settings.assistants.editAssistant')}
                  onClick={(event) => {
                    event.stopPropagation()
                    setOpen(false)
                    new AssistantsModal(app, plugin, assistant.id, false).open()
                  }}
                >
                  <Pencil size={12} />
                </button>
              ),
            })
          })}
          {cliRows.length > 0 || hermesProfileRows.length > 0 ? (
            <li className="yolo-agent-picker-group" aria-hidden="true">
              {t('chat.agentPicker.cliGroup', 'CLI')}
            </li>
          ) : null}
          {cliRows.flatMap((descriptor) => {
            const name = t(descriptor.labelKey, descriptor.defaultLabel)
            const logo = (
              <img
                className="yolo-agent-picker-logo"
                src={descriptor.icon.src}
                alt=""
                draggable={false}
                data-provider={descriptor.icon.provider}
              />
            )
            if (descriptor.id !== 'hermes') {
              const ref: AgentRef = { kind: 'cli', runtimeId: descriptor.id }
              return [
                renderRow({
                  key: serializeAgentRef(ref),
                  ref,
                  name,
                  icon: logo,
                  onSelect: () => pick(ref),
                }),
              ]
            }
            // Hermes：只有一个 profile 时它就是一个普通 Agent；多个时整行只负责
            // 展开，各 profile 才是可选、可钉住的 Agent。
            if (hermesProfiles.length <= 1) {
              const ref: AgentRef = { kind: 'hermes', profileId: undefined }
              return [
                renderRow({
                  key: serializeAgentRef(ref),
                  ref,
                  name,
                  icon: logo,
                  onSelect: () => pick(ref),
                }),
              ]
            }
            return [
              renderRow({
                key: 'hermes-group',
                ref: null,
                name,
                icon: logo,
                meta: (
                  <div className="yolo-assistant-selector-item-meta">
                    <span className="yolo-assistant-selector-meta-chip">
                      <Bot size={10} />
                      <span>
                        {t(
                          'chat.agentPicker.profileCount',
                          '{count} profiles',
                        ).replace('{count}', String(hermesProfiles.length))}
                      </span>
                    </span>
                  </div>
                ),
                onSelect: () => setHermesExpanded((value) => !value),
                trailing: (
                  <ChevronRight
                    size={13}
                    className={`yolo-agent-picker-expand${
                      showHermesProfiles ? ' is-expanded' : ''
                    }`}
                  />
                ),
              }),
            ]
          })}
          {showHermesProfiles
            ? hermesProfileRows.map((profile) => {
                const ref: AgentRef = {
                  kind: 'hermes',
                  profileId:
                    profile.id === DEFAULT_HERMES_PROFILE_ID
                      ? undefined
                      : profile.id,
                }
                return renderRow({
                  key: serializeAgentRef(ref),
                  ref,
                  name: `${hermesLabel} · ${profile.displayName}`,
                  icon: <Bot size={14} />,
                  meta: profile.model ? (
                    <div className="yolo-assistant-selector-item-meta">
                      <span className="yolo-assistant-selector-meta-chip">
                        <Cpu size={10} />
                        <span>{toModelLabel(profile.model)}</span>
                      </span>
                    </div>
                  ) : undefined,
                  onSelect: () => pick(ref),
                  nested: true,
                })
              })
            : null}
          {assistants.length === 0 &&
          cliRows.length === 0 &&
          hermesProfileRows.length === 0 ? (
            <li className="yolo-agent-picker-empty">
              {t('common.noResults', 'No matches found')}
            </li>
          ) : null}
        </ul>

        <div className="yolo-assistant-selector-footer yolo-agent-picker-footer">
          <span className="yolo-agent-picker-pin-count">
            {t('chat.agentPicker.pinnedCount', '{count} / {max} pinned')
              .replace('{count}', String(pinned.length))
              .replace('{max}', String(MAX_PINNED_AGENTS))}
          </span>
          <button
            type="button"
            className="yolo-assistant-selector-footer-btn"
            onClick={() => {
              setOpen(false)
              openPluginSettingsTab(app, plugin, 'agent')
            }}
          >
            <Settings size={12} />
            <span>{t('settings.assistants.manageAll', 'Manage all…')}</span>
          </button>
        </div>
      </YoloPopoverContent>
    </Popover.Root>
  )
}

/** 触发按钮里「当前 Agent」的图标与名字，头部和其他入口共用。 */
export function useAgentDisplay(
  ref: AgentRef,
  cliRuntimeScope?: CliRuntimeScope,
): {
  name: string
  icon: ReactNode
} {
  const { settings } = useSettings()
  const { t } = useLanguage()
  const hermesProfileId = ref.kind === 'hermes' ? ref.profileId : undefined
  const [hermesProfileName, setHermesProfileName] = useState<string | null>(
    null,
  )

  // Hermes profile 的显示名只有本机发现才知道；拿不到时退回 profile id
  useEffect(() => {
    setHermesProfileName(null)
    if (!hermesProfileId || !cliRuntimeScope) return
    let cancelled = false
    void cliRuntimeScope
      .listHermesProfiles()
      .then((profiles) => {
        if (cancelled) return
        const profile = profiles.find((item) => item.id === hermesProfileId)
        setHermesProfileName(profile?.displayName ?? null)
      })
      .catch((error: unknown) => {
        console.error('[YOLO] Failed to list Hermes profiles', error)
      })
    return () => {
      cancelled = true
    }
  }, [cliRuntimeScope, hermesProfileId])

  switch (ref.kind) {
    case 'assistant': {
      const assistants = settings.assistants ?? []
      const assistant =
        assistants.find((item) => item.id === ref.assistantId) ??
        (isDefaultAssistantId(ref.assistantId)
          ? assistants.find((item) => isDefaultAssistantId(item.id))
          : undefined)
      return {
        name: assistant?.name ?? t('settings.assistants.noAssistant'),
        icon: renderAssistantIcon(assistant?.icon, 14),
      }
    }
    case 'cli':
    case 'hermes': {
      const descriptor = getCliRuntimeDescriptor(
        ref.kind === 'cli' ? ref.runtimeId : 'hermes',
      )
      const label = t(descriptor.labelKey, descriptor.defaultLabel)
      return {
        name: hermesProfileId
          ? `${label} · ${hermesProfileName ?? hermesProfileId}`
          : label,
        icon: (
          <img
            className="yolo-agent-picker-logo"
            src={descriptor.icon.src}
            alt=""
            draggable={false}
            data-provider={descriptor.icon.provider}
          />
        ),
      }
    }
  }
}
