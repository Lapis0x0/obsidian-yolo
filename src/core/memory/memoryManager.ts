import { App, TFile, TFolder, normalizePath } from 'obsidian'

import { getYoloBaseDir } from '../paths/yoloPaths'

type AssistantLike = {
  id: string
  name?: string
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

type MemorySectionDefinition = {
  key: MemorySectionKey
  title: string
  description: string
  idPrefix: string
  headingAliases: string[]
}

type MemorySectionBlock = {
  key: MemorySectionKey
  headingLineIndex: number
  startLineIndex: number
  endLineIndex: number
}

type MemoryEntryOccurrence = {
  id: string
  content: string
  lineIndex: number
  sectionKey: MemorySectionKey
}

export type MemoryPromptContext = {
  global: string | null
  assistant: string | null
}

const MEMORY_DIR_NAME = 'memory'
const GLOBAL_MEMORY_FILE_NAME = 'global.md'
const ENTRY_LINE_REGEX = /^\s*[-*]\s+([^:：]+)\s*[:：]\s*(.*)$/

const MEMORY_SECTIONS: MemorySectionDefinition[] = [
  {
    key: 'profile',
    title: 'User Profile',
    description:
      'Long-term characteristics about the user. Update when user info changes.',
    idPrefix: 'Profile',
    headingAliases: ['user profile', 'profile', '用户画像', '用户信息'],
  },
  {
    key: 'preferences',
    title: 'Preferences',
    description:
      "User's interaction preferences and behavioral patterns. Add when patterns emerge.",
    idPrefix: 'Preference',
    headingAliases: ['preferences', 'preference', '偏好'],
  },
  {
    key: 'other',
    title: 'Other Memory',
    description: 'Contextual facts and temporary notes. Default category.',
    idPrefix: 'Memory',
    headingAliases: ['other memory', 'memory', 'other', '其他记忆'],
  },
]

const memoryFileLocks = new Map<string, Promise<void>>()

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

const sanitizeAssistantNameForFileName = (assistantName: string): string => {
  const normalized = assistantName
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
  return normalized.length > 0 ? normalized : 'assistant'
}

const resolveAssistantDisplayName = (assistant: AssistantLike): string => {
  const preferredName = assistant.name?.trim()
  if (preferredName) {
    return preferredName
  }
  return assistant.id
}

const getAssistantNameDuplicateIndex = ({
  settings,
  assistant,
  baseFileName,
}: {
  settings?: MemorySettingsLike
  assistant: AssistantLike
  baseFileName: string
}): number => {
  const assistants = settings?.assistants ?? []
  if (assistants.length === 0) {
    return 0
  }

  const siblings = assistants
    .filter((item) => {
      return (
        sanitizeAssistantNameForFileName(resolveAssistantDisplayName(item)) ===
        baseFileName
      )
    })
    .sort((left, right) => left.id.localeCompare(right.id))

  return Math.max(
    0,
    siblings.findIndex((item) => item.id === assistant.id),
  )
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
  assistant,
}: {
  settings?: MemorySettingsLike
  assistant: AssistantLike
}): string => {
  const baseFileName = sanitizeAssistantNameForFileName(
    resolveAssistantDisplayName(assistant),
  )
  const duplicateIndex = getAssistantNameDuplicateIndex({
    settings,
    assistant,
    baseFileName,
  })
  const fileName =
    duplicateIndex === 0
      ? `${baseFileName}.md`
      : `${baseFileName} (${duplicateIndex + 1}).md`
  return normalizePath(`${getMemoryDirPath(settings)}/${fileName}`)
}

const getSectionDefinitionByKey = (
  key: MemorySectionKey,
): MemorySectionDefinition => {
  return MEMORY_SECTIONS.find((section) => section.key === key)!
}

const renderTemplateSection = (section: MemorySectionDefinition): string[] => {
  return [`# ${section.title}`, `> ${section.description}`, '']
}

const buildMemoryTemplateContent = (): string => {
  const lines: string[] = []
  MEMORY_SECTIONS.forEach((section, index) => {
    lines.push(...renderTemplateSection(section))
    if (index < MEMORY_SECTIONS.length - 1) {
      lines.push('')
    }
  })
  return `${lines.join('\n')}\n`
}

