import {
  getSessionMessages,
  getSubagentMessages,
  query,
} from '@yolo/claude-agent-sdk-runtime'

// The host types this API as `ClaudeSdkModule`
// (`src/core/cli-runtime/claude/types.ts`), which is written against the same
// SDK package, so the functions are handed over as-is. They hold no state of
// their own: every live resource (the Claude Code child process of a query)
// belongs to the query object the host creates and closes.
globalThis.__yolo_register_runtime_component__({
  id: 'claude-agent-sdk',
  create: () =>
    Object.freeze({ query, getSessionMessages, getSubagentMessages }),
})
