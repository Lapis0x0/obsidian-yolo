import { estimatePcm16WavByteLength } from './audioTranscode'

describe('estimatePcm16WavByteLength', () => {
  it('uses fixed 16 kHz mono 16-bit PCM WAV sizing', () => {
    expect(estimatePcm16WavByteLength(1000)).toBe(44 + 16_000 * 2)
    expect(estimatePcm16WavByteLength(60 * 60 * 1000)).toBe(
      44 + 60 * 60 * 16_000 * 2,
    )
  })
})
