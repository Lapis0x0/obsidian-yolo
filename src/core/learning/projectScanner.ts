import { App, TFile, TFolder, normalizePath, parseYaml } from 'obsidian'

import {
  chapterCardsFrontmatterSchema,
  chapterFrontmatterSchema,
  chapterKnowledgeFrontmatterSchema,
  projectFrontmatterSchema,
} from './frontmatter-schema'
import { scanMarkdownEntries } from './markdownScanner'
import type {
  CardChapter,
  Chapter,
  KnowledgePoint,
  Project,
  ProjectStatus,
} from './types'

const KNOWLEDGE_FILE = 'knowledge.md'
const CARDS_FILE = 'cards.md'
const EXERCISES_FILE = 'exercises.md'
const PROJECT_INDEX_FILE = 'index.md'

export type ScanResult = {
  projects: Project[]
}

export async function scanProjects(
  app: App,
  baseDir: string,
): Promise<ScanResult> {
  const normalized = normalizePath(baseDir.replace(/\/$/, ''))
  const root = app.vault.getAbstractFileByPath(normalized)
  if (!(root instanceof TFolder)) {
    return { projects: [] }
  }

  const projects: Project[] = []
  for (const child of root.children) {
    if (!(child instanceof TFolder)) continue
    const project = await scanProject(app, child)
    if (project) projects.push(project)
  }
  projects.sort((a, b) => a.slug.localeCompare(b.slug))
  return { projects }
}

export async function scanProject(
  app: App,
  projectFolder: TFolder,
): Promise<Project | null> {
  const indexFile = projectFolder.children.find(
    (c): c is TFile => c instanceof TFile && c.name === PROJECT_INDEX_FILE,
  )
  if (!indexFile) return null

  const projectId = projectFolder.path
  const indexFrontmatter = await readFrontmatter(app, indexFile)
  const parsed = projectFrontmatterSchema.safeParse(indexFrontmatter)
  if (!parsed.success) return null
  const topic = parsed.data.topic
  const goal = parsed.data.goal
  const status: ProjectStatus = parsed.data.status ?? 'outlining'
  const orderedChapterSlugs = parsed.data.chapters ?? null

  if (parsed.data.kind === 'cards') {
    const chapters = await scanCardChapters(
      app,
      projectId,
      projectFolder,
      orderedChapterSlugs ?? [],
    )
    return {
      kind: 'cards',
      id: projectId,
      slug: projectFolder.name,
      topic,
      goal,
      status,
      folderPath: projectFolder.path,
      indexFilePath: indexFile.path,
      chapters,
      knowledgePoints: [],
    }
  }

  const chapterFolders = projectFolder.children.filter(
    (c): c is TFolder => c instanceof TFolder && c.name !== 'ref',
  )
  const orderedChapterFolders = orderedChapterSlugs
    ? orderChaptersBySlugs(chapterFolders, orderedChapterSlugs)
    : chapterFolders.sort((a, b) => a.name.localeCompare(b.name))

  const chapters: Chapter[] = []
  const knowledgePoints: KnowledgePoint[] = []
  for (const chapterFolder of orderedChapterFolders) {
    const scanned = await scanChapter(app, projectId, chapterFolder)
    chapters.push(scanned.chapter)
    knowledgePoints.push(...scanned.knowledgePoints)
  }

  return {
    kind: 'outline',
    id: projectId,
    slug: projectFolder.name,
    topic,
    goal,
    status,
    folderPath: projectFolder.path,
    indexFilePath: indexFile.path,
    chapters,
    knowledgePoints,
  }
}

async function scanCardChapters(
  app: App,
  projectId: string,
  projectFolder: TFolder,
  orderedSlugs: string[],
): Promise<CardChapter[]> {
  const folders = new Map(
    projectFolder.children
      .filter(
        (child): child is TFolder =>
          child instanceof TFolder &&
          child.name !== 'assets' &&
          child.name !== 'ref',
      )
      .map((folder) => [folder.name, folder]),
  )
  const chapters: CardChapter[] = []
  for (const slug of orderedSlugs) {
    const folder = folders.get(slug)
    if (!folder) continue
    const indexFile = findChildFile(folder, PROJECT_INDEX_FILE)
    const cardsFile = findChildFile(folder, CARDS_FILE)
    if (!indexFile || !cardsFile) continue
    const indexFrontmatter = await readFrontmatter(app, indexFile)
    const cardsFrontmatter = await readFrontmatter(app, cardsFile)
    const parsedIndex = chapterFrontmatterSchema.safeParse(indexFrontmatter)
    const parsedCards =
      chapterCardsFrontmatterSchema.safeParse(cardsFrontmatter)
    const title =
      (parsedIndex.success ? parsedIndex.data.title : undefined) ??
      (parsedCards.success ? parsedCards.data.title : undefined) ??
      folder.name
    chapters.push({
      id: folder.path,
      projectId,
      slug: folder.name,
      title,
      folderPath: folder.path,
      cardsFilePath: cardsFile.path,
    })
  }
  return chapters
}

