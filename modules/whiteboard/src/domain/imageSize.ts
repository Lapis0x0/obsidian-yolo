// An image file's own size, read from its header: what a card laying an
// image out in its text needs to know before the image is decoded — and all
// it needs, so the rest of the file is never looked at.
//
// PNG, GIF, WebP (lossy, lossless, extended) and JPEG; null for anything
// else, or a header it cannot read.

export type ImageSize = Readonly<{ w: number; h: number }>

export function imageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at = (offset: number, text: string) =>
    Array.from(text).every((ch, i) => bytes[offset + i] === ch.charCodeAt(0))
  if (bytes.length >= 24 && at(1, 'PNG') && at(12, 'IHDR')) {
    return sized(view.getUint32(16), view.getUint32(20))
  }
  if (bytes.length >= 10 && at(0, 'GIF')) {
    return sized(view.getUint16(6, true), view.getUint16(8, true))
  }
  if (bytes.length >= 30 && at(0, 'RIFF') && at(8, 'WEBP')) {
    if (at(12, 'VP8 ')) {
      return sized(
        view.getUint16(26, true) & 0x3fff,
        view.getUint16(28, true) & 0x3fff,
      )
    }
    if (at(12, 'VP8L')) {
      const b = view.getUint32(21, true)
      return sized((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1)
    }
    if (at(12, 'VP8X')) {
      const w = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)
      const h = bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)
      return sized(w + 1, h + 1)
    }
    return null
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return jpegSize(view)
  }
  return null
}

/** A JPEG's size: the first start-of-frame marker's. */
function jpegSize(view: DataView): ImageSize | null {
  let offset = 2
  while (offset + 9 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null
    const marker = view.getUint8(offset + 1)
    // Fill bytes before a marker.
    if (marker === 0xff) {
      offset += 1
      continue
    }
    const length = view.getUint16(offset + 2)
    // SOF0–SOF15, except the ones that are not frames: DHT, JPG, DAC.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return sized(view.getUint16(offset + 7), view.getUint16(offset + 5))
    }
    offset += 2 + length
  }
  return null
}

function sized(w: number, h: number): ImageSize | null {
  return w > 0 && h > 0 ? { w, h } : null
}
