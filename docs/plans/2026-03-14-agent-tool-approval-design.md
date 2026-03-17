# Agent Tool Approval Design

## Goal

- Move tool approval ownership from global MCP settings to each Agent.
- Keep the global tool settings focused on capability pool management only.
- Replace the old mixed approval model with a single per-Agent rule for each tool.

## Decisions

- Global built-in and MCP tool pages only manage whether a tool is available in the pool.
- Each Agent manages two things per tool: `enabled` and `approvalMode`.
- `approvalMode` has two values: `full_access` and `require_approval`.
- `fs_edit` is folded into the same approval system as every other tool.
- Conversation-scoped approval remains available from the tool call UI.

## Data Model

- Add `toolPreferences` to `Assistant`.
- Each record is keyed by full tool name.
- Each value stores:

```ts
type AssistantToolPreference = {
  enabled?: boolean
  approvalMode?: 'full_access' | 'require_approval'
}
```

- Keep `enabledToolNames` during the transition for compatibility.
- Introduce a migration that backfills `toolPreferences` from existing enabled tools.

## Runtime

- `AgentToolGateway` becomes the source of truth for tool approval mode.
- `McpManager` only checks whether the tool exists, is globally enabled, or is allowed for the current conversation.
- `full_access` tools auto-run.
- `require_approval` tools wait in `pending_approval` unless the conversation has already granted them.

## UI

- Remove MCP `auto execute` controls.
- Agent tool rows show:
  - enable toggle
  - approval selector when enabled
- Approval selector options:
  - `Require approval`
  - `Full access`

## Migration Notes

- Existing enabled tools migrate to `require_approval` by default.
- This keeps upgraded Agents on the safer side.
