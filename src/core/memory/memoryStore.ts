import { App, TFile, normalizePath } from 'obsidian'

import {
  YOLO_MEMORY_GLOBAL_DIR_NAME,
  YOLO_MEMORY_INDEX_FILE_NAME,
  YOLO_MEMORY_PROJECTS_DIR_NAME,
  YOLO_MEMORY_SUBDIR,
  getYoloBaseDir,
} from '../paths/yoloPaths'

/**
 * Memory v2 storage layout.
 *
 * `<baseDir>/memory/global/MEMORY.md` applies to every assistant;
 * `<baseDir>/memory/<assistantDirName>/MEMORY.md` only to that assistant;
 * `<baseDir>/memory/projects/<projectDirName>/MEMORY.md` only to conversations
 * in that project. Each directory holds the index plus one ordinary markdown
 * file per fact — the model reads and writes them with the generic file tools,
 * so nothing here writes; this module only resolves paths and reads the
 * indexes.
 *
 * `yolo.baseDir` is user-configurable at runtime, so every export takes
 * `settings` and resolves paths on the spot. Never cache a resolved path or
 * hold it in a long-lived singleton.
 */

type AssistantLike = {
  id: string
  name?: string
}

type ProjectLike = {
  id: string
  name: string
}

export type MemorySettingsLike = {
  yolo?: {
    baseDir?: string
  }
  currentAssistantId?: string
  assistants?: AssistantLike[]
  projects?: ProjectLike[]
}

export type MemoryDirPaths = {
  global: string
  assistant: string | null
  project: string | null
}

export type MemoryIndexPaths = {
  global: string
  assistant: string | null
  project: string | null
}

export type MemoryIndexes = {
  global: string | null
  assistant: string | null
  project: string | null
}

const getMemoryRootDir = (settings?: MemorySettingsLike): string =>
  normalizePath(`${getYoloBaseDir(settings)}/${YOLO_MEMORY_SUBDIR}`)

const sanitizeNameForDirName = (name: string, fallback: string): string => {
  const normalized = name
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
  return normalized.length > 0 ? normalized : fallback
}

const resolveAssistantDisplayName = (assistant: AssistantLike): string =>
  assistant.name?.trim() || assistant.id

const RESERVED_MEMORY_DIR_NAMES: readonly string[] = [
  YOLO_MEMORY_GLOBAL_DIR_NAME,
  YOLO_MEMORY_PROJECTS_DIR_NAME,
]

/**
 * `global/` and `projects/` sit beside the assistant directories, so an
 * assistant whose sanitized name collides with either (case-insensitively) is
 * pushed aside instead of silently merging its facts into everyone's memory
 * or into the projects tree.
 */
const avoidReservedDirName = (baseDirName: string): string => {
  const reserved = RESERVED_MEMORY_DIR_NAMES.find(
    (name) => name === baseDirName.toLowerCase(),
  )
  return reserved ? `${reserved} (assistant)` : baseDirName
}

const resolveAssistantBaseDirName = (assistant: AssistantLike): string =>
  avoidReservedDirName(
    sanitizeNameForDirName(resolveAssistantDisplayName(assistant), 'assistant'),
  )

const resolveProjectBaseDirName = (project: ProjectLike): string =>
  sanitizeNameForDirName(project.name, 'project')

/**
 * Two items can share a display name (and therefore a sanitized directory
 * name). Order the namesakes by id — a stable, rename-proof key — and suffix
 * all but the first, so each keeps its own directory.
 */
const withDuplicateSuffix = <T extends { id: string }>({
  items,
  item,
  baseDirName,
  resolveBaseDirName,
}: {
  items: readonly T[]
  item: T
  baseDirName: string
  resolveBaseDirName: (candidate: T) => string
}): string => {
  const duplicateIndex = Math.max(
    0,
    items
      .filter((candidate) => resolveBaseDirName(candidate) === baseDirName)
      .sort((left, right) => left.id.localeCompare(right.id))
      .findIndex((candidate) => candidate.id === item.id),
  )
  return duplicateIndex === 0
    ? baseDirName
    : `${baseDirName} (${duplicateIndex + 1})`
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
}): string =>
  withDuplicateSuffix({
    items: settings?.assistants ?? [],
    item: assistant,
    baseDirName: resolveAssistantBaseDirName(assistant),
    resolveBaseDirName: resolveAssistantBaseDirName,
  })

const resolveProjectMemoryDirName = ({
  settings,
  project,
}: {
  settings?: MemorySettingsLike
  project: ProjectLike
}): string =>
  withDuplicateSuffix({
    items: settings?.projects ?? [],
    item: project,
    baseDirName: resolveProjectBaseDirName(project),
    resolveBaseDirName: resolveProjectBaseDirName,
  })

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
  projectId,
}: {
  settings?: MemorySettingsLike
  assistantId?: string
  /** The conversation's project; omitted outside a project. */
  projectId?: string
}): MemoryDirPaths => {
  const memoryRootDir = getMemoryRootDir(settings)
  const assistant = getAssistantById(settings, assistantId)
  const project = projectId
    ? (settings?.projects?.find((item) => item.id === projectId) ?? null)
    : null
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
    project: project
      ? normalizePath(
          `${memoryRootDir}/${YOLO_MEMORY_PROJECTS_DIR_NAME}/${resolveProjectMemoryDirName(
            { settings, project },
          )}`,
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
  projectId,
}: {
  settings?: MemorySettingsLike
  assistantId?: string
  projectId?: string
}): MemoryIndexPaths => {
  const dirs = resolveMemoryDirPaths({ settings, assistantId, projectId })
  const indexOf = (dir: string | null) =>
    dir ? normalizePath(`${dir}/${YOLO_MEMORY_INDEX_FILE_NAME}`) : null
  return {
    global: normalizePath(`${dirs.global}/${YOLO_MEMORY_INDEX_FILE_NAME}`),
    assistant: indexOf(dirs.assistant),
    project: indexOf(dirs.project),
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

/** Full text of the MEMORY.md indexes; an empty file reads as absent. */
export const readMemoryIndexes = async ({
  app,
  settings,
  assistantId,
  projectId,
}: {
  app: App
  settings?: MemorySettingsLike
  assistantId?: string
  projectId?: string
}): Promise<MemoryIndexes> => {
  const paths = resolveMemoryIndexPaths({ settings, assistantId, projectId })
  const [global, assistant, project] = await Promise.all([
    readIndexIfExists({ app, filePath: paths.global }),
    readIndexIfExists({ app, filePath: paths.assistant }),
    readIndexIfExists({ app, filePath: paths.project }),
  ])
  return { global, assistant, project }
}
