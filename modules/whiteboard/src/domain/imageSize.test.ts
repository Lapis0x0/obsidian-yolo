import { imageSize } from './imageSize'

const bytes = (...parts: (string | number[])[]): Uint8Array =>
  Uint8Array.from(
    parts.flatMap((part) =>
      typeof part === 'string'
        ? Array.from(part).map((ch) => ch.charCodeAt(0))
        : part,
    ),
  )
const be32 = (n: number) => [
  n >>> 24,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
]
const be16 = (n: number) => [n >>> 8, n & 255]
const le16 = (n: number) => [n & 255, n >>> 8]

describe('imageSize', () => {
  test('PNG', () => {
    const png = bytes(
      [0x89],
      'PNG',
      [13, 10, 26, 10],
      be32(13),
      'IHDR',
      be32(1920),
      be32(1080),
      [8, 6, 0, 0, 0],
    )
    expect(imageSize(png)).toEqual({ w: 1920, h: 1080 })
  })

  test('GIF', () => {
    expect(imageSize(bytes('GIF89a', le16(320), le16(200)))).toEqual({
      w: 320,
      h: 200,
    })
  })

  test('JPEG: the first frame past the other segments', () => {
    const app0 = [0xff, 0xe0, ...be16(16), ...new Array<number>(14).fill(0)]
    const sof = [0xff, 0xc0, ...be16(17), 8, ...be16(480), ...be16(640), 3]
    const jpeg = Uint8Array.from([
      0xff,
      0xd8,
      ...app0,
      ...sof,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ])
    expect(imageSize(jpeg)).toEqual({ w: 640, h: 480 })
  })

  test('WebP, extended', () => {
    const webp = bytes(
      'RIFF',
      [0, 0, 0, 0],
      'WEBP',
      'VP8X',
      [10, 0, 0, 0],
      [0, 0, 0, 0],
      [0xff, 0x03, 0],
      [0xdf, 0x02, 0],
    )
    expect(imageSize(webp)).toEqual({ w: 1024, h: 736 })
  })

  test('anything else', () => {
    expect(
      imageSize(bytes('<svg xmlns="http://www.w3.org/2000/svg">')),
    ).toBeNull()
  })
})
