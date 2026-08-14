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
}
