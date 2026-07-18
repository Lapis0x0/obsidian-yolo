import type YoloPlugin from '../../../main'
import type { AssistantWorkspaceScope } from '../../../types/assistant.types'
import type { AgentRunActivity } from '../../agent/service'
import { scanMarkdownEntries } from '../markdownScanner'

import { type ChapterDebugData, PhaseDebugCollector } from './debugLog'
import {
  KNOWLEDGE_POINT_GENERATOR_PROMPT,
  buildLanguageDirective,
  buildLanguageReminder,
} from './prompts'
import { LEARNING_READONLY_TOOL_NAMES } from './tools'
import type {
  ChapterGenerationResult,
  GenerationProgress,
  KnowledgePointDraft,
  OutlineChapter,
} from './types'

export type GenerateKnowledgePointsForChapterOptions = {
  plugin: YoloPlugin
  modelId?: string
  chapterIndex: number
  projectTopic: string
  chapterTitle: string
  chapterContract: string
  level: string
  workspaceScope?: AssistantWorkspaceScope
  referenceDir?: string
  abortSignal?: AbortSignal
  activity?: AgentRunActivity
  onProgress?: (delta: string, fullText: string) => void
  onKnowledgePointTitle?: (title: string) => void | Promise<void>
  onKnowledgePoint?: (point: KnowledgePointDraft) => void | Promise<void>
}

export async function generateKnowledgePointsForChapter({
  plugin,
  modelId,
  chapterIndex,
  projectTopic,
  chapterTitle,
  chapterContract,
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
  debugData: ChapterDebugData
}> {
  let accumulated = ''
  let completedText = ''
  let titledCount = 0
  let emittedCount = 0
  const debug = new PhaseDebugCollector()

  const emitNewKnowledgePointTitles = async (titles: string[]) => {
    if (!onKnowledgePointTitle) return
    for (const title of titles.slice(titledCount)) {
      await onKnowledgePointTitle(title)
      titledCount += 1
    }
  }

  const emitNewKnowledgePoints = async (points: KnowledgePointDraft[]) => {
    if (!onKnowledgePoint) return
    for (const point of points.slice(emittedCount)) {
      await onKnowledgePoint(point)
      emittedCount += 1
    }
  }

  const stream = plugin.agent.stream({
    prompt: buildKnowledgePointPrompt({
      projectTopic,
      chapterTitle,
      chapterContract,
      level,
      referenceDir,
    }),
    modelId,
    mode: 'agent',
    yolo: true,
    systemPromptOverride:
      buildLanguageDirective(plugin.settings?.learningOptions?.outputLanguage) +
      KNOWLEDGE_POINT_GENERATOR_PROMPT +
      buildLanguageReminder(plugin.settings?.learningOptions?.outputLanguage),
    tools: {
      allowedToolNames: workspaceScope?.enabled
        ? LEARNING_READONLY_TOOL_NAMES
        : [],
    },
    workspaceScope,
    activity,
    abortSignal,
  })

  for await (const event of stream) {
    if (event.type === 'text') {
      accumulated = event.text || accumulated + event.delta
      onProgress?.(event.delta, accumulated)
      await emitNewKnowledgePointTitles(parseKnowledgePointTitles(accumulated))
      await emitNewKnowledgePoints(
        parseCompletedKnowledgePointDrafts(accumulated),
      )
    }
    if (event.type === 'tool') {
      debug.recordToolCall(event)
    }
    if (event.type === 'completed') {
      completedText = event.text
    }
    if (event.type === 'error') {
      throw new Error(event.message)
    }
  }

  const drafts = parseKnowledgePointDrafts(completedText || accumulated)
  await emitNewKnowledgePointTitles(drafts.map((draft) => draft.title))
  await emitNewKnowledgePoints(drafts)

  const finalText = completedText || accumulated
  const collected = debug.finalize()
  return {
    drafts,
    debugData: {
      chapterIndex,
      chapterTitle,
      startedAt: collected.startedAt,
      completedAt: collected.completedAt,
      toolCalls: collected.toolCalls,
      outputLength: finalText.length,
      output: finalText,
      count: drafts.length,
    },
  }
}

export type GenerateKnowledgePointsParallelOptions = {
  plugin: YoloPlugin
  modelId?: string
  projectTopic: string
  chapters: OutlineChapter[]
  level: string
  workspaceScope?: AssistantWorkspaceScope
  referenceDir?: string
  abortSignal?: AbortSignal
  onChapterProgress?: (progress: GenerationProgress) => void
}

export async function generateKnowledgePointsParallel({
  plugin,
  modelId,
  projectTopic,
  chapters,
  level,
  workspaceScope,
  referenceDir,
  abortSignal,
  onChapterProgress,
}: GenerateKnowledgePointsParallelOptions): Promise<ChapterGenerationResult[]> {
  const tasks = chapters.map(async (chapter, index) => {
    const chapterIndex = index
    onChapterProgress?.({
      chapterIndex,
      chapterTitle: chapter.title,
      status: 'generating',
    })
    try {
      const { drafts } = await generateKnowledgePointsForChapter({
        plugin,
        modelId,
        chapterIndex,
        projectTopic,
        chapterTitle: chapter.title,
        chapterContract: chapter.contract,
        level,
        workspaceScope,
        referenceDir,
        abortSignal,
        onProgress: (_delta, fullText) => {
          onChapterProgress?.({
            chapterIndex,
            chapterTitle: chapter.title,
            status: 'generating',
            currentKnowledgePointTitle: getLatestHeading(fullText),
          })
        },
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
  })

  return Promise.all(tasks)
}

function buildKnowledgePointPrompt({
  projectTopic,
  chapterTitle,
  chapterContract,
  level,
  referenceDir,
}: {
  projectTopic: string
  chapterTitle: string
  chapterContract: string
  level: string
  referenceDir?: string
}): string {
  const refSection = referenceDir
    ? `\n参考资料目录：${referenceDir}（如契约中注明了参考文件，用 fs_read 读取对应路径）`
    : ''

  return `请为以下章节生成知识点：

项目主题：${projectTopic}
章节标题：${chapterTitle}
章节契约：
${chapterContract}

用户当前水平：${level}${refSection}`
}

function parseKnowledgePointDrafts(markdown: string): KnowledgePointDraft[] {
  return scanMarkdownEntries(markdown)
    .filter((entry) => entry.title.trim().length > 0)
    .map((entry) => ({
      title: entry.title.trim(),
      body: entry.body.trim(),
    }))
}

function parseCompletedKnowledgePointDrafts(
  markdown: string,
): KnowledgePointDraft[] {
  const entries = scanMarkdownEntries(markdown).filter(
    (entry) => entry.title.trim().length > 0,
  )
  if (entries.length <= 1) return []
  return entries.slice(0, -1).map((entry) => ({
    title: entry.title.trim(),
    body: entry.body.trim(),
  }))
}

function parseKnowledgePointTitles(markdown: string): string[] {
  return [...markdown.matchAll(/^##[ \t]+([^\r\n]+)\r?\n/gm)]
    .map((match) => match[1]?.trim() ?? '')
    .filter((title) => title.length > 0)
}

function getLatestHeading(markdown: string): string | undefined {
  const entries = scanMarkdownEntries(markdown)
  return entries.at(-1)?.title
}
