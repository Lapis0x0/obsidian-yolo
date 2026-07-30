import { Check, CornerDownLeft, MessageCircleQuestion, X } from 'lucide-react'
import { Notice } from 'obsidian'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import type {
  AnswerUserQuestionAnswer,
  AnswerUserQuestionPayload,
} from '../../core/agent/service'
import type {
  AskUserQuestionInputType,
  AskUserQuestionItem,
} from '../../core/mcp/localFileTools'
import {
  ASK_USER_QUESTION_OTHER_ID,
  validateAskUserQuestionArgs,
} from '../../core/mcp/localFileTools'
import { ChatMessage } from '../../types/chat'
import {
  ToolCallRequest,
  ToolCallResponse,
  ToolCallResponseStatus,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'

import { useChatRuntimeActions } from './chat-runtime-actions-context'
import { handleRuntimeQuestionResult } from './runtime-action-handlers'

type AskUserQuestionPanelProps = {
  request: ToolCallRequest
  response: ToolCallResponse
  conversationId: string
  onRecoverAnswerUserQuestion: (payload: {
    resolvedMessages: ChatMessage[]
    toolCallId: string
  }) => void
}

type AnswerState = {
  freeText: Record<string, string>
  singleSelect: Record<string, string>
  multiSelect: Record<string, string[]>
  /** Free-text the user typed for the auto-appended "Other" option, keyed by question id. */
  otherText: Record<string, string>
}

const buildInitialAnswers = (questions: AskUserQuestionItem[]): AnswerState => {
  const state: AnswerState = {
    freeText: {},
    singleSelect: {},
    multiSelect: {},
    otherText: {},
  }
  for (const question of questions) {
    if (question.inputType === 'free_text') {
      state.freeText[question.id] = ''
    } else if (question.inputType === 'single_select') {
      state.singleSelect[question.id] = ''
      state.otherText[question.id] = ''
    } else {
      state.multiSelect[question.id] = []
      state.otherText[question.id] = ''
    }
  }
  return state
}

const isComplete = (
  questions: AskUserQuestionItem[],
  answers: AnswerState,
): boolean => {
  for (const question of questions) {
    if (question.inputType === 'free_text') {
      // free_text is treated as optional — never blocks submission.
      continue
    }
    if (question.inputType === 'single_select') {
      const picked = answers.singleSelect[question.id]
      if (!picked) return false
      if (
        picked === ASK_USER_QUESTION_OTHER_ID &&
        (answers.otherText[question.id] ?? '').trim() === ''
      ) {
        return false
      }
    } else {
      const picked = answers.multiSelect[question.id] ?? []
      if (picked.length === 0) return false
      if (
        picked.includes(ASK_USER_QUESTION_OTHER_ID) &&
        (answers.otherText[question.id] ?? '').trim() === ''
      ) {
        return false
      }
    }
  }
  return true
}

const parseSubmittedAnswers = (
  text: string,
): AnswerUserQuestionPayload | null => {
  try {
    const parsed: unknown = JSON.parse(text)
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as { type?: unknown }).type !== 'user_answers' ||
      !Array.isArray((parsed as { answers?: unknown }).answers)
    ) {
      return null
    }
    return parsed as AnswerUserQuestionPayload
  } catch {
    return null
  }
}

