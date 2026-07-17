import { load as parseYaml } from 'js-yaml'

import {
  chapterCardsFrontmatterSchema,
  chapterFrontmatterSchema,
  chapterKnowledgeFrontmatterSchema,
  projectFrontmatterSchema,
} from './frontmatter-schema'
import {
  type LearningVaultEntry,
  type LearningVaultFile,
  type LearningVaultFolder,
  type LearningVaultReadApi,
  isLearningVaultPathInScope,
  normalizeLearningVaultPath,
} from './learningVaultReadApi'
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

export type ScanResult = { projects: Project[] }

export async function scanProjects(
  vault: LearningVaultReadApi,
  baseDir: string,
): Promise<ScanResult> {
  const normalized = normalizeLearningVaultPath(baseDir)
  const root = vault.getEntry(normalized)
  if (root?.kind !== 'folder') return { projects: [] }

  const projects: Project[] = []
  for (const child of vault.listChildren(root.path)) {
    if (child.kind !== 'folder') continue
    const project = await scanProject(vault, child.path)
    if (project) projects.push(project)
  }
  projects.sort((a, b) => a.slug.localeCompare(b.slug))
  return { projects }
}

export async function scanProject(
  vault: LearningVaultReadApi,
  projectFolderPath: string,
): Promise<Project | null> {
  const projectFolder = vault.getEntry(projectFolderPath)
  if (projectFolder?.kind !== 'folder') return null
  const children = vault.listChildren(projectFolder.path)
  const indexFile = findChildFile(children, PROJECT_INDEX_FILE)
  if (!indexFile) return null

  const projectId = projectFolder.path
  const parsed = projectFrontmatterSchema.safeParse(
    await readFrontmatter(vault, indexFile),
  )
  if (!parsed.success) return null
  const { topic, goal } = parsed.data
  const status: ProjectStatus = parsed.data.status ?? 'outlining'
  const orderedChapterSlugs = parsed.data.chapters ?? null

  if (parsed.data.kind === 'cards') {
    const chapters = await scanCardChapters(
      vault,
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

  const chapterFolders = children.filter(
    (entry): entry is LearningVaultFolder =>
      entry.kind === 'folder' && entry.name !== 'ref',
  )
  const orderedFolders = orderedChapterSlugs
    ? orderChaptersBySlugs(chapterFolders, orderedChapterSlugs)
    : chapterFolders.sort((a, b) => a.name.localeCompare(b.name))
  const chapters: Chapter[] = []
  const knowledgePoints: KnowledgePoint[] = []
  for (const chapterFolder of orderedFolders) {
    const scanned = await scanChapter(vault, projectId, chapterFolder)
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
  vault: LearningVaultReadApi,
  projectId: string,
  projectFolder: LearningVaultFolder,
  orderedSlugs: string[],
): Promise<CardChapter[]> {
  const folders = new Map(
    vault
      .listChildren(projectFolder.path)
      .filter(
        (entry): entry is LearningVaultFolder =>
          entry.kind === 'folder' &&
          entry.name !== 'assets' &&
          entry.name !== 'ref',
      )
      .map((entry) => [entry.name, entry]),
  )
  const chapters: CardChapter[] = []
  for (const slug of orderedSlugs) {
    const folder = folders.get(slug)
    if (!folder) continue
    const children = vault.listChildren(folder.path)
    const indexFile = findChildFile(children, PROJECT_INDEX_FILE)
    const cardsFile = findChildFile(children, CARDS_FILE)
    if (!indexFile || !cardsFile) continue
    const parsedIndex = chapterFrontmatterSchema.safeParse(
      await readFrontmatter(vault, indexFile),
    )
    const parsedCards = chapterCardsFrontmatterSchema.safeParse(
      await readFrontmatter(vault, cardsFile),
    )
    chapters.push({
      id: folder.path,
      projectId,
      slug: folder.name,
      title:
        (parsedIndex.success ? parsedIndex.data.title : undefined) ??
        (parsedCards.success ? parsedCards.data.title : undefined) ??
        folder.name,
      folderPath: folder.path,
      cardsFilePath: cardsFile.path,
    })
  }
  return chapters
}

function findChildFile(
  entries: readonly LearningVaultEntry[],
  name: string,
): LearningVaultFile | undefined {
  return entries.find(
    (entry): entry is LearningVaultFile =>
      entry.kind === 'file' && entry.name === name,
  )
}

async function scanChapter(
  vault: LearningVaultReadApi,
  projectId: string,
  chapterFolder: LearningVaultFolder,
): Promise<{ chapter: Chapter; knowledgePoints: KnowledgePoint[] }> {
  const children = vault.listChildren(chapterFolder.path)
  const chapterId = chapterFolder.path
  const fallbackTitle = await resolveChapterTitleFromIndex(
    vault,
    chapterFolder,
    children,
  )
  const knowledgeFile = findChildFile(children, KNOWLEDGE_FILE)
  const hasCards = findChildFile(children, CARDS_FILE) !== undefined
  const hasExercises = findChildFile(children, EXERCISES_FILE) !== undefined
  const title = knowledgeFile
    ? await resolveChapterKnowledgeTitle(vault, knowledgeFile, fallbackTitle)
    : fallbackTitle
  const knowledgePoints = knowledgeFile
    ? await scanChapterKnowledgeFile({
        vault,
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
      knowledgePointIds: knowledgePoints.map((point) => point.id),
    },
    knowledgePoints,
  }
}

async function scanChapterKnowledgeFile({
  vault,
  projectId,
  chapterId,
  knowledgeFile,
  hasCards,
  hasExercises,
}: {
  vault: LearningVaultReadApi
  projectId: string
  chapterId: string
  knowledgeFile: LearningVaultFile
  hasCards: boolean
  hasExercises: boolean
}): Promise<KnowledgePoint[]> {
  const content = await vault.readText(knowledgeFile.path)
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
      mtime: knowledgeFile.mtime,
    }))
}

