import { useMemo } from 'react'

import { useApp } from '../contexts/app-context'
import { useSettings } from '../contexts/settings-context'
import { ChatManager } from '../database/json/chat/ChatManager'
// templates feature removed

export function useChatManager() {
  const app = useApp()
  const { settings } = useSettings()
  return useMemo(() => new ChatManager(app, settings), [app, settings])
}
