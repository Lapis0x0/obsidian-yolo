import type {
  YoloModuleAgentCapabilityV1,
  YoloModuleAgentRequestV1,
  YoloModuleAgentV1,
} from '../../modules/types'

import type {
  LearningGenerationAgentRequest,
  LearningGenerationCapability,
} from './host'
import { createLearningGenerationAgent } from './moduleAgentAdapter'

describe('createLearningGenerationAgent', () => {
  it.each([
    ['none', 'none'],
    ['readonly-vault', 'vault-read'],
    ['edit-vault', 'vault-write'],
  ] as const)(
    'maps %s capability to %s',
    async (
      capability: LearningGenerationCapability,
      expected: YoloModuleAgentCapabilityV1,
    ) => {
      const requests: YoloModuleAgentRequestV1[] = []
      const moduleAgent: YoloModuleAgentV1 = {
        stream: async function* (request) {
          requests.push(request)
          yield { type: 'completed', text: 'done' }
        },
      }

      const events = await collect(
        createLearningGenerationAgent(moduleAgent).stream(
          createRequest(capability),
        ),
      )

      expect(requests[0]?.capability).toBe(expected)
      expect(events).toEqual([{ type: 'completed', text: 'done' }])
    },
  )

  it('maps messages, activity, and common request fields', async () => {
    const controller = new AbortController()
    let received: YoloModuleAgentRequestV1 | undefined
    const moduleAgent: YoloModuleAgentV1 = {
      stream: async function* (request) {
        received = request
        yield { type: 'text', text: 'partial', delta: 'partial' }
        yield { type: 'aborted' }
      },
    }
    const request: LearningGenerationAgentRequest = {
      messages: [
        { role: 'user', id: 'u1', promptContent: 'question' },
        { role: 'assistant', id: 'a1', content: 'answer' },
        { role: 'user', id: 'u2', promptContent: 'follow-up' },
      ],
      modelId: 'model',
      systemPromptOverride: 'system',
      capability: 'readonly-vault',
      workspaceScope: {
        enabled: true,
        include: ['Learning'],
        exclude: ['Archive'],
      },
      activity: { kind: 'learning-agent', title: 'Generating' },
      abortSignal: controller.signal,
    }

    const events = await collect(
      createLearningGenerationAgent(moduleAgent).stream(request),
    )

    expect(received).toEqual({
      messages: [
        { role: 'user', id: 'u1', content: 'question' },
        { role: 'assistant', id: 'a1', content: 'answer' },
        { role: 'user', id: 'u2', content: 'follow-up' },
      ],
      modelId: 'model',
      systemPrompt: 'system',
      capability: 'vault-read',
      activity: { title: 'Generating' },
      workspaceScope: {
        enabled: true,
        include: ['Learning'],
        exclude: ['Archive'],
      },
      signal: controller.signal,
    })
    expect(events).toEqual([
      { type: 'text', text: 'partial', delta: 'partial' },
      { type: 'aborted' },
    ])
  })
})

function createRequest(
  capability: LearningGenerationCapability,
): LearningGenerationAgentRequest {
  return {
    prompt: 'prompt',
    systemPromptOverride: 'system',
    capability,
  }
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of stream) values.push(value)
  return values
}
