const DEFAULT_OVERLAY_GAP_PX = 4

const getElementStyle = (element: Element): CSSStyleDeclaration | null => {
  const ownerWindow = element.ownerDocument?.defaultView
  if (typeof ownerWindow?.getComputedStyle === 'function') {
    return ownerWindow.getComputedStyle(element)
  }
  if (typeof getComputedStyle === 'function') {
    return getComputedStyle(element)
  }
  return null
}

export const hasRenderableOverlayChildren = (element: HTMLElement): boolean => {
  return Array.from(element.children).some((child) => {
    const style = getElementStyle(child)
    return style?.display !== 'none' && style?.visibility !== 'hidden'
  })
}

export const getInputOverlayReserveHeight = (element: HTMLElement): number => {
  if (!hasRenderableOverlayChildren(element)) {
    return 0
  }

  const height = element.offsetHeight
  if (height <= 0) {
    return 0
  }

  const gap = parseFloat(
    getElementStyle(element)?.getPropertyValue('--size-2-1') ?? '',
  )
  const gapPx = Number.isFinite(gap) && gap > 0 ? gap : DEFAULT_OVERLAY_GAP_PX
  return Math.ceil(height + gapPx)
}
