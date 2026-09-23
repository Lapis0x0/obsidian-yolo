// Wire types for the Gemini `generateContent` REST API, limited to the fields
// this plugin reads or writes. Requests and responses are plain JSON, so these
// describe the JSON body — not an SDK's response class with computed getters.
// Reference: https://ai.google.dev/api/generate-content

export type GeminiFunctionCall = {
  id?: string
  name?: string
  args?: Record<string, unknown>
}

export type GeminiFunctionResponse = {
  id?: string
  name?: string
  response?: Record<string, unknown>
}

export type GeminiPart = {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  inlineData?: { mimeType?: string; data?: string }
  functionCall?: GeminiFunctionCall
  functionResponse?: GeminiFunctionResponse
}

export type GeminiContent = {
  role?: string
  parts?: GeminiPart[]
}

export type GeminiFunctionDeclaration = {
  name: string
  description?: string
  parametersJsonSchema?: unknown
}

export type GeminiTool = {
  functionDeclarations?: GeminiFunctionDeclaration[]
  googleSearch?: Record<string, never>
  urlContext?: Record<string, never>
}

export type GeminiToolConfig = {
  includeServerSideToolInvocations?: boolean
}

export type GeminiUsageMetadata = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
  cachedContentTokenCount?: number
}

export type GeminiGenerateContentResponse = {
  candidates?: {
    content?: GeminiContent
    finishReason?: string
  }[]
  usageMetadata?: GeminiUsageMetadata
  responseId?: string
}
