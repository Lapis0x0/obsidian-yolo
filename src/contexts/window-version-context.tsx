import React, { useEffect, useState } from 'react'

/**
 * Tracks how many times the host element has been migrated to a different
 * window (Obsidian pop-out). Components that own non-React resources tied to
 * the current `document` / `window` (e.g. Lexical editors whose internal
 * `selectionchange` listener is bound to the owning document) should use this
 * as a React `key` so they fully unmount + remount on migration, getting a
 * fresh instance bound to the new window.
 */
const WindowVersionContext = React.createContext<number>(0)

export const WindowVersionProvider = ({
  containerEl,
  children,
}: {
  containerEl: HTMLElement
  children: React.ReactNode
}) => {
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const cleanup = containerEl.onWindowMigrated(() => {
      setVersion((prev) => prev + 1)
    })
    return cleanup
  }, [containerEl])

  return (
    <WindowVersionContext.Provider value={version}>
      {children}
    </WindowVersionContext.Provider>
  )
}

export const useWindowVersion = (): number =>
  React.useContext(WindowVersionContext)
