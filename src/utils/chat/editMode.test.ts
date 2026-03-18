import { parseEditPlan } from './editMode'

describe('parseEditPlan', () => {
  it('parses direct dsl plans', () => {
    const result = parseEditPlan(`<<<<<<< REPLACE
[old]
a
=======
[new]
b
>>>>>>> END`)

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

  it('rejects wrapped or malformed content', () => {
    const result = parseEditPlan(
      'Here is the plan: <<<<<<< APPEND\n[content]\ntail',
    )

    expect(result).toBeNull()
  })
})
