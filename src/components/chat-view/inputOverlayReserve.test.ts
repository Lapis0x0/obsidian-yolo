import { getInputOverlayReserveHeight } from './inputOverlayReserve'

type StyleInput = {
  display?: string
  visibility?: string
  gap?: string
}

const makeStyle = ({
  display = 'block',
  visibility = 'visible',
  gap = '',
}: StyleInput = {}) =>
  ({
    display,
    visibility,
    getPropertyValue: (name: string) => (name === '--size-2-1' ? gap : ''),
  }) as CSSStyleDeclaration

const makeOverlay = ({
  height,
  gap,
  childStyles,
}: {
  height: number
  gap?: string
  childStyles: StyleInput[]
}) => {
  const styles = new Map<object, CSSStyleDeclaration>()
  const ownerDocument = {
    defaultView: {
      getComputedStyle: (element: object) => styles.get(element) ?? makeStyle(),
    },
  }
  const children = childStyles.map((style) => {
    const child = { ownerDocument }
    styles.set(child, makeStyle(style))
    return child
  })
  const overlay = {
    ownerDocument,
    children,
    offsetHeight: height,
  }
  styles.set(overlay, makeStyle({ gap }))

  return overlay as unknown as HTMLElement
}

describe('input overlay reserve height', () => {
  it('does not reserve space for an empty overlay', () => {
    const overlay = makeOverlay({
      height: 180,
      gap: '6px',
      childStyles: [],
    })

    expect(getInputOverlayReserveHeight(overlay)).toBe(0)
  })

  it('does not reserve space when all overlay children are hidden', () => {
    const overlay = makeOverlay({
      height: 180,
      gap: '6px',
      childStyles: [{ display: 'none' }, { visibility: 'hidden' }],
    })

    expect(getInputOverlayReserveHeight(overlay)).toBe(0)
  })

  it('reserves measured height plus the configured overlay gap', () => {
    const overlay = makeOverlay({
      height: 42,
      gap: '3.2px',
      childStyles: [{}],
    })

    expect(getInputOverlayReserveHeight(overlay)).toBe(46)
  })

  it('uses a small default gap when the CSS variable is unavailable', () => {
    const overlay = makeOverlay({
      height: 42,
      childStyles: [{}],
    })

    expect(getInputOverlayReserveHeight(overlay)).toBe(46)
  })
})
