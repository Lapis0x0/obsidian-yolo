import React, { useEffect, useMemo, useState } from 'react'

import { YoloSettings } from '../settings/schema/setting.types'

type SettingsContextType = {
  settings: YoloSettings
  setSettings: (newSettings: YoloSettings) => Promise<boolean>
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

  useEffect(() => {
    const removeListener = addSettingsChangeListener((newSettings) => {
      setSettingsCached(newSettings)
    })

    return () => {
      removeListener()
    }
  }, [addSettingsChangeListener, setSettings])

  const value = useMemo(
    () => ({ settings: settingsCached, setSettings }),
    [settingsCached, setSettings],
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
