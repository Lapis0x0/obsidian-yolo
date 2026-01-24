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
    const stored = app.loadLocalStorage(STORAGE_KEY)
    if (stored && SETTINGS_TABS.some((tab) => tab.id === stored)) {
      return stored as SettingsTabId
    }
    return 'models'
  })

  useEffect(() => {
    // Save to localStorage when tab changes
    void app.saveLocalStorage(STORAGE_KEY, activeTab)
  }, [activeTab])

  const ActiveComponent =
    SETTINGS_TABS.find((tab) => tab.id === activeTab)?.component || ModelsTab

  const activeTabIndex = SETTINGS_TABS.findIndex((tab) => tab.id === activeTab)

  return (
    <div className="smtcmp-settings-tabs-container">
      <div
        className="smtcmp-settings-tabs-nav smtcmp-settings-tabs-nav--glider"
        role="tablist"
        style={
          {
            '--smtcmp-tab-count': SETTINGS_TABS.length,
            '--smtcmp-tab-index': activeTabIndex,
          } as React.CSSProperties
        }
      >
        <div className="smtcmp-settings-tabs-glider" aria-hidden="true" />
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            className={`smtcmp-settings-tab-button ${
              activeTab === tab.id ? 'is-active' : ''
            }`}
            onClick={() => setActiveTab(tab.id)}
            role="tab"
            aria-selected={activeTab === tab.id}
          >
            <span className="smtcmp-settings-tab-label">{t(tab.labelKey)}</span>
          </button>
        ))}
      </div>
      <div className="smtcmp-settings-tabs-content">
        <ActiveComponent app={app} plugin={plugin} />
      </div>
    </div>
  )
}
