import { App } from 'obsidian'

import { ChatGPTOAuthService } from './chatgptOAuthService'
import { ChatGPTOAuthStore } from './chatgptOAuthStore'

const services = new Map<string, ChatGPTOAuthService>()

export const initializeChatGPTOAuthRuntime = (
  app: App,
  pluginId: string,
  providerId = 'chatgpt-oauth',
): ChatGPTOAuthService => {
  const existing = services.get(providerId)
  if (existing) {
    return existing
  }

  const service = new ChatGPTOAuthService(
    new ChatGPTOAuthStore(app, pluginId, providerId),
  )
  services.set(providerId, service)
  return service
}

export const getChatGPTOAuthService = (
  providerId = 'chatgpt-oauth',
): ChatGPTOAuthService | null => services.get(providerId) ?? null

export const clearChatGPTOAuthService = (providerId: string): void => {
  services.get(providerId)?.dispose()
  services.delete(providerId)
}

export const clearAllChatGPTOAuthServices = (): void => {
  for (const service of services.values()) {
    service.dispose()
  }
  services.clear()
}
