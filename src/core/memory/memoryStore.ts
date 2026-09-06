import { App, TFile, normalizePath } from 'obsidian'

import {
  YOLO_MEMORY_GLOBAL_DIR_NAME,
  YOLO_MEMORY_INDEX_FILE_NAME,
  YOLO_MEMORY_SUBDIR,
  getYoloBaseDir,
} from '../paths/yoloPaths'

/**
 * Memory v2 storage layout.
 *
 * `<baseDir>/memory/global/MEMORY.md` applies to every assistant;
 * `<baseDir>/memory/<assistantDirName>/MEMORY.md` only to that assistant. Each
 * directory holds the index plus one ordinary markdown file per fact — the
 * model reads and writes them with the generic file tools, so nothing here
 * writes; this module only resolves paths and reads the two indexes.
 *
 * `yolo.baseDir` is user-configurable at runtime, so every export takes
 * `settings` and resolves paths on the spot. Never cache a resolved path or
 * hold it in a long-lived singleton.
 */

type AssistantLike = {
  id: string
  name?: string
}

export type MemorySettingsLike = {
  yolo?: {
    baseDir?: string
  }
  currentAssistantId?: string
  assistants?: AssistantLike[]
}

export type MemoryDirPaths = {
  global: string
  assistant: string | null
}

export type MemoryIndexPaths = {
  global: string
  assistant: string | null
}

export type MemoryIndexes = {
  global: string | null
  assistant: string | null
}

const getMemoryRootDir = (settings?: MemorySettingsLike): string =>
  normalizePath(`${getYoloBaseDir(settings)}/${YOLO_MEMORY_SUBDIR}`)

const sanitizeAssistantNameForDirName = (assistantName: string): string => {
  const normalized = assistantName
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
  return normalized.length > 0 ? normalized : 'assistant'
}

const resolveAssistantDisplayName = (assistant: AssistantLike): string =>
  assistant.name?.trim() || assistant.id

/**
 * `global/` is reserved for the cross-assistant scope, so an assistant whose
 * sanitized name collides with it (case-insensitively) is pushed aside instead
 * of silently merging its facts into everyone's memory.
 */
const avoidReservedGlobalDirName = (baseDirName: string): string =>
  baseDirName.toLowerCase() === YOLO_MEMORY_GLOBAL_DIR_NAME
    ? `${YOLO_MEMORY_GLOBAL_DIR_NAME} (assistant)`
    : baseDirName

const resolveAssistantBaseDirName = (assistant: AssistantLike): string =>
  avoidReservedGlobalDirName(
    sanitizeAssistantNameForDirName(resolveAssistantDisplayName(assistant)),
  )

/**
 * Two assistants can share a display name (and therefore a sanitized directory
 * name). Order them by id — a stable, rename-proof key — and suffix all but the
 * first, so each keeps its own directory.
 */
const getAssistantNameDuplicateIndex = ({
  settings,
  assistant,
  baseDirName,
}: {
  settings?: MemorySettingsLike
  assistant: AssistantLike
  baseDirName: string
}): number => {
  const assistants = settings?.assistants ?? []
  if (assistants.length === 0) {
    return 0
  }

  const siblings = assistants
    .filter((item) => resolveAssistantBaseDirName(item) === baseDirName)
    .sort((left, right) => left.id.localeCompare(right.id))

  return Math.max(
    0,
    siblings.findIndex((item) => item.id === assistant.id),
  )
}

/**
 * Directory name (not a path) holding one assistant's memory. Exported because
 * the legacy-data migration must land files in exactly the directory the
 * injection layer will later read — one algorithm, one source of truth.
 */
export const resolveAssistantMemoryDirName = ({
  settings,
  assistant,
}: {
  settings?: MemorySettingsLike
  assistant: AssistantLike
}): string => {
  const baseDirName = resolveAssistantBaseDirName(assistant)
  const duplicateIndex = getAssistantNameDuplicateIndex({
    settings,
    assistant,
    baseDirName,
  })
  return duplicateIndex === 0
    ? baseDirName
    : `${baseDirName} (${duplicateIndex + 1})`
}

/**
 * No fallback to `settings.currentAssistantId`: "which assistant, if any" is
 * the caller's decision (module chat modes deliberately run with none), and a
 * silent fallback would leak that assistant's memory back into a mode that had
 * cut it out.
 */
const getAssistantById = (
  settings: MemorySettingsLike | undefined,
  assistantId: string | undefined,
): AssistantLike | null => {
  if (!assistantId) {
    return null
  }
  return (
    settings?.assistants?.find((assistant) => assistant.id === assistantId) ??
    null
  )
}

/**
 * The memory directories for this assistant — where the fact files live. The
 * rules text names these so the model writes facts into the directory rather
 * than into the index file. {@link resolveMemoryIndexPaths} derives the index
 * paths from them, so directory and index never drift apart.
 */
export const resolveMemoryDirPaths = ({
  settings,
  assistantId,
}: {
  settings?: MemorySettingsLike
  assistantId?: string
}): MemoryDirPaths => {
  const memoryRootDir = getMemoryRootDir(settings)
  const assistant = getAssistantById(settings, assistantId)
  return {
    global: normalizePath(`${memoryRootDir}/${YOLO_MEMORY_GLOBAL_DIR_NAME}`),
    assistant: assistant
      ? normalizePath(
          `${memoryRootDir}/${resolveAssistantMemoryDirName({
            settings,
            assistant,
          })}`,
        )
      : null,
  }
}

/**
 * The exact index files {@link readMemoryIndexes} would read for this
 * assistant — field-for-field mirrored, and returned whether or not the files
 * exist. Non-existent paths matter: the prompt-source watcher has to watch a
 * MEMORY.md that is about to be created.
 */
export const resolveMemoryIndexPaths = ({
  settings,
  assistantId,
}: {
  settings?: MemorySettingsLike
  assistantId?: string
}): MemoryIndexPaths => {
  const dirs = resolveMemoryDirPaths({ settings, assistantId })
  return {
    global: normalizePath(`${dirs.global}/${YOLO_MEMORY_INDEX_FILE_NAME}`),
    assistant: dirs.assistant
      ? normalizePath(`${dirs.assistant}/${YOLO_MEMORY_INDEX_FILE_NAME}`)
      : null,
  }
}

const readIndexIfExists = async ({
  app,
  filePath,
}: {
  app: App
  filePath: string | null
}): Promise<string | null> => {
  if (!filePath) {
    return null
  }
  const existing = app.vault.getAbstractFileByPath(filePath)
  if (!existing || !(existing instanceof TFile)) {
    return null
  }
  const trimmed = (await app.vault.read(existing)).trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Full text of both MEMORY.md indexes; an empty file reads as absent. */
export const readMemoryIndexes = async ({
  app,
  settings,
  assistantId,
}: {
  app: App
  settings?: MemorySettingsLike
  assistantId?: string
}): Promise<MemoryIndexes> => {
  const paths = resolveMemoryIndexPaths({ settings, assistantId })
  const [global, assistant] = await Promise.all([
    readIndexIfExists({ app, filePath: paths.global }),
    readIndexIfExists({ app, filePath: paths.assistant }),
  ])
  return { global, assistant }
}
