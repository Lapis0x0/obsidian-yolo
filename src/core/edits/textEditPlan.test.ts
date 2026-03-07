import {
  getTextEditPlanPreviewContent,
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
