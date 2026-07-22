import type { AnkiImportPlan } from './importPlan'
import type {
  AnkiImportJournalStorage,
  AnkiImportParserPort,
  AnkiImportSrsPort,
  AnkiImportVaultPort,
} from './ports'

type ImportJournal = {
  version: 1
  phase?: 'writing' | 'verified'
  runId: string
  projectSlug: string
  projectPath: string
  indexPath: string
  srsPath: string
  createdFiles: string[]
  createdFolders: string[]
}

const normalizePath = (path: string): string =>
  path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')

const joinPath = (...parts: string[]): string => normalizePath(parts.join('/'))

const yamlFile = (
  frontmatter: Record<string, string | readonly string[]>,
  body = '',
): string => {
  const yaml = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n')
  return `---\n${yaml}\n---\n\n${body.trim()}\n`
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw new DOMException('Anki import was aborted', 'AbortError')
  }
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

const assertJournalScope = (journal: ImportJournal): void => {
  const prefix = `${journal.projectPath}/`
  if (
    journal.indexPath !== `${journal.projectPath}/index.md` ||
    journal.createdFiles.some((path) => !path.startsWith(prefix)) ||
    journal.createdFolders.some(
      (path) => path !== journal.projectPath && !path.startsWith(prefix),
    )
  ) {
    throw new Error(`Unsafe Anki import journal: ${journal.runId}`)
  }
}

const rollback = async (
  vault: AnkiImportVaultPort,
  srs: AnkiImportSrsPort,
  journal: ImportJournal,
): Promise<void> => {
  assertJournalScope(journal)
  for (const path of [...journal.createdFiles].reverse()) {
    await vault.removeExactPath(path)
  }
  await srs.deletePersistedProjectStateAtPath(
    journal.projectSlug,
    journal.srsPath,
  )
  for (const path of [...journal.createdFolders].reverse()) {
    await vault.removeEmptyFolder(path)
  }
}

const verify = async (
  vault: AnkiImportVaultPort,
  parser: AnkiImportParserPort,
  plan: AnkiImportPlan,
  srs: AnkiImportSrsPort,
): Promise<void> => {
  const projectIndexPath = joinPath(plan.projectPath, 'index.md')
  if ((await vault.readText(projectIndexPath)) !== indexFile(plan)) {
    throw new Error(
      `Imported project index failed validation: ${projectIndexPath}`,
    )
  }
  if (!(await parser.scanProject(plan.projectPath))) {
    throw new Error('Imported Anki project cannot be scanned')
  }
  const uuids = new Set<string>()
  for (const chapter of plan.chapters) {
    const chapterPath = joinPath(plan.projectPath, chapter.slug)
    const chapterIndexPath = joinPath(chapterPath, 'index.md')
    if (
      (await vault.readText(chapterIndexPath)) !==
      yamlFile({ title: chapter.title })
    ) {
      throw new Error(
        `Imported chapter index failed validation: ${chapterIndexPath}`,
      )
    }
    const path = joinPath(chapterPath, 'cards.md')
    const content = await vault.readText(path)
    if (content !== cardFile(plan, chapter)) {
      throw new Error(`Imported cards failed validation: ${path}`)
    }
    const parsed = parser.parseChapterCards(content, path)
    if (!parsed.complete || parsed.cards.length !== chapter.cards.length) {
      throw new Error(`Imported cards failed validation: ${path}`)
    }
    parsed.cards.forEach((card) => uuids.add(card.cardUuid))
  }
  for (const asset of plan.assets) {
    const path = joinPath(plan.projectPath, 'assets', asset.fileName)
    const bytes = new Uint8Array(await vault.readBinary(path))
    if (
      bytes.byteLength !== asset.bytes.byteLength ||
      bytes.some((value, index) => value !== asset.bytes[index])
    ) {
      throw new Error(`Imported media failed validation: ${path}`)
    }
  }
  const state = await srs.getProjectState(plan.projectSlug)
  if (
    uuids.size !== plan.cardCount ||
    Object.keys(state.cards).length !==
      Object.keys(plan.srsState.cards).length ||
    Object.keys(plan.srsState.cards).some(
      (uuid) =>
        JSON.stringify(state.cards[uuid]) !==
        JSON.stringify(plan.srsState.cards[uuid]),
    )
  ) {
    throw new Error('Imported card and SRS state are inconsistent')
  }
}