export function AskUserQuestionPanel({
  request,
  response,
  conversationId,
  onRecoverAnswerUserQuestion,
}: AskUserQuestionPanelProps) {
  const { t } = useLanguage()
  const { actions, conversation } = useChatRuntimeActions(conversationId)

  const parsedQuestions = useMemo<AskUserQuestionItem[] | null>(() => {
    const args = getToolCallArgumentsObject(request.arguments)
    if (!args) return null
    const validation = validateAskUserQuestionArgs(args)
    return validation.ok ? validation.value.questions : null
  }, [request.arguments])

  const [answers, setAnswers] = useState<AnswerState>(() =>
    parsedQuestions
      ? buildInitialAnswers(parsedQuestions)
      : {
          freeText: {},
          singleSelect: {},
          multiSelect: {},
          otherText: {},
        },
  )
  const [submitting, setSubmitting] = useState(false)

  // Reset local state if the panel is keyed to a different tool call but
  // somehow reuses this instance (defensive).
  useEffect(() => {
    if (parsedQuestions) {
      setAnswers(buildInitialAnswers(parsedQuestions))
    }
  }, [parsedQuestions])

  const handleSubmit = useCallback(async () => {
    if (!parsedQuestions || submitting) return
    if (!isComplete(parsedQuestions, answers)) return

    const payload: AnswerUserQuestionPayload = {
      type: 'user_answers',
      answers: parsedQuestions.map<AnswerUserQuestionAnswer>((question) => {
        if (question.inputType === 'free_text') {
          return {
            id: question.id,
            question: question.prompt,
            inputType: 'free_text',
            value: answers.freeText[question.id] ?? '',
          }
        }
        const otherText = (answers.otherText[question.id] ?? '').trim()
        if (question.inputType === 'single_select') {
          const value = answers.singleSelect[question.id] ?? ''
          const includesOther = value === ASK_USER_QUESTION_OTHER_ID
          return {
            id: question.id,
            question: question.prompt,
            inputType: 'single_select',
            value,
            ...(includesOther && otherText ? { otherText } : {}),
          }
        }
        const value = [...(answers.multiSelect[question.id] ?? [])]
        const includesOther = value.includes(ASK_USER_QUESTION_OTHER_ID)
        return {
          id: question.id,
          question: question.prompt,
          inputType: 'multi_select',
          value,
          ...(includesOther && otherText ? { otherText } : {}),
        }
      }),
    }

    setSubmitting(true)
    try {
      const result = await actions.answerQuestion({
        conversation,
        toolCallId: request.id,
        payload,
      })
      handleRuntimeQuestionResult({
        result,
        onRecovery: (resolvedMessages) =>
          onRecoverAnswerUserQuestion({
            resolvedMessages,
            toolCallId: request.id,
          }),
        onStale: () =>
          new Notice(
            t(
              'chat.askUserQuestion.stale',
              '该提问已过期或已被处理，无法再次提交。',
            ),
          ),
      })
    } finally {
      setSubmitting(false)
    }
  }, [
    actions,
    answers,
    conversation,
    onRecoverAnswerUserQuestion,
    parsedQuestions,
    request.id,
    submitting,
    t,
  ])

  if (response.status === ToolCallResponseStatus.Rejected) {
    return (
      <PanelShell variant="rejected" titleKey="title" t={t}>
        <div className="yolo-ask-user-question-body">
          {t(
            'chat.askUserQuestion.rejected',
            '系统已拒绝该提问（仅允许每轮一次，或被禁用）。',
          )}
        </div>
      </PanelShell>
    )
  }

  if (response.status === ToolCallResponseStatus.Aborted) {
    return (
      <PanelShell variant="aborted" titleKey="title" t={t}>
        <div className="yolo-ask-user-question-body">
          {t('chat.askUserQuestion.aborted', '已被停止。')}
        </div>
      </PanelShell>
    )
  }

  if (response.status === ToolCallResponseStatus.Error) {
    return (
      <PanelShell variant="error" titleKey="title" t={t}>
        <div className="yolo-ask-user-question-body">
          {t(
            'chat.askUserQuestion.schemaError',
            '模型的提问参数不合法：{{error}}',
          ).replace('{{error}}', response.error)}
        </div>
      </PanelShell>
    )
  }

  // After terminal branches, the gateway invariants guarantee questions
  // parsed cleanly — otherwise the tool call would have been marked Error
  // before reaching AwaitingUserInput / Success.
  if (!parsedQuestions) {
    throw new Error(
      'ask_user_question: parsedQuestions is null in a non-terminal state — gateway invariant violated',
    )
  }

  if (response.status === ToolCallResponseStatus.Success) {
    const payload = parseSubmittedAnswers(response.data.text)
    return (
      <PanelShell variant="answered" titleKey="title" t={t}>
        <div className="yolo-ask-user-question-questions">
          {parsedQuestions.map((question) => {
            const answer = payload?.answers.find((a) => a.id === question.id)
            return (
              <div
                key={question.id}
                className="yolo-ask-user-question-item yolo-ask-user-question-item--answered"
              >
                <div className="yolo-ask-user-question-prompt">
                  <Check
                    size={12}
                    className="yolo-ask-user-question-answered-icon"
                  />
                  <span>{question.prompt}</span>
                </div>
                <div className="yolo-ask-user-question-answer">
                  {renderAnsweredValue(question, answer, t)}
                </div>
              </div>
            )
          })}
        </div>
        <div className="yolo-ask-user-question-footer-meta">
          {t('chat.askUserQuestion.answeredBadge', '已提交')}
        </div>
      </PanelShell>
    )
  }

  const handleCancel = () => {
    if (submitting) return
    void actions.cancelQuestion({ conversation, toolCallId: request.id })
  }

  // Pending (AwaitingUserInput) — interactive form.
  const complete = isComplete(parsedQuestions, answers)
  return (
    <PanelShell variant="pending" titleKey="title" t={t}>
      <div className="yolo-ask-user-question-questions">
        {parsedQuestions.map((question) => (
          <QuestionRow
            key={question.id}
            question={question}
            answers={answers}
            setAnswers={setAnswers}
            onSubmit={() => void handleSubmit()}
          />
        ))}
      </div>
      <div className="yolo-ask-user-question-footer">
        <span className="yolo-ask-user-question-footer-hint">
          {t('chat.askUserQuestion.submitHint', 'Cmd / Ctrl + Enter 提交')}
        </span>
        <div className="yolo-ask-user-question-footer-actions">
          <button
            type="button"
            className="yolo-ask-user-question-cancel"
            disabled={submitting}
            onClick={handleCancel}
            title={t(
              'chat.askUserQuestion.cancelTooltip',
              '取消本轮提问并结束当前回合',
            )}
          >
            <X size={12} />
            <span>{t('chat.askUserQuestion.cancel', '取消')}</span>
          </button>
          <button
            type="button"
            className="yolo-ask-user-question-submit"
            disabled={!complete || submitting}
            onClick={() => void handleSubmit()}
          >
            <span>{t('chat.askUserQuestion.submit', '提交答案')}</span>
            <CornerDownLeft size={12} />
          </button>
        </div>
      </div>
    </PanelShell>
  )
}

