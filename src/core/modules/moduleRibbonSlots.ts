import type { Plugin } from 'obsidian'

/**
 * Obsidian applies the left ribbon's saved order and visibility once, when it
 * loads the workspace layout, and only to icons registered by then. An icon
 * added later is appended at the end, and the next layout save overwrites its
 * saved position. Module code loads well after that point, so each module's
 * ribbon icon is a host-owned slot: the last declaration is remembered on this
 * device, re-registered during plugin load, and taken over by the activated
 * module under the same ribbon id (`<plugin id>:<title>`).
 *
 * Device-local, like the module activations it mirrors.
 */
const STORAGE_KEY = 'yolo-module-ribbon-slots'

type RibbonSlotDeclaration = Readonly<{ icon: string; title: string }>

type RibbonSlot = {
  title: string
  buttonEl: HTMLElement
  claimed: boolean
}

export class ModuleRibbonSlots {
  private readonly slots = new Map<string, RibbonSlot>()
  private readonly declarations = new Map<string, RibbonSlotDeclaration>()

  constructor(private readonly plugin: Plugin) {}

  /** Must run during plugin load, before Obsidian restores the layout. */
  restore(): void {
    for (const [moduleId, declaration] of readDeclarations(this.plugin)) {
      this.declarations.set(moduleId, declaration)
      const buttonEl = this.plugin.addRibbonIcon(
        declaration.icon,
        declaration.title,
        () => {},
      )
      this.slots.set(moduleId, {
        title: declaration.title,
        buttonEl,
        claimed: false,
      })
    }
  }

  bind(
    moduleId: string,
    icon: string,
    title: string,
    onClick: () => void,
  ): HTMLElement {
    // A changed title is a different ribbon id (e.g. after a language switch),
    // so the restored placeholder cannot be taken over.
    if (this.slots.get(moduleId)?.title !== title) this.remove(moduleId)
    const buttonEl = this.plugin.addRibbonIcon(icon, title, onClick)
    this.slots.set(moduleId, { title, buttonEl, claimed: true })
    this.declarations.set(moduleId, { icon, title })
    this.persist()
    return buttonEl
  }

  /** Removes the icon but keeps the declaration for the next plugin load. */
  unbind(moduleId: string): void {
    this.remove(moduleId)
  }

  /** The module will no longer activate on startup. */
  forget(moduleId: string): void {
    if (this.declarations.delete(moduleId)) this.persist()
  }

  /** Startup activation has settled: drop placeholders no module took over. */
  releaseUnclaimed(): void {
    for (const [moduleId, slot] of [...this.slots]) {
      if (slot.claimed) continue
      this.remove(moduleId)
      this.forget(moduleId)
    }
  }

  private remove(moduleId: string): void {
    const slot = this.slots.get(moduleId)
    if (!slot) return
    this.slots.delete(moduleId)
    // Detaching the button alone is not enough: the ribbon re-attaches every
    // registered button on its next render. Mirrors Plugin.addRibbonIcon's own
    // unload cleanup, and keeps the item's saved position for a later rebind.
    this.plugin.app.workspace.leftRibbon.removeRibbonAction(
      `${this.plugin.manifest.id}:${slot.title}`,
    )
    slot.buttonEl.detach()
  }

  private persist(): void {
    this.plugin.app.saveLocalStorage(
      STORAGE_KEY,
      Object.fromEntries(this.declarations),
    )
  }
}

function readDeclarations(
  plugin: Plugin,
): Array<[string, RibbonSlotDeclaration]> {
  const stored: unknown = plugin.app.loadLocalStorage(STORAGE_KEY)
  if (!stored || typeof stored !== 'object') return []
  return Object.entries(stored).flatMap(([moduleId, value]) => {
    const { icon, title } = (value ?? {}) as Record<string, unknown>
    return typeof icon === 'string' && typeof title === 'string'
      ? [[moduleId, { icon, title }] as [string, RibbonSlotDeclaration]]
      : []
  })
}
