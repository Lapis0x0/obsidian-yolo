import { App, TFile, TFolder, normalizePath } from 'obsidian'

import {
  chapterFrontmatterSchema,
  knowledgePointFrontmatterSchema,
  parseRelationsFromFrontmatter,
  projectFrontmatterSchema,
} from './frontmatter-schema'
import type {
  Chapter,
  KnowledgePoint,
  Project,
  ProjectStatus,
  Relation,
} from './types'

/**
 * Scans the vault for learning projects.
 *
 * Vault layout (see types.ts for the full contract):
 *   <baseDir>/<projectSlug>/index.md
 *   <baseDir>/<projectSlug>/<chapterSlug>/<knowledgePointSlug>/knowledge.md
 *
 * No database. We rebuild the Project model from the filesystem on demand,
 * then keep it fresh with incremental vault events (see projectEventBus.ts).
 */

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
  if (!indexFile) {
    // Without index.md, we treat the folder as "not a learning project".
    return null
  }

  const projectId = projectFolder.path
  const indexFrontmatter =
    app.metadataCache.getFileCache(indexFile)?.frontmatter ?? {}
  const parsed = projectFrontmatterSchema.safeParse(indexFrontmatter)
  const topic =
    parsed.success && parsed.data.topic ? parsed.data.topic : projectFolder.name
  const status: ProjectStatus =
    parsed.success && parsed.data.status ? parsed.data.status : 'outlining'

  const orderedChapterSlugs =
    parsed.success && parsed.data.chapters ? parsed.data.chapters : null

  const chapterFolders = projectFolder.children.filter(
    (c): c is TFolder => c instanceof TFolder,
  )

  const orderedChapterFolders = orderedChapterSlugs
    ? orderChaptersBySlugs(chapterFolders, orderedChapterSlugs)
    : chapterFolders.sort((a, b) => a.name.localeCompare(b.name))

  const chapters: Chapter[] = []
  const knowledgePoints: KnowledgePoint[] = []

  // First pass: collect all knowledge points so we can resolve relations by path.
  for (const chapterFolder of orderedChapterFolders) {
    const { chapter, knowledgePoints: kps } = await scanChapter(
      app,
      projectId,
      chapterFolder,
    )
    chapters.push(chapter)
    knowledgePoints.push(...kps)
  }

  // Second pass: resolve relations by vault path → knowledgePointId.
  const idByRelativeFolderPath = new Map<string, string>()
  for (const kp of knowledgePoints) {
    // Relative to project root: "<chapterSlug>/<kpSlug>"
    const relative = kp.folderPath.slice(projectFolder.path.length + 1)
    idByRelativeFolderPath.set(relative, kp.id)
  }
  for (const kp of knowledgePoints) {
    if (kp.relations.length === 0) continue
    // Relations were stored as unresolved targets; re-resolve via the lookup.
    kp.relations = resolveRelationTargets(kp.relations, idByRelativeFolderPath)
  }

  return {
    id: projectId,
    slug: projectFolder.name,
    topic,
    status,
    folderPath: projectFolder.path,
    indexFilePath: indexFile.path,
    chapters,
    knowledgePoints,
  }
}

async function scanChapter(
  app: App,
  projectId: string,
  chapterFolder: TFolder,
): Promise<{ chapter: Chapter; knowledgePoints: KnowledgePoint[] }> {
  // A chapter may optionally have its own `index.md` with a title override.
  const chapterIndex = chapterFolder.children.find(
    (c): c is TFile => c instanceof TFile && c.name === PROJECT_INDEX_FILE,
  )
  const chapterFrontmatter = chapterIndex
    ? (app.metadataCache.getFileCache(chapterIndex)?.frontmatter ?? {})
    : {}
  const parsedChapter = chapterFrontmatterSchema.safeParse(chapterFrontmatter)
  const title =
    parsedChapter.success && parsedChapter.data.title
      ? parsedChapter.data.title
      : chapterFolder.name

  const chapterId = chapterFolder.path

  const kpFolders = chapterFolder.children
    .filter((c): c is TFolder => c instanceof TFolder)
    .sort((a, b) => a.name.localeCompare(b.name))

  const knowledgePoints: KnowledgePoint[] = []
  for (const kpFolder of kpFolders) {
    const kp = await scanKnowledgePoint(app, projectId, chapterId, kpFolder)
    if (kp) knowledgePoints.push(kp)
  }

  const chapter: Chapter = {
    id: chapterId,
    projectId,
    slug: chapterFolder.name,
    title,
    folderPath: chapterFolder.path,
    knowledgePointIds: knowledgePoints.map((kp) => kp.id),
  }

  return { chapter, knowledgePoints }
}

async function scanKnowledgePoint(
  app: App,
  projectId: string,
  chapterId: string,
  kpFolder: TFolder,
): Promise<KnowledgePoint | null> {
  const knowledgeFile = kpFolder.children.find(
    (c): c is TFile => c instanceof TFile && c.name === KNOWLEDGE_FILE,
  )
  if (!knowledgeFile) return null

  const frontmatter =
    app.metadataCache.getFileCache(knowledgeFile)?.frontmatter ?? {}
  const parsed = knowledgePointFrontmatterSchema.safeParse(frontmatter)
  const title =
    parsed.success && parsed.data.title ? parsed.data.title : kpFolder.name

  // Phase-1 relations: we keep the raw target paths as `targetId` for now;
  // scanProject() will resolve them to real knowledge-point IDs after all
  // knowledge points are collected.
  const rawRelations = parseRelationsFromFrontmatter(
    parsed.success ? parsed.data.relations : [],
    (rawTarget) => rawTarget, // pass through unresolved; resolved in second pass
  )

  const hasCards = kpFolder.children.some(
    (c) => c instanceof TFile && c.name === CARDS_FILE,
  )
  const hasExercises = kpFolder.children.some(
    (c) => c instanceof TFile && c.name === EXERCISES_FILE,
  )

  return {
    id: kpFolder.path,
    projectId,
    chapterId,
    slug: kpFolder.name,
    title,
    knowledgeFilePath: knowledgeFile.path,
    folderPath: kpFolder.path,
    relations: rawRelations,
    hasCards,
    hasExercises,
    mtime: knowledgeFile.stat.mtime,
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

function resolveRelationTargets(
  relations: Relation[],
  idByRelativeFolderPath: Map<string, string>,
): Relation[] {
  const resolved: Relation[] = []
  for (const relation of relations) {
    const targetId = idByRelativeFolderPath.get(relation.targetId)
    if (!targetId) continue
    resolved.push({ ...relation, targetId })
  }
  return resolved
}

/**
 * Returns true if the given vault path lies under the configured learning
 * base directory and looks like it could belong to a learning project.
 */
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
