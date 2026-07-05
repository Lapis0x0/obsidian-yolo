import type YoloPlugin from '../../../main'
import type { AgentRunActivity } from '../../agent/service'

import { OUTLINE_GENERATOR_PROMPT } from './prompts'
import type { Outline, OutlineChapter } from './types'

export type GenerateOutlineOptions = {
  plugin: YoloPlugin
  topic: string
  level: string
  goal: string
  referencesBlock?: string
  abortSignal?: AbortSignal
  activity?: AgentRunActivity
  onProgress?: (delta: string, fullText: string) => void
  onOutline?: (outline: Outline) => void
}

export async function generateOutline({
  plugin,
  topic,
  level,
  goal,
  referencesBlock,
  abortSignal,
  activity,
  onProgress,
  onOutline,
}: GenerateOutlineOptions): Promise<{ outline: Outline }> {
  let accumulated = ''
  let completedText = ''
  let streamedOutline: Outline = {
    projectName: '',
    chapters: [],
    estimatedKnowledgePoints: 0,
  }

  const stream = plugin.agent.stream({
    prompt: buildOutlinePrompt({ topic, level, goal, referencesBlock }),
    mode: 'agent',
    systemPromptOverride: OUTLINE_GENERATOR_PROMPT,
    tools: { allowedToolNames: [] },
    activity,
    abortSignal,
  })

  for await (const event of stream) {
    if (event.type === 'text') {
      accumulated = event.text || accumulated + event.delta
      onProgress?.(event.delta, accumulated)
      const outline = parsePartialOutline(accumulated)
      if (!isOutlineEqual(outline, streamedOutline)) {
        streamedOutline = outline
        onOutline?.(outline)
      }
    }
    if (event.type === 'completed') {
      completedText = event.text
    }
    if (event.type === 'error') {
      throw new Error(event.message)
    }
  }

  const outline = parseOutline(completedText || accumulated)
  if (!isOutlineEqual(outline, streamedOutline)) {
    onOutline?.(outline)
  }
  return { outline }
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

function parseOutline(text: string): Outline {
  const parsed = parseJsonObject(text)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('大纲生成结果不是 JSON 对象')
  }

  const record = parsed as Record<string, unknown>
  const projectName =
    typeof record.projectName === 'string' ? record.projectName.trim() : ''
  const chapters = parseChapters(record.chapters)
  const estimatedKnowledgePoints =
    typeof record.estimatedKnowledgePoints === 'number'
      ? record.estimatedKnowledgePoints
      : 0

  if (!projectName) {
    throw new Error('大纲生成结果缺少 projectName')
  }
  if (chapters.length === 0) {
    throw new Error('大纲生成结果中没有可用章节')
  }

  return { projectName, chapters, estimatedKnowledgePoints }
}

function parsePartialOutline(text: string): Outline {
  const projectName = extractStringField(text, 'projectName')
  const chapters = extractChapters(text)
  const estimatedMatch = text.match(/"estimatedKnowledgePoints"\s*:\s*(\d+)/)
  const estimatedKnowledgePoints = estimatedMatch
    ? Number(estimatedMatch[1])
    : 0
  return { projectName, chapters, estimatedKnowledgePoints }
}

function extractStringField(text: string, field: string): string {
  const match = text.match(
    new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`),
  )
  if (!match) return ''
  try {
    return JSON.parse(`"${match[1]}"`).trim()
  } catch {
    return match[1].trim()
  }
}

function extractChapters(text: string): OutlineChapter[] {
  const arrayStart = text.indexOf('"chapters"')
  if (arrayStart === -1) return []
  const bracketStart = text.indexOf('[', arrayStart)
  if (bracketStart === -1) return []

  const chapters: OutlineChapter[] = []
  let objectStart = -1
  let objectDepth = 0
  let inString = false
  let escaped = false

  for (let i = bracketStart + 1; i < text.length; i += 1) {
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

function parseChapters(value: unknown): OutlineChapter[] {
  if (!Array.isArray(value)) return []
  const chapters: OutlineChapter[] = []
  for (const item of value) {
    if (!isOutlineChapter(item)) continue
    chapters.push({
      title: item.title.trim(),
      contract: item.contract.trim(),
    })
  }
  return chapters
}

function isOutlineEqual(a: Outline, b: Outline): boolean {
  if (a.projectName !== b.projectName) return false
  if (a.estimatedKnowledgePoints !== b.estimatedKnowledgePoints) return false
  if (a.chapters.length !== b.chapters.length) return false
  return a.chapters.every(
    (chapter, index) =>
      chapter.title === b.chapters[index]?.title &&
      chapter.contract === b.chapters[index]?.contract,
  )
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('无法解析大纲 JSON')
    return JSON.parse(match[0])
  }
}

function isOutlineChapter(value: unknown): value is OutlineChapter {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.title === 'string' && typeof record.contract === 'string'
}
