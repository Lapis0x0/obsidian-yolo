import { App, TFile, TFolder, normalizePath } from 'obsidian'

import { ensureFolderPathExists } from '../mcp/vaultFileOps'
import {
  YOLO_MEMORY_GLOBAL_DIR_NAME,
  YOLO_MEMORY_INDEX_FILE_NAME,
  YOLO_MEMORY_SUBDIR,
  getYoloBaseDir,
} from '../paths/yoloPaths'

import {
  MemorySettingsLike,
  resolveAssistantMemoryDirName,
} from './memoryStore'

/**
 * One-time, idempotent migration of the pre-v2 memory layout.
 *
 * Before v2 each scope was a single file directly under `<baseDir>/memory/`:
 * `global.md` for the cross-assistant scope and `<assistant name>.md` (plus
 * `<assistant name> (2).md` for same-named assistants) for the per-assistant
 * one, each holding `- <Id>: <content>` entry lines under fixed headings.
 *
 * v2 reads `<baseDir>/memory/<scope>/MEMORY.md` plus one file per fact, so
 * every old file is folded whole into a single `legacy-memory.md` fact in the
 * matching scope directory and linked from that directory's index. Splitting it
 * into real facts is left to the model — old entries are usually a sentence
 * each, and mechanically exploding them would only produce fragments.
 *
 * Idempotence needs no persisted flag: the source file is deleted once its
 * scope is done, so "the source is still there" means "not migrated yet". A
 * scope whose `legacy-memory.md` already exists is skipped with its source left
 * untouched, which also makes a crash mid-scope safe to re-run.
 */

const LEGACY_GLOBAL_FILE_NAME = 'global.md'
const LEGACY_FACT_FILE_NAME = 'legacy-memory.md'

const LEGACY_FACT_FRONTMATTER = [
  '---',
  'name: legacy-memory',
  'description: Memory entries migrated from the pre-v2 single-file format; split into proper facts when you touch them',
  '---',
  '',
  '',
].join('\n')

const LEGACY_INDEX_LINE =
  "- [Legacy memory](legacy-memory.md) — entries migrated from the old memory file; read when the user's background or preferences matter"

/**
 * Entry ids were always generated (`Profile_1`, `Preference_2`, `Memory_3`), so
 * matching that exact shape strips every real entry prefix while leaving a
 * hand-written list line such as `- note: ...` alone.
 */
const LEGACY_ENTRY_ID_PREFIX_REGEX =
  /^(\s*[-*]\s+)(?:Profile|Preference|Memory)_\d+\s*[:：]\s*/

const stripLegacyEntryIds = (content: string): string =>
  content
    .split('\n')
    .map((line) => line.replace(LEGACY_ENTRY_ID_PREFIX_REGEX, '$1'))
    .join('\n')

const buildLegacyFactContent = (legacyContent: string): string => {
  const body = stripLegacyEntryIds(legacyContent)
  return `${LEGACY_FACT_FRONTMATTER}${body.endsWith('\n') ? body : `${body}\n`}`
}

const appendIndexLine = (existingContent: string): string | null => {
  if (existingContent.includes(LEGACY_INDEX_LINE)) {
    return null
  }
  if (existingContent.trim().length === 0) {
    return `${LEGACY_INDEX_LINE}\n`
  }
  const separator = existingContent.endsWith('\n') ? '' : '\n'
  return `${existingContent}${separator}${LEGACY_INDEX_LINE}\n`
}

/**
 * The legacy file name for an assistant, reproducing the pre-v2 algorithm:
 * same sanitizing as v2 but without the `global` reserved-name rule, which did
 * not exist when these files were written.
 */
const resolveLegacyAssistantFileName = ({
  settings,
  assistantId,
}: {
  settings: MemorySettingsLike
  assistantId: string
}): string | null => {
  const assistants = settings.assistants ?? []
  const assistant = assistants.find((item) => item.id === assistantId)
  if (!assistant) {
    return null
  }
  const sanitize = (value: string): string => {
    const normalized = value
      .trim()
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
    return normalized.length > 0 ? normalized : 'assistant'
  }
  const baseFileName = sanitize(assistant.name?.trim() || assistant.id)
  const siblings = assistants
    .filter((item) => sanitize(item.name?.trim() || item.id) === baseFileName)
    .sort((left, right) => left.id.localeCompare(right.id))
  const duplicateIndex = Math.max(
    0,
    siblings.findIndex((item) => item.id === assistantId),
  )
  return duplicateIndex === 0
    ? `${baseFileName}.md`
    : `${baseFileName} (${duplicateIndex + 1}).md`
}

