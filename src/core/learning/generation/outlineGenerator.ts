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
}

export async function generateOutline({
  plugin,
  topic,
  level,
  goal,
  referencesBlock,
  abortSignal,
  onProgress,
}: GenerateOutlineOptions): Promise<{ chapters: OutlineChapter[] }> {
  let accumulated = ''
  let completedText = ''

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
    }
    if (event.type === 'completed') {
      completedText = event.text
    }
    if (event.type === 'error') {
      throw new Error(event.message)
    }
  }

  return { chapters: parseOutlineChapters(completedText || accumulated) }
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
