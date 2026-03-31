import { App } from 'obsidian'

import { GeminiOAuthService } from './geminiOAuthService'
import { GeminiOAuthStore } from './geminiOAuthStore'

const services = new Map<string, GeminiOAuthService>()

export const initializeGeminiOAuthRuntime = (
  app: App,
  pluginId: string,
  providerId = 'gemini-oauth',
): GeminiOAuthService => {
  const existing = services.get(providerId)
  if (existing) {
    return existing
  }

  const service = new GeminiOAuthService(
    new GeminiOAuthStore(app, pluginId, providerId),
  )
  services.set(providerId, service)
  return service
}

export const getGeminiOAuthService = (
  providerId = 'gemini-oauth',
): GeminiOAuthService | null => services.get(providerId) ?? null

export const clearGeminiOAuthService = (providerId: string): void => {
  services.delete(providerId)
}
