import type { LearningLifecyclePorts } from '../domain/stats/ports'

type LearningOwner = Document | HTMLElement
const DOCUMENT_NODE = 9

export function createOwnerLearningLifecyclePorts(
  owner: LearningOwner,
): LearningLifecyclePorts {
  const document = getOwnerDocument(owner)
  const window = document.defaultView
  if (!window) throw new Error('Learning owner document has no window')

  return {
    clock: {
      now: () => new Date(),
      setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    },
    focus: {
      subscribeFocus: (listener) => subscribe(window, 'focus', listener),
    },
    visibility: {
      subscribeVisible: (listener) =>
        subscribe(document, 'visibilitychange', () => {
          if (document.visibilityState === 'visible') listener()
        }),
    },
  }
}

function getOwnerDocument(owner: LearningOwner): Document {
  if (owner.nodeType === DOCUMENT_NODE) return owner as Document
  if (!owner.ownerDocument) {
    throw new Error('Learning owner element has no document')
  }
  return owner.ownerDocument
}

function subscribe(
  target: Window | Document,
  type: 'focus' | 'visibilitychange',
  listener: () => void,
): () => void {
  let subscribed = true
  target.addEventListener(type, listener)
  return () => {
    if (!subscribed) return
    subscribed = false
    target.removeEventListener(type, listener)
  }
}
