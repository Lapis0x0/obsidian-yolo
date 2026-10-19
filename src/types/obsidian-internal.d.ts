import 'obsidian'

declare module 'obsidian' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- Declaration merging with Obsidian's own Keymap requires an interface.
  interface Keymap {
    /**
     * The root scope Obsidian dispatches key events into.
     *
     * Not part of the published API surface, but it is the only way to parent a
     * new `Scope` to the app's own stack, which is what makes shortcuts and Esc
     * layering work inside popout windows — there the host consumes the same
     * keys at capture phase, so DOM listeners never see them.
     */
    scope: Scope
  }

  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- Declaration merging with Obsidian's own WorkspaceRibbon requires an interface.
  interface WorkspaceRibbon {
    /**
     * Unregisters a ribbon icon by `<plugin id>:<title>` while keeping its
     * saved position. Not part of the published API surface, but it is what
     * `Plugin.addRibbonIcon` itself calls on unload; detaching the button
     * alone leaves it registered, and the next ribbon render re-attaches it.
     */
    removeRibbonAction(id: string): void
  }
}
