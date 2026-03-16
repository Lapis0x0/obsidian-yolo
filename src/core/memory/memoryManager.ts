import { App, TFile, TFolder, normalizePath } from 'obsidian'

import { getYoloBaseDir } from '../paths/yoloPaths'

type AssistantLike = {
  id: string
  systemPrompt?: string
}

type MemorySettingsLike = {
  yolo?: {
    baseDir?: string
  }
  currentAssistantId?: string
  assistants?: AssistantLike[]
}

export type MemoryScope = 'global' | 'assistant'
type MemoryCategory = 'profile' | 'preferences' | 'other'
type MemorySectionKey = 'profile' | 'preferences' | 'other'

type MemoryEntry = {
  id: string
  content: string
}

type ParsedMemoryDocument = {
  profile: MemoryEntry[]
  preferences: MemoryEntry[]
  other: MemoryEntry[]
}

type MemorySectionDefinition = {
  key: MemorySectionKey
  title: string
  description: string
  idPrefix: string
}

export type MemoryPromptContext = {
  global: string | null
  assistant: string | null
}

const MEMORY_DIR_NAME = 'memory'
const GLOBAL_MEMORY_FILE_NAME = 'global.md'

const MEMORY_SECTIONS: MemorySectionDefinition[] = [
  {
    key: 'profile',
    title: 'User Profile',
    description:
      'Long-term characteristics about the user. Update when user info changes.',
    idPrefix: 'Profile',
  },
  {
    key: 'preferences',
    title: 'Preferences',
    description:
      "User's interaction preferences and behavioral patterns. Add when patterns emerge.",
    idPrefix: 'Preference',
  },
  {
    key: 'other',
    title: 'Other Memory',
    description: 'Contextual facts and temporary notes. Default category.',
    idPrefix: 'Memory',
  },
]

const EMPTY_MEMORY_DOCUMENT: ParsedMemoryDocument = {
  profile: [],
  preferences: [],
  other: [],
}

const cloneEmptyMemoryDocument = (): ParsedMemoryDocument => ({
  profile: [],
  preferences: [],
  other: [],
})

const normalizeMemoryCategory = (value: unknown): MemoryCategory => {
  if (typeof value !== 'string') {
    return 'other'
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === 'profile' || normalized === 'user_profile') {
    return 'profile'
  }
  if (
    normalized === 'preferences' ||
    normalized === 'preference' ||
    normalized === 'user_preferences'
  ) {
    return 'preferences'
  }
  return 'other'
}

const normalizeMemoryScope = (value: unknown): MemoryScope => {
  if (typeof value !== 'string') {
    return 'assistant'
  }
  const normalized = value.trim().toLowerCase()
  return normalized === 'global' ? 'global' : 'assistant'
}

const sanitizeAssistantIdForFileName = (assistantId: string): string => {
  const normalized = assistantId.trim().replace(/[^A-Za-z0-9._-]/g, '_')
  return normalized.length > 0 ? normalized : 'assistant'
}

const getMemoryDirPath = (settings?: MemorySettingsLike): string => {
  return normalizePath(`${getYoloBaseDir(settings)}/${MEMORY_DIR_NAME}`)
}

const getGlobalMemoryPath = (settings?: MemorySettingsLike): string => {
  return normalizePath(
    `${getMemoryDirPath(settings)}/${GLOBAL_MEMORY_FILE_NAME}`,
  )
}

const getAssistantById = (
  settings?: MemorySettingsLike,
  assistantId?: string,
): AssistantLike | null => {
  const targetId = assistantId ?? settings?.currentAssistantId
  if (!targetId) {
    return null
  }

  return (
    settings?.assistants?.find((assistant) => assistant.id === targetId) ?? null
  )
}

const hasAssistantInstructions = (assistant: AssistantLike | null): boolean => {
  return Boolean(assistant?.systemPrompt?.trim())
}

const getAssistantMemoryPath = ({
  settings,
  assistantId,
}: {
  settings?: MemorySettingsLike
  assistantId: string
}): string => {
  const fileName = `assistant-${sanitizeAssistantIdForFileName(assistantId)}.md`
  return normalizePath(`${getMemoryDirPath(settings)}/${fileName}`)
}

const renderMemoryDocument = (document: ParsedMemoryDocument): string => {
  const lines: string[] = []

  MEMORY_SECTIONS.forEach((section, index) => {
    lines.push(`# ${section.title}`)
    lines.push(`> ${section.description}`)
    lines.push('')

    const entries = document[section.key]
    entries.forEach((entry) => {
      lines.push(`- ${entry.id}: ${entry.content}`)
    })

    if (index < MEMORY_SECTIONS.length - 1) {
      lines.push('')
    }
  })

  return `${lines.join('\n')}\n`
}

const MEMORY_TEMPLATE_CONTENT = renderMemoryDocument(EMPTY_MEMORY_DOCUMENT)

