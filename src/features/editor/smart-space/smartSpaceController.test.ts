import { isStandaloneSmartSpaceSlash } from './smartSpaceTrigger'

describe('isStandaloneSmartSpaceSlash', () => {
  it.each(['', ' ', '\n', '\t'])(
    'accepts a slash at a line start or after whitespace %p',
    (precedingCharacter) => {
      expect(isStandaloneSmartSpaceSlash(precedingCharacter)).toBe(true)
    },
  )

  it.each(['w', '0', ')', '_'])(
    'does not treat a slash after non-whitespace %p as a Smart Space trigger',
    (precedingCharacter) => {
      expect(isStandaloneSmartSpaceSlash(precedingCharacter)).toBe(false)
    },
  )
})
