import { App } from 'obsidian'

import { CopilotOAuthService } from './copilotOAuthService'
import { CopilotOAuthStore } from './copilotOAuthStore'

const services = new Map<string, CopilotOAuthService>()

export const initializeCopilotOAuthRuntime = (
  app: App,
  pluginId: string,
  providerId: string,
): CopilotOAuthService => {
  const existing = services.get(providerId)
  if (existing) {
    return existing
  }

  const service = new CopilotOAuthService(
    new CopilotOAuthStore(app, pluginId, providerId),
  )
  services.set(providerId, service)
  return service
}

export const getCopilotOAuthService = (
  providerId: string,
): CopilotOAuthService | null => services.get(providerId) ?? null

export const clearCopilotOAuthService = (providerId: string): void => {
  services.delete(providerId)
}

export const clearAllCopilotOAuthServices = (): void => {
  services.clear()
}
