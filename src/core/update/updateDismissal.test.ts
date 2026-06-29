import {
  dismissUpdateVersion,
  isUpdateVersionMuted,
} from './updateDismissal'

describe('update dismissal state', () => {
  it('soft-dismisses a version the first time it is closed', () => {
    const result = dismissUpdateVersion(
      { softDismissedUpdateVersion: '', mutedUpdateVersion: '' },
      '1.2.3',
    )

    expect(result).toEqual({
      softDismissedUpdateVersion: '1.2.3',
      mutedUpdateVersion: '',
    })
    expect(isUpdateVersionMuted(result, '1.2.3')).toBe(false)
  })

  it('mutes the same version when it is closed after a soft dismissal', () => {
    const result = dismissUpdateVersion(
      { softDismissedUpdateVersion: '1.2.3', mutedUpdateVersion: '' },
      '1.2.3',
    )

    expect(result).toEqual({
      softDismissedUpdateVersion: '1.2.3',
      mutedUpdateVersion: '1.2.3',
    })
    expect(isUpdateVersionMuted(result, '1.2.3')).toBe(true)
  })

  it('does not carry an older soft dismissal onto a newer version', () => {
    const result = dismissUpdateVersion(
      { softDismissedUpdateVersion: '1.2.3', mutedUpdateVersion: '1.2.3' },
      '1.2.4',
    )

    expect(result).toEqual({
      softDismissedUpdateVersion: '1.2.4',
      mutedUpdateVersion: '1.2.3',
    })
    expect(isUpdateVersionMuted(result, '1.2.4')).toBe(false)
  })
})