const parseMemoryDocument = (content: string): ParsedMemoryDocument => {
  const parsed = cloneEmptyMemoryDocument()
  const titleToSection = new Map<string, MemorySectionKey>(
    MEMORY_SECTIONS.map((section) => [section.title, section.key]),
  )

  let activeSection: MemorySectionKey | null = null
  const lines = content.split('\n')
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith('# ')) {
      const heading = line.slice(2).trim()
      activeSection = titleToSection.get(heading) ?? null
      continue
    }

    if (!activeSection || !line.startsWith('- ')) {
      continue
    }

    const matched = line.match(/^-\s+([^:]+):\s*(.*)$/)
    if (!matched) {
      continue
    }

    const id = matched[1]?.trim()
    if (!id) {
      continue
    }

    parsed[activeSection].push({
      id,
      content: matched[2] ?? '',
    })
  }

  return parsed
}

const findEntryById = (
  document: ParsedMemoryDocument,
  id: string,
): { section: MemorySectionKey; index: number } | null => {
  for (const section of MEMORY_SECTIONS) {
    const index = document[section.key].findIndex((entry) => entry.id === id)
    if (index >= 0) {
      return {
        section: section.key,
        index,
      }
    }
  }
  return null
}

const getSectionDefinitionByCategory = (
  category: MemoryCategory,
): MemorySectionDefinition => {
  return MEMORY_SECTIONS.find((section) => section.key === category)!
}

const getNextMemoryId = ({
  entries,
  idPrefix,
}: {
  entries: MemoryEntry[]
  idPrefix: string
}): string => {
  let maxIndex = 0
  const pattern = new RegExp(`^${idPrefix}_(\\d+)$`)

  entries.forEach((entry) => {
    const matched = entry.id.match(pattern)
    if (!matched) {
      return
    }
    const index = Number.parseInt(matched[1] ?? '0', 10)
    if (Number.isFinite(index) && index > maxIndex) {
      maxIndex = index
    }
  })

  return `${idPrefix}_${maxIndex + 1}`
}

const ensureDirectoryPathExists = async ({
  app,
  path,
}: {
  app: App
  path: string
}): Promise<void> => {
  const segments = normalizePath(path)
    .split('/')
    .filter((segment) => segment.length > 0)

  let currentPath = ''
  for (const segment of segments) {
    currentPath = currentPath.length > 0 ? `${currentPath}/${segment}` : segment
    const existing = app.vault.getAbstractFileByPath(currentPath)
    if (!existing) {
      await app.vault.createFolder(currentPath)
      continue
    }
    if (!(existing instanceof TFolder)) {
      throw new Error(`Path exists and is not a folder: ${currentPath}`)
    }
  }
}

const ensureMemoryFile = async ({
  app,
  filePath,
  settings,
}: {
  app: App
  filePath: string
  settings?: MemorySettingsLike
}): Promise<TFile> => {
  await ensureDirectoryPathExists({
    app,
    path: getMemoryDirPath(settings),
  })

  const existing = app.vault.getAbstractFileByPath(filePath)
  if (!existing) {
    return await app.vault.create(filePath, MEMORY_TEMPLATE_CONTENT)
  }
  if (!(existing instanceof TFile)) {
    throw new Error(`Memory file path is not a file: ${filePath}`)
  }
  return existing
}

const readMemoryDocument = async ({
  app,
  filePath,
  settings,
}: {
  app: App
  filePath: string
  settings?: MemorySettingsLike
}): Promise<{ file: TFile; document: ParsedMemoryDocument }> => {
  const file = await ensureMemoryFile({ app, filePath, settings })
  const content = await app.vault.read(file)
  return {
    file,
    document: parseMemoryDocument(content),
  }
}

const readMemoryContentIfExists = async ({
  app,
  filePath,
}: {
  app: App
  filePath: string
}): Promise<string | null> => {
  const existing = app.vault.getAbstractFileByPath(filePath)
  if (!existing || !(existing instanceof TFile)) {
    return null
  }

  const content = await app.vault.read(existing)
  const trimmed = content.trim()
  return trimmed.length > 0 ? trimmed : null
}

const resolveEffectiveScope = ({
  settings,
  requestedScope,
  assistantId,
}: {
  settings?: MemorySettingsLike
  requestedScope: MemoryScope
  assistantId?: string
}): {
  scope: MemoryScope
  targetAssistantId: string | null
} => {
  if (requestedScope === 'global') {
    return {
      scope: 'global',
      targetAssistantId: null,
    }
  }

  const assistant = getAssistantById(settings, assistantId)
  if (!assistant || !hasAssistantInstructions(assistant)) {
    return {
      scope: 'global',
      targetAssistantId: null,
    }
  }

  return {
    scope: 'assistant',
    targetAssistantId: assistant.id,
  }
}

