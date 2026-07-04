import { dump as dumpYaml } from 'js-yaml'
import { App, normalizePath } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import { createUniqueSlug } from './slug'
import type { ChapterGenerationResult } from './types'

export type WriteProjectOptions = {
  app: App
  baseDir: string
  topic: string
  chapters: ChapterGenerationResult[]
  level: string
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
  for (const chapter of successfulChapters) {
    chapterSlugs.push(createUniqueSlug(chapter.chapterTitle, chapterSlugs))
  }

  await app.vault.create(
    normalizePath(`${projectPath}/index.md`),
    buildMarkdown(
      { topic, status: 'studying', chapters: chapterSlugs },
      buildIndexBody(successfulChapters, chapterSlugs),
    ),
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

function buildIndexBody(
  chapters: ChapterGenerationResult[],
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
