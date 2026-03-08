import {
  getTextEditPlanPreviewContent,
  getStreamingTextEditPlanPreviewContent,
  isTextEditPlanStreamingCandidate,
  parseTextEditPlan,
  TEXT_EDIT_PLAN_TYPE,
  TEXT_EDIT_PLAN_VERSION,
} from './textEditPlan'

describe('parseTextEditPlan', () => {
  it('parses document-typed JSON plans', () => {
    const result = parseTextEditPlan(
      `{
      "type": "${TEXT_EDIT_PLAN_TYPE}",
      "version": ${TEXT_EDIT_PLAN_VERSION},
      "operations": [
        {
          "type": "replace",
          "oldText": "a",
          "newText": "b"
        }
      ]
    }`,
      {
        requireDocumentType: true,
      },
    )

    expect(result).toEqual({
      operations: [
        {
          type: 'replace',
          oldText: 'a',
          newText: 'b',
          expectedOccurrences: undefined,
        },
      ],
    })
  })

  it('rejects plans without the document type when required', () => {
    const result = parseTextEditPlan(
      '{"operations":[{"type":"append","content":"tail"}]}',
      {
        requireDocumentType: true,
      },
    )

    expect(result).toBeNull()
  })
})

describe('getTextEditPlanPreviewContent', () => {
  it('joins visible operation content for preview rendering', () => {
    const result = getTextEditPlanPreviewContent({
      operations: [
        {
          type: 'replace',
          oldText: 'old',
          newText: 'new',
        },
        {
          type: 'insert_after',
          anchor: 'anchor',
          content: 'inserted',
        },
      ],
    })

    expect(result).toBe('new\n\ninserted')
  })
})

describe('isTextEditPlanStreamingCandidate', () => {
  it('detects streamed text edit plan headers before the plan is complete', () => {
    expect(
      isTextEditPlanStreamingCandidate(`{
        "type": "${TEXT_EDIT_PLAN_TYPE}",
        "version": 1,
        "operations": [`),
    ).toBe(true)
  })

  it('ignores regular markdown blocks', () => {
    expect(isTextEditPlanStreamingCandidate('# heading\n\nbody')).toBe(false)
  })
})

describe('streaming text edit helpers', () => {
  it('extracts partial preview content before the json document is complete', () => {
    expect(
      getStreamingTextEditPlanPreviewContent(`{
        "type": "${TEXT_EDIT_PLAN_TYPE}",
        "version": 1,
        "operations": [
          {
            "type": "replace",
            "oldText": "old paragraph",
            "newText": "new first line\\nnew second line"
          },
          {
            "type": "append",
            "content": "tail fragment`),
    ).toBe('new first line\nnew second line\n\ntail fragment')
  })
})
