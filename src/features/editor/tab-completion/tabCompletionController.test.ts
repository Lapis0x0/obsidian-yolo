import { TabCompletionController } from './tabCompletionController'

const createController = (triggers: unknown[]) =>
  new TabCompletionController({
    getSettings: () => ({
      continuationOptions: {
        tabCompletionOptions: { contextRange: 4000 },
        tabCompletionTriggers: triggers,
      },
    }),
    clearInlineSuggestion: jest.fn(),
  } as never)

const createView = (text: string) =>
  ({
    state: {
      doc: {
        sliceString: (from: number, to: number) => text.slice(from, to),
      },
      selection: { main: { head: text.length } },
    },
  }) as never

describe('TabCompletionController replacement triggers', () => {
  it('records the complete regex match ending at the cursor for replacement', () => {
    const controller = createController([
      {
        id: 'inline-math',
        type: 'regex',
        pattern: '\\$[^$\\n]*$',
        enabled: true,
        acceptMode: 'replace',
      },
    ])

    expect(
      (controller as any).getTriggerMatch(createView('$质能方程'), 5),
    ).toEqual({ replaceFromOffset: 0 })
  })

  it('does not use an earlier regex match as a replacement range', () => {
    const controller = createController([
      {
        id: 'inline-math',
        type: 'regex',
        pattern: '\\$[^$\\s]*',
        enabled: true,
        acceptMode: 'replace',
      },
    ])

    expect(
      (controller as any).getTriggerMatch(createView('$x trailing'), 11),
    ).toBeNull()
  })

  it('replaces the recorded range when accepting a suggestion', () => {
    const replaceRange = jest.fn()
    const clearInlineSuggestion = jest.fn()
    const view = {
      state: { selection: { main: { head: 5 } } },
    } as never
    const editor = {
      getSelection: () => '',
      getCursor: () => ({ line: 0, ch: 5 }),
      offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
      replaceRange,
      setCursor: jest.fn(),
    } as never
    const controller = new TabCompletionController({
      getEditorView: () => view,
      clearInlineSuggestion,
    } as never)
    ;(controller as any).tabCompletionSuggestion = {
      editor,
      view,
      cursorOffset: 5,
      replaceFromOffset: 0,
      candidates: [{ text: '$E = mc^2$', status: 'complete' }],
      selectedIndex: 0,
      hasUserNavigated: false,
      multipleCandidates: false,
    }

    expect(controller.tryAcceptFromView(view)).toBe(true)
    expect(replaceRange).toHaveBeenCalledWith(
      '$E = mc^2$',
      { line: 0, ch: 0 },
      { line: 0, ch: 5 },
    )
    expect(clearInlineSuggestion).toHaveBeenCalled()
  })
})
