export const CLAUDE_ASK_USER_QUESTION_TOOL = 'AskUserQuestion'

const YOLO_OTHER_OPTION_ID = '__other__'

type InputType = 'free_text' | 'single_select' | 'multi_select'

type NativeQuestionMapping = {
  uiId: string
  nativeKey: string
  inputType: InputType
  optionIds: Set<string>
  yoloQuestion: {
    id: string
    prompt: string
    inputType: InputType
    options?: Array<{ id: string; label: string }>
  }
}

export type ClaudeQuestionAnswerMap = Record<string, string | string[]>

export type ClaudeAnswerConversion =
  | { ok: true; answers: ClaudeQuestionAnswerMap }
  | { ok: false; error: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const getNonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null

const parseOption = (value: unknown): { id: string; label: string } | null => {
  if (typeof value === 'string' && value.trim()) {
    return { id: value, label: value }
  }
  if (!isRecord(value)) return null

  const label =
    getNonEmptyString(value.label) ??
    getNonEmptyString(value.value) ??
    getNonEmptyString(value.text)
  if (!label) return null
  const id =
    getNonEmptyString(value.value) ?? getNonEmptyString(value.id) ?? label
  return { id, label }
}

const resolveInputType = (
  question: Record<string, unknown>,
  optionCount: number,
): InputType => {
  if (
    question.inputType === 'free_text' ||
    question.inputType === 'single_select' ||
    question.inputType === 'multi_select'
  ) {
    return question.inputType
  }
  if (optionCount === 0) return 'free_text'
  return question.multiSelect === true ? 'multi_select' : 'single_select'
}

const buildQuestionMappings = (
  input: Record<string, unknown>,
): NativeQuestionMapping[] | null => {
  if (!Array.isArray(input.questions) || input.questions.length === 0) {
    return null
  }

  const mappings: NativeQuestionMapping[] = []
  const nativeKeys = new Set<string>()
  for (const rawQuestion of input.questions) {
    if (!isRecord(rawQuestion)) return null
    const prompt =
      getNonEmptyString(rawQuestion.question) ??
      getNonEmptyString(rawQuestion.prompt)
    if (!prompt) return null
    const nativeKey = getNonEmptyString(rawQuestion.id) ?? prompt
    if (nativeKeys.has(nativeKey)) return null
    nativeKeys.add(nativeKey)

    const rawOptions = Array.isArray(rawQuestion.options)
      ? rawQuestion.options
      : []
    const options = rawOptions.map(parseOption)
    if (options.some((option) => option === null)) return null
    const concreteOptions = options.filter(
      (option): option is { id: string; label: string } => option !== null,
    )
    const optionIds = new Set(concreteOptions.map((option) => option.id))
    if (optionIds.size !== concreteOptions.length) return null

    const inputType = resolveInputType(rawQuestion, concreteOptions.length)
    if (inputType !== 'free_text' && concreteOptions.length < 2) {
      return null
    }
    mappings.push({
      uiId: nativeKey,
      nativeKey,
      inputType,
      optionIds,
      yoloQuestion: {
        id: nativeKey,
        prompt,
        inputType,
        ...(inputType === 'free_text' ? {} : { options: concreteOptions }),
      },
    })
  }
  return mappings
}

export const mapClaudeAskUserQuestionInput = (
  input: Record<string, unknown>,
): Record<string, unknown> | null => {
  const mappings = buildQuestionMappings(input)
  if (!mappings) return null
  return { questions: mappings.map((mapping) => mapping.yoloQuestion) }
}

const parseAnswerValue = ({
  answer,
  mapping,
}: {
  answer: Record<string, unknown>
  mapping: NativeQuestionMapping
}): string | string[] | null => {
  if (answer.inputType !== mapping.inputType) return null
  const otherText =
    typeof answer.otherText === 'string' ? answer.otherText.trim() : ''

  if (mapping.inputType === 'free_text') {
    return typeof answer.value === 'string' ? answer.value : null
  }
  if (mapping.inputType === 'single_select') {
    if (typeof answer.value !== 'string') return null
    if (answer.value === YOLO_OTHER_OPTION_ID) return otherText || null
    return mapping.optionIds.has(answer.value) ? answer.value : null
  }
  if (
    !Array.isArray(answer.value) ||
    !answer.value.every((value): value is string => typeof value === 'string')
  ) {
    return null
  }

  const values: string[] = []
  for (const value of answer.value) {
    if (value === YOLO_OTHER_OPTION_ID) {
      if (!otherText) return null
      values.push(otherText)
    } else if (mapping.optionIds.has(value)) {
      values.push(value)
    } else {
      return null
    }
  }
  if (otherText && !answer.value.includes(YOLO_OTHER_OPTION_ID)) {
    values.push(otherText)
  }
  return values.length > 0 ? values : null
}

export const convertYoloAnswerPayloadToClaude = ({
  payload,
  nativeInput,
}: {
  payload: unknown
  nativeInput: Record<string, unknown>
}): ClaudeAnswerConversion => {
  const mappings = buildQuestionMappings(nativeInput)
  if (!mappings) {
    return { ok: false, error: 'Claude question input is invalid.' }
  }
  if (
    !isRecord(payload) ||
    payload.type !== 'user_answers' ||
    !Array.isArray(payload.answers)
  ) {
    return { ok: false, error: 'Question response payload is invalid.' }
  }

  const answersById = new Map<string, Record<string, unknown>>()
  for (const rawAnswer of payload.answers) {
    if (!isRecord(rawAnswer) || typeof rawAnswer.id !== 'string') {
      return {
        ok: false,
        error: 'Question response contains an invalid answer.',
      }
    }
    if (answersById.has(rawAnswer.id)) {
      return {
        ok: false,
        error: `Question "${rawAnswer.id}" was answered twice.`,
      }
    }
    answersById.set(rawAnswer.id, rawAnswer)
  }

  const answers: ClaudeQuestionAnswerMap = {}
  for (const mapping of mappings) {
    const answer = answersById.get(mapping.uiId)
    if (!answer) {
      return { ok: false, error: `Question "${mapping.uiId}" has no answer.` }
    }
    const value = parseAnswerValue({ answer, mapping })
    if (value === null) {
      return {
        ok: false,
        error: `Question "${mapping.uiId}" has an invalid answer.`,
      }
    }
    answers[mapping.nativeKey] = value
  }
  if (answersById.size !== mappings.length) {
    return { ok: false, error: 'Question response contains an unknown answer.' }
  }
  return { ok: true, answers }
}
