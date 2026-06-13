import type { VolcengineAucProviderProfile } from './volcengineAucAdapter'
import {
  buildVolcengineAucHeaders,
  buildVolcengineAucRequestBody,
  parseVolcengineAucResponse,
} from './volcengineAucAdapter'

const profile: VolcengineAucProviderProfile = {
  baseURL: 'https://openspeech.bytedance.com',
  apiKey: 'api-key',
  appId: '',
  resourceId: 'volc.bigasr.auc_turbo',
  transcriptionPath: '/api/v3/auc/bigmodel/recognize/flash',
  transportMode: 'node',
  punctuation: true,
  diarizeMode: 'auto',
}

describe('Volcengine AUC adapter helpers', () => {
  it('builds new-console headers with API key and resource id', () => {
    expect(
      buildVolcengineAucHeaders({
        profile,
        requestId: 'request-id',
        resourceId: 'volc.bigasr.auc_turbo',
        includeSequence: true,
      }),
    ).toEqual({
      'X-Api-Key': 'api-key',
      'X-Api-Resource-Id': 'volc.bigasr.auc_turbo',
      'X-Api-Request-Id': 'request-id',
      'X-Api-Sequence': '-1',
    })
  })

  it('builds recognition body with base64 audio and long-audio options', async () => {
    const body = await buildVolcengineAucRequestBody({
      profile,
      audio: { data: 'BASE64' },
      options: {
        language: 'zh-CN',
        purpose: 'audio-file-transcription',
      },
    })

    expect(body).toEqual({
      user: { uid: 'api-key' },
      audio: {
        data: 'BASE64',
      },
      request: {
        model_name: 'bigmodel',
        enable_itn: true,
        enable_punc: true,
        enable_speaker_info: true,
      },
    })
  })

  it('leaves auto speaker options off for context voice input', async () => {
    const body = await buildVolcengineAucRequestBody({
      profile,
      audio: { data: 'BASE64' },
      options: { purpose: 'context-voice-input' },
    })

    expect(body).toMatchObject({
      request: {
        enable_speaker_info: false,
      },
    })
  })

  it('forces speaker options on when the mode is on', async () => {
    const body = await buildVolcengineAucRequestBody({
      profile: { ...profile, diarizeMode: 'on' },
      audio: { data: 'BASE64' },
      options: { purpose: 'context-voice-input' },
    })

    expect(body).toMatchObject({
      request: {
        enable_speaker_info: true,
      },
    })
  })

  it('parses text and utterance segments from flash/query responses', () => {
    expect(
      parseVolcengineAucResponse({
        result: {
          text: '整段文本',
          utterances: [
            {
              start_time: 100,
              end_time: 400,
              text: '第一句',
              speaker_id: 1,
            },
            {
              start_time: 500,
              end_time: 900,
              text: '第二句',
              speaker_id: 2,
            },
          ],
        },
      }),
    ).toEqual({
      text: '整段文本',
      segments: [
        {
          startMs: 100,
          endMs: 400,
          text: '第一句',
          speakerId: '1',
          speakerLabel: 'Speaker 1',
        },
        {
          startMs: 500,
          endMs: 900,
          text: '第二句',
          speakerId: '2',
          speakerLabel: 'Speaker 2',
        },
      ],
    })
  })
})
