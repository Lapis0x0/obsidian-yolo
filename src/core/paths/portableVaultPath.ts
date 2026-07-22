const WINDOWS_FORBIDDEN_FILE_NAME_CHARACTERS = /[<>:"\\|?*]/
const UNICODE_CONTROL_OR_SURROGATE = /[\p{Cc}\p{Cs}]/u
const WINDOWS_RESERVED_FILE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${String(index + 1)}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${String(index + 1)}`),
])

/**
 * Whether a single Vault path segment is safe to sync across supported
 * desktop and mobile file systems. Unlike module artifact identifiers, Vault
 * folders are user-facing and may contain Unicode.
 */
export function isPortableVaultPathSegment(value: string): boolean {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    value.normalize('NFC') !== value ||
    value.endsWith('.') ||
    value.endsWith(' ') ||
    value.includes('/') ||
    WINDOWS_FORBIDDEN_FILE_NAME_CHARACTERS.test(value) ||
    UNICODE_CONTROL_OR_SURROGATE.test(value)
  ) {
    return false
  }

  const baseName = value.split('.')[0]?.trimEnd().toUpperCase()
  return !WINDOWS_RESERVED_FILE_NAMES.has(baseName ?? '')
}

export function assertPortableVaultPathSegment(
  value: string,
  label: string,
): void {
  if (!isPortableVaultPathSegment(value)) {
    throw new Error(
      `${label} contains an unsupported path segment: ${JSON.stringify(value)}`,
    )
  }
}
