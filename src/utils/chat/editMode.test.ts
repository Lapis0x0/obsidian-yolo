import { parseEditPlan } from './editMode'

describe('parseEditPlan', () => {
  it('parses direct JSON plans', () => {
    const result = parseEditPlan(`{
      "operations": [
        {
          "type": "replace",
          "oldText": "a",
          "newText": "b"
        }
      ]
    }`)

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

  it('parses a JSON object wrapped in extra text', () => {
    const result = parseEditPlan(
      'Here is the plan: {"operations":[{"type":"append","content":"tail"}]}',
    )

    expect(result).toEqual({
      operations: [
        {
          type: 'append',
          content: 'tail',
        },
      ],
    })
  })
})
