import { createRoot } from 'react-dom/client'

/**
 * React 18 adds a `selectionchange` listener to a document the first time a
 * root is created in it, and never removes it. That listener closes over the
 * plugin bundle, so after a plugin reload it keeps the entire previous plugin
 * alive. Call this before any other root is created in `doc`: it triggers the
 * registration on a throwaway root, records the listeners React added, and
 * returns a disposer that removes them.
 */
export function captureReactDocumentListeners(doc: Document): () => void {
  const captured: Parameters<Document['addEventListener']>[] = []
  const ownDescriptor = Object.getOwnPropertyDescriptor(doc, 'addEventListener')
  const original = doc.addEventListener.bind(doc)
  doc.addEventListener = (
    ...args: Parameters<Document['addEventListener']>
  ) => {
    captured.push(args)
    original(...args)
  }
  try {
    createRoot(doc.createElement('div')).unmount()
  } finally {
    if (ownDescriptor) {
      Object.defineProperty(doc, 'addEventListener', ownDescriptor)
    } else {
      Reflect.deleteProperty(doc, 'addEventListener')
    }
  }
  return () => {
    for (const [type, listener, options] of captured) {
      doc.removeEventListener(type, listener, options)
    }
  }
}
