import { EditorView } from '@codemirror/view'
import { Root, createRoot } from 'react-dom/client'

import { AppProvider } from '../../contexts/app-context'
import { LanguageProvider } from '../../contexts/language-context'
import { PluginProvider } from '../../contexts/plugin-context'
import type YoloPlugin from '../../main'
import type { ApplyViewState } from '../../types/apply-view.types'
import ApplyViewRoot from './ApplyViewRoot'
import type { ApplyViewActions } from './types'

type ApplyReviewOverlayOptions = {
  plugin: YoloPlugin
  view: EditorView
  state: ApplyViewState
  onClose: () => void
  onActionsReady?: (actions: ApplyViewActions | null) => void
}

export class ApplyReviewOverlay {
  private root: Root | null = null
  private overlayRoot: HTMLDivElement | null = null
  private overlayContainer: HTMLDivElement | null = null
  private overlayHost: HTMLElement | null = null

  constructor(private readonly options: ApplyReviewOverlayOptions) {}

  mount(): void {
    this.mountOverlay()
  }

  destroy(): void {
    this.root?.unmount()
    this.root = null

    if (this.overlayRoot?.parentNode) {
      this.overlayRoot.parentNode.removeChild(this.overlayRoot)
    }
    this.overlayRoot = null
    this.overlayContainer = null

    if (this.overlayHost) {
      this.overlayHost.classList.remove('yolo-apply-overlay-host')
      this.overlayHost = null
    }
  }

  private mountOverlay(): void {
    const overlayHost = this.options.view.dom ?? document.body
    this.overlayHost = overlayHost
    overlayHost.classList.add('yolo-apply-overlay-host')

    const overlayRoot = document.createElement('div')
    overlayRoot.className = 'yolo-apply-overlay-root'
    overlayHost.appendChild(overlayRoot)
    this.overlayRoot = overlayRoot

    const overlayContainer = document.createElement('div')
    overlayContainer.className = 'yolo-apply-overlay'
    overlayRoot.appendChild(overlayContainer)
    this.overlayContainer = overlayContainer

    this.root = createRoot(overlayContainer)
    this.root.render(
      <PluginProvider plugin={this.options.plugin}>
        <LanguageProvider>
          <AppProvider app={this.options.plugin.app}>
            <ApplyViewRoot
              state={this.options.state}
              close={this.options.onClose}
              onActionsReady={this.options.onActionsReady}
              useRootId={false}
              showHeader={false}
            />
          </AppProvider>
        </LanguageProvider>
      </PluginProvider>,
    )
  }
}
