import { bytesToBase64 } from './common'

const encodeUtf8 = (value: string): Uint8Array =>
  new TextEncoder().encode(value)

const getSubtleCrypto = (): SubtleCrypto => {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error('Web Crypto is not available for ASR request signing.')
  }
  return subtle
}

export async function hmacBase64(
  algorithm: 'SHA-1' | 'SHA-256',
  secret: string,
  message: string,
): Promise<string> {
  const subtle = getSubtleCrypto()
  const key = await subtle.importKey(
    'raw',
    encodeUtf8(secret),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  )
  const signature = await subtle.sign('HMAC', key, encodeUtf8(message))
  return bytesToBase64(new Uint8Array(signature))
}

export async function sha256Base64(
  body: string | ArrayBuffer | Uint8Array,
): Promise<string> {
  const bytes =
    typeof body === 'string'
      ? encodeUtf8(body)
      : body instanceof Uint8Array
        ? body
        : new Uint8Array(body)
  const digest = await getSubtleCrypto().digest('SHA-256', bytes)
  return bytesToBase64(new Uint8Array(digest))
}
