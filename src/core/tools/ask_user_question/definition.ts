import type { McpTool } from '../../../types/mcp.types'
import { defineTool } from '../define'

// Schema copied verbatim from the `ask_user_question` entry in
// `getLocalFileTools()` (`src/core/mcp/localFileTools.ts:1154`).
const ASK_USER_QUESTION_MCP_TOOL: Omit<McpTool, 'name'> = {
  description:
    'Ask the user one or more structured questions when you are blocked by missing information that cannot be inferred from context or the vault. Group related questions in a single call instead of asking turn by turn. Use sparingly — never to confirm trivial actions. Prefer concrete options (single_select / multi_select) over free text for the main questions. The UI automatically appends an "Other" escape hatch to every single_select / multi_select (with a free-text input that lands in the answer as `otherText`), so you do NOT need to add your own "Other" / "其他" option. The trailing free_text catch-all is also useful when an open-ended answer is plausible (e.g. "Anything else to add? (optional)") — note that free_text answers are treated as optional and may come back empty. This call MUST be the only tool call in the turn; the agent run pauses until the user submits answers in a dedicated panel.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        description:
          'One or more structured questions to ask the user. Group related questions together rather than splitting them across turns.',
        items: {
          type: 'object',
          required: ['id', 'prompt', 'inputType'],
          properties: {
            id: {
              type: 'string',
              description:
                'Stable id used to key the answer back. Must be unique across the questions array.',
            },
            prompt: {
              type: 'string',
              description: 'The question text shown to the user.',
            },
            inputType: {
              type: 'string',
              enum: ['free_text', 'single_select', 'multi_select'],
              description:
                'free_text: open answer. single_select: pick exactly one option. multi_select: pick one or more options.',
            },
            options: {
              type: 'array',
              minItems: 2,
              description:
                'Required for single_select / multi_select. Each option has a stable id and a human-readable label. Disallowed for free_text. The id "__other__" is reserved — the UI appends its own "Other" entry, so do not include one yourself.',
              items: {
                type: 'object',
                required: ['id', 'label'],
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    required: ['questions'],
  },
}

export const askUserQuestionDefinition = defineTool({
  name: 'ask_user_question',
  getMcpTool: () => ASK_USER_QUESTION_MCP_TOOL,
  chatLabel: {
    key: 'settings.agent.builtinAskUserQuestionLabel',
    fallback: 'Ask User',
  },
  contextPrunable: true,
  // `ask_user_question` never reaches this function in the live runtime, and
  // never had a `case` in `callLocalFileTool`'s switch to port from: the
  // gateway (`core/agent/tool-gateway.ts`, around `resolveInitialResponse`)
  // resolves it straight to `AwaitingUserInput` after schema validation, and
  // `AgentService.answerUserQuestion` later resolves that pause directly to
  // a Success response built from the user's own answers — "mirrors
  // approveToolCall but skips the MCP execution path" (service.ts's doc
  // comment on that method). This body exists only because
  // `BuiltinToolDefinition.execute` is required; it throws defensively so a
  // future caller that mistakenly routes this tool through the normal
  // execute path fails loudly instead of silently producing a bogus result.
  execute: async () => {
    throw new Error(
      "ask_user_question does not execute through executeBuiltinTool. It is resolved by the agent gateway pausing to AwaitingUserInput and AgentService.answerUserQuestion resuming it directly from the user's answers.",
    )
  },
})
