import { App, PluginSettingTab } from 'obsidian'
import type { Root } from 'react-dom/client'

import type YoloPlugin from '../main'

export class YoloSettingTab extends PluginSettingTab {
  plugin: YoloPlugin
  private root: Root | null = null
  private isClosed = true

  constructor(app: App, plugin: YoloPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()
    this.isClosed = false

    const loadingEl = containerEl.createDiv({ cls: 'yolo-settings-loading' })
    loadingEl.setText('Loading settings…')

    void this.renderAsync(loadingEl)
  }

  private async renderAsync(loadingEl: HTMLElement): Promise<void> {
    const [
      { createRoot },
      { SettingsTabRoot },
      { PluginProvider },
      { SettingsProvider },
    ] = await Promise.all([
      import('react-dom/client'),
      import('../components/settings/SettingsTabRoot'),
      import('../contexts/plugin-context'),
      import('../contexts/settings-context'),
    ])

    if (this.isClosed) return

    loadingEl.remove()
    this.root = createRoot(this.containerEl)
    this.root.render(
      <PluginProvider plugin={this.plugin}>
        <SettingsProvider
          settings={this.plugin.settings}
          setSettings={(newSettings) => this.plugin.setSettings(newSettings)}
          addSettingsChangeListener={(listener) =>
            this.plugin.addSettingsChangeListener(listener)
          }
        >
          <SettingsTabRoot app={this.app} plugin={this.plugin} />
        </SettingsProvider>
      </PluginProvider>,
    )
  }

  hide(): void {
    this.isClosed = true
    if (this.root) {
      this.root.unmount()
      this.root = null
    }
    // Clear model list cache when settings page closes
    this.plugin.clearModelListCache()
  }
}
