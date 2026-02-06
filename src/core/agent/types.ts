import { ReasoningLevel } from '../../components/chat-view/chat-input/ReasoningSelect'
import { ChatMessage } from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import { LLMProvider } from '../../types/provider.types'
import { PromptGenerator } from '../../utils/chat/promptGenerator'
import { BaseLLMProvider } from '../llm/base'
import { McpManager } from '../mcp/mcpManager'

export type AgentRuntimeSubscribe = (messages: ChatMessage[]) => void

export type AgentRuntimeRunInput = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  messages: ChatMessage[]
  conversationId: string
  promptGenerator: PromptGenerator
  mcpManager: McpManager
  abortSignal?: AbortSignal
  reasoningLevel?: ReasoningLevel
  requestParams?: {
    stream?: boolean
    temperature?: number
    top_p?: number
  }
  maxContextOverride?: number
  geminiTools?: {
    useWebSearch?: boolean
    useUrlContext?: boolean
  }
}

export type AgentRuntimeLoopConfig = {
  enableTools: boolean
  maxAutoIterations: number
  includeBuiltinTools: boolean
}

export type AgentWorkerInbound =
  | {
      type: 'start'
      runId: string
      maxIterations: number
      hasTools: boolean
    }
  | {
      type: 'llm_result'
      runId: string
      hasToolCalls: boolean
    }
  | {
      type: 'tool_result'
      runId: string
      hasPendingTools: boolean
    }
  | {
      type: 'abort'
      runId: string
    }

export type AgentWorkerOutbound =
  | {
      type: 'llm_request'
      runId: string
      iteration: number
    }
  | {
      type: 'tool_phase'
      runId: string
    }
  | {
      type: 'done'
      runId: string
      reason: 'completed' | 'max_iterations' | 'aborted' | 'no_tools'
    }
  | {
      type: 'error'
      runId: string
      error: string
    }
