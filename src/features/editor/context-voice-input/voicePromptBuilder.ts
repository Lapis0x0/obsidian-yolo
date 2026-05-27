import {
  type ContextVoiceInputOptions,
  DEFAULT_VOICE_INPUT_SYSTEM_PROMPT,
  VOICE_POLISH_PROMPT_PRESETS,
} from '../../../settings/schema/setting.types'
import type { RequestMessage } from '../../../types/llm/request'

export type VoiceInputTarget = {
  fileTitle: string
  filePath: string
  before: string
  after: string
  selectionText: string
  hasSelection: boolean
}

export type BuildVoicePromptInput = {
  options: ContextVoiceInputOptions
  target: VoiceInputTarget
  asrTranscript: string
  previousModelOutput?: string
}

/**
 * Split a combined context budget into a before/after window. We bias toward
 * the text BEFORE the cursor (where the user is writing) at roughly 4:1, so
 * polish has enough preceding context to match tone, list continuation and
 * existing terminology, while still seeing a useful sample of the suffix to
 * avoid duplicating the next paragraph.
 */
export function splitContextWindow(target: {
  before: string
  after: string
  totalBudget: number
  maxAfterBudget: number
}): { before: string; after: string } {
  const budget = Math.max(0, target.totalBudget)
  const maxAfter = Math.min(
    Math.max(0, target.maxAfterBudget),
    Math.floor(budget / 5) + Math.max(0, target.maxAfterBudget),
  )
  // Bias 4:1 before:after, but cap the after by `maxAfterBudget`.
  const desiredAfter = Math.min(maxAfter, Math.floor(budget / 5))
  const afterSlice = target.after.slice(0, desiredAfter)
  const beforeBudget = Math.max(0, budget - afterSlice.length)
  const beforeSlice =
    target.before.length > beforeBudget
      ? target.before.slice(target.before.length - beforeBudget)
      : target.before
  return { before: beforeSlice, after: afterSlice }
}

const renderTargetBlock = (target: VoiceInputTarget): string => {
  const meta = [
    target.fileTitle ? `file_title: ${target.fileTitle}` : null,
    target.filePath ? `file_path: ${target.filePath}` : null,
    `has_selection: ${target.hasSelection ? 'true' : 'false'}`,
  ]
    .filter(Boolean)
    .join('\n')
  return `<target_metadata>\n${meta}\n</target_metadata>`
}

export function buildVoiceInputMessages(
  input: BuildVoicePromptInput,
): RequestMessage[] {
  const { options, target, asrTranscript, previousModelOutput } = input
  // Built-in preset → use the canned prompt. Custom → use the user textarea
  // when non-empty, otherwise fall back to the default preset.
  const systemPromptBody = (() => {
    const mode = options.systemPromptMode
    if (mode === 'custom') {
      return options.customSystemPrompt.trim().length > 0
        ? options.customSystemPrompt
        : DEFAULT_VOICE_INPUT_SYSTEM_PROMPT
    }
    return (
      VOICE_POLISH_PROMPT_PRESETS[mode] ?? DEFAULT_VOICE_INPUT_SYSTEM_PROMPT
    )
  })()

  const { before, after } = splitContextWindow({
    before: target.before,
    after: target.after,
    totalBudget: options.contextRangeChars,
    maxAfterBudget: options.maxAfterContextChars,
  })

  const sections: string[] = [renderTargetBlock(target)]
  if (before.length > 0) {
    sections.push(`<cursor_before>\n${before}\n</cursor_before>`)
  }
  if (after.length > 0) {
    sections.push(`<cursor_after>\n${after}\n</cursor_after>`)
  }
  if (target.hasSelection && target.selectionText.length > 0) {
    sections.push(
      `<current_selection>\n${target.selectionText}\n</current_selection>`,
    )
  }
  if (previousModelOutput && previousModelOutput.trim().length > 0) {
    sections.push(
      '<uncommitted_draft_instruction>\n' +
        'The previous_model_output is polished text that is still only a ' +
        'preview, not editor content. Combine it with current_asr_final and ' +
        'emit the complete draft that should be inserted if accepted.\n' +
        '</uncommitted_draft_instruction>',
    )
    sections.push(
      `<previous_model_output>\n${previousModelOutput}\n</previous_model_output>`,
    )
  }
  sections.push(`<current_asr_final>\n${asrTranscript}\n</current_asr_final>`)

  const userContent = sections.join('\n\n')

  return [
    { role: 'system', content: systemPromptBody },
    { role: 'user', content: userContent },
  ]
}
