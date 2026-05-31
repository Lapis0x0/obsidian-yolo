import {
  applyVoiceDecisionBoundaryFallback,
  getVoiceDecisionInsertionOffset,
} from './voiceDecisionBoundaryFallback'
import type { VoiceEditorDecision } from './voiceDecisionParser'

const decision = (text: string): VoiceEditorDecision => ({
  action: 'insert_at_cursor',
  text,
})

describe('applyVoiceDecisionBoundaryFallback', () => {
  test('trims trailing terminal punctuation when cursor_after starts with adjacent punctuation', () => {
    expect(
      applyVoiceDecisionBoundaryFallback(decision('还要记录。'), {
        before: '会议纪要里写到',
        after: '，下周继续跟进',
        asrTranscript: '还要记录。',
      }).text,
    ).toBe('还要记录')

    expect(
      applyVoiceDecisionBoundaryFallback(decision('for active customers.'), {
        before: 'same price ',
        after: '. More text',
        asrTranscript: 'for active customers.',
      }).text,
    ).toBe('for active customers')
  })

  test('keeps useful final punctuation when cursor_after starts with normal content', () => {
    expect(
      applyVoiceDecisionBoundaryFallback(decision('需要具体分析。'), {
        before: '结论',
        after: '后续报告继续',
        asrTranscript: '需要具体分析。',
      }).text,
    ).toBe('需要具体分析。')
  })

  test('does not treat a closing quote as adjacent boundary punctuation', () => {
    expect(
      applyVoiceDecisionBoundaryFallback(decision('需要标注来源。'), {
        before: '他说「',
        after: '」随后解释',
        asrTranscript: '需要标注来源。',
      }).text,
    ).toBe('需要标注来源。')
  })

  test('keeps single leading punctuation when it starts a new clause', () => {
    expect(
      applyVoiceDecisionBoundaryFallback(decision('，也不能牺牲停顿。'), {
        before: '这段话已经强调清晰表达',
        after: '，但预算还没批',
        asrTranscript: '也不能牺牲停顿。',
      }).text,
    ).toBe('，也不能牺牲停顿')
  })

  test('removes one duplicated leading boundary punctuation', () => {
    expect(
      applyVoiceDecisionBoundaryFallback(decision('，，需要补充验收标准。'), {
        before: '这项任务已经完成开发',
        after: '，后续还要安排验收',
        asrTranscript: '需要补充验收标准。',
      }).text,
    ).toBe('，需要补充验收标准')
  })

  test('keeps leading punctuation when it belongs to ASR', () => {
    expect(
      applyVoiceDecisionBoundaryFallback(decision('，而且更容易维护。'), {
        before: '这版实现不只是能跑',
        after: '，后续还要加测试',
        asrTranscript: '，而且更容易维护。',
      }).text,
    ).toBe('，而且更容易维护')
  })

  test('removes leading whitespace only when cursor_before ends with whitespace', () => {
    expect(
      applyVoiceDecisionBoundaryFallback(decision('  补充说明。'), {
        before: '项目： ',
        after: '',
        asrTranscript: '  补充说明。',
      }).text,
    ).toBe('补充说明。')

    expect(
      applyVoiceDecisionBoundaryFallback(decision(' for active customers'), {
        before: 'same price',
        after: '. More text',
        asrTranscript: ' for active customers.',
      }).text,
    ).toBe(' for active customers')
  })
})

describe('getVoiceDecisionInsertionOffset', () => {
  const target = {
    startCursorOffset: 10,
    selectionFromOffset: 20,
    selectionToOffset: 30,
  }

  test('matches controller insertion anchors by action', () => {
    expect(getVoiceDecisionInsertionOffset('insert_at_cursor', target)).toBe(10)
    expect(getVoiceDecisionInsertionOffset('replace_selection', target)).toBe(
      20,
    )
    expect(
      getVoiceDecisionInsertionOffset('insert_after_selection', target),
    ).toBe(30)
  })
})
