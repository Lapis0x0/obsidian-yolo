import {
  buildTencentFlashRequest,
  parseTencentFlashResponse,
} from './tencentFlashAdapter'

describe('parseTencentFlashResponse', () => {
  it('formats sentence speaker ids from flash_result', () => {
    const parsed = parseTencentFlashResponse({
      code: 0,
      flash_result: [
        {
          text: '你好。请继续。',
          channel_id: 0,
          sentence_list: [
            {
              text: '你好。',
              start_time: 0,
              end_time: 520,
              speaker_id: 0,
            },
            {
              text: '请继续。',
              start_time: 600,
              end_time: 1200,
              speaker_id: 1,
            },
          ],
        },
      ],
    })

    expect(parsed.text).toBe('Speaker 1: 你好。\n\nSpeaker 2: 请继续。')
    expect(parsed.segments).toMatchObject([
      { startMs: 0, endMs: 520, speakerLabel: 'Speaker 1' },
      { startMs: 600, endMs: 1200, speakerLabel: 'Speaker 2' },
    ])
  })

  it('throws provider errors with the response message', () => {
    expect(() =>
      parseTencentFlashResponse({ code: 100, message: '签名失败' }),
    ).toThrow('签名失败')
  })

  it('can return plain dictation text when speaker labels are disabled', () => {
    const parsed = parseTencentFlashResponse(
      {
        code: 0,
        flash_result: [
          {
            sentence_list: [
              { text: '你好。', speaker_id: 0 },
              { text: '请继续。', speaker_id: 1 },
            ],
          },
        ],
      },
      { speakerLabels: false },
    )

    expect(parsed.text).toBe('你好。\n请继续。')
  })
})

describe('buildTencentFlashRequest', () => {
  const baseInput = {
    profile: {
      baseURL: 'https://asr.cloud.tencent.com',
      appId: '123',
      secretId: 'secret-id',
      secretKey: 'secret-key',
      engineType: '16k_zh',
      transcriptionPath: '/asr/flash/v1',
      transportMode: 'node' as const,
      diarizeMode: 'auto' as const,
      timestamps: true,
    },
    input: {
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }),
      mimeType: 'audio/wav',
    },
    body: new ArrayBuffer(0),
  }

  it('resolves auto speaker options by purpose', async () => {
    const context = await buildTencentFlashRequest({
      ...baseInput,
      options: { purpose: 'context-voice-input' },
    })
    const file = await buildTencentFlashRequest({
      ...baseInput,
      options: { purpose: 'audio-file-transcription' },
    })

    expect(new URL(context.url).searchParams.get('speaker_diarization')).toBe(
      '0',
    )
    expect(new URL(file.url).searchParams.get('speaker_diarization')).toBe('1')
    expect(new URL(file.url).searchParams.get('word_info')).toBe('1')
  })

  it('forces speaker options on when the mode is on', async () => {
    const request = await buildTencentFlashRequest({
      ...baseInput,
      profile: { ...baseInput.profile, diarizeMode: 'on' },
      options: { purpose: 'context-voice-input' },
    })

    expect(new URL(request.url).searchParams.get('speaker_diarization')).toBe(
      '1',
    )
  })
})
