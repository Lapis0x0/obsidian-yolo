import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { BookOpen, Copy, Cpu, Plus, Trash2, Wrench } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { type App, usePlugin } from '../../../runtime/react-compat'
import { useSettings } from '../../../contexts/settings-context'
import {
  FILE_OPS_GROUP_TOOL_NAME,
  MEMORY_OPS_GROUP_TOOL_NAME,
  WEB_OPS_GROUP_TOOL_NAME,
  WEB_OPS_SPLIT_ACTION_TOOL_NAMES,
  getBuiltinToolUiMeta,
} from '../../../core/agent/builtinToolUiMeta'
import { isDefaultAssistantId } from '../../../core/agent/default-assistant'
import {
  LOCAL_FS_SPLIT_ACTION_TOOL_NAMES,
  LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES,
  getLocalFileTools,
} from '../../../core/mcp/localFileTools'
import { McpManager } from '../../../core/mcp/mcpManager'
import { listLiteSkillEntries } from '../../../core/skills/liteSkills'
import { isSkillEnabledForAssistant } from '../../../core/skills/skillPolicy'
import { Assistant } from '../../../types/assistant.types'
import { McpServerState, McpServerStatus } from '../../../types/mcp.types'
import { renderAssistantIcon } from '../../../utils/assistant-icon'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ConfirmModal } from '../../modals/ConfirmModal'
import { AgentSkillsModal } from '../modals/AgentSkillsModal'
import { AgentToolsModal } from '../modals/AgentToolsModal'
import { AssistantsModal } from '../modals/AssistantsModal'

import { AgentAutoContextCompactionSection } from './AgentAutoContextCompactionSection'
import { AgentFocusSyncSection } from './AgentFocusSyncSection'
import { AgentImageReadingSection } from './AgentImageReadingSection'
import { NotificationSettingsSection } from './NotificationSettingsSection'

type AgentSectionProps = {
  app: App
}

const SPLIT_FS_TOOL_NAME_SET = new Set<string>(LOCAL_FS_SPLIT_ACTION_TOOL_NAMES)
const SPLIT_MEMORY_TOOL_NAME_SET = new Set<string>(
  LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES,
)
const SPLIT_WEB_TOOL_NAME_SET = new Set<string>(WEB_OPS_SPLIT_ACTION_TOOL_NAMES)

