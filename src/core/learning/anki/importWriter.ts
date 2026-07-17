import { dump as dumpYaml } from 'js-yaml'

import { parseCardFile } from '../cardFile'
import {
  type LearningVaultReadApi,
  normalizeLearningVaultPath,
} from '../learningVaultReadApi'
import type { LearningVaultWriteApi } from '../learningVaultWriteApi'
import { scanProject } from '../projectScanner'
import { LearningSrsStore } from '../srs/srsStore'

import type { AnkiImportJournalStorage } from './ankiImportJournalStorage'
import type { AnkiImportPlan } from './importPlan'

type ImportJournal = {
  version: 1
  runId: string
  projectSlug: string
  projectPath: string
  indexPath: string
  srsPath: string
  createdFiles: string[]
  createdFolders: string[]
}

const yamlFile = (frontmatter: Record<string, unknown>, body = ''): string =>
  `---\n${dumpYaml(frontmatter, { lineWidth: -1 }).trimEnd()}\n---\n\n${body.trim()}\n`

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted)
    throw new DOMException('Anki import was aborted', 'AbortError')
}

const joinPath = (...parts: string[]): string =>
  normalizeLearningVaultPath(parts.join('/'))

const replaceMedia = (
  markdown: string,
  projectPath: string,
  names: ReadonlyMap<string, string>,
): string =>
  markdown.replace(
    /{{anki-media:(?:image|audio):([^}]+)}}/g,
    (placeholder, encoded: string) => {
      const fileName = names.get(decodeURIComponent(encoded))
      return fileName ? `![[${projectPath}/assets/${fileName}]]` : placeholder
    },
  )

const safeCardSide = (markdown: string): string =>
  markdown.replace(/^---\r?$/gm, '\\---')

const cardFile = (
  plan: AnkiImportPlan,
  chapter: AnkiImportPlan['chapters'][number],
): string => {
  const assets = new Map(
    plan.assets.map((asset) => [asset.sourceName, asset.fileName]),
  )
  const body = chapter.cards
    .map(
      (card) =>
        `## ${card.title.replace(/\r?\n/g, ' ')} <!--card:${card.uuid}-->\n\n${safeCardSide(replaceMedia(card.front, plan.projectPath, assets))}\n\n---\n\n${safeCardSide(replaceMedia(card.back, plan.projectPath, assets))}`,
    )
    .join('\n\n')
  return yamlFile({ title: chapter.title }, body)
}

const indexFile = (plan: AnkiImportPlan): string =>
  yamlFile(
    {
      kind: 'cards',
      topic: plan.projectName,
      goal: `Imported from Anki: ${plan.projectName}`,
      status: 'studying',
      chapters: plan.chapters.map((chapter) => chapter.slug),
    },
    plan.chapters
      .map(
        (chapter, index) =>
          `${index + 1}. [[${chapter.slug}/index|${chapter.title}]]`,
      )
      .join('\n'),
  )

const rollback = async (
  writer: LearningVaultWriteApi,
  srsStore: LearningSrsStore,
  journal: ImportJournal,
): Promise<void> => {
  assertJournalScope(journal)
  for (const path of [...journal.createdFiles].reverse())
    await writer.removeExactPath(path)
  await srsStore.deletePersistedProjectStateAtPath(
    journal.projectSlug,
    journal.srsPath,
  )
  for (const path of [...journal.createdFolders].reverse())
    await writer.removeEmptyFolder(path)
}

const assertJournalScope = (journal: ImportJournal): void => {
  const prefix = `${journal.projectPath}/`
  if (
    journal.indexPath !== `${journal.projectPath}/index.md` ||
    journal.createdFiles.some((path) => !path.startsWith(prefix)) ||
    journal.createdFolders.some(
      (path) => path !== journal.projectPath && !path.startsWith(prefix),
    )
  )
    throw new Error(`Unsafe Anki import journal: ${journal.runId}`)
}

const verify = async (
  vault: LearningVaultReadApi,
  plan: AnkiImportPlan,
  srsStore: LearningSrsStore,
): Promise<void> => {
  if (!(await scanProject(vault, plan.projectPath)))
    throw new Error('Imported Anki project cannot be scanned')
  const uuids = new Set<string>()
  for (const chapter of plan.chapters) {
    const path = joinPath(plan.projectPath, chapter.slug, 'cards.md')
    const content = await vault.readText(path)
    const parsed = parseCardFile(content, { mode: 'chapter-direct', path })
    if (!parsed.complete || parsed.cards.length !== chapter.cards.length)
      throw new Error(`Imported cards failed validation: ${path}`)
    parsed.cards.forEach((card) => uuids.add(card.cardUuid))
  }
  for (const asset of plan.assets) {
    const path = joinPath(plan.projectPath, 'assets', asset.fileName)
    const bytes = new Uint8Array(await vault.readBinary(path))
    if (
      bytes.byteLength !== asset.bytes.byteLength ||
      bytes.some((v, i) => v !== asset.bytes[i])
    )
      throw new Error(`Imported media failed validation: ${path}`)
  }
  const state = await srsStore.getProjectState(plan.projectSlug)
  if (
    uuids.size !== plan.cardCount ||
    Object.keys(state.cards).length !==
      Object.keys(plan.srsState.cards).length ||
    Object.keys(plan.srsState.cards).some(
      (uuid) =>
        JSON.stringify(state.cards[uuid]) !==
        JSON.stringify(plan.srsState.cards[uuid]),
    )
  )
    throw new Error('Imported card and SRS state are inconsistent')
}

