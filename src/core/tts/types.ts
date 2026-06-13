import type {
  TtsConfig,
  TtsOutputFormat,
} from '../../settings/schema/setting.types'

export type TtsSynthesisRequest = {
  text: string
  voice: string
  model: string
  format: TtsOutputFormat
  sampleRate?: number
  speed?: number
  pitch?: number
  volume?: number
  language?: string
  styleInstruction?: string
  signal?: AbortSignal
}

export type TtsSynthesisFileResult = {
  kind: 'file'
  bytes: ArrayBuffer
  mimeType: string
  format: Exclude<TtsOutputFormat, 'pcm' | 'pcm16'>
}

export type TtsSynthesisResult = TtsSynthesisFileResult

export type TtsProviderCapabilities = {
  maxInputChars?: number
}

export type TtsProvider = {
  readonly format: TtsConfig['format']
  readonly capabilities?: TtsProviderCapabilities
  synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult>
}

export type TtsProviderProfile = Pick<
  TtsConfig,
  | 'baseURL'
  | 'apiKey'
  | 'model'
  | 'voice'
  | 'outputFormat'
  | 'sampleRate'
  | 'speed'
  | 'pitch'
  | 'volume'
  | 'language'
  | 'styleInstruction'
  | 'transportMode'
  | 'requestPath'
>
