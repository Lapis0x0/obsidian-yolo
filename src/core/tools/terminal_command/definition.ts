import { FileSystemAdapter, Platform } from 'obsidian'

import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { defineTool } from '../define'
import { getOptionalBoundedIntegerArg, getOptionalTextArg } from '../tool-args'

// Schema copied verbatim from the `terminal_command` entry in
// `getLocalFileTools()` (`src/core/mcp/localFileTools.ts`).
const TERMINAL_COMMAND_MCP_TOOL: Omit<McpTool, 'name'> = {
  description:
    'Run a command in the local OS shell. Desktop-only. ' +
    'Uses PowerShell on Windows and a POSIX shell on macOS/Linux. ' +
    'Use for terminal-style inspection or local CLI commands on the user’s machine. ' +
    'For vault content search/read/inspection, prefer the bash tool instead — it is sandboxed to the vault and works on every platform. ' +
    'By default, command runs as a one-shot process and completes when that process exits; ' +
    'it does not keep shell state between calls. ' +
    'Use background=true to create a persistent session for long-running or interactive commands; ' +
    'session_id polls or continues an existing ' +
    'session; input sends stdin to that session; kill=true terminates it. ' +
    'Results separate stdout and stderr. ' +
    'Use tail_lines or tail_bytes when polling verbose sessions to inspect recent logs only. ' +
    'Avoid heredocs and full-screen TUI programs such as vim/top. Long-running ' +
    'commands should use background=true; completion is pushed when finished. ' +
    'Avoid frequent polling to check status. ' +
    'The tool result is returned to you, but it does not automatically become a user-facing answer; to show the user the result, send a concise text summary of the relevant output.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'Shell command to run. Omit when polling, sending input, or killing an existing session.',
      },
      session_id: {
        type: 'integer',
        description:
          'Existing session id returned by a previous terminal_command call. Use it to poll, send input, or kill.',
      },
      input: {
        type: 'string',
        description:
          'Text to write to the session stdin. Include a trailing newline when submitting interactive input.',
      },
      background: {
        type: 'boolean',
        description:
          'Start the command in a dedicated session and return a session_id if it is still running after a short wait.',
      },
      cwd: {
        type: 'string',
        description:
          'Absolute working directory for this command. Defaults to the current vault root when available.',
      },
      timeout: {
        type: 'integer',
        description:
          'Maximum seconds to wait for foreground output before returning a live session_id. Defaults to 30.',
      },
      tail_lines: {
        type: 'integer',
        description:
          'Return only the last N lines from stdout and stderr. Useful when polling verbose long-running sessions.',
      },
      tail_bytes: {
        type: 'integer',
        description:
          'Return only the last N bytes from stdout and stderr. Cannot be combined with tail_lines.',
      },
      kill: {
        type: 'boolean',
        description: 'Terminate the given session_id.',
      },
    },
  },
}

// Single consumer (this tool) — moved here rather than left as a shared
// import, per phase2-migration.md D6 "注意" ("只被一个工具用的跟着走"). Ported
// verbatim from the private `getOptionalBooleanArg` in
// `src/core/mcp/localFileTools.ts`, which `bash` (not yet migrated, D6 batch
// 7) does not use — it had exactly two call sites, both in this tool's own
// `case TERMINAL_COMMAND_TOOL_NAME` branch.
const getOptionalBooleanArg = (
  args: Record<string, unknown>,
  key: string,
): boolean | undefined => {
  const value = args[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${key} must be a boolean.`)
  }
  return value
}

export const terminalCommandDefinition = defineTool({
  name: 'terminal_command',
  getMcpTool: () => TERMINAL_COMMAND_MCP_TOOL,
  // Platform gate — the ONE deliberate behavior change in this batch
  // (master.md §3.1b, approved 2026-08-15): previously `terminal_command` was
  // handed to the model on every platform and only failed at execution time
  // (`core/agent/bash/index.ts`'s `runBash` throws off-desktop). This keeps
  // it off the mobile candidate list entirely rather than advertising a tool
  // call that is guaranteed to fail. `bash/index.ts`'s execution-time throw
  // is NOT removed — it stays as defense-in-depth for any call path that
  // reaches `execute` below without going through catalog filtering first
  // (master.md §3.4's "upstream filtering doesn't retire downstream
  // fallbacks" principle). This gate must not be copied to `js_eval` — that
  // tool has no platform restriction today (see its own definition.ts).
  isAvailable: () => Platform.isDesktop,
  chatLabel: {
    key: 'settings.agent.builtinTerminalCommandLabel',
    fallback: 'Terminal Commands',
  },
  contextPrunable: true,
  // Ported verbatim from the `case TERMINAL_COMMAND_TOOL_NAME` branch of
  // `callLocalFileTool` (`src/core/mcp/localFileTools.ts`), minus the abort
  // check / workspace-scope / YOLO-data-root guards and the outer try/catch
  // that normalizes thrown errors to an Error-status result — those are
  // dispatcher responsibilities (master.md §3.4), not tool semantics.
  execute: async (args, ctx) => {
    const { app, conversationId, conversationMessages, toolCallId, signal } =
      ctx
    // Dynamic import, matching the original `case TERMINAL_COMMAND_TOOL_NAME`
    // branch verbatim — keeps the bash session-manager runtime out of tools
    // that never call it, and (per this repo's convention for desktop-only
    // dependencies) avoids a static import reaching toward `node:*` through
    // `session-manager.ts`.
    const { runBash } = await import('../../agent/bash/index')

    let assistantMessageId = ''
    if (conversationMessages) {
      for (let i = conversationMessages.length - 1; i >= 0; i--) {
        const m = conversationMessages[i]
        if (m.role === 'assistant') {
          assistantMessageId = m.id
          break
        }
      }
    }

    let cwd = getOptionalTextArg(args, 'cwd')?.trim() ?? ''
    if (!cwd) {
      const adapter = app.vault.adapter
      if (adapter instanceof FileSystemAdapter) {
        cwd = adapter.getBasePath()
      }
    }

    const result = await runBash({
      command: getOptionalTextArg(args, 'command'),
      sessionId: getOptionalBoundedIntegerArg({
        args,
        key: 'session_id',
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      }),
      input: getOptionalTextArg(args, 'input'),
      background: getOptionalBooleanArg(args, 'background') ?? false,
      cwd: cwd || undefined,
      timeoutSeconds: getOptionalBoundedIntegerArg({
        args,
        key: 'timeout',
        min: 1,
        max: 600,
      }),
      tailLines: getOptionalBoundedIntegerArg({
        args,
        key: 'tail_lines',
        min: 1,
        max: 10_000,
      }),
      tailBytes: getOptionalBoundedIntegerArg({
        args,
        key: 'tail_bytes',
        min: 1,
        max: 1_048_576,
      }),
      kill: getOptionalBooleanArg(args, 'kill') ?? false,
      signal,
      conversationId,
      source:
        conversationId && toolCallId && assistantMessageId
          ? {
              type: 'llm_tool_call',
              toolCallId,
              assistantMessageId,
            }
          : undefined,
    })

    const exitOk =
      result.exit_code === undefined ||
      result.exit_code === null ||
      result.exit_code === 0
    const text = JSON.stringify(
      {
        session_id: result.session_id,
        state: result.state,
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
      },
      null,
      2,
    )

    if (!exitOk) {
      return {
        status: ToolCallResponseStatus.Error,
        error: `Exit code ${result.exit_code}. Output:\n${text}`,
      }
    }

    return {
      status: ToolCallResponseStatus.Success,
      text,
      metadata: result.truncated ? { truncated: result.truncated } : undefined,
    }
  },
})
