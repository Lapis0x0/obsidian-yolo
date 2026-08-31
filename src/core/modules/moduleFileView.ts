import {
  type Menu,
  type Plugin,
  Scope,
  TAbstractFile,
  TFile,
  TFolder,
  TextFileView,
  type WorkspaceLeaf,
} from 'obsidian'

import {
  createTranslationFunction,
  resolveLanguageFromLocale,
} from '../../i18n'
import { getNodeDocument, getNodeWindow } from '../../utils/dom/window-context'
import { type LocaleStore } from '../i18n/localeStore'

import type { ModuleLifecycleScope } from './lifecycleScope'
import { resolveLocalizedText } from './moduleI18n'
import { describeEntry } from './moduleVault'
import type {
  ModuleDisposer,
  YoloModuleFileMenuActionV1,
  YoloModuleFileViewContextV1,
  YoloModuleFileViewInstanceV1,
  YoloModuleFileViewV1,
  YoloModuleKeymapBindingV1,
} from './types'

// Obsidian has no public unregisterView/unregisterExtensions API, so — same
// as ModuleViewSlot in moduleRuntime.tsx — each file view type keeps one
// host-owned slot for the plugin's lifetime while module declarations are
// bound/released independently across activation changes.
type ModuleFileViewSlotListener = (
  declaration: YoloModuleFileViewV1 | null,
) => void

export class ModuleFileViewSlot {
  private declaration: YoloModuleFileViewV1 | null = null
  private readonly listeners = new Set<ModuleFileViewSlotListener>()

  constructor(
    readonly moduleId: string,
    readonly viewType: string,
    readonly icon: string,
    private readonly name: YoloModuleFileViewV1['name'],
    private readonly locales: LocaleStore,
  ) {}

  getName(): string {
    return resolveLocalizedText(
      this.declaration?.name ?? this.name,
      this.locales.getSnapshot().locale,
    )
  }

  /** Host-owned copy for when no module claims this file type right now. */
  getInactivePlaceholderText(): string {
    const t = createTranslationFunction(
      resolveLanguageFromLocale(this.locales.getSnapshot().locale),
    )
    return t('moduleFileView.inactivePlaceholder')
  }

  get(): YoloModuleFileViewV1 | null {
    return this.declaration
  }

  bind(declaration: YoloModuleFileViewV1): void {
    if (this.declaration) {
      throw new Error(
        `Module file view type "${this.viewType}" is already active`,
      )
    }
    if (declaration.viewType !== this.viewType) {
      throw new Error(
        `Module "${this.moduleId}" changed file view type from "${this.viewType}" to "${declaration.viewType}"`,
      )
    }
    this.declaration = declaration
    for (const listener of this.listeners) listener(declaration)
  }

  unbind(expected?: YoloModuleFileViewV1): void {
    if (!this.declaration || (expected && this.declaration !== expected)) {
      return
    }
    this.declaration = null
    for (const listener of this.listeners) listener(null)
  }

