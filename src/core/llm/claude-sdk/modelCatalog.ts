import type { SDKUserMessage } from '@yolo/claude-agent-sdk-runtime'

import { AsyncPushQueue } from '../../cli-runtime/claude/asyncQueue'
import { loadClaudeAgentSdk } from '../../cli-runtime/claude/sdk-loader'

import { getClaudeSdkVaultPath } from './host'
import { constructWithNodeRealmAbort } from './liveSession'

/**
 * Model ids the Claude Code CLI will accept, straight from the CLI itself.
 *
 * Asking costs a subprocess spawn, so this is only for the settings page's
 * explicit "fetch models" action, never a chat path. The query is opened with
 * an input stream that is closed immediately: `initializationResult()` settles
 * from the CLI's own handshake without a turn or a model call.
 *
 * Aliases (`sonnet`, `opus`) and canonical ids both come back — the alias is
 * what the CLI reports as the row's `value`, and it is what stays correct when
 * Anthropic ships a new generation, so it is offered as-is.
 */
export const listClaudeSdkModels = async ({
  oauthToken,
}: {
  oauthToken: string
}): Promise<string[]> => {
  const sdk = await loadClaudeAgentSdk()
  const { resolveClaudeProcessSupport } = await import(
    '../../cli-runtime/claude/process'
  )
  const processSupport = await resolveClaudeProcessSupport({ oauthToken })
  const input = new AsyncPushQueue<SDKUserMessage>()

  const query = constructWithNodeRealmAbort(processSupport, () =>
    sdk.query({
      prompt: input,
      options: {
        cwd: getClaudeSdkVaultPath(),
        pathToClaudeCodeExecutable: processSupport.cliPath,
        env: processSupport.env,
        spawnClaudeCodeProcess: processSupport.spawnClaudeCodeProcess,
        abortController: processSupport.createAbortController(),
        // Nothing is asked of the model, so the session is pure overhead —
        // keep it off disk rather than littering ~/.claude/projects.
        persistSession: false,
        tools: [],
      },
    }),
  )

  try {
    const initialization = await query.initializationResult()
    const models =
      initialization.models.length > 0
        ? initialization.models
        : await query.supportedModels()
    return [...new Set(models.map((model) => model.value))].filter(
      (value) => value.length > 0,
    )
  } finally {
    input.close()
    query.close()
  }
}
