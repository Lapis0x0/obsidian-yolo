import { scanMarkdownEntries } from '../domain/markdownScanner'

import { LearningGenerationAbortError } from './abortError'
import type {
  LearningGenerationActivity,
  LearningGenerationHost,
  LearningWorkspaceScope,
} from './host'
import { KNOWLEDGE_POINT_GENERATOR_PROMPT } from './prompts'
import type {
  ChapterGenerationResult,
  GenerationProgress,
  KnowledgePointDraft,
  OutlineChapter,
} from './types'

export type GenerateKnowledgePointsForChapterOptions = {
  host: LearningGenerationHost
  modelId?: string
  projectTopic: string
  chapterTitle: string
  chapterContract: string
  outputLanguage: string
  level: string
  workspaceScope?: LearningWorkspaceScope
  referenceDir?: string
  abortSignal?: AbortSignal
  activity?: LearningGenerationActivity
  onProgress?: (delta: string, fullText: string) => void
  onKnowledgePointTitle?: (title: string) => void | Promise<void>
  onKnowledgePoint?: (point: KnowledgePointDraft) => void | Promise<void>
}

export async function generateKnowledgePointsForChapter({
  host,
  modelId,
  projectTopic,
  chapterTitle,
  chapterContract,
  outputLanguage,
  level,
  workspaceScope,
  referenceDir,
  abortSignal,
  activity,
  onProgress,
  onKnowledgePointTitle,
  onKnowledgePoint,
}: GenerateKnowledgePointsForChapterOptions): Promise<{
  drafts: KnowledgePointDraft[]
}> {
  let accumulated = ''
  let completedText = ''
  let titledCount = 0
  let emittedCount = 0
  const emitTitles = async (titles: string[]) => {
    if (!onKnowledgePointTitle) return
    for (const title of titles.slice(titledCount)) {
      await onKnowledgePointTitle(title)
      titledCount += 1
    }
  }
  const emitPoints = async (points: KnowledgePointDraft[]) => {
    if (!onKnowledgePoint) return
    for (const point of points.slice(emittedCount)) {
      await onKnowledgePoint(point)
      emittedCount += 1
    }
  }
  const refSection = referenceDir
    ? `\nReference materials directory: ${referenceDir} (when the contract names reference files, use the bash tool, e.g. \`cat\`, at their corresponding paths)`
    : ''
  const prompt = `Generate knowledge points for the following chapter:

Project topic: ${projectTopic}
Chapter title: ${chapterTitle}
Chapter contract:
${chapterContract}

Required output language: ${outputLanguage}

User's current level: ${level}${refSection}`
  for await (const event of host.agent.stream({
    prompt,
    modelId,
    systemPromptOverride: KNOWLEDGE_POINT_GENERATOR_PROMPT,
    capability: workspaceScope?.enabled ? 'readonly-vault' : 'none',
    workspaceScope,
    activity,
    abortSignal,
  })) {
    if (event.type === 'text') {
      accumulated = event.text || accumulated + event.delta
      onProgress?.(event.delta, accumulated)
      await emitTitles(parseKnowledgePointTitles(accumulated))
      await emitPoints(parseCompletedKnowledgePointDrafts(accumulated))
    }
    if (event.type === 'completed') completedText = event.text
    if (event.type === 'aborted') {
      throw new LearningGenerationAbortError(
        `Knowledge point generation aborted: ${chapterTitle}`,
      )
    }
    if (event.type === 'error') throw new Error(event.message)
  }
  const finalText = completedText || accumulated
  const drafts = parseKnowledgePointDrafts(finalText)
  await emitTitles(drafts.map((draft) => draft.title))
  await emitPoints(drafts)
  return { drafts }
}

export type GenerateKnowledgePointsParallelOptions = {
  host: LearningGenerationHost
  modelId?: string
  projectTopic: string
  outputLanguage: string
  chapters: OutlineChapter[]
  level: string
  workspaceScope?: LearningWorkspaceScope
  referenceDir?: string
  abortSignal?: AbortSignal
  onChapterProgress?: (progress: GenerationProgress) => void
}

export async function generateKnowledgePointsParallel({
  host,
  modelId,
  projectTopic,
  outputLanguage,
  chapters,
  level,
  workspaceScope,
  referenceDir,
  abortSignal,
  onChapterProgress,
}: GenerateKnowledgePointsParallelOptions): Promise<ChapterGenerationResult[]> {
  return Promise.all(
    chapters.map(async (chapter, chapterIndex) => {
      onChapterProgress?.({
        chapterIndex,
        chapterTitle: chapter.title,
        status: 'generating',
      })
      try {
        const { drafts } = await generateKnowledgePointsForChapter({
          host,
          modelId,
          projectTopic,
          chapterTitle: chapter.title,
          chapterContract: chapter.contract,
          outputLanguage,
          level,
          workspaceScope,
          referenceDir,
          abortSignal,
          onProgress: (_delta, fullText) =>
            onChapterProgress?.({
              chapterIndex,
              chapterTitle: chapter.title,
              status: 'generating',
              currentKnowledgePointTitle:
                scanMarkdownEntries(fullText).at(-1)?.title,
            }),
        })
        onChapterProgress?.({
          chapterIndex,
          chapterTitle: chapter.title,
          status: 'completed',
        })
        return {
          chapterIndex,
          chapterTitle: chapter.title,
          knowledgePoints: drafts,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        onChapterProgress?.({
          chapterIndex,
          chapterTitle: chapter.title,
          status: 'error',
          error: message,
        })
        return {
          chapterIndex,
          chapterTitle: chapter.title,
          knowledgePoints: [],
          error: message,
        }
      }
    }),
  )
}

function parseKnowledgePointDrafts(markdown: string): KnowledgePointDraft[] {
  return scanMarkdownEntries(markdown)
    .filter((entry) => entry.title.trim().length > 0)
    .map((entry) => ({ title: entry.title.trim(), body: entry.body.trim() }))
}

function parseCompletedKnowledgePointDrafts(
  markdown: string,
): KnowledgePointDraft[] {
  const entries = scanMarkdownEntries(markdown).filter(
    (entry) => entry.title.trim().length > 0,
  )
  return entries.slice(0, -1).map((entry) => ({
    title: entry.title.trim(),
    body: entry.body.trim(),
  }))
}

function parseKnowledgePointTitles(markdown: string): string[] {
  return [...markdown.matchAll(/^##[ \t]+([^\r\n]+)\r?\n/gm)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean)
}
