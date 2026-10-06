// The file formats a board export is written in: a PNG, and a one-page PDF
// that holds the same picture. Both are written as the picture is made, a
// band of rows at a time (ui/export/boardExport.ts), so the size of an export
// is bounded by the disk rather than by memory — neither format needs the
// whole picture at once, and neither encoder ever holds it.
//
// Pixels come in as RGB rows, three bytes a pixel, top row first; the board
// is drawn on its own opaque background, so there is no alpha to keep.
// Compression is handed in (`CreateDeflater`): the browser has a zlib stream
// (`CompressionStream('deflate')`) and the tests have Node's, and neither
// belongs in a file that only knows the formats.
//
// DOM-free like everything in domain/ (Module Boundaries, CLAUDE.md).

/** Where encoded bytes go, in order. */
export type ByteSink = (chunk: Uint8Array) => Promise<void>

/** A zlib stream (RFC 1950): what both formats call Flate. Bytes pushed in
 * come out compressed through the sink it was made with; `finish` ends the
 * stream and resolves once its last bytes are out. */
export type Deflater = Readonly<{
  push(bytes: Uint8Array): Promise<void>
  finish(): Promise<void>
}>

export type CreateDeflater = (output: ByteSink) => Deflater

const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
/** PNG's own colour type for RGB without alpha. */
const PNG_RGB = 2
/** The "Up" filter: each byte minus the one above it. A board is mostly flat
 * colour and horizontal rules, which this turns into runs of zeros. */
const PNG_FILTER_UP = 2
/** How much compressed data an IDAT chunk collects before it is written:
 * a chunk per deflate output would be thousands of tiny chunks. */
const IDAT_CHUNK_BYTES = 1 << 18

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(parts: readonly Uint8Array[]): number {
  let crc = 0xffffffff
  for (const bytes of parts) {
    for (let i = 0; i < bytes.length; i += 1) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}

/**
 * A PNG written a band of rows at a time: `writeRows` until every row is in,
 * then `finish`. One zlib stream runs through every IDAT chunk, as the format
 * requires, so the bands are one picture rather than several.
 */
export class PngWriter {
  private readonly deflater: Deflater
  private pending: Uint8Array[] = []
  private pendingBytes = 0
  private previous: Uint8Array
  private rowsWritten = 0
  private started = false

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly sink: ByteSink,
    createDeflater: CreateDeflater,
  ) {
    if (!isDimension(width) || !isDimension(height)) {
      throw new RangeError('A PNG is 1 to 2^31-1 pixels on a side')
    }
    this.previous = new Uint8Array(width * 3)
    this.deflater = createDeflater((chunk) => this.collect(chunk))
  }

  /** `rgb` holds `rows` whole rows, top first. */
  async writeRows(rgb: Uint8Array, rows: number): Promise<void> {
    const stride = this.width * 3
    if (rgb.length < rows * stride) {
      throw new RangeError('Fewer bytes than rows')
    }
    if (this.rowsWritten + rows > this.height) {
      throw new RangeError('More rows than the picture has')
    }
    await this.start()
    const filtered = new Uint8Array(rows * (stride + 1))
    let previous = this.previous
    for (let row = 0; row < rows; row += 1) {
      const line = rgb.subarray(row * stride, (row + 1) * stride)
      const out = row * (stride + 1)
      filtered[out] = PNG_FILTER_UP
      for (let i = 0; i < stride; i += 1) {
        filtered[out + 1 + i] = (line[i] - previous[i]) & 0xff
      }
      previous = line
    }
    // Copied: the caller reuses its buffer for the next band.
    this.previous = previous.slice()
    this.rowsWritten += rows
    await this.deflater.push(filtered)
  }

  async finish(): Promise<void> {
    if (this.rowsWritten !== this.height) {
      throw new RangeError('Not every row was written')
    }
    await this.deflater.finish()
    await this.flushIdat()
    await this.chunk('IEND', new Uint8Array(0))
  }

  private async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.sink(PNG_SIGNATURE)
    const header = new Uint8Array(13)
    const view = new DataView(header.buffer)
    view.setUint32(0, this.width)
    view.setUint32(4, this.height)
    header[8] = 8 // bits per channel
    header[9] = PNG_RGB
    // Compression, filter method and interlacing: the only defined values.
    await this.chunk('IHDR', header)
  }

  private async collect(chunk: Uint8Array): Promise<void> {
    this.pending.push(chunk)
    this.pendingBytes += chunk.length
    if (this.pendingBytes >= IDAT_CHUNK_BYTES) await this.flushIdat()
  }

  private async flushIdat(): Promise<void> {
    if (this.pendingBytes === 0) return
    const data = concat(this.pending, this.pendingBytes)
    this.pending = []
    this.pendingBytes = 0
    await this.chunk('IDAT', data)
  }

  private async chunk(type: string, data: Uint8Array): Promise<void> {
    const typeBytes = encoder.encode(type)
    await this.sink(uint32(data.length))
    await this.sink(typeBytes)
    if (data.length > 0) await this.sink(data)
    await this.sink(uint32(crc32([typeBytes, data])))
  }
}

function isDimension(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 0x7fffffff
}

function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * The largest a page side may be in a viewer's units: Acrobat's 200 inches.
 * Past it the page states a `/UserUnit` — how many points one unit is — so a
 * board of any size is still one page of its true proportions.
 */
const PDF_MAX_PAGE_UNITS = 14400

/** Points per CSS pixel: a board's world unit prints at the size a pixel of
 * it would be on a 96 dpi screen. */
export const PDF_POINTS_PER_WORLD_UNIT = 72 / 96

