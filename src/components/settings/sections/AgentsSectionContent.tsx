import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  BookOpen,
  Check,
  ChevronDown,
  FolderOpen,
  Maximize2,
  User,
  Wrench,
  X,
} from 'lucide-react'
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
  ASSISTANT_FOLLOW_DEFAULT_MODEL_OPTION_VALUE,
  getAssistantModelSelectValue,
  modelIdFromAssistantModelSelectValue,
} from '../../../core/agent/assistant-model'
import { countEnabledVisibleAssistantTools } from '../../../core/agent/tool-display-count'
import {
  buildDefaultBuiltinCapabilityPreferences,
  buildServerToolTokenBudgets,
  getAssistantToolApprovalMode,
  getAssistantToolDisclosureMode,
  getAssistantToolPreferences,
  getDefaultApprovalModeForTool,
  getEnabledAssistantToolNames,
  getExplicitlyEnabledAssistantToolNames,
  isAssistantToolEnabled,
  resolveDefaultDisclosureModeForServer,
} from '../../../core/agent/tool-preferences'
import { applyDynamicToolDescriptions } from '../../../core/agent/tool-selection'
import { getJsSandboxSettings } from '../../../core/mcp/jsSandboxSettings'
import { getLocalFileToolServerName } from '../../../core/mcp/localFileTools'
import { getToolName, parseToolName } from '../../../core/mcp/tool-name-utils'
import { getYoloSkillsDir } from '../../../core/paths/yoloPaths'
import {
  LiteSkillEntry,
  getLiteSkillDocument,
  humanizeSkillName,
} from '../../../core/skills/liteSkills'
import {
  getDisabledSkillNameSet,
  resolveAssistantSkillPolicy,
} from '../../../core/skills/skillPolicy'
import {
  BUILTIN_TOOL_CATEGORY_I18N,
  BUILTIN_TOOL_CATEGORY_ORDER,
} from '../../../core/tools/categories'
import {
  type BuiltinCapabilityId,
  listCapabilities,
} from '../../../core/tools/registry'
import { useLiteSkillEntries } from '../../../hooks/useLiteSkillEntries'
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
import { stableStringify } from '../../../utils/json/stableStringify'
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
import { buildBuiltinCapabilityRows } from './builtinCapabilityRows'

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
  /**
   * The owning built-in capability's id, for rows built from
   * `buildBuiltinCapabilityRows` (undefined for MCP server tool rows, which
   * have no capability). Used to look up this row's approval
   * `allowedModes` (D7, phase2-migration.md D7 item 8) instead of a
   * hardcoded two-option literal.
   */
  capabilityId?: BuiltinCapabilityId
}

type SkillRowView = LiteSkillEntry & {
  enabled: boolean
  loadMode: AssistantSkillLoadMode
}

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
const toolDeferredContextTokenCache = new Map<string, Promise<number>>()

function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
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

function estimateToolDeferredContextTokens(tool: McpTool): Promise<number> {
  const payload = buildDeferredToolStubTokenPayload(tool)
  const cacheKey = `${tool.name}:${fnv1aHash(stableStringify(payload))}`
  const cached = toolDeferredContextTokenCache.get(cacheKey)
  if (cached) return cached
  const pending = estimateJsonTokens(payload).catch((error) => {
    toolDeferredContextTokenCache.delete(cacheKey)
    throw error
  })
  toolDeferredContextTokenCache.set(cacheKey, pending)
  return pending
}

function groupToolsByServer(tools: readonly McpTool[]): Map<string, McpTool[]> {
  const serverTools = new Map<string, McpTool[]>()
  for (const tool of tools) {
    let serverName: string
    try {
      serverName = parseToolName(tool.name).serverName
    } catch {
      continue
    }
    const bucket = serverTools.get(serverName) ?? []
    bucket.push(tool)
    serverTools.set(serverName, bucket)
  }
  return serverTools
}

function buildSkillMetadataPrompt(skill: LiteSkillEntry): string {
  return `- name: ${skill.name} | description: ${skill.description}`
}

