/* eslint-disable import/no-nodejs-modules -- the encoders are checked against Node's own zlib */
import { deflateSync, inflateSync } from 'node:zlib'

import { type CreateDeflater, ImagePdfWriter, PngWriter } from './imageFiles'

/** Node's zlib, collected and compressed at the end — the stream's contract
 * without its timing. */
const nodeDeflater: CreateDeflater = (output) => {
  const parts: Uint8Array[] = []
  return {
    push: async (bytes) => {
      parts.push(bytes.slice())
    },
    finish: async () => {
      await output(new Uint8Array(deflateSync(Buffer.concat(parts))))
    },
  }
}

function collector(): {
  sink: (b: Uint8Array) => Promise<void>
  bytes: () => Buffer
} {
  const parts: Uint8Array[] = []
  return {
    sink: async (bytes) => {
      parts.push(bytes.slice())
    },
    bytes: () => Buffer.concat(parts),
  }
}

/** Reads a PNG back far enough to check it: its chunks, then its pixels. */
function decodePng(file: Buffer): {
  width: number
  height: number
  types: string[]
  rgb: Uint8Array
} {
  expect([...file.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  const types: string[] = []
  const idat: Buffer[] = []
  let width = 0
  let height = 0
  let at = 8
  while (at < file.length) {
    const length = file.readUInt32BE(at)
    const type = file.toString('latin1', at + 4, at + 8)
    const data = file.subarray(at + 8, at + 8 + length)
    types.push(type)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      expect([data[8], data[9]]).toEqual([8, 2])
    }
    if (type === 'IDAT') idat.push(data)
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 3
  const rgb = new Uint8Array(height * stride)
  for (let row = 0; row < height; row += 1) {
    const line = raw.subarray(row * (stride + 1), (row + 1) * (stride + 1))
    expect(line[0]).toBe(2)
    for (let i = 0; i < stride; i += 1) {
      const above = row === 0 ? 0 : rgb[(row - 1) * stride + i]
      rgb[row * stride + i] = (line[1 + i] + above) & 0xff
    }
  }
  return { width, height, types, rgb }
}

function picture(width: number, height: number): Uint8Array {
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0; i < rgb.length; i += 1) rgb[i] = (i * 37 + (i >> 5)) & 0xff
  return rgb
}

describe('PngWriter', () => {
  it('writes bands as one picture that reads back pixel for pixel', async () => {
    const out = collector()
    const rgb = picture(5, 7)
    const png = new PngWriter(5, 7, out.sink, nodeDeflater)
    await png.writeRows(rgb.subarray(0, 3 * 15), 3)
    await png.writeRows(rgb.subarray(3 * 15), 4)
    await png.finish()

    const decoded = decodePng(out.bytes())
    expect(decoded.types[0]).toBe('IHDR')
    expect(decoded.types.at(-1)).toBe('IEND')
    expect([decoded.width, decoded.height]).toEqual([5, 7])
    expect(decoded.rgb).toEqual(rgb)
  })

  it('refuses a picture that is not whole', async () => {
    const png = new PngWriter(2, 2, collector().sink, nodeDeflater)
    await expect(png.writeRows(new Uint8Array(18), 3)).rejects.toThrow(
      'More rows',
    )
    await png.writeRows(new Uint8Array(6), 1)
    await expect(png.finish()).rejects.toThrow('Not every row')
  })
})

describe('ImagePdfWriter', () => {
  async function write(pageWidth: number, pageHeight: number): Promise<string> {
    const out = collector()
    const pdf = new ImagePdfWriter(out.sink, {
      pageWidth,
      pageHeight,
      pixelWidth: 4,
      pixelHeight: 6,
    })
    await pdf.addBand(new Uint8Array(deflateSync(Buffer.alloc(4 * 2 * 3))), 2)
    await pdf.addBand(new Uint8Array(deflateSync(Buffer.alloc(4 * 4 * 3))), 4)
    await pdf.finish()
    return out.bytes().toString('latin1')
  }

  it('places each band down the page, top band highest', async () => {
    const text = await write(400, 600)
    expect(text.startsWith('%PDF-1.7')).toBe(true)
    expect(text).toContain('/MediaBox [0 0 400 600]')
    // Six rows over 600 points: the first band's two rows sit at the top.
    expect(text).toContain('q 400 0 0 200 0 400 cm /Im5 Do Q')
    expect(text).toContain('q 400 0 0 400 0 0 cm /Im6 Do Q')
    expect(text).not.toContain('/UserUnit')
  })

  it('points every cross-reference at its object', async () => {
    const text = await write(400, 600)
    const startxref = Number(/startxref\n(\d+)/.exec(text)?.[1])
    const table = text.slice(startxref)
    const offsets = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    )
    expect(offsets).toHaveLength(6)
    offsets.forEach((offset, index) => {
      expect(text.startsWith(`${index + 1} 0 obj`, offset)).toBe(true)
    })
  })

  it('states a user unit for a page past what viewers accept', async () => {
    const text = await write(30000, 600)
    expect(text).toContain('/UserUnit 3')
    expect(text).toContain('/MediaBox [0 0 10000 200]')
  })
})
