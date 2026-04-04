import { App } from 'obsidian'

import { QwenOAuthService } from './qwenOAuthService'
import { QwenOAuthStore } from './qwenOAuthStore'

const services = new Map<string, QwenOAuthService>()

export const initializeQwenOAuthRuntime = (
  app: App,
  pluginId: string,
  providerId = 'qwen-oauth',
): QwenOAuthService => {
  const existing = services.get(providerId)
  if (existing) {
    return existing
  }

  const service = new QwenOAuthService(
    new QwenOAuthStore(app, pluginId, providerId),
  )
  services.set(providerId, service)
  return service
}

export const getQwenOAuthService = (
  providerId = 'qwen-oauth',
): QwenOAuthService | null => services.get(providerId) ?? null

export const clearQwenOAuthService = (providerId: string): void => {
  services.delete(providerId)
}
