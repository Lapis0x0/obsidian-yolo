jest.mock('obsidian', () => ({ App: jest.fn(), TFile: class {} }))

import {
  assertMarkdownEditorInstance,
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
    getScroll: jest.fn(),
    applyScroll: jest.fn(),
    cm: { hasFocus: false, focus: jest.fn(), contentDOM: {} },
    editor: { getValue: jest.fn(), setValue: jest.fn() },
  })

  it('accepts an instance carrying every member the host drives', () => {
    expect(() => assertMarkdownEditorInstance(validInstance())).not.toThrow()
  })

  it.each([
    ['set', /no set\(\)/],
    ['destroy', /no destroy\(\)/],
    ['getScroll', /no getScroll\(\)/],
    ['applyScroll', /no applyScroll\(\)/],
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
