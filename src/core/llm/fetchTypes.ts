export type UploadProgress = {
  sentBytes: number
  totalBytes: number
}

export type UploadProgressCallback = (progress: UploadProgress) => void

export type UploadProgressRequestInit = RequestInit & {
  /**
   * Best-effort upload progress hook used by ASR/TTS HTTP transports.
   * Ordinary LLM callers ignore it and still see a normal `fetch` shape.
   */
  onUploadProgress?: UploadProgressCallback
}

export type UploadProgressFetch = (
  input: Parameters<typeof fetch>[0],
  init?: UploadProgressRequestInit,
) => ReturnType<typeof fetch>
