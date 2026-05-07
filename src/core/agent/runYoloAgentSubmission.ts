import type { RunYoloAgentInput } from '../../runtime/yoloRuntime.types'

import type { BuildAgentRuntimeResult } from './buildAgentRuntimeInput'

type AgentServiceRunPayload = {
  conversationId: string
  input: BuildAgentRuntimeResult['input']
  loopConfig: BuildAgentRuntimeResult['loopConfig']
  persistState?: boolean
}

export async function runYoloAgentSubmission({
  input,
  buildAgentRuntimeInput,
  replaceConversationMessages,
  runAgentService,
}: {
  input: RunYoloAgentInput
  buildAgentRuntimeInput: (
    input: RunYoloAgentInput,
  ) => Promise<BuildAgentRuntimeResult>
  replaceConversationMessages: (
    conversationId: string,
    messages: RunYoloAgentInput['messages'],
    compaction: RunYoloAgentInput['compaction'] | [],
    options?: { persistState?: boolean },
  ) => void
  runAgentService: (payload: AgentServiceRunPayload) => Promise<void>
}): Promise<void> {
  const baseMessages = input.conversationMessages ?? input.messages
  replaceConversationMessages(
    input.conversationId,
    baseMessages,
    input.compaction ?? [],
    { persistState: true },
  )

  const requestMessages = input.requestMessages ?? input.messages
  const lastRequestMessage = requestMessages.at(-1)
  const modelIds = input.modelIds ?? []
  const shouldFanOutMultiModel =
    !input.branchTarget &&
    modelIds.length > 1 &&
    lastRequestMessage?.role === 'user' &&
    typeof lastRequestMessage.id === 'string' &&
    lastRequestMessage.id.length > 0

  if (!shouldFanOutMultiModel) {
    const result = await buildAgentRuntimeInput(input)
    await runAgentService({
      conversationId: input.conversationId,
      persistState: true,
      input: result.input,
      loopConfig: result.loopConfig,
    })
    return
  }

  const sourceUserMessageId = lastRequestMessage.id
  const runPromises = modelIds.map(async (modelId) => {
    const result = await buildAgentRuntimeInput({
      ...input,
      modelId,
      branchTarget: {
        branchId: `${sourceUserMessageId}:${modelId}`,
        sourceUserMessageId,
      },
    })
    const branchModel = result.input.model
    await runAgentService({
      conversationId: input.conversationId,
      persistState: true,
      input: {
        ...result.input,
        branchLabel:
          result.input.branchLabel ??
          branchModel.name ??
          branchModel.model ??
          branchModel.id,
      },
      loopConfig: result.loopConfig,
    })
  })

  await Promise.allSettled(runPromises)
}
