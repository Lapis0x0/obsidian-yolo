import {
  App,
  Component,
  Keymap,
  MarkdownRenderer,
  Notice,
  TFile,
  htmlToMarkdown,
} from 'obsidian'

import type { ModuleLifecycleScope } from './lifecycleScope'
import { assertModuleId } from './moduleStore'
import { normalizeModuleVaultPath } from './moduleVault'
import type {
  YoloModuleActionToastV1,
  YoloModuleConfirmOptionsV1,
  YoloModuleHoverLinkOptionsV1,
  YoloModuleMarkdownRendererV1,
  YoloModuleOpenFileLocationV1,
  YoloModuleUiV1,
} from './types'

export type ModuleUiCapabilityActivationV1 = Readonly<{
  api: YoloModuleUiV1
  activate(): void
}>

export type ModuleUiCapabilityProviderV1 = {
  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): ModuleUiCapabilityActivationV1
}

const unavailable = (): never => {
  throw new Error('Module UI capability is unavailable')
}

export const UNAVAILABLE_MODULE_UI_CAPABILITY_PROVIDER: ModuleUiCapabilityProviderV1 =
  Object.freeze({
    create: () => ({
      api: Object.freeze({
        notice: unavailable,
        showActionToast: unavailable,
        confirm: async () => unavailable(),
        createMarkdownRenderer: unavailable,
        htmlToMarkdown: unavailable,
        isModEvent: unavailable,
        openLink: async () => unavailable(),
        openFileAt: async () => unavailable(),
        hoverLink: unavailable,
      }),
      activate: () => undefined,
    }),
  })

type PendingConfirm = {
  modal: ModuleConfirmModal
  settle(value: boolean): void
}

type OwnedRenderer = {
  unload(): void
}

export type ModuleConfirmModal = {
  open(): void
  close(): void
}

export type ModuleConfirmModalFactory = (
  app: App,
  options: YoloModuleConfirmOptionsV1 & {
    onConfirm(): void
    onCancel(): void
  },
) => ModuleConfirmModal

export type ObsidianModuleUiCapabilityProviderOptions = {
  app: App
  createConfirmModal: ModuleConfirmModalFactory
  actionToasts?: Readonly<{
    show(toast: YoloModuleActionToastV1): void
    dismiss(id: string): void
  }>
  reportCleanupError?: (moduleId: string, error: unknown) => void
}