  subscribe(listener: ModuleFileViewSlotListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/**
 * Host-owned TextFileView that bridges Obsidian's file-view lifecycle to a
 * module's YoloModuleFileViewInstanceV1. One instance exists per open leaf;
 * the module-side `instance` is created/torn down as the backing
 * ModuleFileViewSlot binds/unbinds (module activation/deactivation) and on
 * popout window migration.
 *
 * `cachedData` always mirrors the most recently known file content —
 * refreshed from the live instance right before every teardown, not only on
 * setViewData — so getViewData() can never regress to '' (and silently wipe
 * the user's file) while the owning module happens to be inactive.
 */
/**
 * Obsidian's View base constructor calls `getViewType()` before the subclass
 * constructor body — and therefore before TS parameter properties like
 * `this.slot` — has run. Construction is synchronous, so
 * `createModuleFileView` parks the slot here for the duration of
 * `new HostModuleFileView(...)` and the slot accessors below fall back to it.
 */
let constructingSlot: ModuleFileViewSlot | null = null

class HostModuleFileView extends TextFileView {
  private instance: YoloModuleFileViewInstanceV1 | null = null
  private cachedData = ''
  private opened = false
  private closed = true
  private unsubscribeSlot: (() => void) | null = null
  private windowMigratedDisposer: (() => void) | null = null

  constructor(
    leaf: WorkspaceLeaf,
    private readonly hostPlugin: Plugin,
    private readonly slot: ModuleFileViewSlot,
  ) {
    super(leaf)
  }

  /** `this.slot` is undefined while the base View constructor is still
   * running (see `constructingSlot`) — every slot read in a method Obsidian
   * may call from that constructor must go through here. */
  private resolveSlot(): ModuleFileViewSlot {
    const slot =
      (this.slot as ModuleFileViewSlot | undefined) ?? constructingSlot
    if (!slot) {
      throw new Error('HostModuleFileView slot is not available')
    }
    return slot
  }

  getViewType(): string {
    return this.resolveSlot().viewType
  }

  getDisplayText(): string {
    return this.file?.basename ?? this.resolveSlot().getName()
  }

  getIcon(): string {
    const slot = this.resolveSlot()
    return slot.get()?.icon ?? slot.icon
  }

  onOpen(): Promise<void> {
    this.closed = false
    this.opened = true
    this.unsubscribeSlot = this.slot.subscribe(() => this.syncInstance())
    this.windowMigratedDisposer = this.containerEl.onWindowMigrated(() =>
      this.syncInstance(),
    )
    this.syncInstance()
    // EditableFileView.onOpen is what makes the view-header title editable
    // (click-to-rename); skipping the super chain silently loses it.
    return super.onOpen()
  }

  onClose(): Promise<void> {
    this.closed = true
    this.opened = false
    this.unsubscribeSlot?.()
    this.unsubscribeSlot = null
    this.windowMigratedDisposer?.()
    this.windowMigratedDisposer = null
    // Refreshes cachedData from the live instance before the super chain's
    // loadFile(null) → onUnloadFile → save(true) flushes any pending edit
    // through getViewData(); TextFileView.save skips the write when the
    // data is unchanged.
    this.disposeInstance()
    this.releaseKeymapScope()
    return super.onClose()
  }

  getViewData(): string {
    if (this.instance) {
      try {
        return this.instance.getViewData()
      } catch (error) {
        this.reportError('getViewData', error)
      }
    }
    return this.cachedData
  }

  setViewData(data: string, clear: boolean): void {
    this.cachedData = data
    if (this.instance) {
      try {
        this.instance.setViewData(data, clear)
        return
      } catch (error) {
        this.reportError('setViewData', error)
        return
      }
    }
    // No live instance (module inactive, or setViewData ran before onOpen):
    // just cache the data. onOpen()/slot bind will replay it once an
    // instance exists; until then a visible view keeps showing the
    // placeholder.
    if (this.opened && !this.closed) this.renderPlaceholder()
  }

  clear(): void {
    if (this.instance) {
      try {
        this.instance.clear()
      } catch (error) {
        this.reportError('clear', error)
      }
    }
    this.cachedData = ''
  }

  onResize(): void {
    if (!this.instance?.onResize) return
    try {
      this.instance.onResize()
    } catch (error) {
      this.reportError('onResize', error)
    }
  }

  /** Rebuilds instance state from the current slot: bound -> live instance,
   * unbound -> placeholder. Used on open, on every slot bind/unbind, and on
   * popout window migration (dispose old instance, rebuild via factory,
   * replay cached data). */
  private syncInstance(): void {
    if (this.closed || !this.opened) return
    this.disposeInstance()
    const declaration = this.slot.get()
    if (!declaration) {
      this.renderPlaceholder()
      return
    }
    this.buildInstance(declaration)
  }

  private buildInstance(declaration: YoloModuleFileViewV1): void {
    this.clearContentEl()
    const context = this.buildContext()
    let instance: YoloModuleFileViewInstanceV1
    try {
      instance = declaration.factory(context)
    } catch (error) {
      this.reportError('factory', error)
      this.renderPlaceholder()
      return
    }
    if (!isValidInstance(instance)) {
      console.error(
        `[YOLO] Module file view "${this.slot.viewType}" factory returned an invalid instance`,
      )
      this.renderPlaceholder()
      return
    }
    this.instance = instance
    try {
      instance.setViewData(this.cachedData, true)
    } catch (error) {
      this.reportError('setViewData', error)
    }
  }

  private disposeInstance(): void {
    if (!this.instance) return
    const instance = this.instance
    this.instance = null
    // Pull the live editing state into the cache before tearing the
    // instance down — this is what lets getViewData() keep returning the
    // user's latest content after the module deactivates or the leaf
    // migrates windows, instead of only the last explicit setViewData().
    try {
      this.cachedData = instance.getViewData()
    } catch (error) {
      this.reportError('getViewData (teardown)', error)
    }
    try {
      instance.dispose()
    } catch (error) {
      this.reportError('dispose', error)
    }
  }

  private renderPlaceholder(): void {
    this.clearContentEl()
    const doc = getNodeDocument(this.contentEl)
    const el = doc.createElement('div')
    el.className = 'yolo-module-file-view-placeholder'
    el.setAttribute('role', 'status')
    el.textContent = this.slot.getInactivePlaceholderText()
    this.contentEl.appendChild(el)
  }

  private clearContentEl(): void {
    while (this.contentEl.firstChild) {
      this.contentEl.removeChild(this.contentEl.firstChild)
    }
  }

  private buildContext(): YoloModuleFileViewContextV1 {
    return Object.freeze({
      contentEl: this.contentEl,
      getFile: () => {
        const file = this.file
        if (!file) return null
        return Object.freeze({
          path: file.path,
          basename: file.basename,
          extension: file.extension,
        })
      },
      getDocument: () => getNodeDocument(this.contentEl),
      getWindow: () => getNodeWindow(this.contentEl),
      requestSave: () => this.requestSave(),
      registerKeymap: (bindings) => this.registerKeymap(bindings),
    })
  }

  /**
   * One scope per view, created on first use and handed to Obsidian through
   * `View.scope` — the workspace consults `activeLeaf.view.scope` on every
   * key, so these bindings arm and disarm with the leaf's focus at no cost
   * to us. Separate `registerKeymap` calls add and remove their own
   * registrations on that one scope (there is nothing to stack: the scope's
   * lifetime is the view's).
   */
  private registerKeymap(
    bindings: readonly YoloModuleKeymapBindingV1[],
  ): ModuleDisposer {
    const validated = validateKeymapBindings(bindings)
    const scope = (this.scope ??= new Scope(this.hostPlugin.app.scope))
    const registered = validated.map((binding) =>
      scope.register([...binding.modifiers], binding.key, () => {
        let consumed = false
        try {
          consumed = binding.handler() === true
        } catch (error) {
          this.reportError('keymap handler', error)
        }
        return consumed ? false : undefined
      }),
    )
    let active = true
    return () => {
      if (!active) return
      active = false
      for (const handler of registered) scope.unregister(handler)
    }
  }

  /** The scope is reachable only through this view, so dropping it releases
   * every binding a module left behind. */
  private releaseKeymapScope(): void {
    this.scope = null
  }

  private reportError(stage: string, error: unknown): void {
    console.error(
      `[YOLO] Module file view "${this.slot.viewType}" ${stage} failed`,
      error,
    )
  }
}

export function createModuleFileView(
  leaf: WorkspaceLeaf,
  plugin: Plugin,
  slot: ModuleFileViewSlot,
): TextFileView {
  constructingSlot = slot
  try {
    return new HostModuleFileView(leaf, plugin, slot)
  } finally {
    constructingSlot = null
  }
}

/**
 * Holds every module's committed file-menu actions and dispatches Obsidian's
 * `file-menu` event to them. Registered once for the plugin's lifetime
 * (constructor), independent of any single module's activation — actions
 * are looked up fresh every time the event fires, so a deactivated module's
 * actions simply stop appearing without any extra bookkeeping here.
 */
export class ModuleFileMenuRegistry {
  private readonly actionsByModuleId = new Map<
    string,
    ReadonlyMap<string, YoloModuleFileMenuActionV1>
  >()

  constructor(
    private readonly plugin: Plugin,
    private readonly locales: LocaleStore,
  ) {
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('file-menu', (menu, file) => {
        this.populate(menu, file)
      }),
    )
  }

  commit(
    moduleId: string,
    actions: readonly YoloModuleFileMenuActionV1[],
    lifecycle: ModuleLifecycleScope,
  ): void {
    const map = new Map(actions.map((action) => [action.id, action]))
    this.actionsByModuleId.set(moduleId, map)
    lifecycle.add(() => {
      if (this.actionsByModuleId.get(moduleId) === map) {
        this.actionsByModuleId.delete(moduleId)
      }
    })
  }

  deactivate(moduleId: string): void {
    this.actionsByModuleId.delete(moduleId)
  }

  private populate(menu: Menu, file: TAbstractFile): void {
    if (this.actionsByModuleId.size === 0) return
    let appliesTo: 'file' | 'folder'
    let extension = ''
    if (file instanceof TFile) {
      appliesTo = 'file'
      extension = file.extension.toLowerCase()
    } else if (file instanceof TFolder) {
      appliesTo = 'folder'
    } else {
      return
    }
    const entry = describeEntry(file)
    const locale = this.locales.getSnapshot().locale
    for (const actions of this.actionsByModuleId.values()) {
      for (const action of actions.values()) {
        if (action.appliesTo !== appliesTo) continue
        if (
          appliesTo === 'file' &&
          action.extensions &&
          action.extensions.length > 0 &&
          !action.extensions.includes(extension)
        ) {
          continue
        }
        menu.addItem((item) => {
          item.setTitle(resolveLocalizedText(action.title, locale))
          item.setIcon(action.icon)
          item.onClick(() => {
            try {
              const result = action.onSelect(entry)
              if (isThenable(result)) {
                void Promise.resolve(result).catch((error: unknown) => {
                  console.error(
                    `[YOLO] Module file menu action "${action.id}" failed`,
                    error,
                  )
                })
              }
            } catch (error) {
              console.error(
                `[YOLO] Module file menu action "${action.id}" failed`,
                error,
              )
            }
          })
        })
      }
    }
  }
}

function isValidInstance(
  value: unknown,
): value is YoloModuleFileViewInstanceV1 {
  return (
    Boolean(value) &&
    typeof (value as YoloModuleFileViewInstanceV1).setViewData === 'function' &&
    typeof (value as YoloModuleFileViewInstanceV1).getViewData === 'function' &&
    typeof (value as YoloModuleFileViewInstanceV1).clear === 'function' &&
    typeof (value as YoloModuleFileViewInstanceV1).dispose === 'function'
  )
}

const KEYMAP_MODIFIERS: ReadonlySet<string> = new Set([
  'Mod',
  'Ctrl',
  'Meta',
  'Shift',
  'Alt',
])

function validateKeymapBindings(
  bindings: readonly YoloModuleKeymapBindingV1[],
): readonly YoloModuleKeymapBindingV1[] {
  if (!Array.isArray(bindings)) {
    throw new TypeError('Module keymap bindings must be an array')
  }
  return bindings.map((binding) => {
    if (!binding || typeof binding !== 'object') {
      throw new TypeError('Module keymap binding must be an object')
    }
    if (!Array.isArray(binding.modifiers)) {
      throw new TypeError('Module keymap binding modifiers must be an array')
    }
    for (const modifier of binding.modifiers) {
      if (!KEYMAP_MODIFIERS.has(modifier)) {
        throw new TypeError(
          `Module keymap binding modifier "${String(modifier)}" is invalid`,
        )
      }
    }
    if (typeof binding.key !== 'string' || !binding.key) {
      throw new TypeError(
        'Module keymap binding key must be a non-empty string',
      )
    }
    if (typeof binding.handler !== 'function') {
      throw new TypeError('Module keymap binding handler must be a function')
    }
    return Object.freeze({
      ...binding,
      modifiers: Object.freeze([...binding.modifiers]),
    })
  })
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  )
}
