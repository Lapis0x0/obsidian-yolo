import { migrateFrom65To66 } from './65_to_66'

describe('migrateFrom65To66', () => {
  it('adds disabled audio file transcription defaults', () => {
    const result = migrateFrom65To66({
      version: 65,
      contextVoiceInputOptions: {
        enabled: true,
        interactionMode: 'toggle-listen',
      },
    })

    expect(result.version).toBe(66)
    expect(result.contextVoiceInputOptions).toMatchObject({
      enabled: true,
      audioFileTranscriptionEnabled: false,
      activeAudioFileAsrConfigId: '',
      audioFileChunkHeaderMode: 'none',
      audioFileOutputMetadataMode: 'none',
      audioFileFallbackNotePathTemplate:
        'Transcriptions/{{date}} {{time}} {{basename}}.md',
      audioFileChunkTargetDurationSec: 120,
      audioFileMaxConcurrentChunks: 5,
      audioFileChunkStartStaggerMs: 1500,
      audioFileChunkOverlapMs: 500,
    })
  })

  it('clamps numeric audio file settings', () => {
    const result = migrateFrom65To66({
      version: 65,
      contextVoiceInputOptions: {
        audioFileTranscriptionEnabled: true,
        audioFileChunkTargetDurationSec: 999,
        audioFileMaxConcurrentChunks: 99,
        audioFileChunkStartStaggerMs: 10,
        audioFileChunkOverlapMs: -1,
      },
    })

    expect(result.contextVoiceInputOptions).toMatchObject({
      audioFileTranscriptionEnabled: true,
      audioFileChunkTargetDurationSec: 600,
      audioFileMaxConcurrentChunks: 5,
      audioFileChunkStartStaggerMs: 1000,
      audioFileChunkOverlapMs: 0,
    })
  })

  it('allows shorter chunk targets for stricter upload providers', () => {
    const result = migrateFrom65To66({
      version: 65,
      contextVoiceInputOptions: {
        audioFileChunkTargetDurationSec: 5,
      },
    })

    expect(result.contextVoiceInputOptions).toMatchObject({
      audioFileChunkTargetDurationSec: 15,
    })
  })
})
