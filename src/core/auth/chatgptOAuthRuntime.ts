import { App } from 'obsidian'

import { ChatGPTOAuthService } from './chatgptOAuthService'
import { ChatGPTOAuthStore } from './chatgptOAuthStore'

let service: ChatGPTOAuthService | null = null

export const initializeChatGPTOAuthRuntime = (
  app: App,
  pluginId: string,
): ChatGPTOAuthService => {
  service = new ChatGPTOAuthService(new ChatGPTOAuthStore(app, pluginId))
  return service
}

export const getChatGPTOAuthService = (): ChatGPTOAuthService | null => service
