import { BookOpen, Cpu, User, Wrench } from 'lucide-react'
import { App } from 'obsidian'
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
  getDefaultApprovalModeForTool,
  getAssistantToolApprovalMode,
  getAssistantToolPreferences,
  getEnabledAssistantToolNames,
  isAssistantToolEnabled,
} from '../../../core/agent/tool-preferences'
import {
  getLocalFileToolServerName,
  LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES,
  LOCAL_FS_SPLIT_ACTION_TOOL_NAMES,
} from '../../../core/mcp/localFileTools'
import { parseToolName } from '../../../core/mcp/tool-name-utils'
import { getYoloSkillsDir } from '../../../core/paths/yoloPaths'
import {
  LiteSkillEntry,
  listLiteSkillEntries,
} from '../../../core/skills/liteSkills'
import {
  getDisabledSkillIdSet,
  resolveAssistantSkillPolicy,
} from '../../../core/skills/skillPolicy'
import {
  AgentPersona,
  Assistant,
  AssistantSkillLoadMode,
  AssistantToolApprovalMode,
  AssistantToolPreference,
} from '../../../types/assistant.types'
import { McpTool } from '../../../types/mcp.types'
import {
  normalizeCustomParameterType,
  sanitizeCustomParameters,
} from '../../../utils/custom-parameters'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextArea } from '../../common/ObsidianTextArea'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { SimpleSelect } from '../../common/SimpleSelect'
import { openIconPicker } from '../assistants/AssistantIconPicker'

type AgentsSectionContentProps = {
  app: App
  onClose: () => void
  initialAssistantId?: string
  initialCreate?: boolean
}

type AgentEditorTab = 'profile' | 'tools' | 'skills' | 'model'

type AgentToolView = {
  fullName: string
  toggleTargets: string[]
  displayName: string
  description: string
}

const SPLIT_FS_TOOL_NAME_SET = new Set<string>(LOCAL_FS_SPLIT_ACTION_TOOL_NAMES)
const SPLIT_MEMORY_TOOL_NAME_SET = new Set<string>(
  LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES,
)
const FILE_OPS_GROUP_TOOL_NAME = 'fs_file_ops'
const MEMORY_OPS_GROUP_TOOL_NAME = 'memory_ops'

const BUILTIN_TOOL_LABEL_KEYS: Record<
  string,
  {
    key: string
    descKey: string
    fallback: string
    descFallback: string
  }
> = {
  fs_list: {
    key: 'settings.agent.builtinFsListLabel',
    descKey: 'settings.agent.builtinFsListDesc',
    fallback: 'Read Vault',
    descFallback:
      'List directory structure under a vault path. Useful for workspace orientation.',
  },
  fs_search: {
    key: 'settings.agent.builtinFsSearchLabel',
    descKey: 'settings.agent.builtinFsSearchDesc',
    fallback: 'Search Vault',
    descFallback: 'Search files, folders, or markdown content in vault.',
  },
  fs_read: {
    key: 'settings.agent.builtinFsReadLabel',
    descKey: 'settings.agent.builtinFsReadDesc',
    fallback: 'Read File',
    descFallback: 'Read line ranges from multiple vault files by path.',
  },
  fs_edit: {
    key: 'settings.agent.builtinFsEditLabel',
    descKey: 'settings.agent.builtinFsEditDesc',
    fallback: 'Text Editing',
    descFallback:
      'Apply text edit operations within a single existing file, including replace, insert_after, and append.',
  },
  fs_file_ops: {
    key: 'settings.agent.builtinFsFileOpsLabel',
    descKey: 'settings.agent.builtinFsFileOpsDesc',
    fallback: 'File Operations',
    descFallback:
      'Grouped file path operations: create/delete file, create/delete folder, and move.',
  },
  memory_ops: {
    key: 'settings.agent.builtinMemoryOpsLabel',
    descKey: 'settings.agent.builtinMemoryOpsDesc',
    fallback: 'Memory Toolset',
    descFallback: 'Grouped memory operations: add, update, and delete memory.',
  },
  memory_add: {
    key: 'settings.agent.builtinMemoryAddLabel',
    descKey: 'settings.agent.builtinMemoryAddDesc',
    fallback: 'Add Memory',
    descFallback:
      'Add one memory item into global or assistant memory and auto-assign an id.',
  },
  memory_update: {
    key: 'settings.agent.builtinMemoryUpdateLabel',
    descKey: 'settings.agent.builtinMemoryUpdateDesc',
    fallback: 'Update Memory',
    descFallback: 'Update an existing memory item by id.',
  },
  memory_delete: {
    key: 'settings.agent.builtinMemoryDeleteLabel',
    descKey: 'settings.agent.builtinMemoryDeleteDesc',
    fallback: 'Delete Memory',
    descFallback: 'Delete an existing memory item by id.',
  },
  open_skill: {
    key: 'settings.agent.builtinOpenSkillLabel',
    descKey: 'settings.agent.builtinOpenSkillDesc',
    fallback: 'Open Skill',
    descFallback: 'Load a skill markdown file by id or name.',
  },
}

