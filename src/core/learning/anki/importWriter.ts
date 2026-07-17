import { dump as dumpYaml } from 'js-yaml'
import { App, TFile, TFolder, normalizePath } from 'obsidian'

import { YOLO_ANKI_IMPORT_JOURNAL_DIR_NAME } from '../../paths/yoloPaths'
import { parseCardFile } from '../cardFile'
import { scanProject } from '../projectScanner'
import { LearningSrsStore } from '../srs/srsStore'

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

const ensureDir = async (app: App, path: string): Promise<void> => {
  if (!(await app.vault.adapter.exists(path)))
    await app.vault.adapter.mkdir(path)
}

const journalDirectory = async (
  app: App,
  srsStore: LearningSrsStore,
): Promise<string> => {
  const root = await srsStore.getLearningDataRootDir()
  const dir = normalizePath(`${root}/${YOLO_ANKI_IMPORT_JOURNAL_DIR_NAME}`)
  await ensureDir(app, dir)
  return dir
}

const removeJournal = async (app: App, path: string): Promise<void> => {
  if (await app.vault.adapter.exists(path)) await app.vault.adapter.remove(path)
}

const removeVaultPath = async (app: App, path: string): Promise<void> => {
  const file = app.vault.getAbstractFileByPath(path)
  if (file instanceof TFile || file instanceof TFolder) {
    // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- Transaction rollback must remove partial import files permanently.
    await app.vault.delete(file, true)
    return
  }
  if (!(await app.vault.adapter.exists(path))) return
  const stat = await app.vault.adapter.stat(path)
  if (stat?.type === 'folder') await app.vault.adapter.rmdir(path, true)
  else await app.vault.adapter.remove(path)
}

const rollback = async (
  app: App,
  srsStore: LearningSrsStore,
  journal: ImportJournal,
): Promise<void> => {
  assertJournalScope(journal)
  for (const path of [...journal.createdFiles].reverse())
    await removeVaultPath(app, path)
  await srsStore.deleteProjectState(journal.projectSlug)
  for (const path of [...journal.createdFolders].reverse())
    await removeVaultPath(app, path)
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
  app: App,
  plan: AnkiImportPlan,
  srsStore: LearningSrsStore,
): Promise<void> => {
  const folder = app.vault.getAbstractFileByPath(plan.projectPath)
  if (!(folder instanceof TFolder) || !(await scanProject(app, folder)))
    throw new Error('Imported Anki project cannot be scanned')
  const uuids = new Set<string>()
  for (const chapter of plan.chapters) {
    const path = normalizePath(`${plan.projectPath}/${chapter.slug}/cards.md`)
    const content = await app.vault.adapter.read(path)
    const parsed = parseCardFile(content, { mode: 'chapter-direct', path })
    if (!parsed.complete || parsed.cards.length !== chapter.cards.length)
      throw new Error(`Imported cards failed validation: ${path}`)
    parsed.cards.forEach((card) => uuids.add(card.cardUuid))
  }
  for (const asset of plan.assets) {
    const path = normalizePath(`${plan.projectPath}/assets/${asset.fileName}`)
    const bytes = new Uint8Array(await app.vault.adapter.readBinary(path))
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
  app,
  plan,
  srsStore,
  signal,
}: {
  app: App
  plan: AnkiImportPlan
  srsStore: LearningSrsStore
  signal?: AbortSignal
}): Promise<string> {
  throwIfAborted(signal)
  if (await app.vault.adapter.exists(plan.projectPath))
    throw new Error(`Import target already exists: ${plan.projectPath}`)
  await ensureDir(app, plan.baseDir)
  const journalPath = normalizePath(
    `${await journalDirectory(app, srsStore)}/${crypto.randomUUID()}.json`,
  )
  const journal: ImportJournal = {
    version: 1,
    runId: crypto.randomUUID(),
    projectSlug: plan.projectSlug,
    projectPath: plan.projectPath,
    indexPath: normalizePath(`${plan.projectPath}/index.md`),
    srsPath: await srsStore.getProjectStateFilePath(plan.projectSlug),
    createdFiles: [],
    createdFolders: [],
  }
  const saveJournal = () =>
    app.vault.adapter.write(journalPath, JSON.stringify(journal, null, 2))
  await saveJournal()
  try {
    const makeFolder = async (path: string) => {
      journal.createdFolders.push(path)
      await saveJournal()
      await app.vault.createFolder(path)
    }
    const writeText = async (path: string, content: string) => {
      journal.createdFiles.push(path)
      await saveJournal()
      await app.vault.create(path, content)
    }
    const writeBinary = async (path: string, bytes: Uint8Array) => {
      journal.createdFiles.push(path)
      await saveJournal()
      await app.vault.createBinary(
        path,
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      )
    }
    await makeFolder(plan.projectPath)
    const assetsPath = normalizePath(`${plan.projectPath}/assets`)
    await makeFolder(assetsPath)
    const writtenAssets = new Set<string>()
    for (const asset of plan.assets) {
      if (writtenAssets.has(asset.fileName)) continue
      writtenAssets.add(asset.fileName)
      await writeBinary(
        normalizePath(`${assetsPath}/${asset.fileName}`),
        asset.bytes,
      )
    }
    for (const chapter of plan.chapters) {
      throwIfAborted(signal)
      const path = normalizePath(`${plan.projectPath}/${chapter.slug}`)
      await makeFolder(path)
      await writeText(
        normalizePath(`${path}/index.md`),
        yamlFile({ title: chapter.title }),
      )
      await writeText(
        normalizePath(`${path}/cards.md`),
        cardFile(plan, chapter),
      )
    }
    throwIfAborted(signal)
    await srsStore.initializeProjectState(plan.projectSlug, plan.srsState, {
      activateCache: false,
    })
    throwIfAborted(signal)
    await writeText(journal.indexPath, indexFile(plan))
    srsStore.activateProjectState(plan.projectSlug, plan.srsState)
    await verify(app, plan, srsStore)
    await removeJournal(app, journalPath)
    return plan.projectPath
  } catch (error) {
    await rollback(app, srsStore, journal)
    await removeJournal(app, journalPath)
    throw error
  }
}

export async function recoverAnkiImports({
  app,
  srsStore,
}: {
  app: App
  srsStore: LearningSrsStore
}): Promise<{ confirmed: string[]; rolledBack: string[] }> {
  const dir = await journalDirectory(app, srsStore)
  const listing = await app.vault.adapter.list(dir)
  const confirmed: string[] = []
  const rolledBack: string[] = []
  for (const path of listing.files.filter((file) => file.endsWith('.json'))) {
    const journal = JSON.parse(
      await app.vault.adapter.read(path),
    ) as ImportJournal
    assertJournalScope(journal)
    const complete =
      (await app.vault.adapter.exists(journal.indexPath)) &&
      (await app.vault.adapter.exists(journal.srsPath))
    if (complete) {
      srsStore.invalidateProject(journal.projectSlug)
      confirmed.push(journal.projectPath)
    } else {
      await rollback(app, srsStore, journal)
      rolledBack.push(journal.projectPath)
    }
    await removeJournal(app, path)
  }
  return { confirmed, rolledBack }
}
