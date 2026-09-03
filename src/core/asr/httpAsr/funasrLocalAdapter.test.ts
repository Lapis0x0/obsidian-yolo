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
      {
        startMs: 0,
        endMs: 1200,
        text: '你好。',
        speakerId: '0',
        speakerLabel: 'Speaker 1',
      },
      {
        startMs: 1300,
        endMs: 2600,
        text: '请继续。',
        speakerId: '1',
        speakerLabel: 'Speaker 2',
      },
    ])
  })

  it('treats OpenAI-compatible segments start/end as seconds even past 1000 seconds', () => {
    const parsed = parseFunAsrResponse(
      {
        segments: [
          {
            start: 1002.45,
            end: 1003.69,
            text: 'minus of open class，',
            speaker: 2,
          },
          {
            start: 13659.08,
            end: 13661.2,
            text: '可能是一个不一样的事情。',
            speaker: 0,
          },
        ],
      },
      { speakerLabels: true },
    )

    expect(parsed.text).toBe(
      'Speaker 3: minus of open class，\n\nSpeaker 1: 可能是一个不一样的事情。',
    )
    expect(parsed.segments).toMatchObject([
      {
        startMs: 1002450,
        endMs: 1003690,
        text: 'minus of open class，',
        speakerId: '2',
        speakerLabel: 'Speaker 3',
      },
      {
        startMs: 13659080,
        endMs: 13661200,
        text: '可能是一个不一样的事情。',
        speakerId: '0',
        speakerLabel: 'Speaker 1',
      },
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
