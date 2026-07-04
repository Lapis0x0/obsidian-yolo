import { dump as dumpYaml } from 'js-yaml'
import { App, TFile, normalizePath } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import { createUniqueSlug } from './slug'
import type {
  ChapterGenerationResult,
  KnowledgePointDraft,
  OutlineChapter,
} from './types'

export type WriteProjectOptions = {
  app: App
  baseDir: string
  topic: string
  chapters: ChapterGenerationResult[]
  level: string
}

export type ProjectScaffold = {
  projectPath: string
  projectSlug: string
  indexPath: string
  chapters: ChapterWriteTarget[]
}

export type ChapterWriteTarget = {
  chapterIndex: number
  chapterTitle: string
  chapterSlug: string
  chapterPath: string
  knowledgePath: string
}

export type WrittenKnowledgePoint = {
  id: string
  projectId: string
  chapterId: string
  uuid: string
  title: string
  knowledgeFilePath: string
  relations: []
  hasCards: false
  hasExercises: false
  mtime: number
}

export async function createProjectScaffold({
  app,
  baseDir,
  topic,
  chapters,
}: {
  app: App
  baseDir: string
  topic: string
  chapters: OutlineChapter[]
}): Promise<ProjectScaffold> {
  const normalizedBaseDir = normalizePath(baseDir.replace(/\/$/, ''))
  await ensureFolder(app, normalizedBaseDir)

  const projectSlug = createUniqueSlug(
    topic,
    await listExistingChildNames(app, normalizedBaseDir),
  )
  const projectPath = normalizePath(`${normalizedBaseDir}/${projectSlug}`)
  await ensureFolder(app, projectPath)

  const chapterSlugs: string[] = []
  const targets: ChapterWriteTarget[] = []
  for (let i = 0; i < chapters.length; i += 1) {
    const chapter = chapters[i]
    const chapterNumber = String(i + 1).padStart(2, '0')
    const orderedTitle = `${chapterNumber}-${chapter.title}`
    const chapterSlug = createUniqueSlug(orderedTitle, chapterSlugs)
    chapterSlugs.push(chapterSlug)
    const chapterPath = normalizePath(`${projectPath}/${chapterSlug}`)
    const knowledgePath = normalizePath(`${chapterPath}/knowledge.md`)
    await ensureFolder(app, chapterPath)
    await app.vault.create(
      knowledgePath,
      buildMarkdown({ title: chapter.title }, ''),
    )
    targets.push({
      chapterIndex: i,
      chapterTitle: chapter.title,
      chapterSlug,
      chapterPath,
      knowledgePath,
    })
  }

  const indexPath = normalizePath(`${projectPath}/index.md`)
  await app.vault.create(
    indexPath,
    buildProjectIndexMarkdown({
      topic,
      status: 'building',
      chapterSlugs,
      chapters: chapters.map((chapter, index) => ({
        chapterTitle: chapter.title,
        chapterIndex: index,
        knowledgePoints: [],
      })),
    }),
  )

  return { projectPath, projectSlug, indexPath, chapters: targets }
}

export async function appendKnowledgePointDraft({
  app,
  projectPath,
  chapter,
  point,
  uuid = createKnowledgePointUuid(),
}: {
  app: App
  projectPath: string
  chapter: ChapterWriteTarget
  point: KnowledgePointDraft
  uuid?: string
}): Promise<WrittenKnowledgePoint> {
  const knowledgeFile = app.vault.getAbstractFileByPath(chapter.knowledgePath)
  if (!(knowledgeFile instanceof TFile)) {
    throw new Error(`Knowledge file not found: ${chapter.knowledgePath}`)
  }

  const existing = await app.vault.cachedRead(knowledgeFile)
  const block = `## ${point.title} <!--kp:${uuid}-->\n\n${point.body.trim()}`
  await app.vault.modify(knowledgeFile, `${existing.trimEnd()}\n\n${block}\n`)

  return {
    id: `${chapter.chapterPath}/${uuid}`,
    projectId: projectPath,
    chapterId: chapter.chapterPath,
    uuid,
    title: point.title,
    knowledgeFilePath: chapter.knowledgePath,
    relations: [],
    hasCards: false,
    hasExercises: false,
    mtime: knowledgeFile.stat.mtime,
  }
}

