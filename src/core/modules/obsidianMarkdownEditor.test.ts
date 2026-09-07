jest.mock('obsidian', () => ({ App: jest.fn(), TFile: class {} }))

import {
  assertMarkdownEditorInstance,
  createQuickAskBlurGate,
  extractMarkdownEditorClass,
} from './obsidianMarkdownEditor'

// Mirrors the real shape: the embed instantiates a subclass, and the class the
// host wants is what that subclass extends — two prototype hops up.
class EditorBase {}
class EmbedEditor extends EditorBase {}

const widgetWithEditMode = (editMode: unknown) => ({ editMode })

describe('extractMarkdownEditorClass', () => {
  it('returns the base class the embed editor derives from', () => {
    const resolved = extractMarkdownEditorClass(
      widgetWithEditMode(new EmbedEditor()),
    )
    expect(resolved).toBe(EditorBase)
    expect(resolved).not.toBe(EmbedEditor)
  })

  // Each rejection names its own step: when a future Obsidian changes shape,
  // the error is what tells us where it changed.
  it.each([
    ['no widget at all', null, /embed registry returned no Markdown embed/],
    [
      'a widget without edit mode',
      widgetWithEditMode(undefined),
      /exposed no edit mode/,
    ],
    [
      'an edit mode with no base prototype',
      widgetWithEditMode(Object.create(null)),
      /no base prototype/,
    ],
    [
      'a base prototype without a constructor',
      widgetWithEditMode(Object.create(Object.create(null))),
      /no base prototype|no constructor/,
    ],
  ])('rejects %s', (_label, widget, message) => {
    expect(() => extractMarkdownEditorClass(widget)).toThrow(message)
  })

  it('explains that the editor is unavailable rather than failing opaquely', () => {
    expect(() => extractMarkdownEditorClass(null)).toThrow(
      /no longer exposes the editor component/,
    )
  })
})

describe('assertMarkdownEditorInstance', () => {
  const validInstance = () => ({
    set: jest.fn(),
    destroy: jest.fn(),
    cm: {
      hasFocus: false,
      focus: jest.fn(),
      dispatch: jest.fn(),
      contentDOM: {},
    },
    editor: {
      getValue: jest.fn(),
      setValue: jest.fn(),
      getCursor: jest.fn(),
      replaceRange: jest.fn(),
      posToOffset: jest.fn(),
    },
  })

  it('accepts an instance carrying every member the host drives', () => {
    expect(() => assertMarkdownEditorInstance(validInstance())).not.toThrow()
  })

  it('rejects a CodeMirror view that cannot be dispatched to', () => {
    const instance = validInstance()
    instance.cm = { ...instance.cm, dispatch: undefined as never }
    expect(() => assertMarkdownEditorInstance(instance)).toThrow(
      /no CodeMirror view/,
    )
  })

  it.each([
    ['set', /no set\(\)/],
    ['destroy', /no destroy\(\)/],
    ['cm', /no CodeMirror view/],
    ['editor', /no editor interface/],
  ])('rejects an instance missing %s', (member, message) => {
    const instance = Object.fromEntries(
      Object.entries(validInstance()).filter(([key]) => key !== member),
    )
    expect(() => assertMarkdownEditorInstance(instance)).toThrow(message)
  })

  it('rejects a construction that produced nothing', () => {
    expect(() => assertMarkdownEditorInstance(null)).toThrow(/no instance/)
  })
})

describe('createQuickAskBlurGate', () => {
  const gate = (hasFocus: () => boolean) => {
    const emitBlur = jest.fn()
    return {
      emitBlur,
      gate: createQuickAskBlurGate({ emitBlur, editorHasFocus: hasFocus }),
    }
  }

  it('reports a blur when no panel is up', () => {
    const { emitBlur, gate: blurGate } = gate(() => false)
    blurGate.handleBlur()
    expect(emitBlur).toHaveBeenCalledTimes(1)
  })

  // Opening the panel takes focus out of the editor; an owner that reads that
  // as "the user left" would tear the editor down under the panel.
  it('says nothing about focus moving to the panel', () => {
    const { emitBlur, gate: blurGate } = gate(() => false)
    blurGate.setPanelOpen(true)
    blurGate.handleBlur()
    blurGate.handleBlur()
    expect(emitBlur).not.toHaveBeenCalled()
  })

  it('delivers the missed blur when the panel closes and focus went elsewhere', () => {
    const { emitBlur, gate: blurGate } = gate(() => false)
    blurGate.setPanelOpen(true)
    blurGate.handleBlur()
    blurGate.setPanelOpen(false)
    expect(emitBlur).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when the panel handed focus back to the editor', () => {
    const { emitBlur, gate: blurGate } = gate(() => true)
    blurGate.setPanelOpen(true)
    blurGate.handleBlur()
    blurGate.setPanelOpen(false)
    expect(emitBlur).not.toHaveBeenCalled()
  })

  it('resumes reporting blurs once the panel is gone', () => {
    const { emitBlur, gate: blurGate } = gate(() => true)
    blurGate.setPanelOpen(true)
    blurGate.setPanelOpen(false)
    blurGate.handleBlur()
    expect(emitBlur).toHaveBeenCalledTimes(1)
  })
})
