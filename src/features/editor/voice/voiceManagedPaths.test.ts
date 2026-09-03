import { parseYoloSettings } from '../../../settings/schema/settings'

import { rebaseVoiceManagedPaths } from './voiceManagedPaths'

describe('rebaseVoiceManagedPaths', () => {
  it('rebases voice destinations stored under the moved YOLO root', () => {
    const settings = parseYoloSettings({
      version: 77,
      yolo: { baseDir: 'YOLO' },
      contextVoiceInputOptions: {
        readAloudGeneratedAudioSaveDir: 'YOLO/custom/audio',
        audioFileFallbackNotePathTemplate:
          'YOLO/custom/transcripts/{{basename}}.md',
      },
    })

    const result = rebaseVoiceManagedPaths(settings, 'YOLO', 'Config/YOLO')

    expect(result.contextVoiceInputOptions).toMatchObject({
      readAloudGeneratedAudioSaveDir: 'Config/YOLO/custom/audio',
      audioFileFallbackNotePathTemplate:
        'Config/YOLO/custom/transcripts/{{basename}}.md',
    })
  })

  it('preserves destinations outside the moved YOLO root', () => {
    const settings = parseYoloSettings({
      version: 77,
      contextVoiceInputOptions: {
        readAloudGeneratedAudioSaveDir: 'Media/audio',
        audioFileFallbackNotePathTemplate: 'Transcripts/{{basename}}.md',
      },
    })

    expect(rebaseVoiceManagedPaths(settings, 'YOLO', 'Config/YOLO')).toBe(
      settings,
    )
  })

  it('keeps explicit simultaneous edits and rejects similar prefixes', () => {
    const previousSettings = parseYoloSettings({
      version: 77,
      yolo: { baseDir: 'YOLO' },
      contextVoiceInputOptions: {
        readAloudGeneratedAudioSaveDir: 'YOLO/read_aloud',
        audioFileFallbackNotePathTemplate:
          'YOLO/transcriptions/{{basename}}.md',
      },
    })
    const settings = parseYoloSettings({
      ...previousSettings,
      yolo: { baseDir: 'Config/YOLO' },
      contextVoiceInputOptions: {
        ...previousSettings.contextVoiceInputOptions,
        readAloudGeneratedAudioSaveDir: 'YOLO-archive/audio',
      },
    })

    const result = rebaseVoiceManagedPaths(
      settings,
      'YOLO',
      'Config/YOLO',
      previousSettings,
    )

    expect(result.contextVoiceInputOptions).toMatchObject({
      readAloudGeneratedAudioSaveDir: 'YOLO-archive/audio',
      audioFileFallbackNotePathTemplate:
        'Config/YOLO/transcriptions/{{basename}}.md',
    })
  })

  it('rebases an exact root but not a similarly prefixed path', () => {
    const settings = parseYoloSettings({
      version: 77,
      contextVoiceInputOptions: {
        readAloudGeneratedAudioSaveDir: 'YOLO',
        audioFileFallbackNotePathTemplate: 'YOLO-archive/{{basename}}.md',
      },
    })

    const result = rebaseVoiceManagedPaths(settings, 'YOLO', 'Config/YOLO')

    expect(result.contextVoiceInputOptions).toMatchObject({
      readAloudGeneratedAudioSaveDir: 'Config/YOLO',
      audioFileFallbackNotePathTemplate: 'YOLO-archive/{{basename}}.md',
    })
  })

  it('rebases paths when a hidden legacy root becomes visible', () => {
    const settings = parseYoloSettings({
      version: 77,
      yolo: { baseDir: '.yolo' },
      contextVoiceInputOptions: {
        readAloudGeneratedAudioSaveDir: '.yolo/read_aloud',
        audioFileFallbackNotePathTemplate:
          '.yolo/transcriptions/{{basename}}.md',
      },
    })

    const result = rebaseVoiceManagedPaths(settings, '.yolo', 'yolo')

    expect(result.contextVoiceInputOptions).toMatchObject({
      readAloudGeneratedAudioSaveDir: 'yolo/read_aloud',
      audioFileFallbackNotePathTemplate: 'yolo/transcriptions/{{basename}}.md',
    })
  })
})
