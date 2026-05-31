import type { TtsSynthesisFileResult } from '../../../../core/tts/types'

import {
  GENERATED_AUDIO_DRAG_MIME,
  applyGeneratedAudioDragData,
} from './generatedAudioDragSource'

const audio: TtsSynthesisFileResult = {
  kind: 'file',
  bytes: new TextEncoder().encode('audio').buffer,
  mimeType: 'audio/mpeg',
  format: 'mp3',
}

const OriginalFile = globalThis.File

beforeAll(() => {
  class TestFile extends Blob {
    readonly name: string
    constructor(parts: BlobPart[], name: string, options?: FilePropertyBag) {
      super(parts, options)
      this.name = name
    }
  }
  ;(globalThis as { File: typeof File }).File = TestFile as typeof File
})

afterAll(() => {
  ;(globalThis as { File: typeof File }).File = OriginalFile
})

function createDragEventMock(options?: { rejectFile?: boolean }): {
  event: DragEvent
  setData: jest.Mock
  add: jest.Mock
  transfer: DataTransfer
} {
  const setData = jest.fn()
  const add = jest.fn(() => {
    if (options?.rejectFile) throw new Error('rejected')
  })
  const transfer = {
    items: { add },
    setData,
    effectAllowed: 'none',
  } as unknown as DataTransfer
  return {
    event: { dataTransfer: transfer } as DragEvent,
    setData,
    add,
    transfer,
  }
}

describe('generated audio drag source', () => {
  it('uses a saved vault path when one exists', () => {
    const { event, setData, transfer } = createDragEventMock()

    expect(
      applyGeneratedAudioDragData(event, {
        segmentIndex: 0,
        audio,
        savedPath: 'YOLO/read_aloud/selection.mp3',
        sourceName: 'selection',
      }),
    ).toBe(true)

    expect(setData).toHaveBeenCalledWith(
      'text/markdown',
      '![[YOLO/read_aloud/selection.mp3]]',
    )
    expect(setData).toHaveBeenCalledWith(GENERATED_AUDIO_DRAG_MIME, '1')
    expect(transfer.effectAllowed).toBe('copy')
  })

  it('does not advertise a fake markdown path for unsaved audio', () => {
    const { event, setData } = createDragEventMock()

    expect(
      applyGeneratedAudioDragData(event, {
        segmentIndex: 0,
        audio,
        savedPath: null,
        sourceName: 'selection',
      }),
    ).toBe(true)

    expect(setData).toHaveBeenCalledTimes(1)
    expect(setData).toHaveBeenCalledWith(GENERATED_AUDIO_DRAG_MIME, '1')
  })

  it('cancels unsaved drags when the runtime rejects file items', () => {
    const { event } = createDragEventMock({ rejectFile: true })

    expect(
      applyGeneratedAudioDragData(event, {
        segmentIndex: 0,
        audio,
        savedPath: null,
        sourceName: 'selection',
      }),
    ).toBe(false)
  })
})