function buildAlwaysOnSkillPrompt({
  entry,
  content,
}: {
  entry: LiteSkillEntry
  content: string
}): string {
  return `<skill name="${entry.name}" path="${entry.path}">
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
    name: skill.name,
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

function createNewAgent(): Assistant {
  return {
    id: crypto.randomUUID(),
    name: '',
    description: '',
    systemPrompt: '',
    persona: DEFAULT_PERSONA,
    // Omit modelId so new agents follow the global chat model.
    enableTools: true,
    includeBuiltinTools: true,
    enabledToolNames: [],
    toolPreferences: {},
    builtinCapabilityPreferences: buildDefaultBuiltinCapabilityPreferences(),
    toolServerPreferences: {},
    enabledSkills: [],
    skillPreferences: {},
    includeCurrentFileContent: true,
    timeContextEnabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function toDraftAgent(assistant: Assistant): Assistant {
  return {
    ...assistant,
    persona: assistant.persona ?? DEFAULT_PERSONA,
    // Preserve empty/undefined modelId as "follow default".
    modelId: assistant.modelId || undefined,
    enabledToolNames: getExplicitlyEnabledAssistantToolNames(assistant),
    toolPreferences: getAssistantToolPreferences(assistant),
    builtinCapabilityPreferences: assistant.builtinCapabilityPreferences ?? {},
    toolServerPreferences: assistant.toolServerPreferences ?? {},
    enabledSkills: assistant.enabledSkills ?? [],
    skillPreferences: assistant.skillPreferences ?? {},
    enableTools: assistant.enableTools ?? true,
    includeBuiltinTools: assistant.includeBuiltinTools ?? true,
    includeCurrentFileContent: assistant.includeCurrentFileContent ?? true,
    timeContextEnabled: assistant.timeContextEnabled ?? true,
  }
}

// Remote MCP tools only, post-D9: built-in tool state no longer lives in
// `toolPreferences` at all (see `updateDraftBuiltinCapabilityPreferences`
// below for the built-in counterpart).
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

// Built-in capabilities only: writes a single capability's
// `{ enabled, approvalMode }` entry in the draft's own
// `builtinCapabilityPreferences` map. `updater` receives the capability's
// *current effective* entry (explicit if present, else its registry
// default) so callers can safely read-modify-write a single field without
// clobbering the other.
function updateDraftBuiltinCapabilityPreferences(
  assistant: Assistant,
  capabilityId: BuiltinCapabilityId,
  updater: (
    current: AssistantToolPreference | undefined,
  ) => AssistantToolPreference,
): Assistant {
  const current = assistant.builtinCapabilityPreferences ?? {}
  return {
    ...assistant,
    builtinCapabilityPreferences: {
      ...current,
      [capabilityId]: updater(current[capabilityId]),
    },
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
      const draft = createNewAgent()
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
    return toDraftAgent(initialAssistant)
  })
  const [activeTab, setActiveTab] = useState<AgentEditorTab>('profile')
  const [isSystemPromptExpanded, setIsSystemPromptExpanded] = useState(false)
  const expandedPromptTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const systemPromptWrapperRef = useRef<HTMLDivElement | null>(null)
  const [portalContainer, setPortalContainer] = useState<HTMLElement>()
  const sectionRef = useCallback((node: HTMLDivElement | null) => {
    setPortalContainer(node?.ownerDocument.body)
  }, [])
  const [systemPromptOverlayTarget, setSystemPromptOverlayTarget] =
    useState<HTMLElement | null>(null)

  useEffect(() => {
    if (!isSystemPromptExpanded) {
      setSystemPromptOverlayTarget(null)
      return
    }
    const wrapper = systemPromptWrapperRef.current
    const target =
      wrapper?.closest<HTMLElement>('.modal') ??
      wrapper?.ownerDocument.body ??
      null
    setSystemPromptOverlayTarget(target)
  }, [isSystemPromptExpanded])
  const [availableTools, setAvailableTools] = useState<McpTool[]>([])
  const activeTabIndex = AGENT_EDITOR_TABS.findIndex((tab) => tab === activeTab)
  const activeTabIndexRef = useRef(activeTabIndex)
  const tabsNavRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const localFsServerName = getLocalFileToolServerName()

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

  const agentFollowDefaultModelOption = useMemo(
    () => ({
      value: ASSISTANT_FOLLOW_DEFAULT_MODEL_OPTION_VALUE,
      label: t('settings.agent.followDefaultModel', 'Follow default model'),
    }),
    [t],
  )

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
    setDraftAgent(toDraftAgent(target))
    setActiveTab('profile')
  }, [assistants, draftAgent, initialAssistantId])

  const upsertDraft = async () => {
    if (!draftAgent || !draftAgent.name.trim()) {
      return
    }

    const normalized: Assistant = {
      ...draftAgent,
      name: draftAgent.name.trim(),
      description: draftAgent.description?.trim(),
      modelId: draftAgent.modelId || undefined,
      toolPreferences: normalizeToolPreferencesForPersistence(
        draftAgent.toolPreferences,
        availableTools,
      ),
      toolServerPreferences: draftAgent.toolServerPreferences ?? {},
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

  // `tools` mixes built-in capability rows (`capabilityId` set — a bulk
  // toggle can span several) and MCP server tool rows (`capabilityId`
  // undefined, `toggleTargets` always a single FQN). Each row is routed to
  // its own persistence half: built-ins write
  // `builtinCapabilityPreferences[capabilityId]`, everything else writes
  // `toolPreferences[fqn]` — see `updateDraftBuiltinCapabilityPreferences` /
  // `updateDraftToolPreferences`.
  const toggleTool = (tools: AgentToolView[], enabled: boolean) => {
    setDraftAgent((prev) => {
      if (!prev) {
        return prev
      }

      let next = prev
      for (const tool of tools) {
        if (tool.capabilityId) {
          const capabilityId = tool.capabilityId
          next = updateDraftBuiltinCapabilityPreferences(
            next,
            capabilityId,
            (current) => ({
              enabled,
              approvalMode:
                current?.approvalMode ??
                getDefaultApprovalModeForTool(tool.toggleTargets[0]),
            }),
          )
          continue
        }
        next = updateDraftToolPreferences(next, (current) => {
          const updated = { ...current }
          for (const toolName of tool.toggleTargets) {
            updated[toolName] = {
              ...updated[toolName],
              enabled,
              approvalMode:
                updated[toolName]?.approvalMode ??
                getDefaultApprovalModeForTool(toolName),
            }
          }
          return updated
        })
      }
      return next
    })
  }

  const setToolApprovalMode = (
    tools: AgentToolView[],
    approvalMode: AssistantToolApprovalMode,
  ) => {
    setDraftAgent((prev) => {
      if (!prev) {
        return prev
      }

      let next = prev
      for (const tool of tools) {
        if (tool.capabilityId) {
          const capabilityId = tool.capabilityId
          next = updateDraftBuiltinCapabilityPreferences(
            next,
            capabilityId,
            (current) => ({
              enabled: current?.enabled ?? true,
              approvalMode,
            }),
          )
          continue
        }
        next = updateDraftToolPreferences(next, (current) => {
          const updated = { ...current }
          for (const toolName of tool.toggleTargets) {
            updated[toolName] = {
              ...updated[toolName],
              enabled: updated[toolName]?.enabled ?? true,
              approvalMode,
            }
          }
          return updated
        })
      }
      return next
    })
  }

  const setServerApprovalMode = (
    serverName: string,
    approvalMode: AssistantToolApprovalMode,
  ) => {
    setDraftAgent((prev) => {
      if (!prev) {
        return prev
      }

      return {
        ...prev,
        toolServerPreferences: {
          ...(prev.toolServerPreferences ?? {}),
          [serverName]: {
            ...(prev.toolServerPreferences?.[serverName] ?? {}),
            approvalMode,
          },
        },
      }
    })
  }

  const setServerDisclosureMode = (
    serverName: string,
    disclosureMode: AssistantToolDisclosureMode | undefined,
  ) => {
    setDraftAgent((prev) => {
      if (!prev) {
        return prev
      }
      const current = prev.toolServerPreferences?.[serverName] ?? {}
      const nextPreferences = { ...(prev.toolServerPreferences ?? {}) }
      if (disclosureMode === undefined) {
        const { disclosureMode: _disclosureMode, ...remaining } = current
        if (Object.keys(remaining).length === 0) {
          return {
            ...prev,
            toolServerPreferences: Object.fromEntries(
              Object.entries(nextPreferences).filter(
                ([name]) => name !== serverName,
              ),
            ),
          }
        } else {
          nextPreferences[serverName] = remaining
        }
      } else {
        nextPreferences[serverName] = { ...current, disclosureMode }
      }
      return {
        ...prev,
        toolServerPreferences: nextPreferences,
      }
    })
  }

  const setWorkspaceScope = (next: AssistantWorkspaceScope) => {
    setDraftAgent((prev) => {
      if (!prev) return prev
      return { ...prev, workspaceScope: next }
    })
  }

  const setSkillEnabled = (skillName: string, enabled: boolean) => {
    if (!draftAgent) {
      return
    }
    const current = new Set(draftAgent.enabledSkills ?? [])
    const nextPreferences = {
      ...(draftAgent.skillPreferences ?? {}),
    }

    if (enabled) {
      current.add(skillName)
    } else {
      current.delete(skillName)
    }

    nextPreferences[skillName] = {
      ...(nextPreferences[skillName] ?? {}),
      enabled,
    }

    setDraftAgent({
      ...draftAgent,
      enabledSkills: [...current],
      skillPreferences: nextPreferences,
    })
  }

  const setSkillLoadMode = (
    skillName: string,
    loadMode: AssistantSkillLoadMode,
  ) => {
    if (!draftAgent) {
      return
    }

    const nextPreferences = {
      ...(draftAgent.skillPreferences ?? {}),
      [skillName]: {
        ...(draftAgent.skillPreferences?.[skillName] ?? {}),
        enabled:
          draftAgent.skillPreferences?.[skillName]?.enabled ??
          draftAgent.enabledSkills?.includes(skillName) ??
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
    const includeBuiltinTools = draftAgent?.includeBuiltinTools !== false
    // Which built-in tool *short* names are actually present in this
    // request's tool catalog (`availableTools` — respects runtime
    // availability, unlike the global settings pages' `getLocalFileTools()`;
    // see `builtinCapabilityRows.ts`'s doc comment on that asymmetry).
    // Populated only when built-in tools are included at all, matching the
    // pre-D7 early-return.
    const builtinToolNamesPresent = new Set<string>()

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
      if (isBuiltin) {
        if (includeBuiltinTools) {
          builtinToolNamesPresent.add(toolName)
        }
        return
      }

      const key = serverName
      const group = groups.get(key) ?? {
        title: serverName,
        tools: [],
        isBuiltin: false,
      }
      group.tools.push({
        fullName: tool.name,
        toggleTargets: [tool.name],
        displayName: toolName,
        description: tool.description || t('common.none', 'None'),
      })
      groups.set(key, group)
    })

    if (includeBuiltinTools) {
      const rows = buildBuiltinCapabilityRows({
        toolOptions: settings.mcp.builtinCapabilityOptions,
        t,
      })
      for (const row of rows) {
        const presentMembers = row.memberToolNames.filter((name) =>
          builtinToolNamesPresent.has(name),
        )
        if (presentMembers.length === 0) {
          continue
        }

        const key = `__builtin:${row.category}`
        const title = t(
          BUILTIN_TOOL_CATEGORY_I18N[row.category].key,
          BUILTIN_TOOL_CATEGORY_I18N[row.category].fallback,
        )
        const group = groups.get(key) ?? { title, tools: [], isBuiltin: true }
        group.tools.push({
          // Only used as a React list key — any present member's own FQN is
          // fine, there is no group-vs-single-tool distinction to preserve
          // post-D9 (decision 12: no virtual tool names anywhere).
          fullName: getToolName(localFsServerName, presentMembers[0]),
          toggleTargets: presentMembers.map((name) =>
            getToolName(localFsServerName, name),
          ),
          displayName: row.label,
          description: row.description,
          capabilityId: row.id,
        })
        groups.set(key, group)
      }
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
  }, [
    availableTools,
    draftAgent?.includeBuiltinTools,
    localFsServerName,
    settings.mcp.builtinCapabilityOptions,
    t,
  ])

  const visibleToolsCount = useMemo(
    () => visibleToolGroups.reduce((sum, group) => sum + group.tools.length, 0),
    [visibleToolGroups],
  )

  const enabledVisibleToolsCount = useMemo(() => {
    return countEnabledVisibleAssistantTools(draftAgent, availableTools)
  }, [availableTools, draftAgent])

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
    serverToolTokenBudgets: Map<string, number>
  }>({
    agentId: null,
    value: null,
    perTool: new Map(),
    serverToolTokenBudgets: new Map(),
  })

  useEffect(() => {
    let cancelled = false
    const currentAgentId = draftAgent?.id ?? null

    if (!draftAgent?.enableTools) {
      setEstimatedToolContextTokens({
        agentId: currentAgentId,
        value: 0,
        perTool: new Map(),
        serverToolTokenBudgets: new Map(),
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
        serverToolTokenBudgets: new Map(),
      })
      return
    }

    // Reset to loading only when agent identity changed; same agent keeps
    // its previous value visible while the new sum resolves.
    setEstimatedToolContextTokens((prev) =>
      prev.agentId === currentAgentId
        ? prev
        : {
            agentId: currentAgentId,
            value: null,
            perTool: new Map(),
            serverToolTokenBudgets: new Map(),
          },
    )

    // Resolve per-agent dynamic descriptions (js_eval's varies with the
    // enabled extension capabilities) before estimating, so the token count
    // tracks capability toggles instead of the static default the cached
    // tool list carries. Same bridge selectAllowedTools uses at request time.
    const resolvedTools = applyDynamicToolDescriptions(eligibleTools, {
      jsSandboxSettings: getJsSandboxSettings(settings),
      settings,
    })

    const automaticBudgetTools = enableToolDisclosure
      ? resolvedTools.filter((tool) => {
          try {
            const { serverName } = parseToolName(tool.name)
            return (
              serverName !== localFsServerName &&
              draftAgent.toolServerPreferences?.[serverName]?.disclosureMode ===
                undefined
            )
          } catch {
            return false
          }
        })
      : []

    void buildServerToolTokenBudgets(
      groupToolsByServer(automaticBudgetTools),
      estimateJsonTokens,
    ).then(async (serverToolTokenBudgets) => {
      const entries = await Promise.all(
        resolvedTools.map(async (tool) => {
          const disclosureMode = getAssistantToolDisclosureMode(
            draftAgent,
            tool.name,
            { enableToolDisclosure, serverToolTokenBudgets },
          )
          if (disclosureMode === 'on_demand') {
            const stubCount = await estimateToolDeferredContextTokens(tool)
            return [tool.name, stubCount] as const
          }
          return [
            tool.name,
            await estimateToolDefaultContextTokens(tool),
          ] as const
        }),
      )
      if (cancelled) return
      const perTool = new Map(entries)
      setEstimatedToolContextTokens({
        agentId: currentAgentId,
        value: entries.reduce((sum, [, count]) => sum + count, 0),
        perTool,
        serverToolTokenBudgets,
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

  const skillEntries = useLiteSkillEntries(app, { settings })

  const disabledSkillIds = useMemo(
    () => settings.skills?.disabledSkillIds ?? [],
    [settings.skills?.disabledSkillIds],
  )
  const skillsDir = getYoloSkillsDir(settings)
  const disabledSkillNameSet = useMemo(
    () => getDisabledSkillNameSet(disabledSkillIds),
    [disabledSkillIds],
  )

  const skillRows = useMemo(() => {
    return skillEntries
      .filter((skill) => !disabledSkillNameSet.has(skill.name))
      .map((skill) => {
        const policy = resolveAssistantSkillPolicy({
          assistant: draftAgent,
          skillName: skill.name,
          defaultLoadMode: skill.mode,
        })
        return {
          ...skill,
          enabled: policy.enabled,
          loadMode: policy.loadMode,
        }
      })
  }, [disabledSkillNameSet, draftAgent, skillEntries])

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
          }).then((count) => [skill.name, count] as const),
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
  // D7 (phase2-migration.md D7 item 8): every built-in row's approval
  // dropdown offers exactly its own capability's `approval.allowedModes`.
  // This replaces both the hardcoded two-item literal that all non-bash rows
  // used to share and the separate bash-only three-item memo — `vault_shell`
  // is no longer a special case in this file, it is simply the one
  // capability whose `allowedModes` includes `dangerous_only`. The
  // `toolApprovalOptions` literal above legitimately stays hardcoded: it
  // serves the MCP *server*-level dropdown, and servers have no capability.
  //
  // Display order stays require -> dangerous -> full rather than following
  // each capability's own `allowedModes` declaration order, since reordering
  // the dropdown is not an approved visible change (master.md §5).
  const capabilityApprovalOptionsById = useMemo(() => {
    const labelFor = (mode: AssistantToolApprovalMode): string => {
      switch (mode) {
        case 'require_approval':
          return t('settings.agent.toolApprovalRequire', 'Require approval')
        case 'dangerous_only':
          return t(
            'settings.agent.toolApprovalDangerousOnly',
            'Approve dangerous operations',
          )
        case 'full_access':
        default:
          return t('settings.agent.toolApprovalFullAccess', 'Full access')
      }
    }
    const displayOrder: AssistantToolApprovalMode[] = [
      'require_approval',
      'dangerous_only',
      'full_access',
    ]
    const map = new Map<
      BuiltinCapabilityId,
      { value: AssistantToolApprovalMode; label: string }[]
    >()
    for (const capability of listCapabilities()) {
      const allowedModes = new Set(capability.approval.allowedModes)
      map.set(
        capability.id as BuiltinCapabilityId,
        displayOrder
          .filter((mode) => allowedModes.has(mode))
          .map((mode) => ({ value: mode, label: labelFor(mode) })),
      )
    }
    return map
  }, [t])
  return (
    <div
      ref={sectionRef}
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
                    value={getAssistantModelSelectValue(draftAgent.modelId)}
                    leadingOptions={[agentFollowDefaultModelOption]}
                    groupedOptions={agentModelOptionGroups}
                    align="end"
                    side="bottom"
                    sideOffset={6}
                    placeholder={t('common.select', 'Select')}
                    contentClassName="yolo-agent-model-select-content"
                    onChange={(value: string) =>
                      setDraftAgent({
                        ...draftAgent,
                        modelId: modelIdFromAssistantModelSelectValue(value),
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
                name={t('settings.agent.focusSyncTitle')}
                desc={t('settings.agent.focusSyncDesc')}
              >
                <ObsidianToggle
                  value={draftAgent.includeCurrentFileContent !== false}
                  onChange={(value) => {
                    setDraftAgent({
                      ...draftAgent,
                      includeCurrentFileContent: value,
                    })
                  }}
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t('settings.agent.timeContextTitle')}
                desc={t('settings.agent.timeContextDesc')}
              >
                <ObsidianToggle
                  value={draftAgent.timeContextEnabled !== false}
                  onChange={(value) => {
                    setDraftAgent({
                      ...draftAgent,
                      timeContextEnabled: value,
                    })
                  }}
                />
              </ObsidianSetting>
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
                  const disclosureSelectionValue = showServerDisclosure
                    ? (draftAgent.toolServerPreferences?.[group.key]
                        ?.disclosureMode ?? 'auto')
                    : 'auto'
                  const autoDisclosureMode = (() => {
                    const firstTarget = groupToggleTargets[0]
                    if (!firstTarget) return null
                    try {
                      const { serverName } = parseToolName(firstTarget)
                      const tokenBudget =
                        estimatedToolContextTokens.serverToolTokenBudgets.get(
                          serverName,
                        )
                      return tokenBudget === undefined
                        ? null
                        : resolveDefaultDisclosureModeForServer(tokenBudget)
                    } catch {
                      return null
                    }
                  })()
                  const disclosureModeLabel = (
                    mode: AssistantToolDisclosureMode,
                  ) =>
                    mode === 'on_demand'
                      ? t('settings.agent.toolDisclosureOnDemand', 'On demand')
                      : t(
                          'settings.agent.toolDisclosureAlways',
                          'Always loaded',
                        )
                  const autoDisclosureLabel = `${t(
                    'settings.agent.toolDisclosureAuto',
                    'Auto',
                  )}${
                    autoDisclosureMode
                      ? `: ${disclosureModeLabel(autoDisclosureMode)}`
                      : ''
                  }`
                  const autoDisclosureOptionLabel = t(
                    'settings.agent.toolDisclosureAutoSelect',
                    'Auto select',
                  )
                  const serverDisclosureLabel =
                    disclosureSelectionValue === 'auto'
                      ? autoDisclosureLabel
                      : disclosureModeLabel(disclosureSelectionValue)
                  const showServerApproval = !group.isBuiltin
                  const serverApprovalMode: AssistantToolApprovalMode =
                    draftAgent.toolServerPreferences?.[group.key]
                      ?.approvalMode ?? 'require_approval'
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
                            <DropdownMenu.Root>
                              <DropdownMenu.Trigger asChild>
                                <button
                                  type="button"
                                  className="yolo-agent-tool-group-disclosure"
                                >
                                  <span>{serverDisclosureLabel}</span>
                                  <ChevronDown size={12} aria-hidden="true" />
                                </button>
                              </DropdownMenu.Trigger>
                              <DropdownMenu.Portal container={portalContainer}>
                                <DropdownMenu.Content
                                  className="yolo-simple-select__content"
                                  side="bottom"
                                  align="center"
                                  sideOffset={6}
                                  collisionPadding={10}
                                  loop
                                  onCloseAutoFocus={(event) => {
                                    event.preventDefault()
                                  }}
                                >
                                  <DropdownMenu.RadioGroup
                                    className="yolo-simple-select__list"
                                    value={disclosureSelectionValue}
                                    onValueChange={(nextValue) => {
                                      if (nextValue === 'auto') {
                                        setServerDisclosureMode(
                                          group.key,
                                          undefined,
                                        )
                                        return
                                      }
                                      if (
                                        nextValue === 'always' ||
                                        nextValue === 'on_demand'
                                      ) {
                                        setServerDisclosureMode(
                                          group.key,
                                          nextValue,
                                        )
                                      }
                                    }}
                                  >
                                    <DropdownMenu.RadioItem
                                      className="yolo-simple-select__item"
                                      value="auto"
                                    >
                                      <div className="yolo-simple-select__item-text">
                                        <div className="yolo-simple-select__item-label">
                                          {autoDisclosureOptionLabel}
                                        </div>
                                      </div>
                                      <DropdownMenu.ItemIndicator className="yolo-simple-select__item-indicator">
                                        <Check size={12} />
                                      </DropdownMenu.ItemIndicator>
                                    </DropdownMenu.RadioItem>
                                    <DropdownMenu.RadioItem
                                      className="yolo-simple-select__item"
                                      value="always"
                                    >
                                      <div className="yolo-simple-select__item-text">
                                        <div className="yolo-simple-select__item-label">
                                          {disclosureModeLabel('always')}
                                        </div>
                                      </div>
                                      <DropdownMenu.ItemIndicator className="yolo-simple-select__item-indicator">
                                        <Check size={12} />
                                      </DropdownMenu.ItemIndicator>
                                    </DropdownMenu.RadioItem>
                                    <DropdownMenu.RadioItem
                                      className="yolo-simple-select__item"
                                      value="on_demand"
                                    >
                                      <div className="yolo-simple-select__item-text">
                                        <div className="yolo-simple-select__item-label">
                                          {disclosureModeLabel('on_demand')}
                                        </div>
                                      </div>
                                      <DropdownMenu.ItemIndicator className="yolo-simple-select__item-indicator">
                                        <Check size={12} />
                                      </DropdownMenu.ItemIndicator>
                                    </DropdownMenu.RadioItem>
                                  </DropdownMenu.RadioGroup>
                                </DropdownMenu.Content>
                              </DropdownMenu.Portal>
                            </DropdownMenu.Root>
                          )}
                        </span>
                        <span className="yolo-agent-tool-group-meta">
                          {showServerApproval && (
                            <DropdownMenu.Root>
                              <DropdownMenu.Trigger asChild>
                                <button
                                  type="button"
                                  className="yolo-agent-tool-group-disclosure yolo-agent-tool-group-approval-trigger"
                                >
                                  <span>
                                    {serverApprovalMode === 'full_access'
                                      ? t(
                                          'settings.agent.toolApprovalFullAccess',
                                          'Full access',
                                        )
                                      : t(
                                          'settings.agent.toolApprovalRequire',
                                          'Require approval',
                                        )}
                                  </span>
                                  <ChevronDown size={12} aria-hidden="true" />
                                </button>
                              </DropdownMenu.Trigger>
                              <DropdownMenu.Portal container={portalContainer}>
                                <DropdownMenu.Content
                                  className="yolo-simple-select__content"
                                  side="bottom"
                                  align="center"
                                  sideOffset={6}
                                  collisionPadding={10}
                                  loop
                                  onCloseAutoFocus={(event) => {
                                    event.preventDefault()
                                  }}
                                >
                                  <DropdownMenu.RadioGroup
                                    className="yolo-simple-select__list"
                                    value={serverApprovalMode}
                                    onValueChange={(nextValue) => {
                                      if (
                                        nextValue === 'full_access' ||
                                        nextValue === 'require_approval'
                                      ) {
                                        setServerApprovalMode(
                                          group.key,
                                          nextValue,
                                        )
                                      }
                                    }}
                                  >
                                    {toolApprovalOptions.map((option) => (
                                      <DropdownMenu.RadioItem
                                        key={option.value}
                                        className="yolo-simple-select__item"
                                        value={option.value}
                                      >
                                        <div className="yolo-simple-select__item-text">
                                          <div className="yolo-simple-select__item-label">
                                            {option.label}
                                          </div>
                                        </div>
                                        <DropdownMenu.ItemIndicator className="yolo-simple-select__item-indicator">
                                          <Check size={12} />
                                        </DropdownMenu.ItemIndicator>
                                      </DropdownMenu.RadioItem>
                                    ))}
                                  </DropdownMenu.RadioGroup>
                                </DropdownMenu.Content>
                              </DropdownMenu.Portal>
                            </DropdownMenu.Root>
                          )}
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
                                toggleTool(group.tools, !allGroupToolsEnabled)
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
                            // Built-in rows offer their own capability's
                            // allowed tiers; MCP server tool rows have no
                            // capability and keep the generic two-tier list.
                            const approvalOptions =
                              (tool.capabilityId &&
                                capabilityApprovalOptionsById.get(
                                  tool.capabilityId,
                                )) ||
                              toolApprovalOptions
                            // Only a capability that allows `dangerous_only`
                            // can display it — today that is `vault_shell`
                            // alone, but this reads the declaration rather
                            // than naming bash (phase2-migration.md D7 item 8).
                            const allowsDangerousOnly = approvalOptions.some(
                              (option) => option.value === 'dangerous_only',
                            )
                            const approvalMode = !group.isBuiltin
                              ? 'require_approval'
                              : tool.toggleTargets.every(
                                    (target) =>
                                      getAssistantToolApprovalMode(
                                        draftAgent,
                                        target,
                                      ) === 'full_access',
                                  )
                                ? 'full_access'
                                : allowsDangerousOnly &&
                                    tool.toggleTargets.every(
                                      (target) =>
                                        getAssistantToolApprovalMode(
                                          draftAgent,
                                          target,
                                        ) === 'dangerous_only',
                                    )
                                  ? 'dangerous_only'
                                  : 'require_approval'
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
                                  {group.isBuiltin && selected && (
                                    <>
                                      <div className="yolo-agent-tool-select">
                                        <SimpleSelect
                                          value={approvalMode}
                                          options={approvalOptions}
                                          onChange={(value) =>
                                            setToolApprovalMode(
                                              [tool],
                                              value as AssistantToolApprovalMode,
                                            )
                                          }
                                          align="end"
                                          contentClassName="yolo-agent-tool-select-menu"
                                        />
                                      </div>
                                    </>
                                  )}
                                  <ObsidianToggle
                                    value={Boolean(selected)}
                                    onChange={(value) =>
                                      toggleTool([tool], value)
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
                      return (
                        <div key={skill.name} className="yolo-agent-tool-row">
                          <div className="yolo-agent-tool-main">
                            <div className="yolo-agent-tool-name">
                              <span>{humanizeSkillName(skill.name)}</span>
                              {skill.enabled &&
                                estimatedSkillContextTokens.perSkill.has(
                                  skill.name,
                                ) && (
                                  <span className="yolo-agent-skill-tokens">
                                    {t(
                                      'settings.agent.editorEstimatedContextTokens',
                                      '~{count} tokens',
                                    ).replace(
                                      '{count}',
                                      formatTokenCount(
                                        estimatedSkillContextTokens.perSkill.get(
                                          skill.name,
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
                                name: {skill.name}
                              </span>
                              <span className="yolo-agent-chip">
                                {skill.path}
                              </span>
                            </div>
                          </div>
                          <div className="yolo-agent-skill-controls">
                            <ObsidianToggle
                              value={skill.enabled}
                              onChange={(value) =>
                                setSkillEnabled(skill.name, value)
                              }
                            />
                            <select
                              value={skill.loadMode}
                              disabled={!skill.enabled}
                              onChange={(event) =>
                                setSkillLoadMode(
                                  skill.name,
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
                      'No skills found. Create a Markdown file or a folder containing SKILL.md under {path}.',
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