function findChildFile(folder: TFolder, name: string): TFile | undefined {
  return folder.children.find(
    (child): child is TFile => child instanceof TFile && child.name === name,
  )
}

async function scanChapter(
  app: App,
  projectId: string,
  chapterFolder: TFolder,
): Promise<{ chapter: Chapter; knowledgePoints: KnowledgePoint[] }> {
  const chapterId = chapterFolder.path
  const fallbackTitle = await resolveChapterTitleFromIndex(app, chapterFolder)
  const knowledgeFile = chapterFolder.children.find(
    (c): c is TFile => c instanceof TFile && c.name === KNOWLEDGE_FILE,
  )
  const hasCards = chapterFolder.children.some(
    (c) => c instanceof TFile && c.name === CARDS_FILE,
  )
  const hasExercises = chapterFolder.children.some(
    (c) => c instanceof TFile && c.name === EXERCISES_FILE,
  )
  const title = knowledgeFile
    ? await resolveChapterKnowledgeTitle(app, knowledgeFile, fallbackTitle)
    : fallbackTitle
  const knowledgePoints = knowledgeFile
    ? await scanChapterKnowledgeFile({
        app,
        projectId,
        chapterId,
        knowledgeFile,
        hasCards,
        hasExercises,
      })
    : []

  return {
    chapter: {
      id: chapterId,
      projectId,
      slug: chapterFolder.name,
      title,
      folderPath: chapterFolder.path,
      knowledgePointIds: knowledgePoints.map((kp) => kp.id),
    },
    knowledgePoints,
  }
}

async function scanChapterKnowledgeFile({
  app,
  projectId,
  chapterId,
  knowledgeFile,
  hasCards,
  hasExercises,
}: {
  app: App
  projectId: string
  chapterId: string
  knowledgeFile: TFile
  hasCards: boolean
  hasExercises: boolean
}): Promise<KnowledgePoint[]> {
  const content = await app.vault.cachedRead(knowledgeFile)
  return scanMarkdownEntries(content)
    .filter((entry) => entry.type === 'kp' && entry.uuid)
    .map((entry) => ({
      id: `${chapterId}/${entry.uuid}`,
      projectId,
      chapterId,
      uuid: entry.uuid,
      title: entry.title,
      knowledgeFilePath: knowledgeFile.path,
      relations: [],
      hasCards,
      hasExercises,
      mtime: knowledgeFile.stat.mtime,
    }))
}

async function resolveChapterTitleFromIndex(
  app: App,
  chapterFolder: TFolder,
): Promise<string> {
  const chapterIndex = chapterFolder.children.find(
    (c): c is TFile => c instanceof TFile && c.name === PROJECT_INDEX_FILE,
  )
  const chapterFrontmatter = chapterIndex
    ? await readFrontmatter(app, chapterIndex)
    : {}
  const parsedChapter = chapterFrontmatterSchema.safeParse(chapterFrontmatter)
  return parsedChapter.success && parsedChapter.data.title
    ? parsedChapter.data.title
    : chapterFolder.name
}

async function resolveChapterKnowledgeTitle(
  app: App,
  knowledgeFile: TFile,
  fallback: string,
): Promise<string> {
  const frontmatter = await readFrontmatter(app, knowledgeFile)
  const parsed = chapterKnowledgeFrontmatterSchema.safeParse(frontmatter)
  return parsed.success ? parsed.data.title : fallback
}

async function readFrontmatter(
  app: App,
  file: TFile,
): Promise<Record<string, unknown>> {
  const content = await app.vault.cachedRead(file)
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (!match) return {}

  try {
    const parsed: unknown = parseYaml(match[1])
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function orderChaptersBySlugs(
  folders: TFolder[],
  orderedSlugs: string[],
): TFolder[] {
  const byName = new Map(folders.map((f) => [f.name, f]))
  const ordered: TFolder[] = []
  const used = new Set<string>()
  for (const slug of orderedSlugs) {
    const folder = byName.get(slug)
    if (folder) {
      ordered.push(folder)
      used.add(slug)
    }
  }
  for (const folder of folders) {
    if (!used.has(folder.name)) ordered.push(folder)
  }
  return ordered
}

export function isPathUnderLearningBase(
  vaultPath: string,
  baseDir: string,
): boolean {
  const normalizedBase = normalizePath(baseDir.replace(/\/$/, ''))
  const normalizedPath = normalizePath(vaultPath)
  return (
    normalizedPath === normalizedBase ||
    normalizedPath.startsWith(normalizedBase + '/')
  )
}
