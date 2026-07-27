import {
  base64ToArrayBuffer,
  extensionForAudioFormat,
  findAudioUrlString,
  findBase64AudioString,
  joinUrl,
  mimeTypeForAudioFormat,
  wrapPcm16AsWav,
} from './utils'

const arrayBufferToString = (buffer: ArrayBuffer): string =>
  String.fromCharCode(...new Uint8Array(buffer))

describe('TTS utils', () => {
  it('joins base URLs and paths without duplicate slashes', () => {
    expect(joinUrl('https://api.example.com/v1/', '/audio/speech')).toBe(
      'https://api.example.com/v1/audio/speech',
    )
    expect(joinUrl('https://api.example.com', 'https://tts.local/speech')).toBe(
      'https://tts.local/speech',
    )
  })

  it('maps raw PCM output to a WAV file surface', () => {
    expect(mimeTypeForAudioFormat('pcm')).toBe('audio/wav')
    expect(extensionForAudioFormat('pcm')).toBe('wav')
    expect(mimeTypeForAudioFormat('pcm16')).toBe('audio/wav')
    expect(extensionForAudioFormat('pcm16')).toBe('wav')
  })

  it('finds nested base64 audio strings', () => {
    const payload = {
      choices: [
        {
          message: {
            audio: {
              data: 'data:audio/mp3;base64,SGVsbG8sIFRUUyE=',
            },
          },
        },
      ],
    }

    expect(findBase64AudioString(payload)).toBe(
      'data:audio/mp3;base64,SGVsbG8sIFRUUyE=',
    )
  })

  it('finds nested audio URL strings without treating them as base64', () => {
    const payload = {
      output: {
        audio: {
          data: '',
          url: 'https://example.com/audio.mp3?sig=1',
        },
      },
    }

    expect(findBase64AudioString(payload)).toBeNull()
    expect(findAudioUrlString(payload)).toBe(
      'https://example.com/audio.mp3?sig=1',
    )
  })

  it('decodes data-URL base64 audio payloads', () => {
    const decoded = base64ToArrayBuffer('data:audio/mp3;base64,SGVsbG8=')

    expect(arrayBufferToString(decoded)).toBe('Hello')
  })

  it('wraps raw PCM16 bytes in a WAV container', () => {
    const pcm = new Uint8Array([1, 0, 2, 0]).buffer
    const wav = wrapPcm16AsWav({
      pcm,
      sampleRate: 24000,
      channels: 1,
    })
    const view = new DataView(wav)

    expect(arrayBufferToString(wav.slice(0, 4))).toBe('RIFF')
    expect(arrayBufferToString(wav.slice(8, 12))).toBe('WAVE')
    expect(view.getUint32(24, true)).toBe(24000)
    expect(view.getUint32(40, true)).toBe(4)
    expect(new Uint8Array(wav).slice(44)).toEqual(new Uint8Array(pcm))
  })
})
