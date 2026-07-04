import type YoloPlugin from '../../../main'

import { OUTLINE_GENERATOR_PROMPT } from './prompts'
import type { OutlineChapter } from './types'

export type GenerateOutlineOptions = {
  plugin: YoloPlugin
  topic: string
  level: string
  goal: string
  referencesBlock?: string
  abortSignal?: AbortSignal
  onProgress?: (delta: string, fullText: string) => void
  onChapters?: (chapters: OutlineChapter[]) => void
}

export async function generateOutline({
  plugin,
  topic,
  level,
  goal,
  referencesBlock,
  abortSignal,
  onProgress,
  onChapters,
}: GenerateOutlineOptions): Promise<{ chapters: OutlineChapter[] }> {
  let accumulated = ''
  let completedText = ''
  let streamedChapters: OutlineChapter[] = []

  const stream = plugin.agent.stream({
    prompt: buildOutlinePrompt({ topic, level, goal, referencesBlock }),
    mode: 'agent',
    systemPromptOverride: OUTLINE_GENERATOR_PROMPT,
    tools: { allowedToolNames: [] },
    abortSignal,
  })

  for await (const event of stream) {
    if (event.type === 'text') {
      accumulated = event.text || accumulated + event.delta
      onProgress?.(event.delta, accumulated)
      const chapters = parseCompletedOutlineChapters(accumulated)
      if (!areOutlineChaptersEqual(chapters, streamedChapters)) {
        streamedChapters = chapters
        onChapters?.(chapters)
      }
    }
    if (event.type === 'completed') {
      completedText = event.text
    }
    if (event.type === 'error') {
      throw new Error(event.message)
    }
  }

  const chapters = parseOutlineChapters(completedText || accumulated)
  if (!areOutlineChaptersEqual(chapters, streamedChapters)) {
    onChapters?.(chapters)
  }
  return { chapters }
}

function buildOutlinePrompt({
  topic,
  level,
  goal,
  referencesBlock,
}: {
  topic: string
  level: string
  goal: string
  referencesBlock?: string
}): string {
  return `请为以下学习需求生成大纲：

主题：${topic}
当前水平：${level}
学习目标：${goal}

${referencesBlock?.trim() ?? ''}`.trim()
}

function parseOutlineChapters(text: string): OutlineChapter[] {
  const parsed = parseJsonArray(text)
  if (!Array.isArray(parsed)) {
    throw new Error('大纲生成结果不是 JSON 数组')
  }

  const chapters: OutlineChapter[] = []
  for (const item of parsed) {
    if (!isOutlineChapter(item)) continue
    chapters.push({
      title: item.title.trim(),
      contract: item.contract.trim(),
    })
  }

  if (chapters.length === 0) {
    throw new Error('大纲生成结果中没有可用章节')
  }
  return chapters
}

function parseCompletedOutlineChapters(text: string): OutlineChapter[] {
  const arrayStart = text.indexOf('[')
  if (arrayStart === -1) return []

  const chapters: OutlineChapter[] = []
  let objectStart = -1
  let objectDepth = 0
  let inString = false
  let escaped = false

  for (let i = arrayStart + 1; i < text.length; i += 1) {
    const char = text[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') {
      if (objectDepth === 0) objectStart = i
      objectDepth += 1
      continue
    }

    if (char !== '}') continue

    objectDepth -= 1
    if (objectDepth !== 0 || objectStart === -1) continue

    try {
      const parsed = JSON.parse(text.slice(objectStart, i + 1))
      if (isOutlineChapter(parsed)) {
        chapters.push({
          title: parsed.title.trim(),
          contract: parsed.contract.trim(),
        })
      }
    } catch {
      // The model can still be streaming escape sequences; ignore until complete.
    }
    objectStart = -1
  }

  return chapters
}

function areOutlineChaptersEqual(
  a: OutlineChapter[],
  b: OutlineChapter[],
): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (chapter, index) =>
      chapter.title === b[index]?.title &&
      chapter.contract === b[index]?.contract,
  )
}

function parseJsonArray(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\[[\s\S]*\]/)
    if (!match) throw new Error('无法解析大纲 JSON')
    return JSON.parse(match[0])
  }
}

function isOutlineChapter(value: unknown): value is OutlineChapter {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.title === 'string' && typeof record.contract === 'string'
}
