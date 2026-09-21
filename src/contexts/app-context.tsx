import { App } from 'obsidian'
// 具名导入，理由同 `plugin-context.tsx`：tsconfig 关闭了 esModuleInterop，
// `import React from 'react'` 在 CJS 下是 undefined。文件编辑卡片会引入本模块，
// 而 ToolMessage 的测试在 CJS 环境里求值那棵依赖树。
import { type ReactNode, createContext, useContext } from 'react'

// App context
const AppContext = createContext<App | undefined>(undefined)

export const AppProvider = ({
  children,
  app,
}: {
  children: ReactNode
  app: App
}) => {
  return <AppContext.Provider value={app}>{children}</AppContext.Provider>
}

export const useApp = () => {
  const app = useContext(AppContext)
  if (!app) {
    throw new Error('useApp must be used within an AppProvider')
  }
  return app
}
