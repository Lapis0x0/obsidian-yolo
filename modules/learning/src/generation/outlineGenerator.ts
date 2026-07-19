import { LearningGenerationAbortError } from './abortError'
import { PhaseDebugCollector, emitPhaseDebugLog } from './debugLog'
import type {
  LearningGenerationActivity,
  LearningGenerationHost,
  LearningWorkspaceScope,
} from './host'
import { OUTLINE_GENERATOR_PROMPT } from './prompts'
import type { Outline, OutlineChapter } from './types'

export type GenerateOutlineOptions = {
  host: LearningGenerationHost
  modelId?: string
  topic: string
  level: string
  goal: string
  referencesBlock?: string
  referenceFiles?: { name: string; vaultPath: string }[]
  workspaceScope?: LearningWorkspaceScope
  abortSignal?: AbortSignal
  activity?: LearningGenerationActivity
  onProgress?: (delta: string, fullText: string) => void
  onOutline?: (outline: Outline) => void
}

export async function generateOutline({
  host,
  modelId,
  topic,
  level,
  goal,
  referencesBlock,
  referenceFiles,
  workspaceScope,
  abortSignal,
  activity,
  onProgress,
  onOutline,
}: GenerateOutlineOptions): Promise<{ outline: Outline }> {
  let accumulated = ''
  let completedText = ''
  let streamedOutline: Outline = {
    projectName: '',
    projectGoal: '',
    chapters: [],
    estimatedKnowledgePoints: 0,
  }
  const debug = new PhaseDebugCollector()
  const refSection = referenceFiles?.length
    ? `\n参考资料（请用 fs_read 读取以下文件，路径已给出）：\n${referenceFiles.map((file) => `- ${file.name}（路径：${file.vaultPath}）`).join('\n')}`
    : ''
  const prompt = `请为以下学习需求生成大纲：

主题：${topic}
当前水平：${level}
学习目标：${goal}
${referencesBlock?.trim() ? `\n${referencesBlock.trim()}` : ''}${refSection}`.trim()
  for await (const event of host.agent.stream({
    prompt,
    modelId,
    systemPromptOverride: OUTLINE_GENERATOR_PROMPT,
    capability: workspaceScope?.enabled ? 'readonly-vault' : 'none',
    workspaceScope,
    activity,
    abortSignal,
  })) {
    if (event.type === 'text') {
      accumulated = event.text || accumulated + event.delta
      onProgress?.(event.delta, accumulated)
      const outline = parsePartialOutline(accumulated)
      if (!isOutlineEqual(outline, streamedOutline)) {
        streamedOutline = outline
        onOutline?.(outline)
      }
    }
    if (event.type === 'tool') debug.recordToolCall(event)
    if (event.type === 'completed') completedText = event.text
    if (event.type === 'aborted') {
      throw new LearningGenerationAbortError('Outline generation aborted')
    }
    if (event.type === 'error') throw new Error(event.message)
  }
  const finalText = completedText || accumulated
  if (!abortSignal?.aborted) {
    const collected = debug.finalize()
    emitPhaseDebugLog(host, {
      label: 'outline-generator',
      ...collected,
      outputLength: finalText.length,
      output: finalText,
      meta: {
        topic: `"${topic}"`,
        level,
        ...(referenceFiles?.length
          ? {
              references: `[${referenceFiles.map((file) => file.name).join(', ')}]`,
            }
          : {}),
      },
    })
  }
  const outline = parseOutline(finalText)
  if (!isOutlineEqual(outline, streamedOutline)) onOutline?.(outline)
  return { outline }
}

function parseOutline(text: string): Outline {
  const parsed = parseJsonObject(text)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Outline generation result is not a JSON object')
  }
  const record = parsed as Record<string, unknown>
  const projectName =
    typeof record.projectName === 'string' ? record.projectName.trim() : ''
  const projectGoal =
    typeof record.projectGoal === 'string' ? record.projectGoal.trim() : ''
  const chapters = parseChapters(record.chapters)
  const estimatedKnowledgePoints =
    typeof record.estimatedKnowledgePoints === 'number'
      ? record.estimatedKnowledgePoints
      : 0
  if (!projectName) {
    throw new Error('Outline generation result is missing projectName')
  }
  if (!projectGoal) {
    throw new Error('Outline generation result is missing projectGoal')
  }
  if (chapters.length === 0) {
    throw new Error('Outline generation result has no usable chapters')
  }
  return { projectName, projectGoal, chapters, estimatedKnowledgePoints }
}

function parsePartialOutline(text: string): Outline {
  const match = text.match(/"estimatedKnowledgePoints"\s*:\s*(\d+)/)
  return {
    projectName: extractStringField(text, 'projectName'),
    projectGoal: extractStringField(text, 'projectGoal'),
    chapters: extractChapters(text),
    estimatedKnowledgePoints: match ? Number(match[1]) : 0,
  }
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
  const fieldStart = text.indexOf('"chapters"')
  const arrayStart = fieldStart === -1 ? -1 : text.indexOf('[', fieldStart)
  if (arrayStart === -1) return []
  const chapters: OutlineChapter[] = []
  let objectStart = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = arrayStart + 1; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') {
      if (depth === 0) objectStart = i
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0 && objectStart !== -1) {
        try {
          const parsed: unknown = JSON.parse(text.slice(objectStart, i + 1))
          if (isOutlineChapter(parsed)) {
            chapters.push({
              title: parsed.title.trim(),
              contract: parsed.contract.trim(),
            })
          }
        } catch {
          // Ignore incomplete streamed objects.
        }
        objectStart = -1
      }
    }
  }
  return chapters
}

function parseChapters(value: unknown): OutlineChapter[] {
  if (!Array.isArray(value)) return []
  return value.filter(isOutlineChapter).map((chapter) => ({
    title: chapter.title.trim(),
    contract: chapter.contract.trim(),
  }))
}

function isOutlineEqual(a: Outline, b: Outline): boolean {
  return (
    a.projectName === b.projectName &&
    a.projectGoal === b.projectGoal &&
    a.estimatedKnowledgePoints === b.estimatedKnowledgePoints &&
    a.chapters.length === b.chapters.length &&
    a.chapters.every(
      (chapter, index) =>
        chapter.title === b.chapters[index]?.title &&
        chapter.contract === b.chapters[index]?.contract,
    )
  )
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) {
      throw new Error(
        `无法解析大纲 JSON（未找到 JSON 对象）。原始文本前 500 字符：\n${text.slice(0, 500)}`,
      )
    }
    try {
      return JSON.parse(match[0])
    } catch (error) {
      throw new Error(
        `无法解析大纲 JSON：${error instanceof Error ? error.message : String(error)}。提取的 JSON 片段前 500 字符：\n${match[0].slice(0, 500)}`,
      )
    }
  }
}

function isOutlineChapter(value: unknown): value is OutlineChapter {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.title === 'string' && typeof record.contract === 'string'
}
