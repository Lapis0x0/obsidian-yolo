/**
 * Ephemeral, in-memory approval channel for the bash tool's "dangerous
 * operations" tier (`rm`/`mv`). Deliberately NOT part of the chat/message
 * state tree: conversation messages are structurally shared and deep-frozen
 * in dev (see CLAUDE.md), so a live "waiting for the user to click a button"
 * request has no business living there. This module is the single source of
 * truth for "is there a pending dangerous-operation request for tool call X
 * right now", consumed by a React hook (`useDangerousBashApproval` in
 * ToolMessage.tsx) via `useSyncExternalStore`.
 *
 * At most one pending request exists per tool call at a time — the bash
 * session runs one command at a time, so a second `rm`/`mv` invocation never
 * starts until the previous one's promise (and thus its approval request)
 * has resolved.
 */

export type DangerousBashOperationKind = 'rm' | 'mv'

export type DangerousBashApprovalRequest = Readonly<{
  requestId: string
  toolCallId: string
  kind: DangerousBashOperationKind
  targets: readonly string[]
}>

type PendingEntry = {
  request: DangerousBashApprovalRequest
  resolve: (approved: boolean) => void
}

const pendingByToolCall = new Map<string, PendingEntry>()
const listeners = new Set<() => void>()

let requestSequence = 0
const makeRequestId = (): string => `dbop_${Date.now()}_${requestSequence++}`

function notify(): void {
  for (const listener of listeners) listener()
}

/**
 * Registers a pending approval request for `toolCallId` and resolves once
 * `resolveDangerousBashApproval` (user response) or
 * `cancelDangerousBashApproval` (tool call aborted) is called for it.
 */
export function requestDangerousBashApproval(
  toolCallId: string,
  kind: DangerousBashOperationKind,
  targets: readonly string[],
): Promise<boolean> {
  return new Promise((resolve) => {
    const request: DangerousBashApprovalRequest = {
      requestId: makeRequestId(),
      toolCallId,
      kind,
      targets,
    }
    pendingByToolCall.set(toolCallId, { request, resolve })
    notify()
  })
}

/** Called by the approval card when the user clicks approve/reject. */
export function resolveDangerousBashApproval(
  toolCallId: string,
  requestId: string,
  approved: boolean,
): void {
  const entry = pendingByToolCall.get(toolCallId)
  if (!entry || entry.request.requestId !== requestId) return
  pendingByToolCall.delete(toolCallId)
  entry.resolve(approved)
  notify()
}

/** Called when the owning tool call is aborted/unmounted while pending. */
export function cancelDangerousBashApproval(toolCallId: string): void {
  const entry = pendingByToolCall.get(toolCallId)
  if (!entry) return
  pendingByToolCall.delete(toolCallId)
  entry.resolve(false)
  notify()
}

export function getPendingDangerousBashApproval(
  toolCallId: string,
): DangerousBashApprovalRequest | null {
  return pendingByToolCall.get(toolCallId)?.request ?? null
}

export function subscribeDangerousBashApproval(
  listener: () => void,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
