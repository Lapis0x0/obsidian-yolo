import { sha256Hex } from '../../utils/crypto/sha256'

export { sha256Hex }

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
