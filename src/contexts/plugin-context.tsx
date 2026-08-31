// 具名导入：本仓库的 tsconfig 关闭了 esModuleInterop，`import React from 'react'`
// 在 CJS 下会解析成 undefined（react 没有 default 导出）。这个模块现在会被
// 流式文本叶子间接引入，必须在 CJS 环境里也能求值。
import { type ReactNode, createContext, useContext } from 'react'

import type YoloPlugin from '../main'

// Plugin context
const PluginContext = createContext<YoloPlugin | undefined>(undefined)

export const PluginProvider = ({
  children,
  plugin,
}: {
  children: ReactNode
  plugin: YoloPlugin
}) => {
  return (
    <PluginContext.Provider value={plugin}>{children}</PluginContext.Provider>
  )
}

export const usePlugin = () => {
  const plugin = useContext(PluginContext)
  if (!plugin) {
    throw new Error('usePlugin must be used within a PluginProvider')
  }
  return plugin
}
