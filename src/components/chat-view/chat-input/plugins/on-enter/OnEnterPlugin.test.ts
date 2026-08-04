jest.mock('obsidian', () => ({
  Platform: { isMacOS: false, isMobile: false },
}))

jest.mock('@lexical/react/LexicalComposerContext', () => ({
  useLexicalComposerContext: jest.fn(),
}))

jest.mock('react', () => ({
  useEffect: (effect: () => void) => effect(),
}))

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { Platform } from 'obsidian'

import OnEnterPlugin from './OnEnterPlugin'

type EnterHandler = (event: KeyboardEvent) => boolean

function getEnterHandler({
  onEnter = jest.fn(),
  onVaultChat,
  enterKeyCreatesNewline,
}: {
  onEnter?: jest.Mock
  onVaultChat?: jest.Mock
  enterKeyCreatesNewline?: boolean
} = {}): EnterHandler {
  let handler: EnterHandler | undefined
  const editor = {
    registerCommand: jest.fn((_command, callback: EnterHandler) => {
      handler = callback
      return jest.fn()
    }),
  }

  ;(useLexicalComposerContext as jest.Mock).mockReturnValue([editor])
  OnEnterPlugin({ onEnter, onVaultChat, enterKeyCreatesNewline })

  if (!handler) {
    throw new Error('Enter handler was not registered')
  }

  return handler
}

function createEnterEvent({
  shiftKey = false,
  ctrlKey = false,
  metaKey = false,
} = {}): {
  event: KeyboardEvent
  preventDefault: jest.Mock
} {
  const preventDefault = jest.fn()

  return {
    event: {
      shiftKey,
      ctrlKey,
      metaKey,
      preventDefault,
      stopPropagation: jest.fn(),
    } as unknown as KeyboardEvent,
    preventDefault,
  }
}

describe('OnEnterPlugin', () => {
  beforeEach(() => {
    ;(Platform as { isMobile: boolean }).isMobile = false
    jest.clearAllMocks()
  })

  it('submits a plain Enter on desktop', () => {
    const onEnter = jest.fn()
    const handler = getEnterHandler({ onEnter })
    const { event, preventDefault } = createEnterEvent()

    expect(handler(event)).toBe(true)
    expect(onEnter).toHaveBeenCalledWith(event)
    expect(preventDefault).toHaveBeenCalled()
  })

  it('lets a plain Enter create a newline on mobile', () => {
    ;(Platform as { isMobile: boolean }).isMobile = true
    const onEnter = jest.fn()
    const handler = getEnterHandler({ onEnter })
    const { event, preventDefault } = createEnterEvent()

    expect(handler(event)).toBe(false)
    expect(onEnter).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('lets a plain Enter create a newline when configured', () => {
    const onEnter = jest.fn()
    const handler = getEnterHandler({
      onEnter,
      enterKeyCreatesNewline: true,
    })
    const { event, preventDefault } = createEnterEvent()

    expect(handler(event)).toBe(false)
    expect(onEnter).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('submits Cmd/Ctrl + Enter when plain Enter creates a newline', () => {
    const onEnter = jest.fn()
    const handler = getEnterHandler({
      onEnter,
      enterKeyCreatesNewline: true,
    })
    const { event, preventDefault } = createEnterEvent({ ctrlKey: true })

    expect(handler(event)).toBe(true)
    expect(onEnter).toHaveBeenCalledWith(event)
    expect(preventDefault).toHaveBeenCalled()
  })
})
