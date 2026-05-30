import { trimDuplicateChunkBoundary } from './audioFileTranscriptionService'

describe('trimDuplicateChunkBoundary', () => {
  it('removes an exact short phrase repeated across chunk overlap', () => {
    expect(
      trimDuplicateChunkBoundary(
        'We should ship the audio plan after review',
        'after review and then update the checklist',
      ),
    ).toBe('and then update the checklist')
  })

  it('leaves non-identical overlap candidates untouched', () => {
    expect(
      trimDuplicateChunkBoundary(
        'We should ship the audio plan after review',
        'after reviewing the checklist',
      ),
    ).toBe('after reviewing the checklist')
  })
})
