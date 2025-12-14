import { TFile, View, ViewStateResult, WorkspaceLeaf } from 'obsidian'
import { Root, createRoot } from 'react-dom/client'

import ApplyViewRoot from './components/apply-view/ApplyViewRoot'
import { APPLY_VIEW_TYPE } from './constants'
import { AppProvider } from './contexts/app-context'
import { LanguageProvider } from './contexts/language-context'
import { PluginProvider } from './contexts/plugin-context'
import SmartComposerPlugin from './main'

export type ApplyViewState = {
  file: TFile
  originalContent: string
  newContent: string
}

export class ApplyView extends View {
  private root: Root | null = null

  private state: ApplyViewState | null = null

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: SmartComposerPlugin,
  ) {
    super(leaf)
  }

  getViewType() {
    return APPLY_VIEW_TYPE
  }

  getDisplayText() {
    return `Applying: ${this.state?.file?.name ?? ''}`
  }

  setState(state: ApplyViewState, _result?: ViewStateResult): Promise<void> {
    this.state = state
    // Should render here because onOpen is called before setState
    this.render()
    return Promise.resolve()
  }

  onOpen(): Promise<void> {
    this.root = createRoot(this.containerEl)
    if (this.state) {
      this.render()
    }
    return Promise.resolve()
  }

  onClose(): Promise<void> {
    this.root?.unmount()
    return Promise.resolve()
  }

  private render(): void {
    if (!this.root || !this.state) return
    this.root.render(
      <PluginProvider plugin={this.plugin}>
        <LanguageProvider>
          <AppProvider app={this.app}>
            <ApplyViewRoot
              state={this.state}
              close={() => this.leaf.detach()}
            />
          </AppProvider>
        </LanguageProvider>
      </PluginProvider>,
    )
  }
}
