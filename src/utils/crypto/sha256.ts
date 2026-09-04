/**
 * Lowercase hex SHA-256, the one form every integrity check in this repo
 * compares against (signed Feed entries, module manifests, release notes).
 *
 * `subtleCrypto` is injected rather than read from `globalThis` so callers
 * that already resolved it — and tests — keep one path.
 */
export async function sha256Hex(
  bytes: Uint8Array,
  subtleCrypto: Pick<SubtleCrypto, 'digest'>,
): Promise<string> {
  const digest = await subtleCrypto.digest('SHA-256', bytes)
  let value = ''
  for (const byte of new Uint8Array(digest)) {
    value += byte.toString(16).padStart(2, '0')
  }
  return value
}
