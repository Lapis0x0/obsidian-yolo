import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { BookOpen, Copy, Cpu, Plus, Trash2, Wrench } from 'lucide-react'
import { App, Platform } from 'obsidian'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import { getAssistantModelDisplayLabel } from '../../../core/agent/assistant-model'
import { isDefaultAssistantId } from '../../../core/agent/default-assistant'
import { getEnabledAssistantToolNames } from '../../../core/agent/tool-preferences'
import { McpManager } from '../../../core/mcp/mcpManager'
import { humanizeSkillName } from '../../../core/skills/liteSkills'
import { isSkillEnabledForAssistant } from '../../../core/skills/skillPolicy'
import { useLiteSkillEntries } from '../../../hooks/useLiteSkillEntries'
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

import { AgentAutoContextCompactionSection } from './AgentAutoContextCompactionSection'
import { AgentCliPathSection } from './AgentCliPathSection'
import { AgentImageReadingSection } from './AgentImageReadingSection'
import { AgentMcpServerSection } from './AgentMcpServerSection'
import { buildBuiltinCapabilityRows } from './builtinCapabilityRows'
import { NotificationSettingsSection } from './NotificationSettingsSection'

type AgentSectionProps = {
  app: App
}

export function AgentSection({ app }: AgentSectionProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const plugin = usePlugin()
  const assistants = settings.assistants || []
  const [mcpManager, setMcpManager] = useState<McpManager | null>(null)
  const [mcpServers, setMcpServers] = useState<McpServerState[]>([])
  const [mcpManagerLoading, setMcpManagerLoading] = useState(true)
  const [portalContainer, setPortalContainer] = useState<HTMLElement>()
  const sectionRef = useCallback((node: HTMLDivElement | null) => {
    setPortalContainer(node?.ownerDocument.body)
  }, [])

  useEffect(() => {
    let isMounted = true
    setMcpManagerLoading(true)
    void plugin
      .getMcpManager()
      .then((manager) => {
        if (!isMounted) {
          return
        }
        setMcpManager(manager)
        setMcpServers(manager.getServers())
        setMcpManagerLoading(false)
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setMcpManagerLoading(false)
        }
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

  const handleToggleToolDisclosure = async (value: boolean) => {
    await setSettings({
      ...settings,
      mcp: {
        ...settings.mcp,
        enableToolDisclosure: value,
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

  const builtinTools = useMemo(() => {
    // Lists every registered capability unconditionally, for the same reason
    // as `AgentToolsModal.tsx`'s `builtinToolGroups` — see that useMemo. This
    // flat overview and the modal it launches must stay in visible sync.
    return buildBuiltinCapabilityRows({
      toolOptions: settings.mcp.builtinCapabilityOptions,
      t,
    }).map((row) => ({ id: row.id, label: row.label, enabled: row.enabled }))
  }, [settings.mcp.builtinCapabilityOptions, t])

  const allSkillEntries = useLiteSkillEntries(app, { settings })
  const disabledSkillIds = settings.skills?.disabledSkillIds ?? []
  const disabledSkillSet = useMemo(
    () => new Set(disabledSkillIds),
    [disabledSkillIds],
  )
  const globallyEnabledSkillEntries = useMemo(
    () => allSkillEntries.filter((skill) => !disabledSkillSet.has(skill.name)),
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

  const enabledConfiguredMcpServerCount = settings.mcp.servers.filter(
    (server) => server.enabled,
  ).length
  const mcpLoadingCount = mcpManagerLoading
    ? enabledConfiguredMcpServerCount
    : mcpServers.filter(
        (server) => server.status === McpServerStatus.Connecting,
      ).length
  const mcpErrorCount = mcpServers.filter(
    (server) => server.status === McpServerStatus.Error,
  ).length
  const mcpToolStatusLabels = [
    mcpLoadingCount > 0
      ? t('settings.agent.mcpLoadingStatus', 'Loading {count} MCP...').replace(
          '{count}',
          String(mcpLoadingCount),
        )
      : null,
    mcpErrorCount > 0
      ? t(
          'settings.agent.mcpErrorStatus',
          '{count} MCP failed to connect',
        ).replace('{count}', String(mcpErrorCount))
      : null,
  ].filter((label): label is string => Boolean(label))

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

  const TAG_DISPLAY_LIMIT = 20
  const visibleToolTags = toolTags.slice(0, TAG_DISPLAY_LIMIT)
  const hiddenToolTagsCount = toolTags.length - visibleToolTags.length
  const visibleSkillEntries = globallyEnabledSkillEntries.slice(
    0,
    TAG_DISPLAY_LIMIT,
  )
  const hiddenSkillEntriesCount =
    globallyEnabledSkillEntries.length - visibleSkillEntries.length

  return (
    <div ref={sectionRef} className="yolo-settings-section yolo-agent-section">
      <div className="yolo-settings-header">
        {t('settings.agent.title', 'Agent')}
      </div>
      <div className="yolo-settings-desc yolo-agent-intro">
        {t(
          'settings.agent.desc',
          'Manage global tool availability. Enabled tools become selectable by agents; actual use must still be enabled in each agent.',
        )}
      </div>

      <section className="yolo-agent-block">
        <div className="yolo-agent-block-head">
          <div className="yolo-settings-sub-header">
            {t('settings.agent.globalCapabilities', 'Global capabilities')}
          </div>
          <div className="yolo-settings-desc">{mcpCountLabel}</div>
        </div>

        <div className="yolo-agent-cap-grid">
          <article className="yolo-agent-cap-card">
            <div className="yolo-agent-cap-title-row">
              <div className="yolo-agent-cap-title">
                <Wrench size={14} />
                <span>{t('settings.agent.tools', 'Tools')}</span>
              </div>
              <button
                type="button"
                className="mod-cta yolo-agent-tools-trigger"
                onClick={handleOpenToolsModal}
              >
                {t('settings.agent.manageTools', 'Manage tools')}
              </button>
            </div>
            <div className="yolo-agent-cap-count">
              <span>{toolsCountLabel}</span>
              {mcpToolStatusLabels.map((label) => (
                <span key={label} className="yolo-agent-cap-status">
                  {label}
                </span>
              ))}
            </div>
            <div className="yolo-agent-cap-tags">
              {visibleToolTags.map((tool) => (
                <span
                  key={tool.key}
                  className="yolo-agent-chip"
                  title={tool.label}
                >
                  {tool.label}
                </span>
              ))}
              {hiddenToolTagsCount > 0 && (
                <button
                  type="button"
                  className="yolo-agent-chip yolo-agent-chip--more"
                  onClick={handleOpenToolsModal}
                  title={t('settings.agent.viewAllTools', 'View all tools')}
                >
                  +{hiddenToolTagsCount}
                </button>
              )}
            </div>
          </article>

          <article className="yolo-agent-cap-card">
            <div className="yolo-agent-cap-title-row">
              <div className="yolo-agent-cap-title">
                <BookOpen size={14} />
                <span>{t('settings.agent.skills', 'Skills')}</span>
              </div>
              <button
                type="button"
                className="mod-cta yolo-agent-tools-trigger"
                onClick={handleOpenSkillsModal}
              >
                {t('settings.agent.manageSkills', 'Manage skills')}
              </button>
            </div>
            <div className="yolo-agent-cap-count">{skillsCountLabel}</div>
            <div className="yolo-agent-cap-tags">
              {visibleSkillEntries.map((skill) => (
                <span
                  key={skill.name}
                  className="yolo-agent-chip"
                  title={skill.name}
                >
                  {humanizeSkillName(skill.name)}
                </span>
              ))}
              {hiddenSkillEntriesCount > 0 && (
                <button
                  type="button"
                  className="yolo-agent-chip yolo-agent-chip--more"
                  onClick={handleOpenSkillsModal}
                  title={t('settings.agent.viewAllSkills', 'View all skills')}
                >
                  +{hiddenSkillEntriesCount}
                </button>
              )}
            </div>
          </article>
        </div>

        <ObsidianSetting
          name={t(
            'settings.agent.enableToolDisclosure',
            'On-demand tool disclosure',
          )}
          desc={t(
            'settings.agent.enableToolDisclosureDesc',
            'Beta: expose large tool schemas only when the model asks for them.',
          )}
        >
          <ObsidianToggle
            value={settings.mcp.enableToolDisclosure}
            onChange={(value) => void handleToggleToolDisclosure(value)}
          />
        </ObsidianSetting>
      </section>

      <section className="yolo-agent-block">
        <div className="yolo-agent-block-head">
          <div className="yolo-agent-block-head-title-row">
            <div className="yolo-settings-sub-header">
              {t('settings.agent.agents', 'Agents')}
            </div>
            <ObsidianButton
              text={t('settings.agent.newAgent', 'New agent')}
              onClick={() => handleOpenAssistantsModal(undefined, true)}
              cta
            />
          </div>
          <div className="yolo-settings-desc">
            {t(
              'settings.agent.agentsDesc',
              'Click Configure to edit each agent profile and prompt.',
            )}
          </div>
        </div>

        <div className="yolo-agent-grid">
          {assistants.map((assistant) => (
            <article
              key={assistant.id}
              className="yolo-agent-card yolo-agent-card--clickable"
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
              <div className="yolo-agent-card-top">
                <div className="yolo-agent-card-top-main">
                  <div className="yolo-agent-avatar">
                    {renderAssistantIcon(assistant.icon, 16)}
                  </div>
                  <div className="yolo-agent-main">
                    <div className="yolo-agent-name-row">
                      <div className="yolo-agent-name">{assistant.name}</div>
                    </div>
                    {assistant.description && (
                      <div className="yolo-agent-desc">
                        {assistant.description}
                      </div>
                    )}
                  </div>
                </div>

                <DropdownMenu.Root>
                  <DropdownMenu.Trigger
                    className="yolo-agent-card-menu-trigger"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <span
                      className="yolo-agent-card-menu-trigger-dots"
                      aria-hidden="true"
                    >
                      ...
                    </span>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal container={portalContainer}>
                    <DropdownMenu.Content
                      className="yolo-agent-card-menu-popover"
                      align="end"
                      sideOffset={8}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <ul className="yolo-agent-card-menu-list">
                        <DropdownMenu.Item
                          asChild
                          onSelect={() => {
                            void handleDuplicateAssistant(assistant)
                          }}
                        >
                          <li className="yolo-agent-card-menu-item">
                            <span className="yolo-agent-card-menu-icon">
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
                            <li className="yolo-agent-card-menu-item yolo-agent-card-menu-danger">
                              <span className="yolo-agent-card-menu-icon">
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

              <div className="yolo-agent-meta-row">
                <span className="yolo-agent-meta-item">
                  <Cpu size={12} />
                  {getAssistantModelDisplayLabel(
                    assistant.modelId,
                    t(
                      'settings.agent.followDefaultModel',
                      'Follow default model',
                    ),
                  )}
                </span>
                <span className="yolo-agent-meta-item">
                  <Wrench size={12} />
                  {assistant.enableTools
                    ? `${getEnabledAssistantToolNames(assistant).length} tools`
                    : '0 tools'}
                </span>
                <span className="yolo-agent-meta-item">
                  <BookOpen size={12} />
                  {`${
                    allSkillEntries.filter((skill) =>
                      isSkillEnabledForAssistant({
                        assistant,
                        skillName: skill.name,
                        disabledSkillNames: disabledSkillIds,
                      }),
                    ).length
                  } skills`}
                </span>
              </div>
            </article>
          ))}
          <article
            className="yolo-agent-create-card"
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
            <div className="yolo-agent-create-card-icon">
              <Plus size={28} />
            </div>
            <div className="yolo-agent-create-card-text">
              {t('settings.agent.newAgent', 'New agent')}
            </div>
          </article>
        </div>
      </section>

      <section className="yolo-agent-block">
        <div className="yolo-agent-block-head">
          <div className="yolo-settings-sub-header">
            {t('settings.agent.agentCapabilitiesBlockTitle')}
          </div>
        </div>
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
        <div className="yolo-agent-sub-card">
          <div className="yolo-agent-sub-card-head">
            {t('settings.agent.mcpServerBlockTitle')}
          </div>
          <AgentMcpServerSection />
        </div>
        {Platform.isDesktop && (
          <div className="yolo-agent-sub-card">
            <div className="yolo-agent-sub-card-head">
              {t('settings.agent.cliRuntimesBlockTitle', 'CLI runtimes')}
            </div>
            <AgentCliPathSection app={app} />
          </div>
        )}
      </section>

      <section className="yolo-agent-block">
        <div className="yolo-agent-block-head">
          <div className="yolo-settings-sub-header">
            {t('settings.etc.notifications', '通知提醒')}
          </div>
        </div>

        <NotificationSettingsSection />
      </section>
    </div>
  )
}
