import { createOwnerLearningLifecyclePorts } from './lifecycle'

type Listener = () => void

class FakeEventTarget {
  readonly listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener as Listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) {
    this.listeners.get(type)?.delete(listener as Listener)
  }

  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
}

describe('owner Learning lifecycle ports', () => {
  it('uses the owner window and document and removes subscriptions', () => {
    const ownerWindow = new FakeEventTarget()
    const ownerDocument = new FakeEventTarget()
    const setTimeout = jest.fn(() => 41)
    const clearTimeout = jest.fn()
    Object.assign(ownerWindow, { setTimeout, clearTimeout })
    Object.assign(ownerDocument, {
      defaultView: ownerWindow,
      nodeType: 9,
      ownerDocument: null,
      visibilityState: 'hidden',
    })
    const lifecycle = createOwnerLearningLifecyclePorts(
      ownerDocument as unknown as Document,
    )
    const onFocus = jest.fn()
    const onVisible = jest.fn()
    const unsubscribeFocus = lifecycle.focus.subscribeFocus(onFocus)
    const unsubscribeVisible = lifecycle.visibility.subscribeVisible(onVisible)

    ownerWindow.dispatch('focus')
    ownerDocument.dispatch('visibilitychange')
    Object.assign(ownerDocument, { visibilityState: 'visible' })
    ownerDocument.dispatch('visibilitychange')
    const handle = lifecycle.clock.setTimeout(jest.fn(), 100)
    lifecycle.clock.clearTimeout(handle)

    expect(onFocus).toHaveBeenCalledTimes(1)
    expect(onVisible).toHaveBeenCalledTimes(1)
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 100)
    expect(clearTimeout).toHaveBeenCalledWith(41)

    unsubscribeFocus()
    unsubscribeVisible()
    ownerWindow.dispatch('focus')
    ownerDocument.dispatch('visibilitychange')
    expect(onFocus).toHaveBeenCalledTimes(1)
    expect(onVisible).toHaveBeenCalledTimes(1)
  })
})
