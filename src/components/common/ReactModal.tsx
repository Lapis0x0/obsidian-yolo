import { App, Modal } from 'obsidian'
import React from 'react'
import { Root, createRoot } from 'react-dom/client'

import { LanguageProvider } from '../../contexts/language-context'
import { PluginProvider } from '../../contexts/plugin-context'
import SmartComposerPlugin from '../../main'

type ModalProps<T extends Record<string, unknown>> = {
  app: App
  Component: React.ComponentType<T & { onClose: () => void }>
  props: T
  options?: { title?: string }
  plugin?: SmartComposerPlugin // Add plugin prop for context providers
}

export class ReactModal<T extends Record<string, unknown>> extends Modal {
  private root: Root | null = null
  private Component: React.ComponentType<T & { onClose: () => void }>
  private props: T
  private options?: { title?: string }
  private plugin?: SmartComposerPlugin

  constructor({ app, Component, props, options, plugin }: ModalProps<T>) {
    super(app)
    this.Component = Component
    this.props = props
    this.options = options
    this.plugin = plugin
  }

  onOpen() {
    if (this.options?.title) this.titleEl.setText(this.options.title)
    this.root = createRoot(this.contentEl)

    const componentProps: T & { onClose: () => void } = {
      ...this.props,
      onClose: () => this.close(),
    }

    const ComponentWithContext = () =>
      this.plugin ? (
        <PluginProvider plugin={this.plugin}>
          <LanguageProvider>
            <this.Component {...componentProps} />
          </LanguageProvider>
        </PluginProvider>
      ) : (
        <this.Component {...componentProps} />
      )

    this.root.render(<ComponentWithContext />)
    
    // 确保模态框内容能够正确应用我们的样式
    this.modalEl.addClass('smtcmp-prompt-edit-modal-wrapper')
    this.contentEl.addClass('smtcmp-prompt-edit-modal-content-wrapper')
    
    // 强制应用样式
    setTimeout(() => {
      this.modalEl.style.cssText += `
        max-width: 35vw !important;
        width: 35vw !important;
        max-height: 47vh !important;
        height: 47vh !important;
      `
      this.contentEl.style.cssText += `
        height: 100% !important;
        display: flex !important;
        flex-direction: column !important;
      `
      
      // 确保按钮容器右对齐
      const footer = this.contentEl.querySelector('.smtcmp-prompt-edit-modal-footer') as HTMLElement
      if (footer) {
        footer.style.cssText += `
          display: flex !important;
          align-items: center !important;
          justify-content: flex-end !important;
          padding: 8px 16px !important;
          border-top: 1px solid var(--background-modifier-border) !important;
          flex-shrink: 0 !important;
          min-height: 50px !important;
          width: 100% !important;
        `
      }
      
      const actions = this.contentEl.querySelector('.smtcmp-prompt-edit-modal-actions') as HTMLElement
      if (actions) {
        actions.style.cssText += `
          display: flex !important;
          flex-direction: row !important;
          align-items: center !important;
          gap: 8px !important;
          flex-shrink: 0 !important;
          margin-left: auto !important;
        `
      }
    }, 0)
  }

  onClose() {
    if (this.root) {
      this.root.unmount()
      this.root = null
    }
    this.contentEl.empty()
  }
}