const MEMORY_TEMPLATE_CONTENT = buildMemoryTemplateContent()

const normalizeHeading = (value: string): string => {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

const resolveSectionKeyFromHeading = (
  heading: string,
): MemorySectionKey | null => {
  const normalizedHeading = normalizeHeading(heading)
  for (const section of MEMORY_SECTIONS) {
    if (section.headingAliases.includes(normalizedHeading)) {
      return section.key
    }
  }
  return null
}

const parseHeading = (line: string): string | null => {
  const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
  if (!match) {
    return null
  }
  return match[1]?.trim() ?? null
}

const parseSectionBlocks = (lines: string[]): MemorySectionBlock[] => {
  const recognized: Array<{ key: MemorySectionKey; lineIndex: number }> = []

  lines.forEach((line, index) => {
    const heading = parseHeading(line)
    if (!heading) {
      return
    }
    const sectionKey = resolveSectionKeyFromHeading(heading)
    if (!sectionKey) {
      return
    }
    recognized.push({ key: sectionKey, lineIndex: index })
  })

  return recognized.map((section, index) => ({
    key: section.key,
    headingLineIndex: section.lineIndex,
    startLineIndex: section.lineIndex + 1,
    endLineIndex:
      index < recognized.length - 1
        ? recognized[index + 1].lineIndex
        : lines.length,
  }))
}

const getPrimarySectionBlock = (
  blocks: MemorySectionBlock[],
  key: MemorySectionKey,
): MemorySectionBlock | null => {
  return blocks.find((block) => block.key === key) ?? null
}

const parseEntryLine = (
  line: string,
): { id: string; content: string } | null => {
  const match = line.match(ENTRY_LINE_REGEX)
  if (!match) {
    return null
  }
  const id = match[1]?.trim()
  if (!id) {
    return null
  }
  return {
    id,
    content: match[2] ?? '',
  }
}

const getEntryOccurrencesInBlock = ({
  lines,
  block,
}: {
  lines: string[]
  block: MemorySectionBlock
}): MemoryEntryOccurrence[] => {
  const entries: MemoryEntryOccurrence[] = []
  for (
    let index = block.startLineIndex;
    index < block.endLineIndex;
    index += 1
  ) {
    const parsed = parseEntryLine(lines[index] ?? '')
    if (!parsed) {
      continue
    }
    entries.push({
      id: parsed.id,
      content: parsed.content,
      lineIndex: index,
      sectionKey: block.key,
    })
  }
  return entries
}

const findEntryOccurrenceById = ({
  lines,
  blocks,
  id,
}: {
  lines: string[]
  blocks: MemorySectionBlock[]
  id: string
}): MemoryEntryOccurrence | null => {
  const matches = blocks
    .flatMap((block) => getEntryOccurrencesInBlock({ lines, block }))
    .filter((entry) => entry.id === id)

  if (matches.length > 1) {
    throw new Error(`Memory id duplicated: ${id}`)
  }

  return matches[0] ?? null
}

const getNextMemoryId = ({
  lines,
  blocks,
  sectionKey,
}: {
  lines: string[]
  blocks: MemorySectionBlock[]
  sectionKey: MemorySectionKey
}): string => {
  const section = getSectionDefinitionByKey(sectionKey)
  const pattern = new RegExp(`^${section.idPrefix}_(\\d+)$`)
  const maxIndex = blocks
    .filter((block) => block.key === sectionKey)
    .flatMap((block) => getEntryOccurrencesInBlock({ lines, block }))
    .reduce((currentMax, entry) => {
      const match = entry.id.match(pattern)
      if (!match) {
        return currentMax
      }
      const parsedIndex = Number.parseInt(match[1] ?? '0', 10)
      return Number.isFinite(parsedIndex) && parsedIndex > currentMax
        ? parsedIndex
        : currentMax
    }, 0)

  return `${section.idPrefix}_${maxIndex + 1}`
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

const ensureSectionBlock = ({
  lines,
  blocks,
  sectionKey,
}: {
  lines: string[]
  blocks: MemorySectionBlock[]
  sectionKey: MemorySectionKey
}): MemorySectionBlock[] => {
  if (blocks.some((block) => block.key === sectionKey)) {
    return blocks
  }

  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
    lines.pop()
  }

  if (lines.length > 0) {
    lines.push('')
  }

  lines.push(...renderTemplateSection(getSectionDefinitionByKey(sectionKey)))
  return parseSectionBlocks(lines)
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

  const assistant = getAssistantById(
    settings,
    resolved.targetAssistantId ?? undefined,
  )
  if (!assistant) {
    throw new Error('Assistant not found for assistant memory scope.')
  }

  return {
    path: getAssistantMemoryPath({
      settings,
      assistant,
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

const withMemoryFileLock = async <T>({
  filePath,
  task,
}: {
  filePath: string
  task: () => Promise<T>
}): Promise<T> => {
  const previous = memoryFileLocks.get(filePath) ?? Promise.resolve()
  let releaseCurrent: () => void = () => {}
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve
  })
  const queued = previous.then(() => current)
  memoryFileLocks.set(filePath, queued)

  await previous
  try {
    return await task()
  } finally {
    releaseCurrent()
    if (memoryFileLocks.get(filePath) === queued) {
      memoryFileLocks.delete(filePath)
    }
  }
}

const writeLinesToFile = async ({
  app,
  file,
  lines,
}: {
  app: App
  file: TFile
  lines: string[]
}): Promise<void> => {
  await app.vault.modify(file, `${lines.join('\n')}\n`)
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
      assistant,
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

  return await withMemoryFileLock({
    filePath: path,
    task: async () => {
      const file = await ensureMemoryFile({
        app,
        filePath: path,
        settings,
      })
      const contentText = await app.vault.read(file)
      const lines = contentText.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop()
      }

      const sectionKey = normalizeMemoryCategory(normalizedCategory)
      let sectionBlocks = parseSectionBlocks(lines)
      sectionBlocks = ensureSectionBlock({
        lines,
        blocks: sectionBlocks,
        sectionKey,
      })

      const targetSectionBlock = getPrimarySectionBlock(
        sectionBlocks,
        sectionKey,
      )
      if (!targetSectionBlock) {
        throw new Error(`Memory section not found: ${sectionKey}`)
      }

      const id = getNextMemoryId({
        lines,
        blocks: sectionBlocks,
        sectionKey,
      })

      let insertIndex = targetSectionBlock.endLineIndex
      while (
        insertIndex > targetSectionBlock.startLineIndex &&
        lines[insertIndex - 1]?.trim() === ''
      ) {
        insertIndex -= 1
      }

      lines.splice(insertIndex, 0, `- ${id}: ${normalizedContent}`)
      await writeLinesToFile({ app, file, lines })

      return {
        id,
        scope: effectiveScope,
        filePath: path,
      }
    },
  })
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

  return await withMemoryFileLock({
    filePath: path,
    task: async () => {
      const file = await ensureMemoryFile({
        app,
        filePath: path,
        settings,
      })
      const contentText = await app.vault.read(file)
      const lines = contentText.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop()
      }

      const blocks = parseSectionBlocks(lines)
      const matchedEntry = findEntryOccurrenceById({
        lines,
        blocks,
        id: normalizedId,
      })
      if (!matchedEntry) {
        throw new Error(`Memory id not found: ${normalizedId}`)
      }

      lines[matchedEntry.lineIndex] = `- ${normalizedId}: ${normalizedContent}`
      await writeLinesToFile({ app, file, lines })

      return {
        id: normalizedId,
        scope: effectiveScope,
        filePath: path,
      }
    },
  })
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

  return await withMemoryFileLock({
    filePath: path,
    task: async () => {
      const file = await ensureMemoryFile({
        app,
        filePath: path,
        settings,
      })
      const contentText = await app.vault.read(file)
      const lines = contentText.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop()
      }

      const blocks = parseSectionBlocks(lines)
      const matchedEntry = findEntryOccurrenceById({
        lines,
        blocks,
        id: normalizedId,
      })
      if (!matchedEntry) {
        throw new Error(`Memory id not found: ${normalizedId}`)
      }

      lines.splice(matchedEntry.lineIndex, 1)
      await writeLinesToFile({ app, file, lines })

      return {
        id: normalizedId,
        scope: effectiveScope,
        filePath: path,
      }
    },
  })
}