const AGENT_EDITOR_TABS: AgentEditorTab[] = [
  'profile',
  'model',
  'tools',
  'skills',
]

const AGENT_EDITOR_TAB_ICONS = {
  profile: User,
  tools: Wrench,
  skills: BookOpen,
  model: Cpu,
} as const

const DEFAULT_PERSONA: AgentPersona = 'balanced'

const AGENT_MODEL_DEFAULTS = {
  temperature: 0.7,
  topP: 0.9,
  maxOutputTokens: 4096,
} as const

const AGENT_MAX_CONTEXT_MESSAGES_RANGE = {
  min: 1,
  max: 100,
} as const
const DEFAULT_MAX_CONTEXT_MESSAGES = 32

const CUSTOM_PARAMETER_TYPES = ['text', 'number', 'boolean', 'json'] as const

function clampTemperature(value: number): number {
  return Math.min(2, Math.max(0, value))
}

function clampTopP(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function clampMaxOutputTokens(value: number): number {
  return Math.max(1, Math.floor(value))
}

function clampMaxContextMessages(value: number): number {
  return Math.min(
    AGENT_MAX_CONTEXT_MESSAGES_RANGE.max,
    Math.max(AGENT_MAX_CONTEXT_MESSAGES_RANGE.min, Math.floor(value)),
  )
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
    temperature: undefined,
    topP: undefined,
    maxOutputTokens: undefined,
    maxContextMessages: undefined,
    customParameters: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
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
    temperature: assistant.temperature,
    topP: assistant.topP,
    maxOutputTokens: assistant.maxOutputTokens,
    maxContextMessages: assistant.maxContextMessages,
    customParameters: assistant.customParameters ?? [],
  }
}

function normalizeToolPreferences(
  toolPreferences: Record<string, AssistantToolPreference> | undefined,
  availableTools: McpTool[],
): Record<string, AssistantToolPreference> {
  const available = new Set(availableTools.map((tool) => tool.name))
  const entries = Object.entries(toolPreferences ?? {}).filter(([toolName]) =>
    available.has(toolName),
  )

  return Object.fromEntries(entries)
}

