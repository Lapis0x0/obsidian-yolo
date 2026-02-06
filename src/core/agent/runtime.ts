import { ChatMessage } from '../../types/chat'

import { AgentRuntimeRunInput, AgentRuntimeSubscribe } from './types'

export type AgentRuntime = {
  subscribe(callback: AgentRuntimeSubscribe): () => void
  run(input: AgentRuntimeRunInput): Promise<void>
  abort(): void
  getMessages(): ChatMessage[]
}
