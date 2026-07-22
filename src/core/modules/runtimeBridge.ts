import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'

export const YOLO_MODULE_RUNTIME_SYMBOL = 'yolo.module.host-runtime.v1'

export type YoloModuleSharedRuntimeV1 = Readonly<{
  react: typeof React
  jsxRuntime: typeof jsxRuntime
}>

type RuntimeGlobal = typeof globalThis & {
  [key: symbol]: unknown
}

/** Publishes Core-owned React identities for independently bundled modules. */
export function installYoloModuleRuntimeBridge(): () => void {
  const target = globalThis as RuntimeGlobal
  const key = Symbol.for(YOLO_MODULE_RUNTIME_SYMBOL)
  const previous = target[key]
  const runtime: YoloModuleSharedRuntimeV1 = Object.freeze({
    react: React,
    jsxRuntime,
  })
  target[key] = runtime
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (target[key] === runtime) {
      if (previous === undefined) Reflect.deleteProperty(target, key)
      else target[key] = previous
    }
  }
}

export function getYoloModuleRuntimeBridge(): YoloModuleSharedRuntimeV1 {
  const value = (globalThis as RuntimeGlobal)[
    Symbol.for(YOLO_MODULE_RUNTIME_SYMBOL)
  ]
  if (!value) throw new Error('YOLO module host runtime v1 is unavailable')
  return value as YoloModuleSharedRuntimeV1
}
