import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { YoloSettings } from '../settings/schema/setting.types'

type SettingsContextType = {
  settings: YoloSettings
  setSettings: (newSettings: YoloSettings) => Promise<boolean>
  updateSettings: (
    updater: (current: YoloSettings) => YoloSettings,
  ) => Promise<boolean>
}

// Settings context
const SettingsContext = React.createContext<SettingsContextType | undefined>(
  undefined,
)

export const SettingsProvider = ({
  children,
  settings: initialSettings,
  setSettings,
  addSettingsChangeListener,
}: {
  children: React.ReactNode
  settings: YoloSettings
  setSettings: (newSettings: YoloSettings) => Promise<boolean>
  addSettingsChangeListener: (
    listener: (newSettings: YoloSettings) => void,
  ) => () => void
}) => {
  const [settingsCached, setSettingsCached] = useState(initialSettings)
  const latestSettingsRef = useRef(initialSettings)
  const updateTailRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    const removeListener = addSettingsChangeListener((newSettings) => {
      latestSettingsRef.current = newSettings
      setSettingsCached(newSettings)
    })

    return () => {
      removeListener()
    }
  }, [addSettingsChangeListener, setSettings])

  const updateSettings = useCallback(
    (updater: (current: YoloSettings) => YoloSettings): Promise<boolean> => {
      const update = updateTailRef.current
        .catch(() => undefined)
        .then(async () => {
          const nextSettings = updater(latestSettingsRef.current)
          const saved = await setSettings(nextSettings)
          if (saved) latestSettingsRef.current = nextSettings
          return saved
        })
      updateTailRef.current = update.then(
        () => undefined,
        () => undefined,
      )
      return update
    },
    [setSettings],
  )

  const value = useMemo(
    () => ({ settings: settingsCached, setSettings, updateSettings }),
    [settingsCached, setSettings, updateSettings],
  )

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  )
}

export const useSettings = () => {
  const settings = React.useContext(SettingsContext)
  if (!settings) {
    throw new Error('useSettings must be used within a SettingsProvider')
  }
  return settings
}
