import {
  COLOR_PRESETS,
  PRESET_HEX,
  commonColor,
  customColorInputValue,
  normalizeHex,
  resolveColor,
} from './color'

describe('resolveColor', () => {
  it('recognizes each of the six JSON Canvas presets', () => {
    for (const preset of COLOR_PRESETS) {
      expect(resolveColor(preset)).toEqual({ kind: 'preset', preset })
    }
  })

  it('resolves a hex colour, normalizing case and short form', () => {
    expect(resolveColor('#FF0000')).toEqual({ kind: 'custom', hex: '#ff0000' })
    expect(resolveColor('#0af')).toEqual({ kind: 'custom', hex: '#00aaff' })
  })

  it('renders nothing for an absent colour', () => {
    expect(resolveColor(undefined)).toEqual({ kind: 'none' })
  })

  it('renders nothing for a value it does not recognize, rather than guessing', () => {
    // The file format keeps unknown values verbatim; rendering them is a
    // separate decision, and the answer is "don't".
    expect(resolveColor('7')).toEqual({ kind: 'none' })
    expect(resolveColor('red')).toEqual({ kind: 'none' })
    expect(resolveColor('#12345')).toEqual({ kind: 'none' })
    expect(resolveColor('')).toEqual({ kind: 'none' })
  })
})

describe('normalizeHex', () => {
  it('expands the short form and lower-cases', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc')
    expect(normalizeHex('  #A1B2C3 ')).toBe('#a1b2c3')
  })

  it('rejects anything that is not a hex colour', () => {
    expect(normalizeHex('1')).toBeNull()
    expect(normalizeHex('#gggggg')).toBeNull()
    expect(normalizeHex('rgb(0,0,0)')).toBeNull()
  })
})

describe('commonColor', () => {
  it('is the shared colour when every member agrees', () => {
    expect(commonColor(['3', '3', '3'])).toBe('3')
  })

  it('is undefined when the members disagree', () => {
    expect(commonColor(['3', '4'])).toBeUndefined()
  })

  it('is undefined when any member is uncoloured', () => {
    expect(commonColor(['3', undefined])).toBeUndefined()
    expect(commonColor([undefined, '3'])).toBeUndefined()
  })

  it('is undefined for an empty selection', () => {
    expect(commonColor([])).toBeUndefined()
  })
})

describe('customColorInputValue', () => {
  it('opens on the colour itself when it is already custom', () => {
    expect(customColorInputValue('#123456')).toBe('#123456')
  })

  it("opens on a preset's own value when the current colour is a preset", () => {
    expect(customColorInputValue('4')).toBe(PRESET_HEX['4'])
  })

  it('opens on a neutral grey when there is no colour', () => {
    expect(customColorInputValue(undefined)).toBe('#808080')
  })
})