const getScopeFilePath = ({
  settings,
  scope,
  assistantId,
}: {
  settings?: MemorySettingsLike
  scope: MemoryScope
  assistantId?: string
}): { path: string; scope: MemoryScope } => {
  const resolved = resolveEffectiveScope({
    settings,
    requestedScope: scope,
    assistantId,
  })

  if (resolved.scope === 'global') {
    return {
      path: getGlobalMemoryPath(settings),
      scope: 'global',
    }
  }

  return {
    path: getAssistantMemoryPath({
      settings,
      assistantId: resolved.targetAssistantId!,
    }),
    scope: 'assistant',
  }
}

const normalizeMemoryContent = (value: unknown, fieldName: string): string => {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string.`)
  }
  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new Error(`${fieldName} cannot be empty.`)
  }
  return normalized
}

export async function getMemoryPromptContext({
  app,
  settings,
  assistantId,
}: {
  app: App
  settings?: MemorySettingsLike
  assistantId?: string
}): Promise<MemoryPromptContext> {
  const global = await readMemoryContentIfExists({
    app,
    filePath: getGlobalMemoryPath(settings),
  })

  const assistant = getAssistantById(settings, assistantId)
  if (!assistant || !hasAssistantInstructions(assistant)) {
    return {
      global,
      assistant: null,
    }
  }

  const assistantContent = await readMemoryContentIfExists({
    app,
    filePath: getAssistantMemoryPath({
      settings,
      assistantId: assistant.id,
    }),
  })

  return {
    global,
    assistant: assistantContent,
  }
}

export async function memoryAdd({
  app,
  settings,
  content,
  category,
  scope,
  assistantId,
}: {
  app: App
  settings?: MemorySettingsLike
  content: unknown
  category?: unknown
  scope?: unknown
  assistantId?: string
}): Promise<{ id: string; scope: MemoryScope; filePath: string }> {
  const normalizedContent = normalizeMemoryContent(content, 'content')
  const normalizedCategory = normalizeMemoryCategory(category)
  const normalizedScope = normalizeMemoryScope(scope)
  const { path, scope: effectiveScope } = getScopeFilePath({
    settings,
    scope: normalizedScope,
    assistantId,
  })
  const { file, document } = await readMemoryDocument({
    app,
    filePath: path,
    settings,
  })

  const section = getSectionDefinitionByCategory(normalizedCategory)
  const nextId = getNextMemoryId({
    entries: document[section.key],
    idPrefix: section.idPrefix,
  })
  document[section.key].push({
    id: nextId,
    content: normalizedContent,
  })

  await app.vault.modify(file, renderMemoryDocument(document))

  return {
    id: nextId,
    scope: effectiveScope,
    filePath: path,
  }
}

export async function memoryUpdate({
  app,
  settings,
  id,
  newContent,
  scope,
  assistantId,
}: {
  app: App
  settings?: MemorySettingsLike
  id: unknown
  newContent: unknown
  scope?: unknown
  assistantId?: string
}): Promise<{ id: string; scope: MemoryScope; filePath: string }> {
  const normalizedId = normalizeMemoryContent(id, 'id')
  const normalizedContent = normalizeMemoryContent(newContent, 'new_content')
  const normalizedScope = normalizeMemoryScope(scope)
  const { path, scope: effectiveScope } = getScopeFilePath({
    settings,
    scope: normalizedScope,
    assistantId,
  })
  const { file, document } = await readMemoryDocument({
    app,
    filePath: path,
    settings,
  })

  const matchedEntry = findEntryById(document, normalizedId)
  if (!matchedEntry) {
    throw new Error(`Memory id not found: ${normalizedId}`)
  }

  document[matchedEntry.section][matchedEntry.index] = {
    ...document[matchedEntry.section][matchedEntry.index],
    content: normalizedContent,
  }

  await app.vault.modify(file, renderMemoryDocument(document))

  return {
    id: normalizedId,
    scope: effectiveScope,
    filePath: path,
  }
}

export async function memoryDelete({
  app,
  settings,
  id,
  scope,
  assistantId,
}: {
  app: App
  settings?: MemorySettingsLike
  id: unknown
  scope?: unknown
  assistantId?: string
}): Promise<{ id: string; scope: MemoryScope; filePath: string }> {
  const normalizedId = normalizeMemoryContent(id, 'id')
  const normalizedScope = normalizeMemoryScope(scope)
  const { path, scope: effectiveScope } = getScopeFilePath({
    settings,
    scope: normalizedScope,
    assistantId,
  })
  const { file, document } = await readMemoryDocument({
    app,
    filePath: path,
    settings,
  })

  const matchedEntry = findEntryById(document, normalizedId)
  if (!matchedEntry) {
    throw new Error(`Memory id not found: ${normalizedId}`)
  }

  document[matchedEntry.section].splice(matchedEntry.index, 1)
  await app.vault.modify(file, renderMemoryDocument(document))

  return {
    id: normalizedId,
    scope: effectiveScope,
    filePath: path,
  }
}