function normalizeToolSelection(
  enabledToolNames: string[] | undefined,
  availableTools: McpTool[],
): string[] {
  if (!enabledToolNames || enabledToolNames.length === 0) {
    return []
  }
  const available = new Set(availableTools.map((tool) => tool.name))
  return enabledToolNames.filter((toolName) => available.has(toolName))
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
  const [modelParamCache, setModelParamCache] = useState<{
    temperature: number
    topP: number
    maxOutputTokens: number
    maxContextMessages: number
  }>(() => ({
    temperature: AGENT_MODEL_DEFAULTS.temperature,
    topP: AGENT_MODEL_DEFAULTS.topP,
    maxOutputTokens: AGENT_MODEL_DEFAULTS.maxOutputTokens,
    maxContextMessages: clampMaxContextMessages(DEFAULT_MAX_CONTEXT_MESSAGES),
  }))
  const activeTabIndex = AGENT_EDITOR_TABS.findIndex((tab) => tab === activeTab)
  const activeTabIndexRef = useRef(activeTabIndex)
  const tabsNavRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

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
    if (!draftAgent) {
      return
    }
    setModelParamCache((prev) => ({
      temperature: draftAgent.temperature ?? prev.temperature,
      topP: draftAgent.topP ?? prev.topP,
      maxOutputTokens: draftAgent.maxOutputTokens ?? prev.maxOutputTokens,
      maxContextMessages:
        draftAgent.maxContextMessages ?? prev.maxContextMessages,
    }))
  }, [draftAgent])

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

    const sanitizedCustomParameters = sanitizeCustomParameters(
      draftAgent.customParameters ?? [],
    )

    const normalized: Assistant = {
      ...draftAgent,
      name: draftAgent.name.trim(),
      description: draftAgent.description?.trim(),
      customParameters:
        sanitizedCustomParameters.length > 0
          ? sanitizedCustomParameters
          : undefined,
      toolPreferences: normalizeToolPreferences(
        draftAgent.toolPreferences,
        availableTools,
      ),
      enabledToolNames: normalizeToolSelection(
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

  const localFsServerName = getLocalFileToolServerName()

  const visibleToolGroups = useMemo(() => {
    const groups = new Map<string, { title: string; tools: AgentToolView[] }>()
    const localSplitToolTargets = new Set<string>()
    const localMemorySplitToolTargets = new Set<string>()

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

      const key = serverName
      const title = isBuiltin
        ? t('settings.agent.toolsGroupBuiltin', 'Built-in tools')
        : serverName
      const builtinMeta = isBuiltin ? BUILTIN_TOOL_LABEL_KEYS[toolName] : null
      const displayName = builtinMeta
        ? t(builtinMeta.key, builtinMeta.fallback)
        : toolName
      const description = builtinMeta
        ? t(builtinMeta.descKey, builtinMeta.descFallback)
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

    if (
      draftAgent?.includeBuiltinTools !== false &&
      localSplitToolTargets.size > 0
    ) {
      const key = localFsServerName
      const title = t('settings.agent.toolsGroupBuiltin', 'Built-in tools')
      const fileOpsMeta = BUILTIN_TOOL_LABEL_KEYS[FILE_OPS_GROUP_TOOL_NAME]
      const group = groups.get(key) ?? { title, tools: [] }
      const prefixedAlias = `${localFsServerName}__${FILE_OPS_GROUP_TOOL_NAME}`
      group.tools.push({
        fullName: prefixedAlias,
        toggleTargets: [...localSplitToolTargets],
        displayName: t(fileOpsMeta.key, fileOpsMeta.fallback),
        description: t(fileOpsMeta.descKey, fileOpsMeta.descFallback),
      })
      groups.set(key, group)
    }

    if (
      draftAgent?.includeBuiltinTools !== false &&
      localMemorySplitToolTargets.size > 0
    ) {
      const key = localFsServerName
      const title = t('settings.agent.toolsGroupBuiltin', 'Built-in tools')
      const memoryOpsMeta = BUILTIN_TOOL_LABEL_KEYS[MEMORY_OPS_GROUP_TOOL_NAME]
      const group = groups.get(key) ?? { title, tools: [] }
      const prefixedAlias = `${localFsServerName}__${MEMORY_OPS_GROUP_TOOL_NAME}`
      group.tools.push({
        fullName: prefixedAlias,
        toggleTargets: [...localMemorySplitToolTargets],
        displayName: t(memoryOpsMeta.key, memoryOpsMeta.fallback),
        description: t(memoryOpsMeta.descKey, memoryOpsMeta.descFallback),
      })
      groups.set(key, group)
    }

    return [...groups.entries()]
      .sort(([a], [b]) => {
        if (a === localFsServerName) return -1
        if (b === localFsServerName) return 1
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

  const resetModelParams = () => {
    if (!draftAgent) {
      return
    }
    const defaultMaxContextMessages = clampMaxContextMessages(
      DEFAULT_MAX_CONTEXT_MESSAGES,
    )
    setModelParamCache({
      temperature: AGENT_MODEL_DEFAULTS.temperature,
      topP: AGENT_MODEL_DEFAULTS.topP,
      maxOutputTokens: AGENT_MODEL_DEFAULTS.maxOutputTokens,
      maxContextMessages: defaultMaxContextMessages,
    })
    setDraftAgent({
      ...draftAgent,
      temperature: AGENT_MODEL_DEFAULTS.temperature,
      topP: AGENT_MODEL_DEFAULTS.topP,
      maxOutputTokens: AGENT_MODEL_DEFAULTS.maxOutputTokens,
      maxContextMessages: defaultMaxContextMessages,
    })
  }

  const setTemperatureEnabled = (enabled: boolean) => {
    if (!draftAgent) {
      return
    }
    const current = draftAgent.temperature ?? modelParamCache.temperature
    setModelParamCache((prev) => ({ ...prev, temperature: current }))
    setDraftAgent({
      ...draftAgent,
      temperature: enabled ? current : undefined,
    })
  }

  const setTopPEnabled = (enabled: boolean) => {
    if (!draftAgent) {
      return
    }
    const current = draftAgent.topP ?? modelParamCache.topP
    setModelParamCache((prev) => ({ ...prev, topP: current }))
    setDraftAgent({
      ...draftAgent,
      topP: enabled ? current : undefined,
    })
  }

  const setMaxOutputTokensEnabled = (enabled: boolean) => {
    if (!draftAgent) {
      return
    }
    const current =
      draftAgent.maxOutputTokens ?? modelParamCache.maxOutputTokens
    setModelParamCache((prev) => ({ ...prev, maxOutputTokens: current }))
    setDraftAgent({
      ...draftAgent,
      maxOutputTokens: enabled ? current : undefined,
    })
  }

  const setMaxContextMessagesEnabled = (enabled: boolean) => {
    if (!draftAgent) {
      return
    }
    const current =
      draftAgent.maxContextMessages ?? modelParamCache.maxContextMessages
    setModelParamCache((prev) => ({ ...prev, maxContextMessages: current }))
    setDraftAgent({
      ...draftAgent,
      maxContextMessages: enabled ? current : undefined,
    })
  }

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
                        model: t('settings.agent.editorTabModel', 'Model'),
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
              <ObsidianSetting
                name={t('settings.agent.editorSystemPrompt', 'System prompt')}
                desc={t(
                  'settings.agent.editorSystemPromptDesc',
                  'Primary behavior instruction for this agent',
                )}
                className="smtcmp-settings-textarea-header"
              />
              <ObsidianSetting className="smtcmp-settings-textarea">
                <ObsidianTextArea
                  value={draftAgent.systemPrompt}
                  onChange={(value) =>
                    setDraftAgent({ ...draftAgent, systemPrompt: value })
                  }
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
                            nextEnabledToolNames.add(tool.name)
                            nextToolPreferences[tool.name] = {
                              ...nextToolPreferences[tool.name],
                              enabled: true,
                              approvalMode:
                                nextToolPreferences[tool.name]?.approvalMode ??
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
                  <div className="smtcmp-agent-tools-panel-title">
                    {t('settings.agent.tools', 'Tools')}
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
                      {group.title}
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
                  <div className="smtcmp-agent-tools-panel-title">
                    {t('settings.agent.skills', 'Skills')}
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

          {activeTab === 'model' && (
            <div className="smtcmp-agent-editor-body">
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

              <div className="smtcmp-agent-tools-panel smtcmp-agent-model-panel">
                <div className="smtcmp-agent-tools-panel-head smtcmp-agent-model-panel-head">
                  <div className="smtcmp-agent-tools-panel-title">
                    {t(
                      'settings.agent.editorModelSampling',
                      'Sampling parameters',
                    )}
                  </div>
                  <button
                    type="button"
                    className="smtcmp-agent-model-reset"
                    onClick={resetModelParams}
                  >
                    {t(
                      'settings.agent.editorModelResetDefaults',
                      'Restore defaults',
                    )}
                  </button>
                </div>

                <div className="smtcmp-agent-model-controls">
                  <div
                    className={`smtcmp-agent-model-control${
                      draftAgent.temperature === undefined ? ' is-disabled' : ''
                    }`}
                  >
                    <div className="smtcmp-agent-model-control-top">
                      <div className="smtcmp-agent-model-control-meta">
                        <div className="smtcmp-agent-model-control-label">
                          {t('settings.agent.editorTemperature', 'Temperature')}
                        </div>
                      </div>
                      <div className="smtcmp-agent-model-control-actions">
                        <ObsidianToggle
                          value={draftAgent.temperature !== undefined}
                          onChange={setTemperatureEnabled}
                        />
                      </div>
                    </div>
                    {draftAgent.temperature !== undefined && (
                      <div className="smtcmp-agent-model-control-adjust">
                        <input
                          type="range"
                          min={0}
                          max={2}
                          step={0.01}
                          value={
                            draftAgent.temperature ??
                            modelParamCache.temperature
                          }
                          onChange={(event) => {
                            const next = Number(event.currentTarget.value)
                            if (!Number.isFinite(next)) {
                              return
                            }
                            const clamped = clampTemperature(next)
                            setModelParamCache((prev) => ({
                              ...prev,
                              temperature: clamped,
                            }))
                            setDraftAgent({
                              ...draftAgent,
                              temperature: clamped,
                            })
                          }}
                        />
                        <input
                          type="number"
                          className="smtcmp-agent-model-number"
                          min={0}
                          max={2}
                          step={0.1}
                          value={
                            draftAgent.temperature ??
                            modelParamCache.temperature
                          }
                          onChange={(event) => {
                            const next = Number(event.currentTarget.value)
                            if (!Number.isFinite(next)) {
                              return
                            }
                            const clamped = clampTemperature(next)
                            setModelParamCache((prev) => ({
                              ...prev,
                              temperature: clamped,
                            }))
                            setDraftAgent({
                              ...draftAgent,
                              temperature: clamped,
                            })
                          }}
                        />
                      </div>
                    )}
                  </div>

                  <div
                    className={`smtcmp-agent-model-control${
                      draftAgent.topP === undefined ? ' is-disabled' : ''
                    }`}
                  >
                    <div className="smtcmp-agent-model-control-top">
                      <div className="smtcmp-agent-model-control-meta">
                        <div className="smtcmp-agent-model-control-label">
                          {t('settings.agent.editorTopP', 'Top P')}
                        </div>
                      </div>
                      <div className="smtcmp-agent-model-control-actions">
                        <ObsidianToggle
                          value={draftAgent.topP !== undefined}
                          onChange={setTopPEnabled}
                        />
                      </div>
                    </div>
                    {draftAgent.topP !== undefined && (
                      <div className="smtcmp-agent-model-control-adjust">
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={draftAgent.topP ?? modelParamCache.topP}
                          onChange={(event) => {
                            const next = Number(event.currentTarget.value)
                            if (!Number.isFinite(next)) {
                              return
                            }
                            const clamped = clampTopP(next)
                            setModelParamCache((prev) => ({
                              ...prev,
                              topP: clamped,
                            }))
                            setDraftAgent({
                              ...draftAgent,
                              topP: clamped,
                            })
                          }}
                        />
                        <input
                          type="number"
                          className="smtcmp-agent-model-number"
                          min={0}
                          max={1}
                          step={0.01}
                          value={draftAgent.topP ?? modelParamCache.topP}
                          onChange={(event) => {
                            const next = Number(event.currentTarget.value)
                            if (!Number.isFinite(next)) {
                              return
                            }
                            const clamped = clampTopP(next)
                            setModelParamCache((prev) => ({
                              ...prev,
                              topP: clamped,
                            }))
                            setDraftAgent({
                              ...draftAgent,
                              topP: clamped,
                            })
                          }}
                        />
                      </div>
                    )}
                  </div>

                  <div
                    className={`smtcmp-agent-model-control${
                      draftAgent.maxOutputTokens === undefined
                        ? ' is-disabled'
                        : ''
                    }`}
                  >
                    <div className="smtcmp-agent-model-control-top">
                      <div className="smtcmp-agent-model-control-meta">
                        <div className="smtcmp-agent-model-control-label">
                          {t(
                            'settings.agent.editorMaxOutputTokens',
                            'Max output tokens',
                          )}
                        </div>
                      </div>
                      <div className="smtcmp-agent-model-control-actions">
                        <ObsidianToggle
                          value={draftAgent.maxOutputTokens !== undefined}
                          onChange={setMaxOutputTokensEnabled}
                        />
                      </div>
                    </div>
                    {draftAgent.maxOutputTokens !== undefined && (
                      <div className="smtcmp-agent-model-control-adjust">
                        <input
                          type="range"
                          min={256}
                          max={32768}
                          step={256}
                          value={Math.min(
                            32768,
                            Math.max(
                              256,
                              draftAgent.maxOutputTokens ??
                                modelParamCache.maxOutputTokens,
                            ),
                          )}
                          onChange={(event) => {
                            const next = Number(event.currentTarget.value)
                            if (!Number.isFinite(next)) {
                              return
                            }
                            const clamped = clampMaxOutputTokens(next)
                            setModelParamCache((prev) => ({
                              ...prev,
                              maxOutputTokens: clamped,
                            }))
                            setDraftAgent({
                              ...draftAgent,
                              maxOutputTokens: clamped,
                            })
                          }}
                        />
                        <input
                          type="number"
                          className="smtcmp-agent-model-number"
                          min={1}
                          step={1}
                          value={
                            draftAgent.maxOutputTokens ??
                            modelParamCache.maxOutputTokens
                          }
                          onChange={(event) => {
                            const next = Number(event.currentTarget.value)
                            if (!Number.isFinite(next)) {
                              return
                            }
                            const clamped = clampMaxOutputTokens(next)
                            setModelParamCache((prev) => ({
                              ...prev,
                              maxOutputTokens: clamped,
                            }))
                            setDraftAgent({
                              ...draftAgent,
                              maxOutputTokens: clamped,
                            })
                          }}
                        />
                      </div>
                    )}
                  </div>

                  <div
                    className={`smtcmp-agent-model-control${
                      draftAgent.maxContextMessages === undefined
                        ? ' is-disabled'
                        : ''
                    }`}
                  >
                    <div className="smtcmp-agent-model-control-top">
                      <div className="smtcmp-agent-model-control-meta">
                        <div className="smtcmp-agent-model-control-label">
                          {t(
                            'settings.agent.editorMaxContextMessages',
                            'Max context messages',
                          )}
                        </div>
                      </div>
                      <div className="smtcmp-agent-model-control-actions">
                        <ObsidianToggle
                          value={draftAgent.maxContextMessages !== undefined}
                          onChange={setMaxContextMessagesEnabled}
                        />
                      </div>
                    </div>
                    {draftAgent.maxContextMessages !== undefined && (
                      <div className="smtcmp-agent-model-control-adjust">
                        <input
                          type="range"
                          min={AGENT_MAX_CONTEXT_MESSAGES_RANGE.min}
                          max={AGENT_MAX_CONTEXT_MESSAGES_RANGE.max}
                          step={1}
                          value={
                            draftAgent.maxContextMessages ??
                            modelParamCache.maxContextMessages
                          }
                          onChange={(event) => {
                            const next = Number(event.currentTarget.value)
                            if (!Number.isFinite(next)) {
                              return
                            }
                            const clamped = clampMaxContextMessages(next)
                            setModelParamCache((prev) => ({
                              ...prev,
                              maxContextMessages: clamped,
                            }))
                            setDraftAgent({
                              ...draftAgent,
                              maxContextMessages: clamped,
                            })
                          }}
                        />
                        <input
                          type="number"
                          className="smtcmp-agent-model-number"
                          min={AGENT_MAX_CONTEXT_MESSAGES_RANGE.min}
                          max={AGENT_MAX_CONTEXT_MESSAGES_RANGE.max}
                          step={1}
                          value={
                            draftAgent.maxContextMessages ??
                            modelParamCache.maxContextMessages
                          }
                          onChange={(event) => {
                            const next = Number(event.currentTarget.value)
                            if (!Number.isFinite(next)) {
                              return
                            }
                            const clamped = clampMaxContextMessages(next)
                            setModelParamCache((prev) => ({
                              ...prev,
                              maxContextMessages: clamped,
                            }))
                            setDraftAgent({
                              ...draftAgent,
                              maxContextMessages: clamped,
                            })
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <ObsidianSetting
                name={t(
                  'settings.agent.editorCustomParameters',
                  'Custom parameters',
                )}
                desc={t(
                  'settings.agent.editorCustomParametersDesc',
                  'Additional request fields for this agent. Same keys override model-level parameters.',
                )}
              >
                <ObsidianButton
                  text={t(
                    'settings.agent.editorCustomParametersAdd',
                    'Add parameter',
                  )}
                  onClick={() =>
                    setDraftAgent({
                      ...draftAgent,
                      customParameters: [
                        ...(draftAgent.customParameters ?? []),
                        {
                          key: '',
                          value: '',
                          type: 'text',
                        },
                      ],
                    })
                  }
                />
              </ObsidianSetting>

              {(draftAgent.customParameters ?? []).map((param, index) => (
                <ObsidianSetting
                  key={`${param.key}-${param.type ?? 'text'}-${param.value}`}
                  className="smtcmp-settings-kv-entry smtcmp-settings-kv-entry--inline"
                >
                  <ObsidianTextInput
                    value={param.key}
                    placeholder={t(
                      'settings.agent.editorCustomParametersKeyPlaceholder',
                      'Key',
                    )}
                    onChange={(value) => {
                      const next = [...(draftAgent.customParameters ?? [])]
                      next[index] = { ...next[index], key: value }
                      setDraftAgent({
                        ...draftAgent,
                        customParameters: next,
                      })
                    }}
                  />
                  <ObsidianDropdown
                    value={normalizeCustomParameterType(param.type)}
                    options={Object.fromEntries(
                      CUSTOM_PARAMETER_TYPES.map((type) => [
                        type,
                        t(
                          `settings.models.customParameterType${
                            type.charAt(0).toUpperCase() + type.slice(1)
                          }`,
                          type,
                        ),
                      ]),
                    )}
                    onChange={(value: string) => {
                      const next = [...(draftAgent.customParameters ?? [])]
                      next[index] = {
                        ...next[index],
                        type: normalizeCustomParameterType(value),
                      }
                      setDraftAgent({
                        ...draftAgent,
                        customParameters: next,
                      })
                    }}
                  />
                  <ObsidianTextInput
                    value={param.value}
                    placeholder={t(
                      'settings.agent.editorCustomParametersValuePlaceholder',
                      'Value',
                    )}
                    onChange={(value) => {
                      const next = [...(draftAgent.customParameters ?? [])]
                      next[index] = { ...next[index], value }
                      setDraftAgent({
                        ...draftAgent,
                        customParameters: next,
                      })
                    }}
                  />
                  <ObsidianButton
                    text={t('common.remove', 'Remove')}
                    onClick={() => {
                      setDraftAgent({
                        ...draftAgent,
                        customParameters: (
                          draftAgent.customParameters ?? []
                        ).filter((_, removeIndex) => removeIndex !== index),
                      })
                    }}
                  />
                </ObsidianSetting>
              ))}
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