function PanelShell({
  variant,
  titleKey,
  t,
  children,
}: {
  variant: 'pending' | 'answered' | 'error' | 'rejected' | 'aborted'
  titleKey: 'title'
  t: ReturnType<typeof useLanguage>['t']
  children: React.ReactNode
}) {
  return (
    <div
      className={`yolo-ask-user-question yolo-ask-user-question--${variant}`}
    >
      <div className="yolo-ask-user-question-header">
        <MessageCircleQuestion size={14} />
        <span>{t(`chat.askUserQuestion.${titleKey}`, '模型向你发起提问')}</span>
      </div>
      {children}
    </div>
  )
}

function QuestionRow({
  question,
  answers,
  setAnswers,
  onSubmit,
}: {
  question: AskUserQuestionItem
  answers: AnswerState
  setAnswers: React.Dispatch<React.SetStateAction<AnswerState>>
  onSubmit: () => void
}) {
  const { t } = useLanguage()
  const otherLabel = t('chat.askUserQuestion.otherOption', '其他（请说明）')
  const otherPlaceholder = t(
    'chat.askUserQuestion.otherPlaceholder',
    '请补充你的回答…',
  )

  const handleOtherTextChange = (next: string) => {
    setAnswers((prev) => ({
      ...prev,
      otherText: { ...prev.otherText, [question.id]: next },
    }))
  }

  const handleOtherKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (
    event,
  ) => {
    if (
      event.key === 'Enter' &&
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey
    ) {
      event.preventDefault()
      onSubmit()
    }
  }

  if (question.inputType === 'single_select') {
    const selected = answers.singleSelect[question.id] ?? ''
    const otherSelected = selected === ASK_USER_QUESTION_OTHER_ID
    return (
      <div className="yolo-ask-user-question-item">
        <div className="yolo-ask-user-question-prompt">{question.prompt}</div>
        <div className="yolo-ask-user-question-chips">
          {(question.options ?? []).map((option) => {
            const isSelected = selected === option.id
            return (
              <button
                key={option.id}
                type="button"
                className={`yolo-ask-user-question-chip${
                  isSelected ? ' yolo-ask-user-question-chip--selected' : ''
                }`}
                onClick={() =>
                  setAnswers((prev) => ({
                    ...prev,
                    singleSelect: {
                      ...prev.singleSelect,
                      [question.id]: option.id,
                    },
                  }))
                }
              >
                {option.label}
              </button>
            )
          })}
          <button
            key={ASK_USER_QUESTION_OTHER_ID}
            type="button"
            className={`yolo-ask-user-question-chip yolo-ask-user-question-chip--other${
              otherSelected ? ' yolo-ask-user-question-chip--selected' : ''
            }`}
            onClick={() =>
              setAnswers((prev) => ({
                ...prev,
                singleSelect: {
                  ...prev.singleSelect,
                  [question.id]: ASK_USER_QUESTION_OTHER_ID,
                },
              }))
            }
          >
            {otherLabel}
          </button>
        </div>
        {otherSelected && (
          <textarea
            className="yolo-ask-user-question-textarea yolo-ask-user-question-textarea--other"
            rows={2}
            placeholder={otherPlaceholder}
            value={answers.otherText[question.id] ?? ''}
            onChange={(event) => handleOtherTextChange(event.target.value)}
            onKeyDown={handleOtherKeyDown}
          />
        )}
      </div>
    )
  }

  if (question.inputType === 'multi_select') {
    const selected = answers.multiSelect[question.id] ?? []
    const otherSelected = selected.includes(ASK_USER_QUESTION_OTHER_ID)
    return (
      <div className="yolo-ask-user-question-item">
        <div className="yolo-ask-user-question-prompt">{question.prompt}</div>
        <div className="yolo-ask-user-question-checkboxes">
          {(question.options ?? []).map((option) => {
            const isSelected = selected.includes(option.id)
            return (
              <label
                key={option.id}
                className="yolo-ask-user-question-checkbox-label"
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={(event) => {
                    const checked = event.target.checked
                    setAnswers((prev) => {
                      const current = prev.multiSelect[question.id] ?? []
                      const next = checked
                        ? [...current, option.id]
                        : current.filter((id) => id !== option.id)
                      return {
                        ...prev,
                        multiSelect: {
                          ...prev.multiSelect,
                          [question.id]: next,
                        },
                      }
                    })
                  }}
                />
                <span>{option.label}</span>
              </label>
            )
          })}
          <label
            key={ASK_USER_QUESTION_OTHER_ID}
            className="yolo-ask-user-question-checkbox-label yolo-ask-user-question-checkbox-label--other"
          >
            <input
              type="checkbox"
              checked={otherSelected}
              onChange={(event) => {
                const checked = event.target.checked
                setAnswers((prev) => {
                  const current = prev.multiSelect[question.id] ?? []
                  const next = checked
                    ? [...current, ASK_USER_QUESTION_OTHER_ID]
                    : current.filter((id) => id !== ASK_USER_QUESTION_OTHER_ID)
                  return {
                    ...prev,
                    multiSelect: {
                      ...prev.multiSelect,
                      [question.id]: next,
                    },
                  }
                })
              }}
            />
            <span>{otherLabel}</span>
          </label>
        </div>
        {otherSelected && (
          <textarea
            className="yolo-ask-user-question-textarea yolo-ask-user-question-textarea--other"
            rows={2}
            placeholder={otherPlaceholder}
            value={answers.otherText[question.id] ?? ''}
            onChange={(event) => handleOtherTextChange(event.target.value)}
            onKeyDown={handleOtherKeyDown}
          />
        )}
      </div>
    )
  }

  // free_text (optional)
  const value = answers.freeText[question.id] ?? ''
  const optionalHint = t(
    'chat.askUserQuestion.freeTextOptional',
    '可选 · 留空将以空答案提交',
  )
  return (
    <div className="yolo-ask-user-question-item">
      <div className="yolo-ask-user-question-prompt">
        <span>{question.prompt}</span>
        <span className="yolo-ask-user-question-optional-hint">
          {optionalHint}
        </span>
      </div>
      <textarea
        className="yolo-ask-user-question-textarea"
        rows={3}
        value={value}
        onChange={(event) =>
          setAnswers((prev) => ({
            ...prev,
            freeText: {
              ...prev.freeText,
              [question.id]: event.target.value,
            },
          }))
        }
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey
          ) {
            event.preventDefault()
            onSubmit()
          }
        }}
      />
    </div>
  )
}