async function resolveChapterTitleFromIndex(
  vault: LearningVaultReadApi,
  chapterFolder: LearningVaultFolder,
  children: readonly LearningVaultEntry[],
): Promise<string> {
  const index = findChildFile(children, PROJECT_INDEX_FILE)
  const parsed = chapterFrontmatterSchema.safeParse(
    index ? await readFrontmatter(vault, index) : {},
  )
  return parsed.success && parsed.data.title
    ? parsed.data.title
    : chapterFolder.name
}

async function resolveChapterKnowledgeTitle(
  vault: LearningVaultReadApi,
  knowledgeFile: LearningVaultFile,
  fallback: string,
): Promise<string> {
  const parsed = chapterKnowledgeFrontmatterSchema.safeParse(
    await readFrontmatter(vault, knowledgeFile),
  )
  return parsed.success ? parsed.data.title : fallback
}

async function readFrontmatter(
  vault: LearningVaultReadApi,
  file: LearningVaultFile,
): Promise<Record<string, unknown>> {
  const content = await vault.readText(file.path)
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
  folders: LearningVaultFolder[],
  orderedSlugs: string[],
): LearningVaultFolder[] {
  const byName = new Map(folders.map((folder) => [folder.name, folder]))
  const ordered: LearningVaultFolder[] = []
  const used = new Set<string>()
  for (const slug of orderedSlugs) {
    const folder = byName.get(slug)
    if (folder) {
      ordered.push(folder)
      used.add(slug)
    }
  }
  for (const folder of folders) if (!used.has(folder.name)) ordered.push(folder)
  return ordered
}

export function isPathUnderLearningBase(
  vaultPath: string,
  baseDir: string,
): boolean {
  return isLearningVaultPathInScope(vaultPath, baseDir)
}
