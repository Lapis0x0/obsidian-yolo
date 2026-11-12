// The script an HTML card puts in front of its page (cardRenderer.ts's
// `renderHtmlFrameInto`), and what the board accepts back from it.
//
// An HTML card's page runs in a sandbox without `allow-same-origin`: it cannot
// reach this window, and this window cannot reach into it. Everything the two
// say to each other goes through `postMessage`, and the bridge is the page's
// end of that — a fixed piece of source, handed the card's state as data, and
// run before anything the page itself contains.

/** What the bridge is handed when the page loads. */
export type PageBridgeInit = Readonly<Record<string, unknown>>

/** The bridge's own source, run with the card's state as its argument. */
const BRIDGE_SOURCE = `(function (init) {
  'use strict';
})`

/**
 * `html` with the bridge in front of everything the page runs.
 *
 * Right after the doctype when there is one — in front of it would put the
 * document in quirks mode — and at the very start otherwise. A `<script>`
 * there is parsed into an implicit `<head>` ahead of the page's own, so it
 * runs before any script, stylesheet or markup of the page's; the page's own
 * `<html>` and `<head>` tags that follow are folded into the elements already
 * made, attributes and all, as the HTML parser does for any such document.
 */
export function withPageBridge(html: string, init: PageBridgeInit): string {
  const script = `<script>${BRIDGE_SOURCE}(${scriptJson(init)});</script>`
  const doctype = DOCTYPE_PATTERN.exec(html)
  if (!doctype) return script + html
  const at = doctype.index + doctype[0].length
  return html.slice(0, at) + script + html.slice(at)
}

/** A doctype at the start of a document: after a byte-order mark, white
 * space and comments, which may come before it. */
const DOCTYPE_PATTERN = /^\uFEFF?(?:\s|<!--[\s\S]*?-->)*<!doctype\b[^>]*>/i

/**
 * JSON that can stand inside an inline `<script>`. The HTML parser ends a
 * script at the first `</script` whatever JavaScript thinks it is inside, and
 * `<!--` can change how it reads what follows, so every `<` is written as its
 * escape; U+2028 and U+2029 are escaped too, being line terminators to older
 * JavaScript parsers inside a string.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
