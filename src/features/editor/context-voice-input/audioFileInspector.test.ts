import { inspectAudioFile } from './audioFileInspector'
import type { AudioFileSource } from './audioFileSource'

const originalAudio = globalThis.Audio

afterEach(() => {
  Object.defineProperty(globalThis, 'Audio', {
    configurable: true,
    value: originalAudio,
  })
})

describe('inspectAudioFile', () => {
  it('reads m4a duration from mp4 metadata when browser metadata is unavailable', async () => {
    Object.defineProperty(globalThis, 'Audio', {
      configurable: true,
      value: undefined,
    })
    const bytes = buildMp4Fixture({ durationMs: 123_456 })
    const getFile = jest.fn(async () => {
      throw new Error('should not materialize')
    })
    const source = createByteSource({
      bytes,
      name: 'meeting.m4a',
      type: 'audio/mp4',
      getFile,
    })

    const inspection = await inspectAudioFile(source, { decode: false })

    expect(inspection.durationMs).toBe(123_456)
    expect(inspection.mp4MoovPosition).toBe('after-mdat')
    expect(getFile).not.toHaveBeenCalled()
  })

  it('recognizes fast-start m4a metadata before media data', async () => {
    Object.defineProperty(globalThis, 'Audio', {
      configurable: true,
      value: undefined,
    })
    const bytes = buildMp4Fixture({
      durationMs: 123_456,
      moovBeforeMdat: true,
    })
    const getFile = jest.fn(async () => {
      throw new Error('should not materialize')
    })
    const source = createByteSource({
      bytes,
      name: 'meeting.m4a',
      type: 'audio/mp4',
      getFile,
    })

    const inspection = await inspectAudioFile(source, { decode: false })

    expect(inspection.durationMs).toBe(123_456)
    expect(inspection.mp4MoovPosition).toBe('before-mdat')
    expect(getFile).not.toHaveBeenCalled()
  })
})

function createByteSource(input: {
  bytes: Uint8Array
  name: string
  type: string
  getFile: AudioFileSource['getFile']
}): AudioFileSource {
  return {
    kind: 'blob',
    name: input.name,
    size: input.bytes.byteLength,
    type: input.type,
    lastModified: 0,
    getFile: input.getFile,
    async readSlice(start, end) {
      return new Blob([input.bytes.slice(start, end)], { type: input.type })
    },
    async createObjectUrl() {
      return null
    },
  }
}

function buildMp4Fixture(input: {
  durationMs: number
  moovBeforeMdat?: boolean
}): Uint8Array {
  const timescale = 1000
  const mvhdPayload = new Uint8Array(20)
  writeUint32Be(mvhdPayload, 12, timescale)
  writeUint32Be(mvhdPayload, 16, input.durationMs)
  const mediaData = box('mdat', new Uint8Array([1, 2, 3, 4]))
  const metadata = box('moov', box('mvhd', mvhdPayload))
  return concatBytes(
    box('ftyp', new Uint8Array([0x4d, 0x34, 0x41, 0x20])),
    ...(input.moovBeforeMdat ? [metadata, mediaData] : [mediaData, metadata]),
  )
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.byteLength)
  writeUint32Be(bytes, 0, bytes.byteLength)
  for (let i = 0; i < type.length; i++) {
    bytes[4 + i] = type.charCodeAt(i)
  }
  bytes.set(payload, 8)
  return bytes
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function writeUint32Be(bytes: Uint8Array, offset: number, value: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4)
  view.setUint32(0, value, false)
}
