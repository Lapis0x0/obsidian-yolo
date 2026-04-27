import { BookOpen, FolderOpen, User, Wrench } from 'lucide-react'
import { App, TFile } from 'obsidian'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import {
  BUILTIN_TOOL_CATEGORY_I18N,
  BUILTIN_TOOL_CATEGORY_ORDER,
  FILE_OPS_GROUP_TOOL_NAME,
  MEMORY_OPS_GROUP_TOOL_NAME,
  WEB_OPS_GROUP_TOOL_NAME,
  WEB_OPS_SPLIT_ACTION_TOOL_NAMES,
  getBuiltinToolCategory,
  getBuiltinToolUiMeta,
} from '../../../core/agent/builtinToolUiMeta'
import {
  getAssistantToolApprovalMode,
  getAssistantToolPreferences,
  getDefaultApprovalModeForTool,
  getEnabledAssistantToolNames,
  isAssistantToolEnabled,
} from '../../../core/agent/tool-preferences'
import {
  LOCAL_FS_SPLIT_ACTION_TOOL_NAMES,
  LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES,
  getLocalFileToolServerName,
} from '../../../core/mcp/localFileTools'
import { parseToolName } from '../../../core/mcp/tool-name-utils'
import { getYoloSkillsDir } from '../../../core/paths/yoloPaths'
import {
  LiteSkillEntry,
  getLiteSkillDocument,
  listLiteSkillEntries,
} from '../../../core/skills/liteSkills'
import {
  getDisabledSkillIdSet,
  resolveAssistantSkillPolicy,
} from '../../../core/skills/skillPolicy'
import { SmartComposerSettings } from '../../../settings/schema/setting.types'
import {
  AgentPersona,
  Assistant,
  AssistantSkillLoadMode,
  AssistantToolApprovalMode,
  AssistantToolPreference,
  AssistantWorkspaceScope,
} from '../../../types/assistant.types'
import { McpTool } from '../../../types/mcp.types'
import {
  estimateJsonTokens,
  estimateTextTokens,
  formatTokenCount,
} from '../../../utils/llm/contextTokenEstimate'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextArea } from '../../common/ObsidianTextArea'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { SimpleSelect } from '../../common/SimpleSelect'
import { openIconPicker } from '../assistants/AssistantIconPicker'

import {
  normalizeToolPreferencesForPersistence,
  normalizeToolSelectionForPersistence,
} from './agentToolPersistence'
import { AgentWorkspaceScopeEditor } from './AgentWorkspaceScopeEditor'

type AgentsSectionContentProps = {
  app: App
  onClose: () => void
  initialAssistantId?: string
  initialCreate?: boolean
}

type AgentEditorTab = 'profile' | 'tools' | 'skills' | 'workspace'

type AgentToolView = {
  fullName: string
  toggleTargets: string[]
  displayName: string
  description: string
}

type SkillRowView = LiteSkillEntry & {
  globallyDisabled: boolean
  enabled: boolean
  loadMode: AssistantSkillLoadMode
}

const SPLIT_FS_TOOL_NAME_SET = new Set<string>(LOCAL_FS_SPLIT_ACTION_TOOL_NAMES)
const SPLIT_MEMORY_TOOL_NAME_SET = new Set<string>(
  LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES,
)
const SPLIT_WEB_TOOL_NAME_SET = new Set<string>(WEB_OPS_SPLIT_ACTION_TOOL_NAMES)

const AGENT_EDITOR_TABS: AgentEditorTab[] = [
  'profile',
  'tools',
  'skills',
  'workspace',
]

const AGENT_EDITOR_TAB_ICONS = {
  profile: User,
  tools: Wrench,
  skills: BookOpen,
  workspace: FolderOpen,
} as const

const DEFAULT_PERSONA: AgentPersona = 'balanced'

const skillDefaultContextTokenCache = new Map<string, number>()

function buildToolTokenPayload(tool: McpTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? {},
  }
}

function buildSkillMetadataPrompt(skill: LiteSkillEntry): string {
  return `- id: ${skill.id} | name: ${skill.name} | description: ${skill.description}`
}

function buildAlwaysOnSkillPrompt({
  entry,
  content,
}: {
  entry: LiteSkillEntry
  content: string
}): string {
  return `<skill id="${entry.id}" name="${entry.name}" path="${entry.path}">
${content}
</skill>`
}

async function estimateSkillDefaultContextTokens({
  app,
  settings,
  skill,
}: {
  app: App
  settings: SmartComposerSettings
  skill: SkillRowView
}): Promise<number> {
  if (skill.loadMode === 'lazy') {
    return estimateTextTokens(buildSkillMetadataPrompt(skill))
  }

  const abstractFile = app.vault.getAbstractFileByPath(skill.path)
  const cacheKey =
    abstractFile instanceof TFile
      ? `${skill.path}:${abstractFile.stat.mtime}:${skill.loadMode}`
      : `${skill.path}:${skill.loadMode}`
  const cached = skillDefaultContextTokenCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  const document = await getLiteSkillDocument({
    app,
    id: skill.id,
    settings,
  })
  if (!document) {
    return 0
  }

  const count = estimateTextTokens(
    buildAlwaysOnSkillPrompt({
      entry: document.entry,
      content: document.content,
    }),
  )
  skillDefaultContextTokenCache.set(cacheKey, count)
  return count
}

