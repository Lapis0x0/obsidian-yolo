import type { App } from '../../runtime/react-compat'
import React from 'react'
import { Root, createRoot } from 'react-dom/client'

import { LanguageProvider } from '../../contexts/language-context'
import { PluginProvider } from '../../contexts/plugin-context'
import { Modal } from '../../runtime/react-compat'
import type SmartComposerPlugin from '../../main'

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
  }

  onClose() {
    if (this.root) {
      this.root.unmount()
      this.root = null
    }
    this.contentEl.empty()
  }
}
