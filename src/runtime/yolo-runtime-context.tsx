import React from 'react'
import type { YoloRuntime } from './yoloRuntime.types'

const YoloRuntimeContext = React.createContext<YoloRuntime | undefined>(
  undefined,
)

export function YoloRuntimeProvider({
  runtime,
  children,
}: {
  runtime: YoloRuntime
  children: React.ReactNode
}) {
  return (
    <YoloRuntimeContext.Provider value={runtime}>
      {children}
    </YoloRuntimeContext.Provider>
  )
}

export function useYoloRuntime(): YoloRuntime {
  const runtime = React.useContext(YoloRuntimeContext)
  if (!runtime) {
    throw new Error('useYoloRuntime must be used within YoloRuntimeProvider')
  }
  return runtime
}

export function useOptionalYoloRuntime(): YoloRuntime | undefined {
  return React.useContext(YoloRuntimeContext)
}
