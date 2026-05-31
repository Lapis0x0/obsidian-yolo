import { parseFunAsrResponse } from './funasrLocalAdapter'

describe('parseFunAsrResponse', () => {
  it('keeps speaker labels for audio-file transcription results', () => {
    const parsed = parseFunAsrResponse(
      {
        text: '你好。请继续。',
        sentence_info: [
          {
            text: '你好。',
            start: 0,
            end: 1200,
            spk: 0,
          },
          {
            text: '请继续。',
            start: 1300,
            end: 2600,
            spk: 1,
          },
        ],
      },
      { speakerLabels: true },
    )

    expect(parsed.text).toBe('Speaker 1: 你好。\n\nSpeaker 2: 请继续。')
    expect(parsed.segments).toMatchObject([
      { text: '你好。', speakerId: '0', speakerLabel: 'Speaker 1' },
      { text: '请继续。', speakerId: '1', speakerLabel: 'Speaker 2' },
    ])
  })

  it('returns plain text for short dictation even when segments include speakers', () => {
    const parsed = parseFunAsrResponse({
      text: '你好。请继续。',
      sentence_info: [
        { text: '你好。', spk: 0 },
        { text: '请继续。', spk: 1 },
      ],
    })

    expect(parsed.text).toBe('你好。请继续。')
  })
})
