export function getNodeDocument(node?: Node | null): Document {
  return node?.ownerDocument ?? document
}

export function getNodeWindow(node?: Node | null): Window {
  return getNodeDocument(node).defaultView ?? window
}

export function getNodeBody(node?: Node | null): HTMLElement {
  return getNodeDocument(node).body
}
