import { isMathSheet, lookClasses, lookVars } from './pictureStyles'

describe('isMathSheet', () => {
  it("tells MathJax's stylesheets from the rest", () => {
    const owner = (id: string) => ({ id }) as unknown as Node
    expect(isMathSheet(owner('MJX-CHTML-styles'))).toBe(true)
    expect(isMathSheet(owner('MJX-Menu-styles'))).toBe(true)
    expect(isMathSheet(owner(''))).toBe(false)
    expect(isMathSheet(owner('css-snippet-mjx'))).toBe(false)
    expect(isMathSheet({} as Node)).toBe(false)
  })
})

/** A body's style with these properties set, in this order. */
const styleOf = (props: Record<string, string>): CSSStyleDeclaration => {
  const names = Object.keys(props)
  return Object.assign([...names], {
    getPropertyValue: (name: string) => props[name] ?? '',
  }) as unknown as CSSStyleDeclaration
}

describe('lookVars', () => {
  it("keeps the body's own variables and leaves out the window's", () => {
    expect(
      lookVars(
        styleOf({
          '--zoom-factor': '1.2',
          '--font-text-size': '18px',
          '--keyboard-height': '300px',
          '--indent-size': '4',
          color: 'red',
        }),
      ),
    ).toBe('--font-text-size:18px;--indent-size:4;')
  })

  it('reads the same whatever the zoom or the keyboard', () => {
    const at = (zoom: string, keyboard: string) =>
      lookVars(
        styleOf({
          '--zoom-factor': zoom,
          '--font-text-size': '16px',
          '--keyboard-height': keyboard,
        }),
      )
    expect(at('1', '0px')).toBe(at('1.5', '320px'))
  })
})

describe('lookClasses', () => {
  it("keeps the look and leaves out the window's state", () => {
    expect(
      lookClasses(
        'mod-macos is-frameless obsidian-app theme-dark is-focused is-fullscreen is-maximized show-ribbon',
      ),
    ).toBe('mod-macos is-frameless obsidian-app theme-dark show-ribbon')
  })

  it('reads the same focused or not, in a popout or not, mid-drag or not', () => {
    const look = 'obsidian-app theme-light minimal-style'
    expect(lookClasses(`${look} is-focused`)).toBe(look)
    expect(lookClasses(`is-popout-window ${look}`)).toBe(look)
    expect(lookClasses(`${look} is-grabbing in-progress`)).toBe(look)
    expect(
      lookClasses(`${look} mod-toolbar-open is-hidden-nav is-screenshotting`),
    ).toBe(look)
  })

  it('reads a body without window state as it is', () => {
    const body = 'mod-macos obsidian-app theme-light show-view-header'
    expect(lookClasses(body)).toBe(body)
    expect(lookClasses('')).toBe('')
  })
})
