import { type ReactNode, createContext, useContext } from 'react'

import type { ChatRuntimeActions, CliSessionRef } from '../../core/cli-runtime'

import type { CliSubagentPresentation } from './cliSubagentReadModel'

type CliSubagentContextValue = {
  actions: ChatRuntimeActions
  sessionRef: CliSessionRef
  presentationsByToolCallId: ReadonlyMap<string, CliSubagentPresentation>
}

const CliSubagentContext = createContext<CliSubagentContextValue | null>(null)

export function CliSubagentProvider({
  value,
  children,
}: {
  value: CliSubagentContextValue
  children: ReactNode
}) {
  return (
    <CliSubagentContext.Provider value={value}>
      {children}
    </CliSubagentContext.Provider>
  )
}

export const useCliSubagent = (
  toolCallId: string,
): {
  presentation?: CliSubagentPresentation
  actions?: ChatRuntimeActions
  sessionRef?: CliSessionRef
} => {
  const value = useContext(CliSubagentContext)
  return {
    presentation: value?.presentationsByToolCallId.get(toolCallId),
    actions: value?.actions,
    sessionRef: value?.sessionRef,
  }
}
