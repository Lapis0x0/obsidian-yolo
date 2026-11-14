import { createContext, useContext } from 'react'

import type { TaskSource } from '../../../types/chat'

/**
 * A request from outside the message flow — the status bar's activity panel —
 * to open one subagent's detail view (#645). Chat holds it until the matching
 * card is mounted; the card opens its own detail and reports it handled, so
 * the detail keeps a single source of truth in `SubagentCard`.
 */
export type SubagentDetailRequest = {
  conversationId: string
  source: TaskSource
}

export type SubagentDetailRequestContextValue = {
  request: SubagentDetailRequest
  handled: () => void
}

export const SubagentDetailRequestContext =
  createContext<SubagentDetailRequestContextValue | null>(null)

export const useSubagentDetailRequest =
  (): SubagentDetailRequestContextValue | null =>
    useContext(SubagentDetailRequestContext)
