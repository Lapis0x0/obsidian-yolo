function toHex(bytes: Uint8Array): string {
  let value = ''
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0')
  return value
}

export async function sha256Hex(
  bytes: Uint8Array,
  subtleCrypto: Pick<SubtleCrypto, 'digest'>,
): Promise<string> {
  const digest = await subtleCrypto.digest('SHA-256', bytes)
  return toHex(new Uint8Array(digest))
}

export async function verifyModuleBytes(
  bytes: Uint8Array,
  expected: Readonly<{ sha256: string }>,
  label: string,
  subtleCrypto: Pick<SubtleCrypto, 'digest'>,
): Promise<void> {
  const actualDigest = await sha256Hex(bytes, subtleCrypto)
  if (actualDigest !== expected.sha256.toLowerCase()) {
    throw new Error(`${label} SHA-256 mismatch`)
  }
}
