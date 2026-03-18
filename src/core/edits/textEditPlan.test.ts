import {
  getTextEditPlanPreviewContent,
  getStreamingTextEditPlanPreviewContent,
  isTextEditPlanStreamingCandidate,
  parseTextEditPlan,
} from './textEditPlan'

describe('parseTextEditPlan', () => {
  it('parses replace plans in the new dsl format', () => {
    const result = parseTextEditPlan(
      `<<<<<<< REPLACE
[old]
a
=======
[new]
b
>>>>>>> END`,
    )

    expect(result).toEqual({
      operations: [
        {
          type: 'replace',
          oldText: 'a',
          newText: 'b',
        },
      ],
    })
  })

  it('parses replace plans when the old marker is omitted', () => {
    const result = parseTextEditPlan(
      `<<<<<<< REPLACE
a
=======
[new]
b
>>>>>>> END`,
    )

    expect(result).toEqual({
      operations: [
        {
          type: 'replace',
          oldText: 'a',
          newText: 'b',
        },
      ],
    })
  })

  it('parses replace plans when the new marker is omitted', () => {
    const result = parseTextEditPlan(
      `<<<<<<< REPLACE
[old]
a
=======
b
>>>>>>> END`,
    )

    expect(result).toEqual({
      operations: [
        {
          type: 'replace',
          oldText: 'a',
          newText: 'b',
        },
      ],
    })
  })

  it('parses replace plans when the new marker uses content', () => {
    const result = parseTextEditPlan(
      `<<<<<<< REPLACE
[old]
a
=======
[content]
b
>>>>>>> END`,
    )

    expect(result).toEqual({
      operations: [
        {
          type: 'replace',
          oldText: 'a',
          newText: 'b',
        },
      ],
    })
  })

  it('parses replace plans when both old and new markers are omitted', () => {
    const result = parseTextEditPlan(
      `<<<<<<< REPLACE
a
=======
b
>>>>>>> END`,
    )

    expect(result).toEqual({
      operations: [
        {
          type: 'replace',
          oldText: 'a',
          newText: 'b',
        },
      ],
    })
  })

  it('parses insert_after plans in the new dsl format', () => {
    const result = parseTextEditPlan(
      `<<<<<<< INSERT_AFTER
[anchor]
## heading
=======
[content]
tail
>>>>>>> END`,
    )

    expect(result).toEqual({
      operations: [
        {
          type: 'insert_after',
          anchor: '## heading',
          content: 'tail',
        },
      ],
    })
  })

  it('parses insert_after plans when the anchor marker is omitted', () => {
    const result = parseTextEditPlan(
      `<<<<<<< INSERT_AFTER
## heading
=======
[content]
tail
>>>>>>> END`,
    )

    expect(result).toEqual({
      operations: [
        {
          type: 'insert_after',
          anchor: '## heading',
          content: 'tail',
        },
      ],
    })
  })

  it('parses insert_after plans when the content marker is omitted', () => {
    const result = parseTextEditPlan(
      `<<<<<<< INSERT_AFTER
[anchor]
## heading
=======
tail
>>>>>>> END`,
    )

    expect(result).toEqual({
      operations: [
        {
          type: 'insert_after',
          anchor: '## heading',
          content: 'tail',
        },
      ],
    })
  })

  it('parses insert_after plans when both markers are omitted', () => {
    const result = parseTextEditPlan(
      `<<<<<<< INSERT_AFTER
## heading
=======
tail
>>>>>>> END`,
    )

    expect(result).toEqual({
      operations: [
        {
          type: 'insert_after',
          anchor: '## heading',
          content: 'tail',
        },
      ],
    })
  })

  it('parses insert_after plans when the content marker uses new', () => {
    const result = parseTextEditPlan(
      `<<<<<<< INSERT_AFTER
[anchor]
## heading
=======
[new]
tail
>>>>>>> END`,
    )

    expect(result).toEqual({
      operations: [
        {
          type: 'insert_after',
          anchor: '## heading',
          content: 'tail',
        },
      ],
    })
  })

  it('parses append plans when the content marker is omitted', () => {
    const result = parseTextEditPlan(
      `<<<<<<< APPEND
tail
>>>>>>> END`,
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

  it('parses append plans in diff style with new marker', () => {
    const result = parseTextEditPlan(
      `<<<<<<< APPEND
=======
[new]
tail
>>>>>>> END`,
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

  it('parses append plans in diff style without markers', () => {
    const result = parseTextEditPlan(
      `<<<<<<< APPEND
=======
tail
>>>>>>> END`,
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

  it('rejects malformed plans', () => {
    expect(
      parseTextEditPlan(`<<<<<<< REPLACE
[old]
a
oops
>>>>>>> END`),
    ).toBeNull()
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
  it('detects streamed dsl plan headers before the plan is complete', () => {
    expect(isTextEditPlanStreamingCandidate('<<<<<<< REPLACE\n[old]\n')).toBe(
      true,
    )
  })

  it('ignores regular markdown blocks', () => {
    expect(isTextEditPlanStreamingCandidate('# heading\n\nbody')).toBe(false)
  })
})

describe('streaming text edit helpers', () => {
  it('extracts partial preview content before the dsl document is complete', () => {
    expect(
      getStreamingTextEditPlanPreviewContent(`<<<<<<< REPLACE
[old]
old paragraph
=======
[new]
new first line
new second line`),
    ).toBe('new first line\nnew second line')
  })

  it('extracts preview content when insert_after uses new marker', () => {
    expect(
      getStreamingTextEditPlanPreviewContent(`<<<<<<< INSERT_AFTER
[anchor]
heading
=======
[new]
tail fragment`),
    ).toBe('tail fragment')
  })

  it('extracts preview content for diff style append blocks', () => {
    expect(
      getStreamingTextEditPlanPreviewContent(`<<<<<<< APPEND
=======
[new]
tail fragment`),
    ).toBe('tail fragment')
  })
})