/**
 * A one-page PDF whose page is the picture, written a band at a time: each
 * band is an image of its own, written to the sink as soon as it is added,
 * and the page that places them all is written by `finish`, followed by the
 * cross-reference table that ties the file together.
 *
 * The page is `pageWidth` by `pageHeight` points; the bands are placed down
 * it in the order they are added, each as tall on the page as its share of
 * the picture's `pixelHeight`.
 */
export class ImagePdfWriter {
  private offset = 0
  private readonly offsets = new Map<number, number>()
  private readonly bands: { object: number; top: number; rows: number }[] = []
  private nextObject = FIRST_IMAGE_OBJECT
  private rowsAdded = 0
  private started = false

  constructor(
    private readonly sink: ByteSink,
    private readonly page: Readonly<{
      pageWidth: number
      pageHeight: number
      pixelWidth: number
      pixelHeight: number
    }>,
  ) {
    if (!isDimension(page.pixelWidth) || !isDimension(page.pixelHeight)) {
      throw new RangeError('A picture is at least one pixel on a side')
    }
    if (!(page.pageWidth > 0) || !(page.pageHeight > 0)) {
      throw new RangeError('A page has a size')
    }
  }

  /** A band of `rows` whole rows, as one zlib stream of RGB bytes. */
  async addBand(compressed: Uint8Array, rows: number): Promise<void> {
    if (this.rowsAdded + rows > this.page.pixelHeight) {
      throw new RangeError('More rows than the picture has')
    }
    await this.start()
    const object = this.nextObject++
    this.bands.push({ object, top: this.rowsAdded, rows })
    this.rowsAdded += rows
    await this.object(
      object,
      `<< /Type /XObject /Subtype /Image /Width ${this.page.pixelWidth} /Height ${rows}` +
        ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>`,
      compressed,
    )
  }

  async finish(): Promise<void> {
    if (this.rowsAdded !== this.page.pixelHeight) {
      throw new RangeError('Not every row was added')
    }
    await this.start()
    const unit = Math.max(
      1,
      Math.ceil(
        Math.max(this.page.pageWidth, this.page.pageHeight) /
          PDF_MAX_PAGE_UNITS,
      ),
    )
    const width = this.page.pageWidth / unit
    const height = this.page.pageHeight / unit
    const perRow = height / this.page.pixelHeight
    const names = this.bands.map((band) => `/Im${band.object}`)
    // PDF's origin is the page's bottom-left corner; a band is placed by
    // its own bottom edge.
    const content = this.bands
      .map((band, index) => {
        const h = band.rows * perRow
        const y = height - (band.top + band.rows) * perRow
        return `q ${num(width)} 0 0 ${num(h)} 0 ${num(y)} cm ${names[index]} Do Q`
      })
      .join('\n')
    const contentBytes = encoder.encode(content)
    await this.object(
      CONTENT_OBJECT,
      `<< /Length ${contentBytes.length} >>`,
      contentBytes,
    )
    const xobjects = this.bands
      .map((band, index) => `${names[index]} ${band.object} 0 R`)
      .join(' ')
    await this.object(
      PAGE_OBJECT,
      `<< /Type /Page /Parent ${PAGES_OBJECT} 0 R /MediaBox [0 0 ${num(width)} ${num(height)}]` +
        (unit > 1 ? ` /UserUnit ${unit}` : '') +
        ` /Resources << /XObject << ${xobjects} >> >> /Contents ${CONTENT_OBJECT} 0 R >>`,
    )
    await this.object(
      PAGES_OBJECT,
      `<< /Type /Pages /Kids [${PAGE_OBJECT} 0 R] /Count 1 >>`,
    )
    await this.object(
      CATALOG_OBJECT,
      `<< /Type /Catalog /Pages ${PAGES_OBJECT} 0 R >>`,
    )
    const count = this.nextObject
    const xrefAt = this.offset
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`
    for (let object = 1; object < count; object += 1) {
      const at = this.offsets.get(object) ?? 0
      xref += `${String(at).padStart(10, '0')} 00000 n \n`
    }
    xref += `trailer\n<< /Size ${count} /Root ${CATALOG_OBJECT} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
    await this.write(encoder.encode(xref))
  }

  private async start(): Promise<void> {
    if (this.started) return
    this.started = true
    // 1.7 for `/UserUnit`; the binary comment marks the file as binary for
    // anything that sniffs it.
    await this.write(
      new Uint8Array([
        ...encoder.encode('%PDF-1.7\n%'),
        0xe2,
        0xe3,
        0xcf,
        0xd3,
        0x0a,
      ]),
    )
  }

  private async object(
    number: number,
    dictionary: string,
    stream?: Uint8Array,
  ): Promise<void> {
    this.offsets.set(number, this.offset)
    if (stream === undefined) {
      await this.write(
        encoder.encode(`${number} 0 obj\n${dictionary}\nendobj\n`),
      )
      return
    }
    await this.write(encoder.encode(`${number} 0 obj\n${dictionary}\nstream\n`))
    await this.write(stream)
    await this.write(encoder.encode('\nendstream\nendobj\n'))
  }

  private async write(bytes: Uint8Array): Promise<void> {
    this.offset += bytes.length
    await this.sink(bytes)
  }
}

// Fixed numbers for the objects written last, so the bands can be numbered
// as they arrive.
const CATALOG_OBJECT = 1
const PAGES_OBJECT = 2
const PAGE_OBJECT = 3
const CONTENT_OBJECT = 4
const FIRST_IMAGE_OBJECT = 5

/** A number as PDF writes it: no exponent, no needless digits. */
function num(value: number): string {
  return String(Math.round(value * 1000) / 1000)
}
