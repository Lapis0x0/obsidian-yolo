import { BookOpen, FolderOpen, Maximize2, User, Wrench, X } from 'lucide-react'
import { App, TFile } from 'obsidian'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import {
  BUILTIN_TOOL_CATEGORY_I18N,
  BUILTIN_TOOL_CATEGORY_ORDER,
  type BuiltinToolCategory,
  FILE_OPS_GROUP_TOOL_NAME,
  MEMORY_OPS_GROUP_TOOL_NAME,
  WEB_OPS_GROUP_TOOL_NAME,
  WEB_OPS_SPLIT_ACTION_TOOL_NAMES,
  getBuiltinToolCategory,
  getBuiltinToolDisplayIndex,
  getBuiltinToolUiMeta,
} from '../../../core/agent/builtinToolUiMeta'
import {
  buildDefaultBuiltinToolPreferences,
  getAssistantToolApprovalMode,
  getAssistantToolDisclosureMode,
  getAssistantToolPreferences,
  getDefaultApprovalModeForTool,
  getEnabledAssistantToolNames,
  getExplicitlyEnabledAssistantToolNames,
  isAssistantToolEnabled,
} from '../../../core/agent/tool-preferences'
import { applyDynamicToolDescriptions } from '../../../core/agent/tool-selection'
import {
  getJsSandboxSettings,
  hasAnyJsSandboxCapEnabled,
} from '../../../core/mcp/jsSandboxSettings'
import { JS_SANDBOX_TOOL_NAME } from '../../../core/mcp/jsSandboxTool'
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
import { YoloSettings } from '../../../settings/schema/setting.types'
import {
  AgentPersona,
  Assistant,
  AssistantSkillLoadMode,
  AssistantToolApprovalMode,
  AssistantToolDisclosureMode,
  AssistantToolPreference,
  AssistantWorkspaceScope,
} from '../../../types/assistant.types'
import { McpTool } from '../../../types/mcp.types'
import {
  estimateJsonTokens,
  estimateTextTokens,
} from '../../../utils/llm/contextTokenEstimate'
import { formatTokenCount } from '../../../utils/llm/formatTokenCount'
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
// Caches the in-flight or resolved promise so concurrent calls dedupe to a
// single estimateJsonTokens invocation.
const toolDefaultContextTokenCache = new Map<string, Promise<number>>()

function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// Stable JSON serialization with sorted object keys, so cache keys stay
// consistent across re-renders that recreate equivalent objects.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']'
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return (
    '{' +
    keys
      .map((key) => JSON.stringify(key) + ':' + stableStringify(record[key]))
      .join(',') +
    '}'
  )
}

function buildToolTokenPayload(tool: McpTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? {},
  }
}

/**
 * Token estimate payload for an on-demand tool stub. Mirrors the stable
 * stub registration: name + truncated description + permissive schema.
 * Kept conservative so the estimate is unaffected by which provider is
 * actually used at request time.
 */
function buildDeferredToolStubTokenPayload(tool: McpTool): unknown {
  const description = (tool.description ?? '').trim()
  const truncatedDescription =
    description.length > 200 ? `${description.slice(0, 197)}...` : description
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: truncatedDescription,
      parameters: { type: 'object', properties: {} },
    },
  }
}

