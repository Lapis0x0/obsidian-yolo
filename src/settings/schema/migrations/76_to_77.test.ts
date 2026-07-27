import { migrateFrom76To77 } from './76_to_77'

describe('76_to_77', () => {
  it('enables multiple Tab completion candidates by default', () => {
    expect(
      migrateFrom76To77({
        version: 76,
        continuationOptions: { tabCompletionOptions: {} },
      }),
    ).toMatchObject({
      version: 77,
      continuationOptions: {
        tabCompletionOptions: { multipleCandidatesEnabled: true },
      },
    })
  })

  it('preserves an explicit disabled preference', () => {
    expect(
      migrateFrom76To77({
        version: 76,
        continuationOptions: {
          tabCompletionOptions: { multipleCandidatesEnabled: false },
        },
      }),
    ).toMatchObject({
      version: 77,
      continuationOptions: {
        tabCompletionOptions: { multipleCandidatesEnabled: false },
      },
    })
  })
})
