const CARD_SIDE_SEPARATOR_RE = /^---\r?$/gm

type CardSides = {
  front: string
  back: string
}

export function parseCardBody(body: string): CardSides | null {
  const separators = [...body.matchAll(CARD_SIDE_SEPARATOR_RE)]
  if (separators.length !== 1) return null

  const separator = separators[0]
  const separatorStart = separator.index
  if (separatorStart === undefined) return null

  return {
    front: body.slice(0, separatorStart).trim(),
    back: body.slice(separatorStart + separator[0].length).trim(),
  }
}

export function formatCardBody(front: string, back: string): string {
  const normalizedFront = front.trim()
  const normalizedBack = back.trim()
  if (
    [...normalizedFront.matchAll(CARD_SIDE_SEPARATOR_RE)].length > 0 ||
    [...normalizedBack.matchAll(CARD_SIDE_SEPARATOR_RE)].length > 0
  ) {
    throw new Error('卡片正反面正文不能包含独占一行的 ---')
  }
  const frontPart = normalizedFront ? `${normalizedFront}\n\n` : ''
  const backPart = normalizedBack ? `\n\n${normalizedBack}` : ''
  return `${frontPart}---${backPart}`
}
