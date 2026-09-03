import { App, Modal } from 'obsidian'
import React from 'react'
import { Root, createRoot } from 'react-dom/client'

import { LanguageProvider } from '../../contexts/language-context'
import { PluginProvider } from '../../contexts/plugin-context'
import type YoloPlugin from '../../main'

type ModalProps<T extends Record<string, unknown>> = {
  app: App
  Component: React.ComponentType<T & { onClose: () => void }>
  props: T
  options?: { title?: string; className?: string }
  plugin?: YoloPlugin // Add plugin prop for context providers
}

export class ReactModal<T extends Record<string, unknown>> extends Modal {
  private root: Root | null = null
  private Component: React.ComponentType<T & { onClose: () => void }>
  private props: T
  private options?: { title?: string; className?: string }
  private plugin?: YoloPlugin

  constructor({ app, Component, props, options, plugin }: ModalProps<T>) {
    super(app)
    this.Component = Component
    this.props = props
    this.options = options
    this.plugin = plugin
  }

  onOpen() {
    if (this.options?.title) this.titleEl.setText(this.options.title)
    if (this.options?.className) {
      this.modalEl.classList.add(this.options.className)
    }
    this.root = createRoot(this.contentEl)

    const componentProps: T & { onClose: () => void } = {
      ...this.props,
      onClose: () => this.close(),
    }

    const modalContent = (
      <LanguageProvider>
        <this.Component {...componentProps} />
      </LanguageProvider>
    )

    const ComponentWithContext = () =>
      this.plugin ? (
        <PluginProvider plugin={this.plugin}>{modalContent}</PluginProvider>
      ) : (
        modalContent
      )

    this.root.render(<ComponentWithContext />)
  }

  onClose() {
    if (this.options?.className) {
      this.modalEl.classList.remove(this.options.className)
    }
    if (this.root) {
      this.root.unmount()
      this.root = null
    }
    this.contentEl.empty()
  }
}