export function createKnowledgePointUuid(): string {
  return uuidv4().replace(/-/g, '').slice(0, 8)
}

export async function markProjectStudying({
  app,
  indexPath,
}: {
  app: App
  indexPath: string
}): Promise<void> {
  const indexFile = app.vault.getAbstractFileByPath(indexPath)
  if (!(indexFile instanceof TFile)) {
    throw new Error(`Project index not found: ${indexPath}`)
  }
  const existing = await app.vault.cachedRead(indexFile)
  await app.vault.modify(
    indexFile,
    existing.replace(/^status: building$/m, 'status: studying'),
  )
}

export async function writeProject({
  app,
  baseDir,
  topic,
  chapters,
}: WriteProjectOptions): Promise<{ projectPath: string; projectSlug: string }> {
  const normalizedBaseDir = normalizePath(baseDir.replace(/\/$/, ''))
  await ensureFolder(app, normalizedBaseDir)

  const projectSlug = createUniqueSlug(
    topic,
    await listExistingChildNames(app, normalizedBaseDir),
  )
  const projectPath = normalizePath(`${normalizedBaseDir}/${projectSlug}`)
  await ensureFolder(app, projectPath)

  const successfulChapters = chapters.filter((chapter) => !chapter.error)
  const chapterSlugs: string[] = []
  for (let i = 0; i < successfulChapters.length; i += 1) {
    const chapter = successfulChapters[i]
    const chapterNumber = String(i + 1).padStart(2, '0')
    const orderedTitle = `${chapterNumber}-${chapter.chapterTitle}`
    chapterSlugs.push(createUniqueSlug(orderedTitle, chapterSlugs))
  }

  await app.vault.create(
    normalizePath(`${projectPath}/index.md`),
    buildProjectIndexMarkdown({
      topic,
      status: 'studying',
      chapterSlugs,
      chapters: successfulChapters,
    }),
  )

  for (let i = 0; i < successfulChapters.length; i += 1) {
    const chapter = successfulChapters[i]
    const chapterSlug = chapterSlugs[i]
    const chapterPath = normalizePath(`${projectPath}/${chapterSlug}`)
    await ensureFolder(app, chapterPath)
    await app.vault.create(
      normalizePath(`${chapterPath}/knowledge.md`),
      buildMarkdown(
        { title: chapter.chapterTitle },
        buildKnowledgeBody(chapter.knowledgePoints),
      ),
    )
  }

  return { projectPath, projectSlug }
}

async function listExistingChildNames(
  app: App,
  folderPath: string,
): Promise<string[]> {
  const listed = await app.vault.adapter.list(folderPath)
  return [...listed.files, ...listed.folders]
    .map((path) => path.split('/').at(-1))
    .filter((name): name is string => Boolean(name))
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
  if (app.vault.getAbstractFileByPath(folderPath)) return
  await app.vault.adapter.mkdir(folderPath)
}

function buildMarkdown(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const yaml = dumpYaml(frontmatter, { lineWidth: -1 }).trimEnd()
  return `---\n${yaml}\n---\n\n${body.trim()}\n`
}

function buildProjectIndexMarkdown({
  topic,
  status,
  chapterSlugs,
  chapters,
}: {
  topic: string
  status: 'building' | 'studying'
  chapterSlugs: string[]
  chapters: Array<Pick<ChapterGenerationResult, 'chapterTitle'>>
}): string {
  return buildMarkdown(
    { topic, status, chapters: chapterSlugs },
    buildIndexBody(chapters, chapterSlugs),
  )
}

function buildIndexBody(
  chapters: Array<Pick<ChapterGenerationResult, 'chapterTitle'>>,
  chapterSlugs: string[],
): string {
  return chapters
    .map(
      (chapter, index) =>
        `${index + 1}. [[${chapterSlugs[index]}/knowledge|${chapter.chapterTitle}]]`,
    )
    .join('\n')
}

function buildKnowledgeBody(
  knowledgePoints: ChapterGenerationResult['knowledgePoints'],
): string {
  return knowledgePoints
    .map((point) => {
      const uuid = uuidv4().replace(/-/g, '').slice(0, 8)
      return `## ${point.title} <!--kp:${uuid}-->\n\n${point.body.trim()}`
    })
    .join('\n\n')
}
