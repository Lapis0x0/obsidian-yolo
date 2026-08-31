export function getNodeDocument(node?: Node | null): Document {
  return node?.ownerDocument ?? document
}

// `Window & typeof globalThis` is what `defaultView` already resolves to, and
// it is the half that matters for popouts: realm-specific constructors and
// globals (`ResizeObserver`, `getComputedStyle`, timers) live on `globalThis`,
// not on the `Window` interface. Narrowing to bare `Window` would push callers
// back onto the main window's globals — the exact bug this module exists to
// prevent.
export function getNodeWindow(node?: Node | null): Window & typeof globalThis {
  return getNodeDocument(node).defaultView ?? window
}

export function getNodeBody(node?: Node | null): HTMLElement {
  return getNodeDocument(node).body
}
