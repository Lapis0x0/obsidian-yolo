import type { EditorView } from '@codemirror/view'

import type { YoloSettings } from '../../../settings/schema/setting.types'

import { handleQuickAskTriggerInput } from './quickAsk.trigger'

type Dispatch = { changes: { from: number; to: number } }

/**
 * Enough of a CodeMirror view for the trigger decision: a single-line
 * document, a collapsed or ranged selection, and a dispatch spy.
 */
function fakeView(
  text: string,
  head: number,
  anchor = head,
): { view: EditorView; dispatched: Dispatch[] } {
  const dispatched: Dispatch[] = []
  const view = {
    state: {
      selection: {
        main: {
          head,
          from: Math.min(head, anchor),
          to: Math.max(head, anchor),
          empty: head === anchor,
        },
      },
      doc: {
        lineAt: () => ({ from: 0, to: text.length, text }),
      },
    },
    dispatch: (spec: Dispatch) => dispatched.push(spec),
  } as unknown as EditorView
  return { view, dispatched }
}

function fakeEvent(
  overrides: Partial<InputEvent> = {},
): InputEvent & { prevented: boolean } {
  const event = {
    inputType: 'insertText',
    isComposing: false,
    data: '@',
    defaultPrevented: false,
    prevented: false,
    preventDefault() {
      ;(this as { prevented: boolean }).prevented = true
    },
    stopPropagation() {},
    ...overrides,
  }
  return event as unknown as InputEvent & { prevented: boolean }
}

const settings = (
  continuationOptions: Record<string, unknown> = {},
): (() => YoloSettings) =>
  (() => ({ continuationOptions })) as unknown as () => YoloSettings

describe('handleQuickAskTriggerInput', () => {
  it('opens Quick Ask on the view that received the trigger', () => {
    const { view, dispatched } = fakeView('', 0)
    const show = jest.fn()
    const event = fakeEvent()

    expect(
      handleQuickAskTriggerInput(event, view, {
        getSettings: settings(),
        show,
      }),
    ).toBe(true)
    expect(show).toHaveBeenCalledWith(view)
    expect(event.prevented).toBe(true)
    // Nothing typed before the trigger, so nothing to delete.
    expect(dispatched).toHaveLength(0)
  })

  it('removes an already-typed multi-character trigger before showing', () => {
    const { view, dispatched } = fakeView('/', 1)
    const show = jest.fn()

    expect(
      handleQuickAskTriggerInput(fakeEvent({ data: 'q' }), view, {
        getSettings: settings({ quickAskTrigger: '/q' }),
        show,
      }),
    ).toBe(true)
    expect(dispatched).toEqual([
      { changes: { from: 0, to: 1 }, selection: { anchor: 0 } },
    ])
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('lets a partial multi-character trigger through', () => {
    const { view } = fakeView('', 0)
    const show = jest.fn()

    expect(
      handleQuickAskTriggerInput(fakeEvent({ data: '/' }), view, {
        getSettings: settings({ quickAskTrigger: '/q' }),
        show,
      }),
    ).toBe(false)
    expect(show).not.toHaveBeenCalled()
  })

  it('stays out of the way when the feature is off, mid-composition, or the line is not empty', () => {
    const show = jest.fn()
    const options = { getSettings: settings(), show }

    expect(
      handleQuickAskTriggerInput(fakeEvent(), fakeView('', 0).view, {
        ...options,
        getSettings: settings({ enableQuickAsk: false }),
      }),
    ).toBe(false)
    expect(
      handleQuickAskTriggerInput(
        fakeEvent({ isComposing: true }),
        fakeView('', 0).view,
        options,
      ),
    ).toBe(false)
    expect(
      handleQuickAskTriggerInput(
        fakeEvent({ inputType: 'insertCompositionText' }),
        fakeView('', 0).view,
        options,
      ),
    ).toBe(false)
    expect(
      handleQuickAskTriggerInput(
        fakeEvent(),
        fakeView('text', 4).view,
        options,
      ),
    ).toBe(false)
    // A non-empty selection is a replacement, not a trigger.
    expect(
      handleQuickAskTriggerInput(
        fakeEvent(),
        fakeView('text', 4, 0).view,
        options,
      ),
    ).toBe(false)
    expect(show).not.toHaveBeenCalled()
  })

  // The guard is what keeps the Markdown-view route from opening a panel on a
  // view Obsidian no longer considers active — and it has to run before the
  // keystroke is consumed, or the character disappears with nothing to show
  // for it.
  it('leaves the keystroke alone when canTrigger refuses', () => {
    const { view, dispatched } = fakeView('/', 1)
    const show = jest.fn()
    const event = fakeEvent({ data: 'q' })

    expect(
      handleQuickAskTriggerInput(event, view, {
        getSettings: settings({ quickAskTrigger: '/q' }),
        canTrigger: () => false,
        show,
      }),
    ).toBe(false)
    expect(event.prevented).toBe(false)
    expect(dispatched).toHaveLength(0)
    expect(show).not.toHaveBeenCalled()
  })
})
