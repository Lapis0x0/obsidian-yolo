export function isStandaloneSmartSpaceSlash(
  precedingCharacter: string,
): boolean {
  return precedingCharacter.length === 0 || /\s/.test(precedingCharacter)
}