function createNewAgent(defaultModelId: string): Assistant {
  return {
    id: crypto.randomUUID(),
    name: '',
    description: '',
    systemPrompt: '',
    persona: DEFAULT_PERSONA,
    modelId: defaultModelId,
    enableTools: true,
    includeBuiltinTools: true,
    enabledToolNames: [],
    toolPreferences: {},
    enabledSkills: [],
    skillPreferences: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

const DEFAULT_DISABLED_NEW_AGENT_BUILTIN_TOOL_NAMES = new Set([
  'context_prune_tool_results',
  'context_compact',
])

function isDefaultDisabledNewAgentBuiltinTool(toolName: string): boolean {
  try {
    return DEFAULT_DISABLED_NEW_AGENT_BUILTIN_TOOL_NAMES.has(
      parseToolName(toolName).toolName,
    )
  } catch {
    return DEFAULT_DISABLED_NEW_AGENT_BUILTIN_TOOL_NAMES.has(toolName)
  }
}

function toDraftAgent(
  assistant: Assistant,
  fallbackModelId: string,
): Assistant {
  return {
    ...assistant,
    persona: assistant.persona ?? DEFAULT_PERSONA,
    modelId: assistant.modelId ?? fallbackModelId,
    enabledToolNames: getEnabledAssistantToolNames(assistant),
    toolPreferences: getAssistantToolPreferences(assistant),
    enabledSkills: assistant.enabledSkills ?? [],
    skillPreferences: assistant.skillPreferences ?? {},
    enableTools: assistant.enableTools ?? true,
    includeBuiltinTools: assistant.includeBuiltinTools ?? true,
  }
}

function updateDraftToolPreferences(
  assistant: Assistant,
  updater: (
    current: Record<string, AssistantToolPreference>,
  ) => Record<string, AssistantToolPreference>,
): Assistant {
  const current = {
    ...getAssistantToolPreferences(assistant),
  }
  const nextToolPreferences = updater(current)
  const nextEnabledToolNames = getEnabledAssistantToolNames({
    ...assistant,
    toolPreferences: nextToolPreferences,
  })

  return {
    ...assistant,
    toolPreferences: nextToolPreferences,
    enabledToolNames: nextEnabledToolNames,
  }
}

export function AgentsSectionContent({
  app,
  onClose,
  initialAssistantId,
  initialCreate,
}: AgentsSectionContentProps) {
  const plugin = usePlugin()
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()

  const assistants = settings.assistants || []
  const isDirectEditEntry = Boolean(initialAssistantId)
  const isDirectCreateEntry = Boolean(initialCreate)
  const isDirectEntry = isDirectEditEntry || isDirectCreateEntry
  const [draftAgent, setDraftAgent] = useState<Assistant | null>(() => {
    if (initialCreate) {
      const draft = createNewAgent(settings.chatModelId)
      draft.name = t('settings.agent.editorDefaultName', 'New agent')
      return draft
    }
    if (!initialAssistantId) {
      return null
    }
    const initialAssistant = assistants.find(
      (assistant) => assistant.id === initialAssistantId,
    )
    if (!initialAssistant) {
      return null
    }
    return toDraftAgent(initialAssistant, settings.chatModelId)
  })
  const [activeTab, setActiveTab] = useState<AgentEditorTab>('profile')
  const [availableTools, setAvailableTools] = useState<McpTool[]>([])
  const activeTabIndex = AGENT_EDITOR_TABS.findIndex((tab) => tab === activeTab)
  const activeTabIndexRef = useRef(activeTabIndex)
  const tabsNavRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const initializedNewAgentBuiltinToolsRef = useRef(false)
  const localFsServerName = getLocalFileToolServerName()

  const updateTabsGlider = useCallback(() => {
    const nav = tabsNavRef.current
    const index = activeTabIndexRef.current
    const activeButton = tabRefs.current[index]

    if (!nav || !activeButton || index < 0) {
      return
    }

    nav.style.setProperty(
      '--smtcmp-agent-tab-glider-left',
      `${activeButton.offsetLeft}px`,
    )
    nav.style.setProperty(
      '--smtcmp-agent-tab-glider-width',
      `${activeButton.offsetWidth}px`,
    )
  }, [])

  useLayoutEffect(() => {
    activeTabIndexRef.current = activeTabIndex
    updateTabsGlider()
  }, [activeTabIndex, updateTabsGlider])

  useEffect(() => {
    const nav = tabsNavRef.current
    if (!nav) {
      return
    }

    if (typeof ResizeObserver === 'undefined') {
      updateTabsGlider()
      return
    }

    const observer = new ResizeObserver(() => updateTabsGlider())
    observer.observe(nav)
    tabRefs.current.forEach((button) => {
      if (button) {
        observer.observe(button)
      }
    })

    return () => observer.disconnect()
  }, [updateTabsGlider])

  useEffect(() => {
    let mounted = true
    void plugin
      .getMcpManager()
      .then((manager) =>
        manager.listAvailableTools({ includeBuiltinTools: true }),
      )
      .then((tools) => {
        if (mounted) {
          setAvailableTools(tools)
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to load available tools for agent editor', error)
      })

    return () => {
      mounted = false
    }
  }, [plugin])

  useEffect(() => {
    if (!isDirectCreateEntry || initializedNewAgentBuiltinToolsRef.current) {
      return
    }

    if (!draftAgent || availableTools.length === 0) {
      return
    }

    const existingPreferences = getAssistantToolPreferences(draftAgent)
    const hasCustomToolSelection =
      (draftAgent.enabledToolNames?.length ?? 0) > 0 ||
      Object.keys(existingPreferences).length > 0
    if (
      hasCustomToolSelection ||
      !draftAgent.enableTools ||
      draftAgent.includeBuiltinTools === false
    ) {
      initializedNewAgentBuiltinToolsRef.current = true
      return
    }

    const builtinToolNames = availableTools
      .filter((tool) => {
        try {
          return parseToolName(tool.name).serverName === localFsServerName
        } catch {
          return true
        }
      })
      .map((tool) => tool.name)

    if (builtinToolNames.length === 0) {
      return
    }

    initializedNewAgentBuiltinToolsRef.current = true
    setDraftAgent((prev) => {
      if (!prev) {
        return prev
      }

      const nextToolPreferences = {
        ...getAssistantToolPreferences(prev),
      }
      const nextEnabledToolNames = new Set(getEnabledAssistantToolNames(prev))

      for (const toolName of builtinToolNames) {
        const existingPreference = nextToolPreferences[toolName]
        const shouldDefaultDisabled =
          isDefaultDisabledNewAgentBuiltinTool(toolName) &&
          existingPreference === undefined

        if (!shouldDefaultDisabled) {
          nextEnabledToolNames.add(toolName)
        }
        nextToolPreferences[toolName] = {
          ...existingPreference,
          enabled: existingPreference?.enabled ?? !shouldDefaultDisabled,
          approvalMode:
            existingPreference?.approvalMode ??
            getDefaultApprovalModeForTool(toolName),
        }
      }

      return {
        ...prev,
        toolPreferences: nextToolPreferences,
        enabledToolNames: [...nextEnabledToolNames],
      }
    })
  }, [availableTools, draftAgent, isDirectCreateEntry, localFsServerName])

  const agentModelOptionGroups = useMemo(() => {
    const providerOrder = settings.providers.map((provider) => provider.id)
    const providerIdsInModels = Array.from(
      new Set(settings.chatModels.map((model) => model.providerId)),
    )
    const orderedProviderIds = [
      ...providerOrder.filter((id) => providerIdsInModels.includes(id)),
      ...providerIdsInModels.filter((id) => !providerOrder.includes(id)),
    ]

    return orderedProviderIds
      .map((providerId) => {
        const models = settings.chatModels.filter(
          (model) => model.providerId === providerId,
        )
        if (models.length === 0) {
          return null
        }
        return {
          label: providerId,
          options: models.map((model) => ({
            value: model.id,
            label: model.name?.trim()
              ? model.name.trim()
              : model.model || model.id,
          })),
        }
      })
      .filter(
        (
          group,
        ): group is {
          label: string
          options: { value: string; label: string }[]
        } => group !== null,
      )
  }, [settings.chatModels, settings.providers])

  useEffect(() => {
    if (!initialAssistantId || draftAgent) {
      return
    }
    const target = assistants.find(
      (assistant) => assistant.id === initialAssistantId,
    )
    if (!target) {
      return
    }
    setDraftAgent(toDraftAgent(target, settings.chatModelId))
    setActiveTab('profile')
  }, [assistants, draftAgent, initialAssistantId, settings.chatModelId])

  const upsertDraft = async () => {
    if (!draftAgent || !draftAgent.name.trim()) {
      return
    }

    const normalized: Assistant = {
      ...draftAgent,
      name: draftAgent.name.trim(),
      description: draftAgent.description?.trim(),
      toolPreferences: normalizeToolPreferencesForPersistence(
        draftAgent.toolPreferences,
        availableTools,
      ),
      enabledToolNames: normalizeToolSelectionForPersistence(
        getEnabledAssistantToolNames(draftAgent),
        availableTools,
      ),
      updatedAt: Date.now(),
    }

    const exists = assistants.some(
      (assistant) => assistant.id === normalized.id,
    )
    const nextAssistants = exists
      ? assistants.map((assistant) =>
          assistant.id === normalized.id ? normalized : assistant,
        )
      : [...assistants, normalized]

    await setSettings({
      ...settings,
      assistants: nextAssistants,
      currentAssistantId: settings.currentAssistantId ?? normalized.id,
      quickAskAssistantId: settings.quickAskAssistantId ?? normalized.id,
    })
    if (isDirectEntry) {
      onClose()
      return
    }
    setDraftAgent(null)
  }

  const toggleTool = (toolNames: string[], enabled: boolean) => {
    setDraftAgent((prev) => {
      if (!prev) {
        return prev
      }

      return updateDraftToolPreferences(prev, (current) => {
        const next = { ...current }
        for (const toolName of toolNames) {
          next[toolName] = {
            ...next[toolName],
            enabled,
            approvalMode:
              next[toolName]?.approvalMode ??
              getDefaultApprovalModeForTool(toolName),
          }
        }
        return next
      })
    })
  }

  const setToolApprovalMode = (
    toolNames: string[],
    approvalMode: AssistantToolApprovalMode,
  ) => {
    setDraftAgent((prev) => {
      if (!prev) {
        return prev
      }

      return updateDraftToolPreferences(prev, (current) => {
        const next = { ...current }
        for (const toolName of toolNames) {
          next[toolName] = {
            ...next[toolName],
            enabled: next[toolName]?.enabled ?? true,
            approvalMode,
          }
        }
        return next
      })
    })
  }

  const setWorkspaceScope = (next: AssistantWorkspaceScope) => {
    setDraftAgent((prev) => {
      if (!prev) return prev
      return { ...prev, workspaceScope: next }
    })
  }

  const setSkillEnabled = (skillId: string, enabled: boolean) => {
    if (!draftAgent) {
      return
    }
    const current = new Set(draftAgent.enabledSkills ?? [])
    const nextPreferences = {
      ...(draftAgent.skillPreferences ?? {}),
    }

    if (enabled) {
      current.add(skillId)
    } else {
      current.delete(skillId)
    }

    nextPreferences[skillId] = {
      ...(nextPreferences[skillId] ?? {}),
      enabled,
    }

    setDraftAgent({
      ...draftAgent,
      enabledSkills: [...current],
      skillPreferences: nextPreferences,
    })
  }

  const setSkillLoadMode = (
    skillId: string,
    loadMode: AssistantSkillLoadMode,
  ) => {
    if (!draftAgent) {
      return
    }

    const nextPreferences = {
      ...(draftAgent.skillPreferences ?? {}),
      [skillId]: {
        ...(draftAgent.skillPreferences?.[skillId] ?? {}),
        enabled:
          draftAgent.skillPreferences?.[skillId]?.enabled ??
          draftAgent.enabledSkills?.includes(skillId) ??
          true,
        loadMode,
      },
    }

    setDraftAgent({
      ...draftAgent,
      skillPreferences: nextPreferences,
    })
  }

  const visibleToolGroups = useMemo(() => {
    const groups = new Map<string, { title: string; tools: AgentToolView[] }>()
    const localSplitToolTargets = new Set<string>()
    const localMemorySplitToolTargets = new Set<string>()
    const localWebSplitToolTargets = new Set<string>()

    availableTools.forEach((tool) => {
      let serverName = localFsServerName
      let toolName = tool.name

      try {
        const parsed = parseToolName(tool.name)
        serverName = parsed.serverName
        toolName = parsed.toolName
      } catch {
        serverName = localFsServerName
        toolName = tool.name
      }

      const isBuiltin = serverName === localFsServerName
      if (isBuiltin && draftAgent?.includeBuiltinTools === false) {
        return
      }
      if (isBuiltin && SPLIT_FS_TOOL_NAME_SET.has(toolName)) {
        localSplitToolTargets.add(tool.name)
        return
      }
      if (isBuiltin && SPLIT_MEMORY_TOOL_NAME_SET.has(toolName)) {
        localMemorySplitToolTargets.add(tool.name)
        return
      }
      if (isBuiltin && SPLIT_WEB_TOOL_NAME_SET.has(toolName)) {
        localWebSplitToolTargets.add(tool.name)
        return
      }

      const builtinCategory = isBuiltin
        ? (getBuiltinToolCategory(toolName) ?? 'vault')
        : null
      const key = isBuiltin ? `__builtin:${builtinCategory}` : serverName
      const title = isBuiltin
        ? t(
            BUILTIN_TOOL_CATEGORY_I18N[builtinCategory!].key,
            BUILTIN_TOOL_CATEGORY_I18N[builtinCategory!].fallback,
          )
        : serverName
      const builtinMeta = isBuiltin ? getBuiltinToolUiMeta(toolName) : null
      const displayName = builtinMeta
        ? t(builtinMeta.labelKey, builtinMeta.labelFallback)
        : toolName
      const description = builtinMeta
        ? t(builtinMeta.descKey ?? '', builtinMeta.descFallback)
        : tool.description || t('common.none', 'None')
      const group = groups.get(key) ?? { title, tools: [] }
      group.tools.push({
        fullName: tool.name,
        toggleTargets: [tool.name],
        displayName,
        description,
      })
      groups.set(key, group)
    })

    const pushBuiltinGroupTool = (toolName: string, tool: AgentToolView) => {
      const category = getBuiltinToolCategory(toolName) ?? 'vault'
      const key = `__builtin:${category}`
      const title = t(
        BUILTIN_TOOL_CATEGORY_I18N[category].key,
        BUILTIN_TOOL_CATEGORY_I18N[category].fallback,
      )
      const group = groups.get(key) ?? { title, tools: [] }
      group.tools.push(tool)
      groups.set(key, group)
    }

    if (
      draftAgent?.includeBuiltinTools !== false &&
      localSplitToolTargets.size > 0
    ) {
      const fileOpsMeta = getBuiltinToolUiMeta(FILE_OPS_GROUP_TOOL_NAME)
      if (!fileOpsMeta) {
        throw new Error('Missing built-in tool UI metadata for fs_file_ops')
      }
      pushBuiltinGroupTool(FILE_OPS_GROUP_TOOL_NAME, {
        fullName: `${localFsServerName}__${FILE_OPS_GROUP_TOOL_NAME}`,
        toggleTargets: [...localSplitToolTargets],
        displayName: t(fileOpsMeta.labelKey, fileOpsMeta.labelFallback),
        description: t(fileOpsMeta.descKey ?? '', fileOpsMeta.descFallback),
      })
    }

    if (
      draftAgent?.includeBuiltinTools !== false &&
      localMemorySplitToolTargets.size > 0
    ) {
      const memoryOpsMeta = getBuiltinToolUiMeta(MEMORY_OPS_GROUP_TOOL_NAME)
      if (!memoryOpsMeta) {
        throw new Error('Missing built-in tool UI metadata for memory_ops')
      }
      pushBuiltinGroupTool(MEMORY_OPS_GROUP_TOOL_NAME, {
        fullName: `${localFsServerName}__${MEMORY_OPS_GROUP_TOOL_NAME}`,
        toggleTargets: [...localMemorySplitToolTargets],
        displayName: t(memoryOpsMeta.labelKey, memoryOpsMeta.labelFallback),
        description: t(memoryOpsMeta.descKey ?? '', memoryOpsMeta.descFallback),
      })
    }

    if (
      draftAgent?.includeBuiltinTools !== false &&
      localWebSplitToolTargets.size > 0
    ) {
      const webOpsMeta = getBuiltinToolUiMeta(WEB_OPS_GROUP_TOOL_NAME)
      if (!webOpsMeta) {
        throw new Error('Missing built-in tool UI metadata for web_ops')
      }
      pushBuiltinGroupTool(WEB_OPS_GROUP_TOOL_NAME, {
        fullName: `${localFsServerName}__${WEB_OPS_GROUP_TOOL_NAME}`,
        toggleTargets: [...localWebSplitToolTargets],
        displayName: t(webOpsMeta.labelKey, webOpsMeta.labelFallback),
        description: t(webOpsMeta.descKey ?? '', webOpsMeta.descFallback),
      })
    }

    const builtinCategoryRank = new Map<string, number>(
      BUILTIN_TOOL_CATEGORY_ORDER.map(
        (category, index) => [`__builtin:${category}`, index] as const,
      ),
    )
    return [...groups.entries()]
      .sort(([a], [b]) => {
        const ra = builtinCategoryRank.get(a)
        const rb = builtinCategoryRank.get(b)
        if (ra !== undefined && rb !== undefined) return ra - rb
        if (ra !== undefined) return -1
        if (rb !== undefined) return 1
        return a.localeCompare(b)
      })
      .map(([key, value]) => ({ key, ...value }))
  }, [availableTools, draftAgent?.includeBuiltinTools, localFsServerName, t])

  const visibleToolsCount = useMemo(
    () => visibleToolGroups.reduce((sum, group) => sum + group.tools.length, 0),
    [visibleToolGroups],
  )

  const enabledVisibleToolsCount = useMemo(() => {
    const enabled = new Set(getEnabledAssistantToolNames(draftAgent))
    return visibleToolGroups.reduce(
      (sum, group) =>
        sum +
        group.tools.filter((tool) =>
          tool.toggleTargets.every((target) => enabled.has(target)),
        ).length,
      0,
    )
  }, [draftAgent, visibleToolGroups])

  const groupEnabledCounts = useMemo(() => {
    const enabled = new Set(getEnabledAssistantToolNames(draftAgent))
    const counts = new Map<string, number>()
    for (const group of visibleToolGroups) {
      counts.set(
        group.key,
        group.tools.filter((tool) =>
          tool.toggleTargets.every((target) => enabled.has(target)),
        ).length,
      )
    }
    return counts
  }, [draftAgent, visibleToolGroups])

  const estimatedToolContextTokens = useMemo(() => {
    if (!draftAgent?.enableTools) {
      return 0
    }

    return availableTools.reduce((sum, tool) => {
      let serverName = localFsServerName
      try {
        serverName = parseToolName(tool.name).serverName
      } catch {
        serverName = localFsServerName
      }

      if (
        serverName === localFsServerName &&
        draftAgent.includeBuiltinTools === false
      ) {
        return sum
      }
      if (!isAssistantToolEnabled(draftAgent, tool.name)) {
        return sum
      }

      return sum + estimateJsonTokens(buildToolTokenPayload(tool))
    }, 0)
  }, [
    availableTools,
    draftAgent,
    draftAgent?.enableTools,
    draftAgent?.includeBuiltinTools,
    localFsServerName,
  ])

  const skillEntries = useMemo<LiteSkillEntry[]>(
    () => listLiteSkillEntries(app, { settings }),
    [app, settings],
  )

  const disabledSkillIds = settings.skills?.disabledSkillIds ?? []
  const skillsDir = getYoloSkillsDir(settings)
  const disabledSkillIdSet = useMemo(
    () => getDisabledSkillIdSet(disabledSkillIds),
    [disabledSkillIds],
  )

  const skillRows = useMemo(() => {
    return skillEntries.map((skill) => {
      const globallyDisabled = disabledSkillIdSet.has(skill.id)
      const policy = resolveAssistantSkillPolicy({
        assistant: draftAgent,
        skillId: skill.id,
        defaultLoadMode: skill.mode,
      })
      const enabled = policy.enabled && !globallyDisabled
      return {
        ...skill,
        globallyDisabled,
        enabled,
        loadMode: policy.loadMode,
      }
    })
  }, [disabledSkillIdSet, draftAgent, skillEntries])

  const [estimatedSkillContextTokens, setEstimatedSkillContextTokens] =
    useState<number | null>(null)

  const alwaysSkillRows = useMemo(
    () =>
      skillRows.filter((skill) => skill.enabled && skill.loadMode === 'always'),
    [skillRows],
  )
  const lazySkillRows = useMemo(
    () =>
      skillRows.filter((skill) => skill.enabled && skill.loadMode === 'lazy'),
    [skillRows],
  )

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      const enabledSkillRows = skillRows.filter((skill) => skill.enabled)
      if (enabledSkillRows.length === 0) {
        if (!cancelled) {
          setEstimatedSkillContextTokens(0)
        }
        return
      }

      if (!cancelled) {
        setEstimatedSkillContextTokens(null)
      }

      const counts = await Promise.all(
        enabledSkillRows.map((skill) =>
          estimateSkillDefaultContextTokens({
            app,
            settings,
            skill,
          }),
        ),
      )

      if (!cancelled) {
        setEstimatedSkillContextTokens(
          counts.reduce((sum, count) => sum + count, 0),
        )
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [app, settings, skillRows])
  const toolApprovalOptions = useMemo(
    () => [
      {
        value: 'require_approval',
        label: t('settings.agent.toolApprovalRequire', 'Require approval'),
      },
      {
        value: 'full_access',
        label: t('settings.agent.toolApprovalFullAccess', 'Full access'),
      },
    ],
    [t],
  )

  return (
    <div
      className={`smtcmp-settings-section smtcmp-agent-editor-panel${
        isDirectEntry ? ' smtcmp-agent-editor-panel--direct' : ''
      }`}
    >
      {draftAgent && (
        <div className="smtcmp-agent-editor-sheet">
          <div className="smtcmp-agent-editor-sheet-header">
            <div>
              <div className="smtcmp-settings-sub-header">
                {draftAgent.name ||
                  t('settings.agent.editorDefaultName', 'New agent')}
              </div>
              <div className="smtcmp-settings-desc">
                {t(
                  'settings.agent.editorIntro',
                  "Configure this agent's capabilities, model, and behavior.",
                )}
              </div>
            </div>
            {!isDirectEntry && (
              <div className="smtcmp-agent-editor-sheet-actions">
                <ObsidianButton
                  text={t('common.cancel', 'Cancel')}
                  onClick={() => setDraftAgent(null)}
                />
                <ObsidianButton
                  text={t('common.save', 'Save')}
                  cta
                  onClick={() => void upsertDraft()}
                />
              </div>
            )}
          </div>

          <div
            className="smtcmp-agent-editor-tabs smtcmp-agent-editor-tabs--glider"
            role="tablist"
            ref={tabsNavRef}
            style={
              {
                '--smtcmp-agent-tab-count': AGENT_EDITOR_TABS.length,
                '--smtcmp-agent-tab-index': activeTabIndex,
              } as React.CSSProperties
            }
          >
            <div
              className="smtcmp-agent-editor-tabs-glider"
              aria-hidden="true"
            />
            {AGENT_EDITOR_TABS.map((tab, index) => {
              const TabIcon = AGENT_EDITOR_TAB_ICONS[tab]
              return (
                <button
                  key={tab}
                  type="button"
                  className={`smtcmp-agent-editor-tab ${activeTab === tab ? 'is-active' : ''}`}
                  onClick={() => setActiveTab(tab)}
                  role="tab"
                  aria-selected={activeTab === tab}
                  ref={(element) => {
                    tabRefs.current[index] = element
                  }}
                >
                  <span
                    className="smtcmp-agent-editor-tab-icon"
                    aria-hidden="true"
                  >
                    <TabIcon size={14} />
                  </span>
                  <span className="smtcmp-agent-editor-tab-label">
                    {
                      {
                        profile: t(
                          'settings.agent.editorTabProfile',
                          'Profile',
                        ),
                        tools: t('settings.agent.editorTabTools', 'Tools'),
                        skills: t('settings.agent.editorTabSkills', 'Skills'),
                        workspace: t(
                          'settings.agent.editorTabWorkspace',
                          'Workspace',
                        ),
                      }[tab]
                    }
                  </span>
                </button>
              )
            })}
          </div>

          {activeTab === 'profile' && (
            <div className="smtcmp-agent-editor-body">
              <ObsidianSetting
                name={t('settings.agent.editorName', 'Name')}
                desc={t('settings.agent.editorNameDesc', 'Agent display name')}
              >
                <ObsidianTextInput
                  value={draftAgent.name}
                  onChange={(value) =>
                    setDraftAgent({ ...draftAgent, name: value })
                  }
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t('settings.agent.editorDescription', 'Description')}
                desc={t(
                  'settings.agent.editorDescriptionDesc',
                  'Short summary for this agent',
                )}
              >
                <ObsidianTextInput
                  value={draftAgent.description || ''}
                  onChange={(value) =>
                    setDraftAgent({ ...draftAgent, description: value })
                  }
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t('settings.agent.editorIcon', 'Icon')}
                desc={t(
                  'settings.agent.editorIconDesc',
                  'Pick an icon for this agent',
                )}
              >
                <ObsidianButton
                  text={t('settings.agent.editorChooseIcon', 'Choose icon')}
                  onClick={() => {
                    openIconPicker(app, draftAgent.icon, (newIcon) => {
                      setDraftAgent({ ...draftAgent, icon: newIcon })
                    })
                  }}
                />
              </ObsidianSetting>
              <div className="smtcmp-agent-model-setting-row">
                <div className="smtcmp-agent-model-setting-info">
                  <div className="smtcmp-agent-model-setting-title">
                    {t('settings.agent.editorModel', 'Model')}
                  </div>
                  <div className="smtcmp-agent-model-setting-desc">
                    {t(
                      'settings.agent.editorModelDesc',
                      'Select the model used by this agent',
                    )}
                  </div>
                </div>
                <div className="smtcmp-agent-model-select-wrap">
                  <SimpleSelect
                    value={draftAgent.modelId || settings.chatModelId}
                    groupedOptions={agentModelOptionGroups}
                    align="end"
                    side="bottom"
                    sideOffset={6}
                    placeholder={t('common.select', 'Select')}
                    contentClassName="smtcmp-agent-model-select-content"
                    onChange={(value: string) =>
                      setDraftAgent({
                        ...draftAgent,
                        modelId: value,
                      })
                    }
                  />
                </div>
              </div>
              <ObsidianSetting
                name={t('settings.agent.editorSystemPrompt', 'System prompt')}
                desc={t(
                  'settings.agent.editorSystemPromptDesc',
                  'Primary behavior instruction for this agent',
                )}
                className="smtcmp-settings-textarea-header smtcmp-settings-desc-copyable"
              />
              <ObsidianSetting className="smtcmp-settings-textarea">
                <ObsidianTextArea
                  value={draftAgent.systemPrompt}
                  onChange={(value) =>
                    setDraftAgent({ ...draftAgent, systemPrompt: value })
                  }
                  autoResize
                  maxAutoResizeHeight={360}
                  inputClassName="smtcmp-agent-system-prompt-textarea"
                />
              </ObsidianSetting>
            </div>
          )}

          {activeTab === 'tools' && (
            <div className="smtcmp-agent-editor-body">
              <ObsidianSetting
                name={t('settings.agent.editorEnableTools', 'Enable tools')}
                desc={t(
                  'settings.agent.editorEnableToolsDesc',
                  'Allow this agent to call tools',
                )}
              >
                <ObsidianToggle
                  value={Boolean(draftAgent.enableTools)}
                  onChange={(value) => {
                    setDraftAgent({
                      ...draftAgent,
                      enableTools: value,
                    })
                  }}
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t(
                  'settings.agent.editorIncludeBuiltinTools',
                  'Include built-in tools',
                )}
                desc={t(
                  'settings.agent.editorIncludeBuiltinToolsDesc',
                  'Allow local vault file tools for this agent',
                )}
              >
                <ObsidianToggle
                  value={Boolean(draftAgent.includeBuiltinTools)}
                  onChange={(value) => {
                    setDraftAgent((prev) => {
                      if (!prev) {
                        return prev
                      }

                      const nextEnabledToolNames = new Set(
                        getEnabledAssistantToolNames(prev),
                      )
                      const nextToolPreferences = {
                        ...getAssistantToolPreferences(prev),
                      }

                      if (value && !prev.includeBuiltinTools) {
                        availableTools.forEach((tool) => {
                          let serverName = localFsServerName
                          try {
                            serverName = parseToolName(tool.name).serverName
                          } catch {
                            serverName = localFsServerName
                          }

                          if (serverName === localFsServerName) {
                            const existingPreference =
                              nextToolPreferences[tool.name]
                            const shouldDefaultDisabled =
                              isDefaultDisabledNewAgentBuiltinTool(tool.name) &&
                              existingPreference === undefined

                            if (!shouldDefaultDisabled) {
                              nextEnabledToolNames.add(tool.name)
                            }
                            nextToolPreferences[tool.name] = {
                              ...existingPreference,
                              enabled:
                                existingPreference?.enabled ??
                                !shouldDefaultDisabled,
                              approvalMode:
                                existingPreference?.approvalMode ??
                                getDefaultApprovalModeForTool(tool.name),
                            }
                          }
                        })
                      }

                      return {
                        ...prev,
                        includeBuiltinTools: value,
                        toolPreferences: nextToolPreferences,
                        enabledToolNames: [...nextEnabledToolNames],
                      }
                    })
                  }}
                />
              </ObsidianSetting>
              <div
                className={`smtcmp-agent-tools-panel${
                  draftAgent.enableTools ? '' : ' is-disabled'
                }`}
              >
                <div className="smtcmp-agent-tools-panel-head">
                  <div className="smtcmp-agent-tools-panel-title-row">
                    <div className="smtcmp-agent-tools-panel-title">
                      {t('settings.agent.tools', 'Tools')}
                    </div>
                    <div className="smtcmp-agent-tools-panel-estimate">
                      {t(
                        'settings.agent.editorEstimatedContextTokens',
                        '~{count} tokens',
                      ).replace(
                        '{count}',
                        formatTokenCount(estimatedToolContextTokens),
                      )}
                    </div>
                  </div>
                  <div className="smtcmp-agent-tools-panel-count">
                    {`${enabledVisibleToolsCount} / ${visibleToolsCount} ${t(
                      'settings.agent.toolsActive',
                      'active',
                    )}`}
                  </div>
                </div>

                {visibleToolGroups.map((group) => (
                  <div key={group.key} className="smtcmp-agent-tool-group">
                    <div className="smtcmp-agent-tool-group-title">
                      <span>{group.title}</span>
                      <span className="smtcmp-agent-tool-group-count">
                        {`${groupEnabledCounts.get(group.key) ?? 0} / ${group.tools.length} ${t(
                          'settings.agent.toolsActive',
                          'active',
                        )}`}
                      </span>
                    </div>
                    <div className="smtcmp-agent-tool-list">
                      {group.tools.map((tool) => {
                        const selected = tool.toggleTargets.every((target) =>
                          isAssistantToolEnabled(draftAgent, target),
                        )
                        const approvalMode = tool.toggleTargets.every(
                          (target) =>
                            getAssistantToolApprovalMode(draftAgent, target) ===
                            'full_access',
                        )
                          ? 'full_access'
                          : 'require_approval'

                        return (
                          <div
                            key={tool.fullName}
                            className="smtcmp-agent-tool-row"
                          >
                            <div className="smtcmp-agent-tool-main">
                              <div className="smtcmp-agent-tool-name smtcmp-agent-tool-name--mono">
                                {tool.displayName}
                              </div>
                              <div className="smtcmp-agent-tool-source smtcmp-agent-tool-source--preview">
                                {tool.description}
                              </div>
                            </div>
                            <div className="smtcmp-agent-tool-controls">
                              {selected && (
                                <div className="smtcmp-agent-tool-approval">
                                  <SimpleSelect
                                    value={approvalMode}
                                    options={toolApprovalOptions}
                                    onChange={(value) =>
                                      setToolApprovalMode(
                                        tool.toggleTargets,
                                        value as AssistantToolApprovalMode,
                                      )
                                    }
                                    align="end"
                                    contentClassName="smtcmp-agent-tool-approval-menu"
                                  />
                                </div>
                              )}
                              <ObsidianToggle
                                value={Boolean(selected)}
                                onChange={(value) =>
                                  toggleTool(tool.toggleTargets, value)
                                }
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}

                {visibleToolsCount === 0 && (
                  <div className="smtcmp-agent-tools-empty">
                    {t('settings.agent.noTools', 'No tools available')}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'skills' && (
            <div className="smtcmp-agent-editor-body">
              <div className="smtcmp-agent-tools-panel">
                <div className="smtcmp-agent-tools-panel-head">
                  <div className="smtcmp-agent-tools-panel-title-row">
                    <div className="smtcmp-agent-tools-panel-title">
                      {t('settings.agent.skills', 'Skills')}
                    </div>
                    {estimatedSkillContextTokens !== null && (
                      <div className="smtcmp-agent-tools-panel-estimate">
                        {t(
                          'settings.agent.editorEstimatedContextTokens',
                          '~{count} tokens',
                        ).replace(
                          '{count}',
                          formatTokenCount(estimatedSkillContextTokens),
                        )}
                      </div>
                    )}
                  </div>
                  <div className="smtcmp-agent-tools-panel-count">
                    {t(
                      'settings.agent.editorSkillsCountWithEnabled',
                      '{count} skills (enabled {enabled})',
                    )
                      .replace('{count}', String(skillRows.length))
                      .replace(
                        '{enabled}',
                        String(
                          skillRows.filter((skill) => skill.enabled).length,
                        ),
                      )}
                  </div>
                </div>

                <div className="smtcmp-agent-skill-summary-row">
                  <span className="smtcmp-agent-chip">
                    {t('settings.agent.skillLoadAlways', 'Full inject')}:{' '}
                    {alwaysSkillRows.length}
                  </span>
                  <span className="smtcmp-agent-chip">
                    {t('settings.agent.skillLoadLazy', 'On demand')}:{' '}
                    {lazySkillRows.length}
                  </span>
                </div>

                {skillRows.length > 0 ? (
                  <div className="smtcmp-agent-tool-list">
                    {skillRows.map((skill) => {
                      const disabledByGlobal = skill.globallyDisabled
                      return (
                        <div key={skill.id} className="smtcmp-agent-tool-row">
                          <div className="smtcmp-agent-tool-main">
                            <div className="smtcmp-agent-tool-name">
                              {skill.name}
                            </div>
                            <div className="smtcmp-agent-tool-source smtcmp-agent-tool-source--preview">
                              {skill.description}
                            </div>
                            <div className="smtcmp-agent-skill-meta">
                              <span className="smtcmp-agent-chip">
                                id: {skill.id}
                              </span>
                              <span className="smtcmp-agent-chip">
                                {skill.path}
                              </span>
                              {disabledByGlobal && (
                                <span className="smtcmp-agent-chip">
                                  {t(
                                    'settings.agent.skillDisabledGlobally',
                                    'Disabled globally',
                                  )}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="smtcmp-agent-skill-controls">
                            <ObsidianToggle
                              value={skill.enabled}
                              onChange={(value) => {
                                if (disabledByGlobal) {
                                  return
                                }
                                setSkillEnabled(skill.id, value)
                              }}
                            />
                            <select
                              value={skill.loadMode}
                              disabled={!skill.enabled || disabledByGlobal}
                              onChange={(event) =>
                                setSkillLoadMode(
                                  skill.id,
                                  event.target.value as AssistantSkillLoadMode,
                                )
                              }
                            >
                              <option value="always">
                                {t(
                                  'settings.agent.skillLoadAlways',
                                  'Full inject',
                                )}
                              </option>
                              <option value="lazy">
                                {t('settings.agent.skillLoadLazy', 'On demand')}
                              </option>
                            </select>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="smtcmp-agent-tools-empty">
                    {t(
                      'settings.agent.skillsEmptyHint',
                      'No skills found. Create skill markdown files under {path}.',
                    ).replace('{path}', skillsDir)}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'workspace' && (
            <div className="smtcmp-agent-editor-body">
              <AgentWorkspaceScopeEditor
                app={app}
                vault={app.vault}
                value={draftAgent.workspaceScope}
                onChange={setWorkspaceScope}
              />
            </div>
          )}

          {isDirectEntry && (
            <div className="smtcmp-agent-editor-direct-footer">
              <div className="smtcmp-agent-editor-direct-footer-actions">
                <ObsidianButton
                  text={t('common.cancel', 'Cancel')}
                  onClick={onClose}
                />
                <ObsidianButton
                  text={t('common.save', 'Save')}
                  cta
                  onClick={() => void upsertDraft()}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