/**
 * Legacy file name -> v2 scope directory name. Built from the current assistant
 * list so a file lands in exactly the directory the injection layer will read;
 * a file with no matching assistant (the assistant was deleted) still migrates,
 * keyed by its own name, rather than being dropped.
 */
const resolveTargetDirNames = (
  settings: MemorySettingsLike,
): Map<string, string> => {
  const byFileName = new Map<string, string>()
  for (const assistant of settings.assistants ?? []) {
    const legacyFileName = resolveLegacyAssistantFileName({
      settings,
      assistantId: assistant.id,
    })
    if (!legacyFileName) {
      continue
    }
    if (legacyFileName === LEGACY_GLOBAL_FILE_NAME) {
      // An assistant literally named `global` wrote to the same file as the
      // global scope — the collision predates v2 and its content is already
      // mixed. Migrate it as global rather than silently claiming the file.
      console.warn(
        `[YOLO] Assistant "${assistant.name ?? assistant.id}" shares the legacy global memory file; migrating it as global memory.`,
      )
      continue
    }
    byFileName.set(
      legacyFileName,
      resolveAssistantMemoryDirName({ settings, assistant }),
    )
  }
  return byFileName
}

/** Directory for a legacy file whose assistant no longer exists. */
const resolveOrphanDirName = (fileName: string): string =>
  resolveAssistantMemoryDirName({
    assistant: { id: fileName.replace(/\.md$/i, '') },
  })

const migrateOneLegacyFile = async ({
  app,
  file,
  memoryRootDir,
  targetDirName,
}: {
  app: App
  file: TFile
  memoryRootDir: string
  targetDirName: string
}): Promise<void> => {
  const targetDir = normalizePath(`${memoryRootDir}/${targetDirName}`)
  const factPath = normalizePath(`${targetDir}/${LEGACY_FACT_FILE_NAME}`)

  if (app.vault.getAbstractFileByPath(factPath)) {
    console.warn(
      `[YOLO] ${factPath} already exists; leaving ${file.path} in place instead of merging into it.`,
    )
    return
  }

  const legacyContent = await app.vault.read(file)
  await ensureFolderPathExists(app, targetDir)
  await app.vault.create(factPath, buildLegacyFactContent(legacyContent))

  const indexPath = normalizePath(`${targetDir}/${YOLO_MEMORY_INDEX_FILE_NAME}`)
  const existingIndex = app.vault.getAbstractFileByPath(indexPath)
  if (existingIndex instanceof TFile) {
    const nextIndex = appendIndexLine(await app.vault.read(existingIndex))
    if (nextIndex !== null) {
      await app.vault.modify(existingIndex, nextIndex)
    }
  } else if (!existingIndex) {
    await app.vault.create(indexPath, `${LEGACY_INDEX_LINE}\n`)
  }

  await app.fileManager.trashFile(file)
}

export const migrateLegacyMemoryFiles = async (
  app: App,
  settings?: MemorySettingsLike,
): Promise<void> => {
  const memoryRootDir = normalizePath(
    `${getYoloBaseDir(settings)}/${YOLO_MEMORY_SUBDIR}`,
  )
  const memoryRoot = app.vault.getAbstractFileByPath(memoryRootDir)
  if (!(memoryRoot instanceof TFolder)) {
    return
  }

  // Only files directly under `memory/` are legacy scopes; the v2 layout keeps
  // everything one level deeper, inside per-scope directories.
  const legacyFiles = memoryRoot.children
    .filter((child): child is TFile => child instanceof TFile)
    .filter((child) => child.extension === 'md')
    .sort((left, right) => left.name.localeCompare(right.name))
  if (legacyFiles.length === 0) {
    return
  }

  const targetDirNames = resolveTargetDirNames(settings ?? {})

  // Serial on purpose: a batch of vault writes in parallel is slow and jumpy on
  // mobile, and each await already yields to the event loop.
  for (const file of legacyFiles) {
    try {
      await migrateOneLegacyFile({
        app,
        file,
        memoryRootDir,
        targetDirName:
          file.name === LEGACY_GLOBAL_FILE_NAME
            ? YOLO_MEMORY_GLOBAL_DIR_NAME
            : (targetDirNames.get(file.name) ??
              resolveOrphanDirName(file.name)),
      })
    } catch (error) {
      console.warn(
        `[YOLO] Failed to migrate legacy memory file ${file.path}; skipping.`,
        error,
      )
    }
  }
}
