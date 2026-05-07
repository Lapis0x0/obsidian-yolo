import type SmartComposerPlugin from '../../main'
import { buildAgentRuntimeInput } from '../../core/agent/buildAgentRuntimeInput'
import { runYoloAgentSubmission } from '../../core/agent/runYoloAgentSubmission'
import type { YoloRuntime } from '../yoloRuntime.types'

export function createObsidianRuntimeAgent(
  plugin: SmartComposerPlugin,
): YoloRuntime['agent'] {
  const getService = () => plugin.getAgentService()

  return {
    run: async (input) => {
      const agentService = getService()
      await runYoloAgentSubmission({
        input,
        buildAgentRuntimeInput: (nextInput) =>
          buildAgentRuntimeInput(plugin, nextInput),
        replaceConversationMessages: (
          conversationId,
          messages,
          compaction,
          options,
        ) =>
          agentService.replaceConversationMessages(
            conversationId,
            messages,
            compaction as any,
            options,
          ),
        runAgentService: (payload) =>
          agentService.run({
            conversationId: payload.conversationId,
            persistState: payload.persistState,
            input: payload.input,
            loopConfig: payload.loopConfig,
          }),
      })
    },
    abort: async (conversationId) => {
      getService().abortConversation(conversationId)
    },
    subscribe: (conversationId, listener) =>
      getService().subscribe(conversationId, listener),
    getState: (conversationId) => getService().getState(conversationId),
    getConversationRunSummary: (conversationId) =>
      getService().getConversationRunSummary(conversationId),
    getMessages: (conversationId) =>
      getService().getState(conversationId).messages,
    approveToolCall: (input) =>
      getService().approveToolCall(input),
    rejectToolCall: (input) =>
      getService().rejectToolCall(input),
    abortToolCall: (input) =>
      getService().abortToolCall(input),
    replaceConversationMessages: (conversationId, messages, compaction, options) =>
      getService().replaceConversationMessages(conversationId, messages, compaction as any, options),
    isRunning: (conversationId) =>
      getService().isRunning(conversationId),
    subscribeToRunSummaries: (callback) =>
      getService().subscribeToRunSummaries(callback),
    subscribeToPendingExternalAgentResults: (fn) =>
      getService().subscribeToPendingExternalAgentResults(fn),
  }
}
