import { TFile } from 'obsidian'
import { useEffect, useState } from 'react'

import { useApp } from '../../../contexts/app-context'

/**
 * The file the user is currently in — nothing else. `useActiveViewState`
 * also reports cursor and viewport position, which means a CodeMirror
 * listener and a re-render on every keystroke; consumers that only care
 * about *which* file is open should use this instead.
 */
export function useActiveFile(): TFile | null {
  const app = useApp()
  const [file, setFile] = useState<TFile | null>(() =>
    app.workspace.getActiveFile(),
  )

  useEffect(() => {
    const update = () => {
      setFile((previous) => {
        const next = app.workspace.getActiveFile()
        return next === previous ? previous : next
      })
    }

    update()
    app.workspace.on('active-leaf-change', update)
    app.workspace.on('file-open', update)
    return () => {
      app.workspace.off('active-leaf-change', update)
      app.workspace.off('file-open', update)
    }
  }, [app.workspace])

  return file
}
