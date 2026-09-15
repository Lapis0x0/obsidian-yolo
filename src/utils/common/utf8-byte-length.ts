/**
 * UTF-8 encoded size of a string, counted without allocating the encoded
 * buffer — the strings measured here (image data URLs, whole-book PDF text)
 * run to megabytes, and only the number is needed.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < text.length &&
      (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      // A surrogate pair is one astral code point: 4 bytes for both halves.
      bytes += 4
      index += 1
    } else {
      // Any other BMP code point, including a lone surrogate (which
      // TextEncoder writes as the 3-byte U+FFFD).
      bytes += 3
    }
  }
  return bytes
}
