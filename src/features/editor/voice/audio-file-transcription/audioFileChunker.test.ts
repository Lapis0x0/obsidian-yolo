import { buildAudioFileChunkSchedule } from './audioFileChunker'

describe('buildAudioFileChunkSchedule', () => {
  it('caps effective chunk duration so overlapped WAV chunks stay within provider duration', () => {
    const schedule = buildAudioFileChunkSchedule({
      audioBuffer: { duration: 120 } as AudioBuffer,
      targetDurationSec: 120,
      overlapMs: 500,
      maxChunkDurationMs: 30_000,
    })

    expect(schedule.effectiveChunkDurationMs).toBe(29_000)
    expect(
      Math.max(
        ...schedule.chunks.map(
          (chunk) => chunk.actualEndMs - chunk.actualStartMs,
        ),
      ),
    ).toBeLessThanOrEqual(30_000)
  })
})
