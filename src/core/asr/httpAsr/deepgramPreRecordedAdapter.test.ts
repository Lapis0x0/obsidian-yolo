import {
  buildDeepgramPreRecordedUrl,
  parseDeepgramPreRecordedResponse,
} from './deepgramPreRecordedAdapter'

describe('parseDeepgramPreRecordedResponse', () => {
  it('formats utterance speaker labels with blank lines between speakers', () => {
    const parsed = parseDeepgramPreRecordedResponse({
      results: {
        utterances: [
          { start: 0, end: 1.2, transcript: 'hello', speaker: 0 },
          { start: 1.3, end: 2, transcript: 'again', speaker: 0 },
          { start: 2.1, end: 3, transcript: 'hi', speaker: 1 },
        ],
      },
    })

    expect(parsed.text).toBe('Speaker 1: hello again\n\nSpeaker 2: hi')
    expect(parsed.segments).toMatchObject([
      { startMs: 0, endMs: 1200, speakerLabel: 'Speaker 1' },
      { startMs: 1300, endMs: 2000, speakerLabel: 'Speaker 1' },
      { startMs: 2100, endMs: 3000, speakerLabel: 'Speaker 2' },
    ])
  })

  it('falls back to word speaker aggregation when utterances are absent', () => {
    const parsed = parseDeepgramPreRecordedResponse({
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: 'hello world',
                words: [
                  { start: 0, end: 0.5, punctuated_word: 'Hello', speaker: 0 },
                  { start: 0.5, end: 1, punctuated_word: 'world.', speaker: 0 },
                  { start: 1, end: 1.4, punctuated_word: 'Yes.', speaker: 1 },
                ],
              },
            ],
          },
        ],
      },
    })

    expect(parsed.text).toBe('Speaker 1: Hello world.\n\nSpeaker 2: Yes.')
  })

  it('normalizes spaced CJK channel transcript when one speaker utterances are present', () => {
    const parsed = parseDeepgramPreRecordedResponse({
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: '你 好 谢谢 小 笼 包 再见',
              },
            ],
          },
        ],
        utterances: [
          {
            start: 0.8,
            end: 5.12,
            transcript: '你 好 谢谢 小 笼 包 再见',
            speaker: 0,
            words: [
              { punctuated_word: '你', speaker: 0 },
              { punctuated_word: '好', speaker: 0 },
              { punctuated_word: '谢谢', speaker: 0 },
              { punctuated_word: '小', speaker: 0 },
              { punctuated_word: '笼', speaker: 0 },
              { punctuated_word: '包', speaker: 0 },
              { punctuated_word: '再见', speaker: 0 },
            ],
          },
        ],
      },
    })

    expect(parsed.text).toBe('Speaker 1: 你好谢谢小笼包再见')
    expect(parsed.segments[0]?.text).toBe('你好谢谢小笼包再见')
  })

  it('normalizes spaced CJK utterance transcripts across speaker blocks', () => {
    const parsed = parseDeepgramPreRecordedResponse({
      results: {
        utterances: [
          { start: 0, end: 1.2, transcript: '你 好', speaker: 0 },
          { start: 1.3, end: 2, transcript: '谢 谢', speaker: 0 },
          { start: 2.1, end: 3, transcript: '再 见', speaker: 1 },
        ],
      },
    })

    expect(parsed.text).toBe('Speaker 1: 你好谢谢\n\nSpeaker 2: 再见')
    expect(parsed.segments).toMatchObject([
      { text: '你好', speakerLabel: 'Speaker 1' },
      { text: '谢谢', speakerLabel: 'Speaker 1' },
      { text: '再见', speakerLabel: 'Speaker 2' },
    ])
  })

  it('normalizes spaced CJK words when falling back to word speakers', () => {
    const parsed = parseDeepgramPreRecordedResponse({
      results: {
        channels: [
          {
            alternatives: [
              {
                words: [
                  { start: 0, end: 0.2, punctuated_word: '你', speaker: 0 },
                  { start: 0.2, end: 0.4, punctuated_word: '好', speaker: 0 },
                  { start: 0.4, end: 0.5, punctuated_word: '，', speaker: 0 },
                  { start: 0.5, end: 0.8, punctuated_word: '世界', speaker: 0 },
                ],
              },
            ],
          },
        ],
      },
    })

    expect(parsed.text).toBe('Speaker 1: 你好，世界')
  })

  it('can return plain dictation text even when speaker metadata is present', () => {
    const parsed = parseDeepgramPreRecordedResponse(
      {
        results: {
          channels: [
            {
              alternatives: [
                {
                  transcript: 'hello again hi',
                },
              ],
            },
          ],
          utterances: [
            { start: 0, end: 1.2, transcript: 'hello', speaker: 0 },
            { start: 1.3, end: 2, transcript: 'again', speaker: 0 },
            { start: 2.1, end: 3, transcript: 'hi', speaker: 1 },
          ],
        },
      },
      { speakerLabels: false },
    )

    expect(parsed.text).toBe('hello again hi')
  })
})

