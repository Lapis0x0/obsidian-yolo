import { resolvePopoverContainer } from './OwnerDocumentPopover'

describe('resolvePopoverContainer', () => {
  it('keeps a card menu in the anchor pop-out document', () => {
    const popoutBody = {} as HTMLElement
    const anchor = { ownerDocument: { body: popoutBody } } as unknown as Node

    expect(resolvePopoverContainer(undefined, anchor)).toBe(popoutBody)
  })

  it('prefers an explicit portal container', () => {
    const explicit = {} as HTMLElement
    const anchor = {
      ownerDocument: { body: {} as HTMLElement },
    } as unknown as Node

    expect(resolvePopoverContainer(explicit, anchor)).toBe(explicit)
  })
})
