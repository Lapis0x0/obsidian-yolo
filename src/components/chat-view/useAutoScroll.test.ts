import { isUpwardKeyboardScrollIntent } from './useAutoScroll'

function makeKeyboardEvent(key: string): Pick<KeyboardEvent, 'key'> {
  return { key }
}

describe('isUpwardKeyboardScrollIntent', () => {
  it.each(['ArrowUp', 'PageUp', 'Home'])(
    'treats %s as upward keyboard scroll intent',
    (key) => {
      expect(isUpwardKeyboardScrollIntent(makeKeyboardEvent(key))).toBe(true)
    },
  )

  it.each(['ArrowDown', 'PageDown', 'End', ' ', 'Enter', 'Escape'])(
    'ignores %s because it does not move history upward',
    (key) => {
      expect(isUpwardKeyboardScrollIntent(makeKeyboardEvent(key))).toBe(false)
    },
  )
})
