import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { BookOpen, Copy, Cpu, Plus, Trash2, Wrench } from 'lucide-react'
import { App } from 'obsidian'
import { useEffect, useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import { isDefaultAssistantId } from '../../../core/agent/default-assistant'
import {
  getLocalFileTools,
  LOCAL_FS_SPLIT_ACTION_TOOL_NAMES,
} from '../../../core/mcp/localFileTools'
import { McpManager } from '../../../core/mcp/mcpManager'
import { listLiteSkillEntries } from '../../../core/skills/liteSkills'
import { isSkillEnabledForAssistant } from '../../../core/skills/skillPolicy'
import { Assistant } from '../../../types/assistant.types'
import { McpServerState, McpServerStatus } from '../../../types/mcp.types'
import { renderAssistantIcon } from '../../../utils/assistant-icon'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ConfirmModal } from '../../modals/ConfirmModal'
import { AgentSkillsModal } from '../modals/AgentSkillsModal'
import { AgentToolsModal } from '../modals/AgentToolsModal'
import { AssistantsModal } from '../modals/AssistantsModal'

type AgentSectionProps = {
  app: App
}

const BUILTIN_TOOL_LABEL_KEYS: Record<
  string,
  { key: string; fallback: string }
> = {
  fs_list: {
    key: 'settings.agent.builtinFsListLabel',
    fallback: 'Read Vault',
  },
  fs_search: {
    key: 'settings.agent.builtinFsSearchLabel',
    fallback: 'Search Vault',
  },
  fs_read: {
    key: 'settings.agent.builtinFsReadLabel',
    fallback: 'Read File',
  },
  fs_edit: {
    key: 'settings.agent.builtinFsEditLabel',
    fallback: 'Text Editing',
  },
  fs_file_ops: {
    key: 'settings.agent.builtinFsFileOpsLabel',
    fallback: 'File Operations',
  },
  open_skill: {
    key: 'settings.agent.builtinOpenSkillLabel',
    fallback: 'Open Skill',
  },
}

const SPLIT_FS_TOOL_NAME_SET = new Set<string>(LOCAL_FS_SPLIT_ACTION_TOOL_NAMES)

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

  const handleToggleFsEditReview = (value: boolean) => {
    void setSettings({
      ...settings,
      mcp: {
        ...settings.mcp,
        fsEditRequireReview: value,
      },
    })
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

  const builtinTools = useMemo(
    () =>
      getLocalFileTools()
        .filter((tool) => !SPLIT_FS_TOOL_NAME_SET.has(tool.name))
        .map((tool) => {
          const meta = BUILTIN_TOOL_LABEL_KEYS[tool.name]
          return {
            id: tool.name,
            label: meta ? t(meta.key, meta.fallback) : tool.name,
            enabled: !(
              settings.mcp.builtinToolOptions[tool.name]?.disabled ?? false
            ),
          }
        }),
    [settings.mcp.builtinToolOptions, t],
  )

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
            {t('settings.agent.safetyControls', 'Safety Controls')}
          </div>
          <div className="smtcmp-settings-desc">
            {t(
              'settings.agent.safetyControlsDesc',
              'Configure extra review behavior before agents perform risky file operations.',
            )}
          </div>
        </div>

        <ObsidianSetting
          name={t(
            'settings.agent.fsEditReviewToggle',
            'Review fs_edit changes',
          )}
          desc={t(
            'settings.agent.fsEditReviewToggleDesc',
            'When enabled, agent fs_edit changes open inline/apply review before writing the file.',
          )}
        >
          <ObsidianToggle
            value={settings.mcp.fsEditRequireReview ?? false}
            onChange={(value) => {
              handleToggleFsEditReview(value)
            }}
          />
        </ObsidianSetting>
      </section>
    </div>
  )
}