function estimateToolDefaultContextTokens(tool: McpTool): Promise<number> {
  const payload = buildToolTokenPayload(tool)
  const cacheKey = `${tool.name}:${fnv1aHash(stableStringify(payload))}`
  const cached = toolDefaultContextTokenCache.get(cacheKey)
  if (cached) {
    return cached
  }
  const pending = estimateJsonTokens(payload).catch((error) => {
    toolDefaultContextTokenCache.delete(cacheKey)
    throw error
  })
  toolDefaultContextTokenCache.set(cacheKey, pending)
  return pending
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
  settings: YoloSettings
  skill: SkillRowView
}): Promise<number> {
  if (skill.loadMode === 'lazy') {
    return await estimateTextTokens(buildSkillMetadataPrompt(skill))
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

  const count = await estimateTextTokens(
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
    toolPreferences: buildDefaultBuiltinToolPreferences(),
    enabledSkills: [],
    skillPreferences: {},
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
    enabledToolNames: getExplicitlyEnabledAssistantToolNames(assistant),
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
  const nextEnabledToolNames = getExplicitlyEnabledAssistantToolNames({
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
  const enableToolDisclosure = settings.mcp.enableToolDisclosure
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
  const [isSystemPromptExpanded, setIsSystemPromptExpanded] = useState(false)
  const expandedPromptTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const systemPromptWrapperRef = useRef<HTMLDivElement | null>(null)
  const [systemPromptOverlayTarget, setSystemPromptOverlayTarget] =
    useState<HTMLElement | null>(null)

  useEffect(() => {
    if (!isSystemPromptExpanded) {
      setSystemPromptOverlayTarget(null)
      return
    }
    const target =
      systemPromptWrapperRef.current?.closest<HTMLElement>('.modal') ??
      document.body
    setSystemPromptOverlayTarget(target)
  }, [isSystemPromptExpanded])
  const [availableTools, setAvailableTools] = useState<McpTool[]>([])
  const activeTabIndex = AGENT_EDITOR_TABS.findIndex((tab) => tab === activeTab)
  const activeTabIndexRef = useRef(activeTabIndex)
  const tabsNavRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const localFsServerName = getLocalFileToolServerName()
  const jsSandboxFullToolName = `${localFsServerName}__${JS_SANDBOX_TOOL_NAME}`

  const updateTabsGlider = useCallback(() => {
    const nav = tabsNavRef.current
    const index = activeTabIndexRef.current
    const activeButton = tabRefs.current[index]

    if (!nav || !activeButton || index < 0) {
      return
    }

    nav.style.setProperty(
      '--yolo-agent-tab-glider-left',
      `${activeButton.offsetLeft}px`,
    )
    nav.style.setProperty(
      '--yolo-agent-tab-glider-width',
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
        getExplicitlyEnabledAssistantToolNames(draftAgent),
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

  const setToolDisclosureMode = (
    toolNames: string[],
    disclosureMode: AssistantToolDisclosureMode,
  ) => {
    setDraftAgent((prev) => {
      if (!prev) {
        return prev
      }

      return updateDraftToolPreferences(prev, (current) => {
        const next = { ...current }
        for (const toolName of toolNames) {
          // Preserve the tool's effective enabled state. Without this, batch
          // server-level disclosure changes would flip default-off MCP tools
          // on, which violates the "enable stays per-tool" decision.
          const effectiveEnabled = isAssistantToolEnabled(prev, toolName)
          next[toolName] = {
            ...next[toolName],
            enabled: next[toolName]?.enabled ?? effectiveEnabled,
            approvalMode:
              next[toolName]?.approvalMode ??
              getDefaultApprovalModeForTool(toolName),
            disclosureMode,
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
    const groups = new Map<
      string,
      { title: string; tools: AgentToolView[]; isBuiltin: boolean }
    >()
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
      const group = groups.get(key) ?? { title, tools: [], isBuiltin }
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
      const group = groups.get(key) ?? { title, tools: [], isBuiltin: true }
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
      .map(([key, value]) => {
        const builtinCategory = key.startsWith('__builtin:')
          ? (key.slice('__builtin:'.length) as BuiltinToolCategory)
          : null
        const tools = builtinCategory
          ? value.tools.slice().sort((toolA, toolB) => {
              const idA = parseToolName(toolA.fullName).toolName
              const idB = parseToolName(toolB.fullName).toolName
              return (
                getBuiltinToolDisplayIndex(builtinCategory, idA) -
                getBuiltinToolDisplayIndex(builtinCategory, idB)
              )
            })
          : value.tools
        return { key, ...value, tools }
      })
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

  // Estimated tokens are scoped to a specific agent identity. Stale values
  // from a previous agent must NOT leak across an agent switch (would mislead
  // the user). Within the same agent, we still keep the prior value visible
  // during recomputation to avoid flickering on tool toggles.
  const [estimatedToolContextTokens, setEstimatedToolContextTokens] = useState<{
    agentId: string | null
    value: number | null
    perTool: Map<string, number>
  }>({ agentId: null, value: null, perTool: new Map() })

  useEffect(() => {
    let cancelled = false
    const currentAgentId = draftAgent?.id ?? null

    if (!draftAgent?.enableTools) {
      setEstimatedToolContextTokens({
        agentId: currentAgentId,
        value: 0,
        perTool: new Map(),
      })
      return
    }

    const eligibleTools = availableTools.filter((tool) => {
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
        return false
      }
      return isAssistantToolEnabled(draftAgent, tool.name)
    })

    if (eligibleTools.length === 0) {
      setEstimatedToolContextTokens({
        agentId: currentAgentId,
        value: 0,
        perTool: new Map(),
      })
      return
    }

    // Reset to loading only when agent identity changed; same agent keeps
    // its previous value visible while the new sum resolves.
    setEstimatedToolContextTokens((prev) =>
      prev.agentId === currentAgentId
        ? prev
        : { agentId: currentAgentId, value: null, perTool: new Map() },
    )

    // Resolve per-agent dynamic descriptions (js_eval's varies with the
    // enabled extension capabilities) before estimating, so the token count
    // tracks capability toggles instead of the static default the cached
    // tool list carries. Same bridge selectAllowedTools uses at request time.
    const resolvedTools = applyDynamicToolDescriptions(eligibleTools, {
      jsSandboxSettings: getJsSandboxSettings(settings),
    })

    void Promise.all(
      resolvedTools.map((tool) =>
        estimateToolDefaultContextTokens(tool).then(async (count) => {
          const disclosureMode = getAssistantToolDisclosureMode(
            draftAgent,
            tool.name,
            { enableToolDisclosure },
          )
          if (disclosureMode !== 'on_demand') {
            return [tool.name, count] as const
          }
          const stubCount = await estimateJsonTokens(
            buildDeferredToolStubTokenPayload(tool),
          )
          return [tool.name, stubCount] as const
        }),
      ),
    ).then((entries) => {
      if (cancelled) return
      const perTool = new Map(entries)
      setEstimatedToolContextTokens({
        agentId: currentAgentId,
        value: entries.reduce((sum, [, count]) => sum + count, 0),
        perTool,
      })
    })

    return () => {
      cancelled = true
    }
  }, [
    availableTools,
    draftAgent,
    draftAgent?.enableTools,
    draftAgent?.includeBuiltinTools,
    localFsServerName,
    enableToolDisclosure,
  ])

  const groupEnabledTokens = useMemo(() => {
    const enabledNames = new Set(getEnabledAssistantToolNames(draftAgent))
    const perTool = estimatedToolContextTokens.perTool
    const result = new Map<string, number>()
    for (const group of visibleToolGroups) {
      let sum = 0
      for (const tool of group.tools) {
        for (const target of tool.toggleTargets) {
          if (enabledNames.has(target)) {
            sum += perTool.get(target) ?? 0
          }
        }
      }
      result.set(group.key, sum)
    }
    return result
  }, [draftAgent, estimatedToolContextTokens.perTool, visibleToolGroups])

  const skillEntries = useMemo<LiteSkillEntry[]>(
    () => listLiteSkillEntries(app, { settings }),
    [app, settings],
  )

  const disabledSkillIds = useMemo(
    () => settings.skills?.disabledSkillIds ?? [],
    [settings.skills?.disabledSkillIds],
  )
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

  // Same agent-scoped pattern as estimatedToolContextTokens above.
  const [estimatedSkillContextTokens, setEstimatedSkillContextTokens] =
    useState<{
      agentId: string | null
      value: number | null
      perSkill: Map<string, number>
    }>({
      agentId: null,
      value: null,
      perSkill: new Map(),
    })

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
    const currentAgentId = draftAgent?.id ?? null

    const run = async () => {
      const enabledSkillRows = skillRows.filter((skill) => skill.enabled)
      if (enabledSkillRows.length === 0) {
        if (!cancelled) {
          setEstimatedSkillContextTokens({
            agentId: currentAgentId,
            value: 0,
            perSkill: new Map(),
          })
        }
        return
      }

      if (!cancelled) {
        setEstimatedSkillContextTokens((prev) =>
          prev.agentId === currentAgentId
            ? prev
            : { agentId: currentAgentId, value: null, perSkill: new Map() },
        )
      }

      const entries = await Promise.all(
        enabledSkillRows.map((skill) =>
          estimateSkillDefaultContextTokens({
            app,
            settings,
            skill,
          }).then((count) => [skill.id, count] as const),
        ),
      )

      if (!cancelled) {
        const perSkill = new Map(entries)
        setEstimatedSkillContextTokens({
          agentId: currentAgentId,
          value: entries.reduce((sum, [, count]) => sum + count, 0),
          perSkill,
        })
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [app, settings, skillRows, draftAgent?.id])
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
      className={`yolo-settings-section yolo-agent-editor-panel${
        isDirectEntry ? ' yolo-agent-editor-panel--direct' : ''
      }`}
    >
      {draftAgent && (
        <div className="yolo-agent-editor-sheet">
          <div className="yolo-agent-editor-sheet-top">
            <div className="yolo-agent-editor-sheet-header">
              <div>
                <div className="yolo-settings-sub-header">
                  {draftAgent.name ||
                    t('settings.agent.editorDefaultName', 'New agent')}
                </div>
                <div className="yolo-settings-desc">
                  {t(
                    'settings.agent.editorIntro',
                    "Configure this agent's capabilities, model, and behavior.",
                  )}
                </div>
              </div>
              {!isDirectEntry && (
                <div className="yolo-agent-editor-sheet-actions">
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
              className="yolo-agent-editor-tabs yolo-agent-editor-tabs--glider"
              role="tablist"
              ref={tabsNavRef}
              style={
                {
                  '--yolo-agent-tab-count': AGENT_EDITOR_TABS.length,
                  '--yolo-agent-tab-index': activeTabIndex,
                } as React.CSSProperties
              }
            >
              <div
                className="yolo-agent-editor-tabs-glider"
                aria-hidden="true"
              />
              {AGENT_EDITOR_TABS.map((tab, index) => {
                const TabIcon = AGENT_EDITOR_TAB_ICONS[tab]
                return (
                  <button
                    key={tab}
                    type="button"
                    className={`yolo-agent-editor-tab ${activeTab === tab ? 'is-active' : ''}`}
                    onClick={() => setActiveTab(tab)}
                    role="tab"
                    aria-selected={activeTab === tab}
                    ref={(element) => {
                      tabRefs.current[index] = element
                    }}
                  >
                    <span
                      className="yolo-agent-editor-tab-icon"
                      aria-hidden="true"
                    >
                      <TabIcon size={14} />
                    </span>
                    <span className="yolo-agent-editor-tab-label">
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
          </div>

          {activeTab === 'profile' && (
            <div className="yolo-agent-editor-body">
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
              <div className="yolo-agent-model-setting-row">
                <div className="yolo-agent-model-setting-info">
                  <div className="yolo-agent-model-setting-title">
                    {t('settings.agent.editorModel', 'Model')}
                  </div>
                  <div className="yolo-agent-model-setting-desc">
                    {t(
                      'settings.agent.editorModelDesc',
                      'Select the model used by this agent',
                    )}
                  </div>
                </div>
                <div className="yolo-agent-model-select-wrap">
                  <SimpleSelect
                    value={draftAgent.modelId || settings.chatModelId}
                    groupedOptions={agentModelOptionGroups}
                    align="end"
                    side="bottom"
                    sideOffset={6}
                    placeholder={t('common.select', 'Select')}
                    contentClassName="yolo-agent-model-select-content"
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
                className="yolo-settings-textarea-header yolo-settings-desc-copyable"
              />
              <div
                className="yolo-agent-system-prompt-wrapper"
                ref={systemPromptWrapperRef}
              >
                <ObsidianSetting className="yolo-settings-textarea">
                  <ObsidianTextArea
                    value={draftAgent.systemPrompt}
                    onChange={(value) =>
                      setDraftAgent({ ...draftAgent, systemPrompt: value })
                    }
                    autoResize
                    maxAutoResizeHeight={360}
                    inputClassName="yolo-agent-system-prompt-textarea"
                  />
                </ObsidianSetting>
                <button
                  type="button"
                  className="clickable-icon yolo-agent-system-prompt-expand-btn"
                  aria-label={t(
                    'settings.agent.editorSystemPromptExpand',
                    'Expand editor',
                  )}
                  title={t(
                    'settings.agent.editorSystemPromptExpand',
                    'Expand editor',
                  )}
                  onClick={() => setIsSystemPromptExpanded(true)}
                >
                  <Maximize2 size={14} />
                </button>
              </div>
              {isSystemPromptExpanded &&
                systemPromptOverlayTarget &&
                createPortal(
                  <div
                    className="yolo-agent-system-prompt-overlay"
                    role="dialog"
                    aria-modal="true"
                    onClick={(e) => {
                      if (e.target === e.currentTarget) {
                        setIsSystemPromptExpanded(false)
                      }
                    }}
                  >
                    <div className="yolo-agent-system-prompt-overlay-panel">
                      <div className="yolo-agent-system-prompt-overlay-header">
                        <div className="yolo-agent-system-prompt-overlay-title">
                          {t(
                            'settings.agent.editorSystemPrompt',
                            'System prompt',
                          )}
                        </div>
                        <button
                          type="button"
                          className="clickable-icon yolo-agent-system-prompt-overlay-close"
                          aria-label={t(
                            'settings.agent.editorSystemPromptCollapse',
                            'Close editor',
                          )}
                          title={t(
                            'settings.agent.editorSystemPromptCollapse',
                            'Close editor',
                          )}
                          onClick={() => setIsSystemPromptExpanded(false)}
                        >
                          <X size={16} />
                        </button>
                      </div>
                      <div className="yolo-agent-system-prompt-overlay-desc">
                        {t(
                          'settings.agent.editorSystemPromptDesc',
                          'Primary behavior instruction for this agent',
                        )}
                      </div>
                      <textarea
                        ref={expandedPromptTextareaRef}
                        className="yolo-agent-system-prompt-overlay-textarea"
                        value={draftAgent.systemPrompt}
                        onChange={(e) =>
                          setDraftAgent({
                            ...draftAgent,
                            systemPrompt: e.target.value,
                          })
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault()
                            setIsSystemPromptExpanded(false)
                          }
                        }}
                        autoFocus
                      />
                    </div>
                  </div>,
                  systemPromptOverlayTarget,
                )}
              <ObsidianSetting
                name={t(
                  'settings.agent.editorEnableProjectInstructions',
                  'Load project instruction files',
                )}
                desc={t(
                  'settings.agent.editorEnableProjectInstructionsDesc',
                  'Auto-load AGENTS.md and CLAUDE.md from the vault root for this agent.',
                )}
              >
                <ObsidianToggle
                  value={draftAgent.enableProjectInstructions === true}
                  onChange={(value) => {
                    setDraftAgent({
                      ...draftAgent,
                      enableProjectInstructions: value,
                    })
                  }}
                />
              </ObsidianSetting>
            </div>
          )}

          {activeTab === 'tools' && (
            <div className="yolo-agent-editor-body">
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
                    setDraftAgent((prev) =>
                      prev ? { ...prev, includeBuiltinTools: value } : prev,
                    )
                  }}
                />
              </ObsidianSetting>
              <div
                className={`yolo-agent-tools-panel${
                  draftAgent.enableTools ? '' : ' is-disabled'
                }`}
              >
                <div className="yolo-agent-tools-panel-head">
                  <div className="yolo-agent-tools-panel-title-row">
                    <div className="yolo-agent-tools-panel-title">
                      {t('settings.agent.tools', 'Tools')}
                    </div>
                    {estimatedToolContextTokens.value !== null && (
                      <div className="yolo-agent-tools-panel-estimate">
                        {t(
                          'settings.agent.editorEstimatedContextTokens',
                          '~{count} tokens',
                        ).replace(
                          '{count}',
                          formatTokenCount(estimatedToolContextTokens.value),
                        )}
                      </div>
                    )}
                  </div>
                  <div className="yolo-agent-tools-panel-count">
                    {`${enabledVisibleToolsCount} / ${visibleToolsCount} ${t(
                      'settings.agent.toolsActive',
                      'active',
                    )}`}
                  </div>
                </div>

                {visibleToolGroups.map((group) => {
                  const groupEnabledCount =
                    groupEnabledCounts.get(group.key) ?? 0
                  const allGroupToolsEnabled =
                    group.tools.length > 0 &&
                    groupEnabledCount === group.tools.length
                  const groupToggleTargets = group.tools.flatMap(
                    (tool) => tool.toggleTargets,
                  )
                  const showServerDisclosure =
                    !group.isBuiltin &&
                    enableToolDisclosure &&
                    group.tools.length > 0
                  const serverDisclosureMode = showServerDisclosure
                    ? groupToggleTargets.every(
                        (target) =>
                          getAssistantToolDisclosureMode(draftAgent, target, {
                            enableToolDisclosure,
                          }) === 'on_demand',
                      )
                      ? 'on_demand'
                      : 'always'
                    : 'on_demand'
                  const groupFullyDisabled =
                    !group.isBuiltin &&
                    group.tools.length > 0 &&
                    groupEnabledCount === 0
                  const groupClassName = [
                    'yolo-agent-tool-group',
                    !group.isBuiltin ? 'yolo-agent-tool-group--mcp' : null,
                  ]
                    .filter(Boolean)
                    .join(' ')
                  return (
                    <div key={group.key} className={groupClassName}>
                      <div className="yolo-agent-tool-group-title">
                        <span className="yolo-agent-tool-group-title-main">
                          <span>{group.title}</span>
                          {estimatedToolContextTokens.perTool.size > 0 && (
                            <span className="yolo-agent-tool-group-tokens">
                              {t(
                                'settings.agent.editorEstimatedContextTokens',
                                '~{count} tokens',
                              ).replace(
                                '{count}',
                                formatTokenCount(
                                  groupEnabledTokens.get(group.key) ?? 0,
                                ),
                              )}
                            </span>
                          )}
                          {showServerDisclosure && (
                            <button
                              type="button"
                              className="yolo-agent-tool-group-disclosure"
                              onClick={() =>
                                setToolDisclosureMode(
                                  groupToggleTargets,
                                  serverDisclosureMode === 'on_demand'
                                    ? 'always'
                                    : 'on_demand',
                                )
                              }
                            >
                              {serverDisclosureMode === 'on_demand'
                                ? t(
                                    'settings.agent.toolDisclosureOnDemand',
                                    'On demand',
                                  )
                                : t(
                                    'settings.agent.toolDisclosureAlways',
                                    'Always loaded',
                                  )}
                            </button>
                          )}
                        </span>
                        <span className="yolo-agent-tool-group-meta">
                          <span className="yolo-agent-tool-group-count">
                            {`${groupEnabledCount} / ${group.tools.length} ${t(
                              'settings.agent.toolsActive',
                              'active',
                            )}`}
                          </span>
                          {group.tools.length > 0 && (
                            <button
                              type="button"
                              className="yolo-agent-tool-group-bulk-toggle"
                              onClick={() =>
                                toggleTool(
                                  groupToggleTargets,
                                  !allGroupToolsEnabled,
                                )
                              }
                            >
                              {allGroupToolsEnabled
                                ? t(
                                    'settings.agent.disableAllTools',
                                    'Disable all',
                                  )
                                : t(
                                    'settings.agent.enableAllTools',
                                    'Enable all',
                                  )}
                            </button>
                          )}
                        </span>
                      </div>
                      {!groupFullyDisabled && (
                        <div className="yolo-agent-tool-list">
                          {group.tools.map((tool) => {
                            const selected = tool.toggleTargets.every(
                              (target) =>
                                isAssistantToolEnabled(draftAgent, target),
                            )
                            const approvalMode = tool.toggleTargets.every(
                              (target) =>
                                getAssistantToolApprovalMode(
                                  draftAgent,
                                  target,
                                  {
                                    jsSandboxSettings:
                                      getJsSandboxSettings(settings),
                                  },
                                ) === 'full_access',
                            )
                              ? 'full_access'
                              : 'require_approval'
                            // When JS isolated execution has any sensitive
                            // capability enabled in the global settings,
                            // `getAssistantToolApprovalMode` forces
                            // require_approval regardless of the saved
                            // preference. Surface that lock in the UI as a
                            // read-only badge instead of a stale dropdown.
                            const approvalLocked =
                              hasAnyJsSandboxCapEnabled(
                                getJsSandboxSettings(settings),
                              ) &&
                              tool.toggleTargets.some(
                                (target) => target === jsSandboxFullToolName,
                              )

                            return (
                              <div
                                key={tool.fullName}
                                className="yolo-agent-tool-row"
                              >
                                <div className="yolo-agent-tool-main">
                                  <div className="yolo-agent-tool-name yolo-agent-tool-name--mono">
                                    {tool.displayName}
                                  </div>
                                  <div className="yolo-agent-tool-source yolo-agent-tool-source--preview">
                                    {tool.description}
                                  </div>
                                </div>
                                <div className="yolo-agent-tool-controls">
                                  {selected && (
                                    <>
                                      <div className="yolo-agent-tool-select">
                                        {approvalLocked ? (
                                          <span className="yolo-agent-tool-forced-approval">
                                            {t(
                                              'settings.agent.toolApprovalForced',
                                              'Approval required',
                                            )}
                                          </span>
                                        ) : (
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
                                            contentClassName="yolo-agent-tool-select-menu"
                                          />
                                        )}
                                      </div>
                                    </>
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
                      )}
                    </div>
                  )
                })}

                {visibleToolsCount === 0 && (
                  <div className="yolo-agent-tools-empty">
                    {t('settings.agent.noTools', 'No tools available')}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'skills' && (
            <div className="yolo-agent-editor-body">
              <div className="yolo-agent-tools-panel">
                <div className="yolo-agent-tools-panel-head">
                  <div className="yolo-agent-tools-panel-title-row">
                    <div className="yolo-agent-tools-panel-title">
                      {t('settings.agent.skills', 'Skills')}
                    </div>
                    {estimatedSkillContextTokens.value !== null && (
                      <div className="yolo-agent-tools-panel-estimate">
                        {t(
                          'settings.agent.editorEstimatedContextTokens',
                          '~{count} tokens',
                        ).replace(
                          '{count}',
                          formatTokenCount(estimatedSkillContextTokens.value),
                        )}
                      </div>
                    )}
                  </div>
                  <div className="yolo-agent-tools-panel-count">
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

                <div className="yolo-agent-skill-summary-row">
                  <span className="yolo-agent-chip">
                    {t('settings.agent.skillLoadAlways', 'Full inject')}:{' '}
                    {alwaysSkillRows.length}
                  </span>
                  <span className="yolo-agent-chip">
                    {t('settings.agent.skillLoadLazy', 'On demand')}:{' '}
                    {lazySkillRows.length}
                  </span>
                </div>

                {skillRows.length > 0 ? (
                  <div className="yolo-agent-tool-list">
                    {skillRows.map((skill) => {
                      const disabledByGlobal = skill.globallyDisabled
                      return (
                        <div key={skill.id} className="yolo-agent-tool-row">
                          <div className="yolo-agent-tool-main">
                            <div className="yolo-agent-tool-name">
                              <span>{skill.name}</span>
                              {skill.enabled &&
                                estimatedSkillContextTokens.perSkill.has(
                                  skill.id,
                                ) && (
                                  <span className="yolo-agent-skill-tokens">
                                    {t(
                                      'settings.agent.editorEstimatedContextTokens',
                                      '~{count} tokens',
                                    ).replace(
                                      '{count}',
                                      formatTokenCount(
                                        estimatedSkillContextTokens.perSkill.get(
                                          skill.id,
                                        ) ?? 0,
                                      ),
                                    )}
                                  </span>
                                )}
                            </div>
                            <div className="yolo-agent-tool-source yolo-agent-tool-source--preview">
                              {skill.description}
                            </div>
                            <div className="yolo-agent-skill-meta">
                              <span className="yolo-agent-chip">
                                id: {skill.id}
                              </span>
                              <span className="yolo-agent-chip">
                                {skill.path}
                              </span>
                              {disabledByGlobal && (
                                <span className="yolo-agent-chip">
                                  {t(
                                    'settings.agent.skillDisabledGlobally',
                                    'Disabled globally',
                                  )}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="yolo-agent-skill-controls">
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
                  <div className="yolo-agent-tools-empty">
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
            <div className="yolo-agent-editor-body">
              <AgentWorkspaceScopeEditor
                app={app}
                vault={app.vault}
                value={draftAgent.workspaceScope}
                onChange={setWorkspaceScope}
              />
            </div>
          )}

          {isDirectEntry && (
            <div className="yolo-agent-editor-direct-footer">
              <div className="yolo-agent-editor-direct-footer-actions">
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
