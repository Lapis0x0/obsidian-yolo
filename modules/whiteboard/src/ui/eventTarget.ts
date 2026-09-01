// `instanceof Element` / `instanceof Node`, minus the realm.
//
// An Obsidian popout is a separate BrowserWindow with its own `document` and
// its own DOM constructors, while the plugin's JavaScript keeps running in the
// main window's realm. So `target instanceof Element` — where `Element` is the
// main window's — is *false* for every node in a popped-out view, and every
// hit test written that way silently answers "not an element": cards cannot be
// dragged, a press on one starts a marquee instead, a group cannot be selected
// (CLAUDE.md, Popout / Multi-window). The host's own `window-context.ts` exists
// for the same reason; a module cannot import it (src/ is out of bounds), and
// these two questions are small enough to answer here.
//
// Answered by shape rather than by constructor: the property each check names
// is one every implementation of the interface has and nothing else the
// listeners can receive does (a `Window`, an `XMLHttpRequest`, an
// `AbortSignal`). Shape does not travel between realms; identity does not
// survive them.

/** The event target as an `Element`, or null when it is not one — including
 * when it is a text node, a document or a window. */
export function asElement(target: EventTarget | null): Element | null {
  const candidate = target as Element | null
  return candidate !== null && typeof candidate.closest === 'function'
    ? candidate
    : null
}

/** The event target as a `Node`, for the callers asking whether it is
 * *inside* something rather than what it is (`contains` takes a Node). */
export function asNode(target: EventTarget | null): Node | null {
  const candidate = target as Node | null
  return candidate !== null && typeof candidate.nodeType === 'number'
    ? candidate
    : null
}