export async function commitAnkiImportPlan({
  vault,
  writer,
  plan,
  srsStore,
  journalStorage,
  signal,
}: {
  vault: LearningVaultReadApi
  writer: LearningVaultWriteApi
  plan: AnkiImportPlan
  srsStore: LearningSrsStore
  journalStorage: AnkiImportJournalStorage
  signal?: AbortSignal
}): Promise<string> {
  throwIfAborted(signal)
  if (await vault.exists(plan.projectPath))
    throw new Error(`Import target already exists: ${plan.projectPath}`)
  await writer.ensureFolder(plan.baseDir)
  const journal: ImportJournal = {
    version: 1,
    runId: crypto.randomUUID(),
    projectSlug: plan.projectSlug,
    projectPath: plan.projectPath,
    indexPath: joinPath(plan.projectPath, 'index.md'),
    srsPath: await srsStore.getProjectStateFilePath(plan.projectSlug),
    createdFiles: [],
    createdFolders: [],
  }
  const serializeJournal = () => JSON.stringify(journal, null, 2)
  const journalPath = await journalStorage.create(serializeJournal())
  const saveJournal = () =>
    journalStorage.write(journalPath, serializeJournal())
  try {
    const makeFolder = async (path: string) => {
      await writer.createFolder(path)
      journal.createdFolders.push(path)
      try {
        await saveJournal()
      } catch (error) {
        journal.createdFolders.pop()
        await writer.removeEmptyFolder(path)
        throw error
      }
    }
    const writeText = async (path: string, content: string) => {
      await writer.createText(path, content)
      journal.createdFiles.push(path)
      try {
        await saveJournal()
      } catch (error) {
        journal.createdFiles.pop()
        await writer.removeExactPath(path)
        throw error
      }
    }
    const writeBinary = async (path: string, bytes: Uint8Array) => {
      await writer.createBinary(
        path,
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      )
      journal.createdFiles.push(path)
      try {
        await saveJournal()
      } catch (error) {
        journal.createdFiles.pop()
        await writer.removeExactPath(path)
        throw error
      }
    }
    await makeFolder(plan.projectPath)
    const assetsPath = joinPath(plan.projectPath, 'assets')
    await makeFolder(assetsPath)
    const writtenAssets = new Set<string>()
    for (const asset of plan.assets) {
      if (writtenAssets.has(asset.fileName)) continue
      writtenAssets.add(asset.fileName)
      await writeBinary(joinPath(assetsPath, asset.fileName), asset.bytes)
    }
    for (const chapter of plan.chapters) {
      throwIfAborted(signal)
      const path = joinPath(plan.projectPath, chapter.slug)
      await makeFolder(path)
      await writeText(
        joinPath(path, 'index.md'),
        yamlFile({ title: chapter.title }),
      )
      await writeText(joinPath(path, 'cards.md'), cardFile(plan, chapter))
    }
    throwIfAborted(signal)
    await srsStore.initializeProjectStateAtPath(
      plan.projectSlug,
      journal.srsPath,
      plan.srsState,
      { activateCache: false },
    )
    throwIfAborted(signal)
    await writeText(journal.indexPath, indexFile(plan))
    srsStore.activateProjectState(plan.projectSlug, plan.srsState)
    await verify(vault, plan, srsStore)
    await journalStorage.remove(journalPath)
    return plan.projectPath
  } catch (error) {
    await rollback(writer, srsStore, journal)
    await journalStorage.remove(journalPath)
    throw error
  }
}

export async function recoverAnkiImports({
  vault,
  writer,
  srsStore,
  journalStorage,
}: {
  vault: LearningVaultReadApi
  writer: LearningVaultWriteApi
  srsStore: LearningSrsStore
  journalStorage: AnkiImportJournalStorage
}): Promise<{ confirmed: string[]; rolledBack: string[] }> {
  const confirmed: string[] = []
  const rolledBack: string[] = []
  for (const path of await journalStorage.list()) {
    const journal = JSON.parse(await journalStorage.read(path)) as ImportJournal
    assertJournalScope(journal)
    const complete =
      (await vault.exists(journal.indexPath)) &&
      (await srsStore.hasPersistedProjectStateAtPath(
        journal.projectSlug,
        journal.srsPath,
      ))
    if (complete) {
      srsStore.invalidateProject(journal.projectSlug)
      confirmed.push(journal.projectPath)
    } else {
      await rollback(writer, srsStore, journal)
      rolledBack.push(journal.projectPath)
    }
    await journalStorage.remove(path)
  }
  return { confirmed, rolledBack }
}