describe('buildDeepgramPreRecordedUrl', () => {
  it('uses current pre-recorded diarization parameters', () => {
    const url = new URL(
      buildDeepgramPreRecordedUrl(
        {
          baseURL: 'https://api.deepgram.com',
          apiKey: 'key',
          model: 'nova-3',
          transcriptionPath: '/v1/listen',
          transportMode: 'node',
          language: 'auto',
          punctuation: true,
          diarizeMode: 'auto',
          timestamps: true,
        },
        { language: 'zh', purpose: 'audio-file-transcription' },
      ),
    )

    expect(url.pathname).toBe('/v1/listen')
    expect(url.searchParams.get('model')).toBe('nova-3')
    expect(url.searchParams.get('language')).toBe('zh')
    expect(url.searchParams.get('smart_format')).toBe('true')
    expect(url.searchParams.get('punctuate')).toBe('true')
    expect(url.searchParams.get('diarize_model')).toBe('latest')
    expect(url.searchParams.get('utterances')).toBe('true')
  })

  it('can disable Deepgram pre-recorded punctuation formatting', () => {
    const url = new URL(
      buildDeepgramPreRecordedUrl({
        baseURL: 'https://api.deepgram.com',
        apiKey: 'key',
        model: 'nova-3',
        transcriptionPath: '/v1/listen',
        transportMode: 'node',
        language: 'zh',
        punctuation: false,
        diarizeMode: 'auto',
        timestamps: true,
      }),
    )

    expect(url.searchParams.get('language')).toBe('zh')
    expect(url.searchParams.get('smart_format')).toBeNull()
    expect(url.searchParams.get('punctuate')).toBeNull()
    expect(url.searchParams.get('diarize_model')).toBeNull()
    expect(url.searchParams.get('utterances')).toBeNull()
  })

  it('leaves auto diarization off for context voice input', () => {
    const url = new URL(
      buildDeepgramPreRecordedUrl(
        {
          baseURL: 'https://api.deepgram.com',
          apiKey: 'key',
          model: 'nova-3',
          transcriptionPath: '/v1/listen',
          transportMode: 'node',
          language: 'zh',
          punctuation: true,
          diarizeMode: 'auto',
          timestamps: true,
        },
        { purpose: 'context-voice-input' },
      ),
    )

    expect(url.searchParams.get('diarize_model')).toBeNull()
    expect(url.searchParams.get('utterances')).toBeNull()
  })

  it('forces diarization on when the mode is on', () => {
    const url = new URL(
      buildDeepgramPreRecordedUrl(
        {
          baseURL: 'https://api.deepgram.com',
          apiKey: 'key',
          model: 'nova-3',
          transcriptionPath: '/v1/listen',
          transportMode: 'node',
          language: 'zh',
          punctuation: true,
          diarizeMode: 'on',
          timestamps: true,
        },
        { purpose: 'context-voice-input' },
      ),
    )

    expect(url.searchParams.get('diarize_model')).toBe('latest')
    expect(url.searchParams.get('utterances')).toBe('true')
  })
})