export async function commitAnkiImportPlan({
  vault,
  parser,
  plan,
  srs,
  journalStorage,
  signal,
}: {
  vault: AnkiImportVaultPort
  parser: AnkiImportParserPort
  plan: AnkiImportPlan
  srs: AnkiImportSrsPort
  journalStorage: AnkiImportJournalStorage
  signal?: AbortSignal
}): Promise<string> {
  throwIfAborted(signal)
  if (await vault.exists(plan.projectPath)) {
    throw new Error(`Import target already exists: ${plan.projectPath}`)
  }
  await vault.ensureFolder(plan.baseDir)
  const journal: ImportJournal = {
    version: 1,
    phase: 'writing',
    runId: crypto.randomUUID(),
    projectSlug: plan.projectSlug,
    projectPath: plan.projectPath,
    indexPath: joinPath(plan.projectPath, 'index.md'),
    srsPath: await srs.getProjectStateFilePath(plan.projectSlug),
    createdFiles: [],
    createdFolders: [],
  }
  const serializeJournal = () => JSON.stringify(journal, null, 2)
  const journalPath = await journalStorage.create(serializeJournal())
  const saveJournal = () =>
    journalStorage.write(journalPath, serializeJournal())
  let verified = false
  try {
    const makeFolder = async (path: string) => {
      await vault.createFolder(path)
      journal.createdFolders.push(path)
      try {
        await saveJournal()
      } catch (error) {
        journal.createdFolders.pop()
        await vault.removeEmptyFolder(path)
        throw error
      }
    }
    const writeText = async (path: string, content: string) => {
      await vault.createText(path, content)
      journal.createdFiles.push(path)
      try {
        await saveJournal()
      } catch (error) {
        journal.createdFiles.pop()
        await vault.removeExactPath(path)
        throw error
      }
    }
    const writeBinary = async (path: string, bytes: Uint8Array) => {
      await vault.createBinary(
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
        await vault.removeExactPath(path)
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
      const chapterPath = joinPath(plan.projectPath, chapter.slug)
      await makeFolder(chapterPath)
      await writeText(
        joinPath(chapterPath, 'index.md'),
        yamlFile({ title: chapter.title }),
      )
      await writeText(
        joinPath(chapterPath, 'cards.md'),
        cardFile(plan, chapter),
      )
    }
    throwIfAborted(signal)
    await srs.initializeProjectStateAtPath(
      plan.projectSlug,
      journal.srsPath,
      plan.srsState,
      { activateCache: false },
    )
    throwIfAborted(signal)
    await writeText(journal.indexPath, indexFile(plan))
    srs.activateProjectState(plan.projectSlug, plan.srsState)
    await verify(vault, parser, plan, srs)
    journal.phase = 'verified'
    await saveJournal()
    verified = true
    await journalStorage.remove(journalPath)
    return plan.projectPath
  } catch (error) {
    if (!verified) {
      await rollback(vault, srs, journal)
      await journalStorage.remove(journalPath)
    }
    throw error
  }
}

export async function recoverAnkiImports({
  vault,
  srs,
  journalStorage,
}: {
  vault: AnkiImportVaultPort
  srs: AnkiImportSrsPort
  journalStorage: AnkiImportJournalStorage
}): Promise<{ confirmed: string[]; rolledBack: string[] }> {
  const confirmed: string[] = []
  const rolledBack: string[] = []
  for (const path of await journalStorage.list()) {
    const journal = JSON.parse(await journalStorage.read(path)) as ImportJournal
    assertJournalScope(journal)
    const complete =
      journal.phase === 'verified' &&
      (await vault.exists(journal.indexPath)) &&
      (await srs.hasPersistedProjectStateAtPath(
        journal.projectSlug,
        journal.srsPath,
      ))
    if (complete) {
      srs.invalidateProject(journal.projectSlug)
      confirmed.push(journal.projectPath)
    } else {
      await rollback(vault, srs, journal)
      rolledBack.push(journal.projectPath)
    }
    await journalStorage.remove(path)
  }
  return { confirmed, rolledBack }
}
