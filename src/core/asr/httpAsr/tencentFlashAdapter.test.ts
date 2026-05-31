import { parseTencentFlashResponse } from './tencentFlashAdapter'

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
})
