import { ItemView, WorkspaceLeaf } from 'obsidian'
import React from 'react'
import { Root, createRoot } from 'react-dom/client'

import SparklePanel from './components/sparkle/SparklePanel'
import { SPARKLE_VIEW_TYPE } from './constants'
import { AppProvider } from './contexts/app-context'
import { DatabaseProvider } from './contexts/database-context'
import { LanguageProvider } from './contexts/language-context'
import { PluginProvider } from './contexts/plugin-context'
import { SettingsProvider } from './contexts/settings-context'
import type YoloPlugin from './main'
import { openPluginSettingsTab } from './utils/openPluginSettingsTab'

/**
 * Standalone pane for writing assistance about the note being edited
 * (currently: similar notes). It used to be a page inside the chat view; it
 * lives on its own so it can stay open beside a chat instead of replacing it.
 */
export class SparkleView extends ItemView {
  private root: Root | null = null

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: YoloPlugin,
  ) {
    super(leaf)
  }

  getViewType(): string {
    return SPARKLE_VIEW_TYPE
  }

  getDisplayText(): string {
    return this.plugin.t('sidebar.tabs.composer', 'Sparkle')
  }

  getIcon(): string {
    return 'sparkles'
  }

  async onOpen(): Promise<void> {
    this.addAction(
      'settings',
      this.plugin.t('sparkle.settings.open', 'Sparkle settings'),
      () => openPluginSettingsTab(this.app, this.plugin, 'editor'),
    )

    this.root = createRoot(this.contentEl)
    this.root.render(
      <PluginProvider plugin={this.plugin}>
        <LanguageProvider>
          <AppProvider app={this.app}>
            <SettingsProvider
              settings={this.plugin.settings}
              setSettings={(newSettings) =>
                this.plugin.setSettings(newSettings)
              }
              addSettingsChangeListener={(listener) =>
                this.plugin.addSettingsChangeListener(listener)
              }
            >
              <DatabaseProvider
                getDatabaseManager={() => this.plugin.getDbManager()}
              >
                <React.StrictMode>
                  <SparklePanel />
                </React.StrictMode>
              </DatabaseProvider>
            </SettingsProvider>
          </AppProvider>
        </LanguageProvider>
      </PluginProvider>,
    )
    return Promise.resolve()
  }

  async onClose(): Promise<void> {
    this.root?.unmount()
    this.root = null
    return Promise.resolve()
  }
}
