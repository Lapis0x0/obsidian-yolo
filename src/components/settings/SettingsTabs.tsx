import { App } from 'obsidian'
import React, { type FC, useEffect, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import SmartComposerPlugin from '../../main'

import { ChatTab } from './tabs/ChatTab'
import { EditorTab } from './tabs/EditorTab'
import { KnowledgeTab } from './tabs/KnowledgeTab'
import { ModelsTab } from './tabs/ModelsTab'
import { OthersTab } from './tabs/OthersTab'
import { ToolsTab } from './tabs/ToolsTab'

type SettingsTabsProps = {
  app: App
  plugin: SmartComposerPlugin
}

export type SettingsTabId =
  | 'models'
  | 'chat'
  | 'editor'
  | 'knowledge'
  | 'tools'
  | 'others'

type SettingsTab = {
  id: SettingsTabId
  labelKey: string
  component: FC<SettingsTabsProps>
}

const SETTINGS_TABS: SettingsTab[] = [
  {
    id: 'models',
    labelKey: 'settings.tabs.models',
    component: ModelsTab,
  },
  {
    id: 'chat',
    labelKey: 'settings.tabs.chat',
    component: ChatTab,
  },
  {
    id: 'editor',
    labelKey: 'settings.tabs.editor',
    component: EditorTab,
  },
  {
    id: 'knowledge',
    labelKey: 'settings.tabs.knowledge',
    component: KnowledgeTab,
  },
  {
    id: 'tools',
    labelKey: 'settings.tabs.tools',
    component: ToolsTab,
  },
  {
    id: 'others',
    labelKey: 'settings.tabs.others',
    component: OthersTab,
  },
]

const STORAGE_KEY = 'smtcmp_settings_active_tab'

export function SettingsTabs({ app, plugin }: SettingsTabsProps) {
  const { t } = useLanguage()
  const [activeTab, setActiveTab] = useState<SettingsTabId>(() => {
    // Load from localStorage
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && SETTINGS_TABS.some((tab) => tab.id === stored)) {
      return stored as SettingsTabId
    }
    return 'models'
  })

  useEffect(() => {
    // Save to localStorage when tab changes
    localStorage.setItem(STORAGE_KEY, activeTab)
  }, [activeTab])

  const ActiveComponent =
    SETTINGS_TABS.find((tab) => tab.id === activeTab)?.component || ModelsTab

  return (
    <div className="smtcmp-settings-tabs-container">
      <div className="smtcmp-settings-tabs-nav">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            className={`smtcmp-settings-tab-button ${
              activeTab === tab.id ? 'smtcmp-settings-tab-button--active' : ''
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>
      <div className="smtcmp-settings-tabs-content">
        <ActiveComponent app={app} plugin={plugin} />
      </div>
    </div>
  )
}