export function AgentSection({ app }: AgentSectionProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const plugin = usePlugin()
  const assistants = settings.assistants || []
  const [mcpManager, setMcpManager] = useState<McpManager | null>(null)
  const [mcpServers, setMcpServers] = useState<McpServerState[]>([])

  useEffect(() => {
    let isMounted = true
    void plugin
      .getMcpManager()
      .then((manager) => {
        if (!isMounted) {
          return
        }
        setMcpManager(manager)
        setMcpServers(manager.getServers())
      })
      .catch((error: unknown) => {
        console.error(
          'Failed to initialize MCP manager in Agent section',
          error,
        )
      })

    return () => {
      isMounted = false
    }
  }, [plugin])

  useEffect(() => {
    if (!mcpManager) {
      return
    }
    const unsubscribe = mcpManager.subscribeServersChange((servers) => {
      setMcpServers(servers)
    })
    return () => {
      unsubscribe()
    }
  }, [mcpManager])

  const handleOpenAssistantsModal = (
    initialAssistantId?: string,
    initialCreate?: boolean,
  ) => {
    const modal = new AssistantsModal(
      app,
      plugin,
      initialAssistantId,
      initialCreate,
    )
    modal.open()
  }

  const handleDuplicateAssistant = async (assistant: Assistant) => {
    const copied: Assistant = {
      ...assistant,
      id: crypto.randomUUID(),
      name: `${assistant.name}${t('settings.agent.copySuffix', ' (copy)')}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    await setSettings({
      ...settings,
      assistants: [...assistants, copied],
    })
  }

  const handleDeleteAssistant = (assistant: Assistant) => {
    if (isDefaultAssistantId(assistant.id)) {
      return
    }

    let confirmed = false

    const modal = new ConfirmModal(app, {
      title: t('settings.agent.deleteConfirmTitle', 'Confirm delete agent'),
      message: `${t('settings.agent.deleteConfirmMessagePrefix', 'Are you sure you want to delete agent')} "${assistant.name}"${t('settings.agent.deleteConfirmMessageSuffix', '? This action cannot be undone.')}`,
      ctaText: t('common.delete'),
      onConfirm: () => {
        confirmed = true
      },
    })

    modal.onClose = () => {
      if (!confirmed) {
        return
      }

      void (async () => {
        const updatedAssistants = assistants.filter(
          (a) => a.id !== assistant.id,
        )
        await setSettings({
          ...settings,
          assistants: updatedAssistants,
          currentAssistantId:
            settings.currentAssistantId === assistant.id
              ? updatedAssistants[0]?.id
              : settings.currentAssistantId,
          quickAskAssistantId:
            settings.quickAskAssistantId === assistant.id
              ? updatedAssistants[0]?.id
              : settings.quickAskAssistantId,
        })
      })().catch((error: unknown) => {
        console.error('Failed to delete agent', error)
      })
    }

    modal.open()
  }

  const handleOpenToolsModal = () => {
    const modal = new AgentToolsModal(app, plugin)
    modal.open()
  }

  const handleOpenSkillsModal = () => {
    const modal = new AgentSkillsModal(app, plugin)
    modal.open()
  }

  const mcpTools = useMemo(
    () =>
      mcpServers
        .filter((server) => server.status === McpServerStatus.Connected)
        .flatMap((server) =>
          server.tools.map((tool) => {
            const option = server.config.toolOptions[tool.name]
            return {
              id: `${server.name}:${tool.name}`,
              name: tool.name,
              source: server.name,
              serverId: server.name,
              enabled: !(option?.disabled ?? false),
            }
          }),
        ),
    [mcpServers],
  )

  const builtinTools = useMemo(() => {
    const toolOptions = settings.mcp.builtinToolOptions
    const tools = getLocalFileTools()
      .filter(
        (tool) =>
          !SPLIT_FS_TOOL_NAME_SET.has(tool.name) &&
          !SPLIT_MEMORY_TOOL_NAME_SET.has(tool.name) &&
          !SPLIT_WEB_TOOL_NAME_SET.has(tool.name),
      )
      .map((tool) => {
        const meta = getBuiltinToolUiMeta(tool.name)
        return {
          id: tool.name,
          label: meta ? t(meta.labelKey, meta.labelFallback) : tool.name,
          enabled: !(toolOptions[tool.name]?.disabled ?? false),
        }
      })

    const splitToolEnabled = LOCAL_FS_SPLIT_ACTION_TOOL_NAMES.every(
      (toolName) =>
        !(toolOptions[toolName]?.disabled ?? false) &&
        !(toolOptions[FILE_OPS_GROUP_TOOL_NAME]?.disabled ?? false),
    )
    const fileOpsMeta = getBuiltinToolUiMeta(FILE_OPS_GROUP_TOOL_NAME)
    if (!fileOpsMeta) {
      throw new Error('Missing built-in tool UI metadata for fs_file_ops')
    }
    const fileOpsTool = {
      id: FILE_OPS_GROUP_TOOL_NAME,
      label: t(fileOpsMeta.labelKey, fileOpsMeta.labelFallback),
      enabled: splitToolEnabled,
    }

    const memorySplitToolEnabled = LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES.every(
      (toolName) =>
        !(toolOptions[toolName]?.disabled ?? false) &&
        !(toolOptions[MEMORY_OPS_GROUP_TOOL_NAME]?.disabled ?? false),
    )
    const memoryOpsMeta = getBuiltinToolUiMeta(MEMORY_OPS_GROUP_TOOL_NAME)
    if (!memoryOpsMeta) {
      throw new Error('Missing built-in tool UI metadata for memory_ops')
    }
    const memoryOpsTool = {
      id: MEMORY_OPS_GROUP_TOOL_NAME,
      label: t(memoryOpsMeta.labelKey, memoryOpsMeta.labelFallback),
      enabled: memorySplitToolEnabled,
    }

    const webSplitToolEnabled = WEB_OPS_SPLIT_ACTION_TOOL_NAMES.every(
      (toolName) =>
        !(toolOptions[toolName]?.disabled ?? false) &&
        !(toolOptions[WEB_OPS_GROUP_TOOL_NAME]?.disabled ?? false),
    )
    const webOpsMeta = getBuiltinToolUiMeta(WEB_OPS_GROUP_TOOL_NAME)
    if (!webOpsMeta) {
      throw new Error('Missing built-in tool UI metadata for web_ops')
    }
    const webOpsTool = {
      id: WEB_OPS_GROUP_TOOL_NAME,
      label: t(webOpsMeta.labelKey, webOpsMeta.labelFallback),
      enabled: webSplitToolEnabled,
    }

    const openSkillIndex = tools.findIndex((tool) => tool.id === 'open_skill')
    if (openSkillIndex >= 0) {
      tools.splice(openSkillIndex, 0, fileOpsTool)
      tools.splice(openSkillIndex + 1, 0, memoryOpsTool)
      tools.splice(openSkillIndex + 2, 0, webOpsTool)
    } else {
      tools.push(fileOpsTool)
      tools.push(memoryOpsTool)
      tools.push(webOpsTool)
    }

    return tools
  }, [settings.mcp.builtinToolOptions, t])

  const allSkillEntries = useMemo(
    () => listLiteSkillEntries(app, { settings }),
    [app, settings],
  )
  const disabledSkillIds = settings.skills?.disabledSkillIds ?? []
  const disabledSkillSet = useMemo(
    () => new Set(disabledSkillIds),
    [disabledSkillIds],
  )
  const globallyEnabledSkillEntries = useMemo(
    () => allSkillEntries.filter((skill) => !disabledSkillSet.has(skill.id)),
    [allSkillEntries, disabledSkillSet],
  )

  const skillsCountLabel = t(
    'settings.agent.skillsCountWithEnabled',
    '{count} skills (enabled {enabled})',
  )
    .replace('{count}', String(allSkillEntries.length))
    .replace('{enabled}', String(globallyEnabledSkillEntries.length))

  const enabledToolsCount =
    builtinTools.filter((tool) => tool.enabled).length +
    mcpTools.filter((tool) => tool.enabled).length

  const toolsCountLabel = t(
    'settings.agent.toolsCountWithEnabled',
    '{count} tools (enabled {enabled})',
  )
    .replace('{count}', String(builtinTools.length + mcpTools.length))
    .replace('{enabled}', String(enabledToolsCount))

  const mcpCountLabel = t(
    'settings.agent.mcpServerCount',
    '{count} MCP servers connected',
  ).replace('{count}', String(settings.mcp.servers.length))

  const toolTags = [
    ...builtinTools.map((tool) => ({
      key: `builtin:${tool.id}`,
      label: tool.label,
    })),
    ...mcpTools.map((tool) => ({ key: tool.id, label: tool.name })),
  ]

  return (
    <div className="smtcmp-settings-section smtcmp-agent-section">
      <div className="smtcmp-settings-header">
        {t('settings.agent.title', 'Agent')}
      </div>
      <div className="smtcmp-settings-desc smtcmp-agent-intro">
        {t(
          'settings.agent.desc',
          'Manage global capabilities and configure your agents.',
        )}
      </div>

      <section className="smtcmp-agent-block">
        <div className="smtcmp-agent-block-head">
          <div className="smtcmp-settings-sub-header">
            {t('settings.agent.globalCapabilities', 'Global capabilities')}
          </div>
          <div className="smtcmp-settings-desc">{mcpCountLabel}</div>
        </div>

        <div className="smtcmp-agent-cap-grid">
          <article className="smtcmp-agent-cap-card">
            <div className="smtcmp-agent-cap-title-row">
              <div className="smtcmp-agent-cap-title">
                <Wrench size={14} />
                <span>{t('settings.agent.tools', 'Tools')}</span>
              </div>
              <button
                type="button"
                className="mod-cta smtcmp-agent-tools-trigger"
                onClick={handleOpenToolsModal}
              >
                {t('settings.agent.manageTools', 'Manage tools')}
              </button>
            </div>
            <div className="smtcmp-agent-cap-count">{toolsCountLabel}</div>
            <div className="smtcmp-agent-cap-tags">
              {toolTags.map((tool) => (
                <span key={tool.key} className="smtcmp-agent-chip">
                  {tool.label}
                </span>
              ))}
            </div>
          </article>

          <article className="smtcmp-agent-cap-card">
            <div className="smtcmp-agent-cap-title-row">
              <div className="smtcmp-agent-cap-title">
                <BookOpen size={14} />
                <span>{t('settings.agent.skills', 'Skills')}</span>
              </div>
              <button
                type="button"
                className="mod-cta smtcmp-agent-tools-trigger"
                onClick={handleOpenSkillsModal}
              >
                {t('settings.agent.manageSkills', 'Manage skills')}
              </button>
            </div>
            <div className="smtcmp-agent-cap-count">{skillsCountLabel}</div>
            <div className="smtcmp-agent-cap-tags">
              {globallyEnabledSkillEntries.map((skill) => (
                <span key={skill.id} className="smtcmp-agent-chip">
                  {skill.name}
                </span>
              ))}
            </div>
          </article>
        </div>
      </section>

      <section className="smtcmp-agent-block">
        <div className="smtcmp-agent-block-head">
          <div className="smtcmp-agent-block-head-title-row">
            <div className="smtcmp-settings-sub-header">
              {t('settings.agent.agents', 'Agents')}
            </div>
            <ObsidianButton
              text={t('settings.agent.newAgent', 'New agent')}
              onClick={() => handleOpenAssistantsModal(undefined, true)}
              cta
            />
          </div>
          <div className="smtcmp-settings-desc">
            {t(
              'settings.agent.agentsDesc',
              'Click Configure to edit each agent profile and prompt.',
            )}
          </div>
        </div>

        <div className="smtcmp-agent-grid">
          {assistants.map((assistant) => (
            <article
              key={assistant.id}
              className="smtcmp-agent-card smtcmp-agent-card--clickable"
              role="button"
              tabIndex={0}
              onClick={() => handleOpenAssistantsModal(assistant.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  handleOpenAssistantsModal(assistant.id)
                }
              }}
            >
              <div className="smtcmp-agent-card-top">
                <div className="smtcmp-agent-card-top-main">
                  <div className="smtcmp-agent-avatar">
                    {renderAssistantIcon(assistant.icon, 16)}
                  </div>
                  <div className="smtcmp-agent-main">
                    <div className="smtcmp-agent-name-row">
                      <div className="smtcmp-agent-name">{assistant.name}</div>
                    </div>
                    {assistant.description && (
                      <div className="smtcmp-agent-desc">
                        {assistant.description}
                      </div>
                    )}
                  </div>
                </div>

                <DropdownMenu.Root>
                  <DropdownMenu.Trigger
                    className="smtcmp-agent-card-menu-trigger"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <span
                      className="smtcmp-agent-card-menu-trigger-dots"
                      aria-hidden="true"
                    >
                      ...
                    </span>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="smtcmp-agent-card-menu-popover"
                      align="end"
                      sideOffset={8}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <ul className="smtcmp-agent-card-menu-list">
                        <DropdownMenu.Item
                          asChild
                          onSelect={() => {
                            void handleDuplicateAssistant(assistant)
                          }}
                        >
                          <li className="smtcmp-agent-card-menu-item">
                            <span className="smtcmp-agent-card-menu-icon">
                              <Copy size={16} />
                            </span>
                            {t('settings.agent.duplicate', 'Duplicate')}
                          </li>
                        </DropdownMenu.Item>
                        {!isDefaultAssistantId(assistant.id) && (
                          <DropdownMenu.Item
                            asChild
                            onSelect={() => handleDeleteAssistant(assistant)}
                          >
                            <li className="smtcmp-agent-card-menu-item smtcmp-agent-card-menu-danger">
                              <span className="smtcmp-agent-card-menu-icon">
                                <Trash2 size={16} />
                              </span>
                              {t('common.delete')}
                            </li>
                          </DropdownMenu.Item>
                        )}
                      </ul>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>

              <div className="smtcmp-agent-meta-row">
                <span className="smtcmp-agent-meta-item">
                  <Cpu size={12} />
                  {assistant.modelId || settings.chatModelId}
                </span>
                <span className="smtcmp-agent-meta-item">
                  <Wrench size={12} />
                  {assistant.enableTools
                    ? `${assistant.enabledToolNames?.length ?? 0} tools`
                    : '0 tools'}
                </span>
                <span className="smtcmp-agent-meta-item">
                  <BookOpen size={12} />
                  {`${
                    allSkillEntries.filter((skill) =>
                      isSkillEnabledForAssistant({
                        assistant,
                        skillId: skill.id,
                        disabledSkillIds,
                      }),
                    ).length
                  } skills`}
                </span>
              </div>
            </article>
          ))}
          <article
            className="smtcmp-agent-create-card"
            role="button"
            tabIndex={0}
            onClick={() => handleOpenAssistantsModal(undefined, true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                handleOpenAssistantsModal(undefined, true)
              }
            }}
          >
            <div className="smtcmp-agent-create-card-icon">
              <Plus size={28} />
            </div>
            <div className="smtcmp-agent-create-card-text">
              {t('settings.agent.newAgent', 'New agent')}
            </div>
          </article>
        </div>
      </section>

      <section className="smtcmp-agent-block">
        <div className="smtcmp-agent-block-head">
          <div className="smtcmp-settings-sub-header">
            {t('settings.agent.agentCapabilitiesBlockTitle')}
          </div>
        </div>
        <AgentFocusSyncSection />
        <div className="yolo-agent-sub-card">
          <div className="yolo-agent-sub-card-head">
            {t('settings.agent.imageReadingBlockTitle')}
          </div>
          <AgentImageReadingSection />
        </div>
        <div className="yolo-agent-sub-card">
          <div className="yolo-agent-sub-card-head">
            {t('settings.agent.autoContextCompactionBlockTitle')}
          </div>
          <AgentAutoContextCompactionSection />
        </div>
      </section>

      <section className="smtcmp-agent-block">
        <div className="smtcmp-agent-block-head">
          <div className="smtcmp-settings-sub-header">
            {t('settings.etc.notifications', '通知提醒')}
          </div>
        </div>

        <NotificationSettingsSection />
      </section>
    </div>
  )
}