function renderAnsweredValue(
  question: AskUserQuestionItem,
  answer: AnswerUserQuestionAnswer | undefined,
  t: ReturnType<typeof useLanguage>['t'],
): string {
  if (!answer) return '—'
  const otherText = (answer.otherText ?? '').trim()
  const otherFallback = t('chat.askUserQuestion.otherAnswerFallback', '其他')
  const otherPrefix = t('chat.askUserQuestion.otherAnswerPrefix', '其他：')
  const labelForId = (id: string): string => {
    if (id === ASK_USER_QUESTION_OTHER_ID) {
      return otherText ? `${otherPrefix}${otherText}` : otherFallback
    }
    return question.options?.find((option) => option.id === id)?.label ?? id
  }
  if (question.inputType === 'single_select') {
    const id = typeof answer.value === 'string' ? answer.value : ''
    if (!id) return '—'
    return labelForId(id)
  }
  if (question.inputType === 'multi_select') {
    const ids: string[] = Array.isArray(answer.value) ? answer.value : []
    if (ids.length === 0) return '—'
    return ids.map(labelForId).join(' / ')
  }
  const text = typeof answer.value === 'string' ? answer.value : ''
  return text.trim() === '' ? '—' : text
}

export function isAskUserQuestionInputType(
  value: string,
): value is AskUserQuestionInputType {
  return (
    value === 'free_text' ||
    value === 'single_select' ||
    value === 'multi_select'
  )
}