export class ObsidianModuleUiCapabilityProvider
  implements ModuleUiCapabilityProviderV1
{
  private readonly app: App
  private readonly createConfirmModal: ModuleConfirmModalFactory
  private readonly actionToasts: ObsidianModuleUiCapabilityProviderOptions['actionToasts']
  private readonly reportCleanupError: (
    moduleId: string,
    error: unknown,
  ) => void

  constructor(options: ObsidianModuleUiCapabilityProviderOptions) {
    this.app = options.app
    this.createConfirmModal = options.createConfirmModal
    this.actionToasts = options.actionToasts
    this.reportCleanupError = options.reportCleanupError ?? (() => undefined)
  }

  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): ModuleUiCapabilityActivationV1 {
    assertModuleId(moduleId, 'Module id')
    let active = true
    let activationComplete = false
    const pendingConfirms = new Set<PendingConfirm>()
    const renderers = new Set<OwnedRenderer>()
    const actionToastTokens = new Map<string, object>()

    const inactiveError = (): Error =>
      new Error(`Module "${moduleId}" is no longer active`)
    const assertActive = (): void => {
      if (!active) throw inactiveError()
      if (!activationComplete) {
        throw new Error(`Module "${moduleId}" UI is not active`)
      }
    }

    lifecycle.add(() => {
      active = false
      activationComplete = false
      const errors: unknown[] = []
      for (const pending of [...pendingConfirms]) {
        pending.settle(false)
        try {
          pending.modal.close()
        } catch (error) {
          errors.push(error)
        }
      }
      for (const renderer of [...renderers]) {
        try {
          renderer.unload()
        } catch (error) {
          errors.push(error)
        }
      }
      for (const id of actionToastTokens.keys()) {
        try {
          this.actionToasts?.dismiss(id)
        } catch (error) {
          errors.push(error)
        }
      }
      actionToastTokens.clear()
      if (errors.length > 0) {
        throw new ModuleUiCleanupError(errors)
      }
    })

    const api: YoloModuleUiV1 = Object.freeze({
      notice: (message: string) => {
        assertActive()
        requireString(message, 'Notice message')
        new Notice(message)
      },
      showActionToast: (toast: YoloModuleActionToastV1) => {
        assertActive()
        if (!this.actionToasts) {
          throw new Error('Module action toast capability is unavailable')
        }
        const snapshot = snapshotActionToast(toast)
        const id = `module:${JSON.stringify([moduleId, snapshot.id])}`
        const token = {}
        actionToastTokens.set(id, token)
        const callback = snapshot.onAction
        this.actionToasts.show({
          ...snapshot,
          id,
          onAction: () => {
            if (
              !active ||
              !activationComplete ||
              actionToastTokens.get(id) !== token
            )
              return
            return callback()
          },
        })
      },
      confirm: (options: YoloModuleConfirmOptionsV1) => {
        assertActive()
        const snapshot = snapshotConfirmOptions(options)
        return new Promise<boolean>((resolve, reject) => {
          let settled = false
          let pending: PendingConfirm | undefined
          const settle = (value: boolean): void => {
            if (settled) return
            settled = true
            if (pending) pendingConfirms.delete(pending)
            resolve(value)
          }
          const fail = (error: Error): void => {
            if (settled) return
            settled = true
            if (pending) pendingConfirms.delete(pending)
            reject(error)
          }
          try {
            const modal = this.createConfirmModal(this.app, {
              ...snapshot,
              onConfirm: () => settle(true),
              onCancel: () => settle(false),
            })
            pending = { modal, settle }
            pendingConfirms.add(pending)
            if (!active) {
              settle(false)
              modal.close()
              return
            }
            modal.open()
          } catch (error) {
            const failure =
              error instanceof Error
                ? error
                : new Error(
                    `Failed to open confirmation modal: ${String(error)}`,
                  )
            fail(failure)
            try {
              pending?.modal.close()
            } catch (cleanupError) {
              this.report(moduleId, cleanupError)
            }
          }
        })
      },
      createMarkdownRenderer: () => {
        assertActive()
        const component = new Component()
        let loaded = true
        const pendingRenders = new Set<() => void>()
        component.load()

        const renderer: OwnedRenderer & YoloModuleMarkdownRendererV1 = {
          render: (
            markdown: string,
            container: HTMLElement,
            sourcePath: string,
          ) => {
            assertActive()
            if (!loaded) throw new Error('Markdown renderer is unloaded')
            requireString(markdown, 'Markdown')
            requireString(sourcePath, 'Markdown source path')
            requireElement(container, 'Markdown container')
            const staging = container.ownerDocument.createElement('div')
            const render = MarkdownRenderer.render(
              this.app,
              markdown,
              staging,
              sourcePath,
              component,
            )
            let cancelRender!: () => void
            const cancelled = new Promise<void>((resolve) => {
              cancelRender = resolve
            })
            pendingRenders.add(cancelRender)
            const finish = (): void => {
              pendingRenders.delete(cancelRender)
            }
            const publish = render.then(() => {
              assertActive()
              if (!loaded) throw new Error('Markdown renderer is unloaded')
              container.replaceChildren(...Array.from(staging.childNodes))
            })
            void publish.then(
              () => finish(),
              () => finish(),
            )
            return Promise.race([publish, cancelled])
          },
          unload: () => {
            if (!loaded) return
            loaded = false
            renderers.delete(renderer)
            for (const cancel of pendingRenders) cancel()
            pendingRenders.clear()
            component.unload()
          },
        }
        renderers.add(renderer)
        return Object.freeze(renderer)
      },
      htmlToMarkdown: (html: string) => {
        assertActive()
        requireString(html, 'HTML')
        return htmlToMarkdown(html)
      },
      isModEvent: (event: MouseEvent) => {
        assertActive()
        requireEvent(event, 'Modifier event')
        return Boolean(Keymap.isModEvent(event))
      },
      openLink: (linktext: string, sourcePath: string, newLeaf?: boolean) => {
        assertActive()
        requireString(linktext, 'Link text')
        requireString(sourcePath, 'Link source path')
        return this.app.workspace.openLinkText(linktext, sourcePath, newLeaf)
      },
      openFileAt: async (location: YoloModuleOpenFileLocationV1) => {
        assertActive()
        const snapshot = snapshotOpenFileLocation(location)
        const file = this.app.vault.getAbstractFileByPath(snapshot.path)
        if (!(file instanceof TFile)) return false
        const leaf = this.app.workspace.getLeaf(
          snapshot.newLeaf ? 'tab' : false,
        )
        await leaf.openFile(file, {
          eState:
            snapshot.line === undefined
              ? undefined
              : {
                  line: snapshot.line - 1,
                  ch: (snapshot.column ?? 1) - 1,
                },
        })
        assertActive()
        return true
      },
      hoverLink: (options: YoloModuleHoverLinkOptionsV1) => {
        assertActive()
        const snapshot = snapshotHoverLinkOptions(options)
        this.app.workspace.trigger('hover-link', {
          ...snapshot,
          source: 'preview',
          hoverParent: { hoverPopover: null },
        })
      },
    })

    return Object.freeze({
      api,
      activate: () => {
        if (!active) throw inactiveError()
        activationComplete = true
      },
    })
  }

  private report(moduleId: string, error: unknown): void {
    try {
      this.reportCleanupError(moduleId, error)
    } catch {
      // Error reporters cannot escape a module UI lifecycle boundary.
    }
  }
}

function snapshotActionToast(
  toast: YoloModuleActionToastV1,
): YoloModuleActionToastV1 {
  if (!toast || typeof toast !== 'object')
    throw new TypeError('Action toast must be an object')
  const id = toast.id
  const tone = toast.tone
  const title = toast.title
  const message = toast.message
  const actionLabel = toast.actionLabel
  const dismissLabel = toast.dismissLabel
  const onAction = toast.onAction
  requireNonEmptyString(id, 'Action toast id')
  requireNonEmptyString(title, 'Action toast title')
  requireString(message, 'Action toast message')
  requireNonEmptyString(actionLabel, 'Action toast action label')
  requireNonEmptyString(dismissLabel, 'Action toast dismiss label')
  if (tone !== 'success' && tone !== 'warning' && tone !== 'error') {
    throw new Error('Action toast tone is invalid')
  }
  if (typeof onAction !== 'function')
    throw new TypeError('Action toast action must be a function')
  return Object.freeze({
    id,
    tone,
    title,
    message,
    actionLabel,
    dismissLabel,
    onAction,
  })
}

function snapshotOpenFileLocation(
  location: YoloModuleOpenFileLocationV1,
): YoloModuleOpenFileLocationV1 {
  if (!location || typeof location !== 'object')
    throw new TypeError('Open file location must be an object')
  const path = normalizeModuleVaultPath(location.path)
  const line = location.line
  const column = location.column
  const newLeaf = location.newLeaf
  for (const [value, label] of [
    [line, 'Open file line'],
    [column, 'Open file column'],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new TypeError(`${label} must be a positive integer`)
    }
  }
  if (column !== undefined && line === undefined) {
    throw new Error('Open file column requires a line')
  }
  if (newLeaf !== undefined && typeof newLeaf !== 'boolean') {
    throw new TypeError('Open file newLeaf must be a boolean')
  }
  return Object.freeze({
    path,
    line,
    column,
    newLeaf,
  })
}

class ModuleUiCleanupError extends Error {
  constructor(readonly errors: unknown[]) {
    super('Module UI cleanup reported errors')
    this.name = 'ModuleUiCleanupError'
  }
}

function snapshotConfirmOptions(
  options: YoloModuleConfirmOptionsV1,
): YoloModuleConfirmOptionsV1 {
  if (!options || typeof options !== 'object') {
    throw new TypeError('Confirm options must be an object')
  }
  const snapshot = {
    title: options.title,
    message: options.message,
    ctaText: options.ctaText,
    cancelText: options.cancelText,
  }
  requireString(snapshot.title, 'Confirm title')
  requireString(snapshot.message, 'Confirm message')
  requireOptionalString(snapshot.ctaText, 'Confirm CTA text')
  requireOptionalString(snapshot.cancelText, 'Confirm cancel text')
  return snapshot
}

function snapshotHoverLinkOptions(
  options: YoloModuleHoverLinkOptionsV1,
): YoloModuleHoverLinkOptionsV1 {
  if (!options || typeof options !== 'object') {
    throw new TypeError('Hover link options must be an object')
  }
  const snapshot = {
    event: options.event,
    targetEl: options.targetEl,
    linktext: options.linktext,
    sourcePath: options.sourcePath,
  }
  requireEvent(snapshot.event, 'Hover event')
  requireElement(snapshot.targetEl, 'Hover target')
  requireString(snapshot.linktext, 'Hover link text')
  requireString(snapshot.sourcePath, 'Hover link source path')
  return snapshot
}

function requireOptionalString(value: unknown, label: string): void {
  if (value !== undefined) requireString(value, label)
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string')
    throw new TypeError(`${label} must be a string`)
}

function requireNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  requireString(value, label)
  if (!value.trim()) throw new TypeError(`${label} must be a non-empty string`)
}

function requireEvent(
  value: unknown,
  label: string,
): asserts value is MouseEvent {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { type?: unknown }).type !== 'string'
  ) {
    throw new TypeError(`${label} must be an event`)
  }
}

function requireElement(
  value: unknown,
  label: string,
): asserts value is HTMLElement {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { nodeType?: unknown }).nodeType !== 1 ||
    !(value as { ownerDocument?: unknown }).ownerDocument
  ) {
    throw new TypeError(`${label} must be an HTML element`)
  }
}
