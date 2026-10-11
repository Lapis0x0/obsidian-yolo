import { meets, selectorListNeeds, selectorNeeds } from './selectorNeeds'

const needs = (
  fields: Partial<{
    classes: string[]
    tags: string[]
    ids: string[]
    attributes: string[]
  }>,
) => ({ classes: [], tags: [], ids: [], attributes: [], ...fields })

const seen = (
  fields: Partial<{
    classes: string[]
    tags: string[]
    ids: string[]
    attributes: string[]
  }>,
) => ({
  classes: new Set(fields.classes),
  tags: new Set(fields.tags),
  ids: new Set(fields.ids),
  attributes: new Set(fields.attributes),
})

describe('selectorNeeds', () => {
  it('needs the classes, element names and ids a selector names', () => {
    expect(selectorNeeds('.markdown-rendered pre > code.hljs')).toEqual(
      needs({ classes: ['markdown-rendered', 'hljs'], tags: ['pre', 'code'] }),
    )
    expect(selectorNeeds('#editorUndoBar *')).toEqual(
      needs({ ids: ['editorUndoBar'] }),
    )
  })

  it('needs an attribute by value where it is compared by `=`', () => {
    expect(selectorNeeds('.callout[data-callout="warning"]')).toEqual(
      needs({ classes: ['callout'], attributes: ['data-callout=warning'] }),
    )
    expect(selectorNeeds('input[type=checkbox]')).toEqual(
      needs({ tags: ['input'], attributes: ['type=checkbox'] }),
    )
    // Any other comparison, or one that ignores case, by name only.
    expect(selectorNeeds('code[class*="language-"]')).toEqual(
      needs({ tags: ['code'], attributes: ['class'] }),
    )
    expect(selectorNeeds('a[href="X" i]')).toEqual(
      needs({ tags: ['a'], attributes: ['href'] }),
    )
  })

  it('asks nothing of what a functional pseudo-class holds', () => {
    expect(selectorNeeds('.callout :is(.a, .b):not(.c, [hidden])')).toEqual(
      needs({ classes: ['callout'] }),
    )
    expect(selectorNeeds('li:nth-child(2n+1)::marker')).toEqual(
      needs({ tags: ['li'] }),
    )
    // A colon or a parenthesis in what an attribute is compared with is
    // the attribute's.
    expect(selectorNeeds('a[href^="javascript:void(0)"]')).toEqual(
      needs({ tags: ['a'], attributes: ['href'] }),
    )
  })

  it('rules out what never matches or never paints in a still picture', () => {
    expect(selectorNeeds('a:hover')).toBeNull()
    expect(selectorNeeds('.x:focus-within .y')).toBeNull()
    expect(selectorNeeds(':root')).toBeNull()
    expect(selectorNeeds('body.theme-dark .x')).toBeNull()
    expect(selectorNeeds('.x::selection')).toBeNull()
    // A scrollbar is not painted, but the room it takes is the layout's.
    expect(selectorNeeds('.x::-webkit-scrollbar')).toEqual(
      needs({ classes: ['x'] }),
    )
    // A state named inside a functional pseudo-class is not the selector's.
    expect(selectorNeeds('.x:not(:hover)')).toEqual(needs({ classes: ['x'] }))
  })

  it('keeps a selector it cannot read', () => {
    expect(selectorNeeds('.w-1\\/2')).toEqual(needs({}))
  })

  it('splits a list at its own commas only', () => {
    expect(selectorListNeeds('.a, :is(.b, .c) .d, a:hover')).toEqual([
      needs({ classes: ['a'] }),
      needs({ classes: ['d'] }),
    ])
  })

  it('is met once everything it needs has been seen', () => {
    const one = needs({
      classes: ['callout'],
      tags: ['p'],
      attributes: ['data-callout=note'],
    })
    const all = {
      classes: ['callout'],
      tags: ['p', 'div'],
      attributes: ['data-callout', 'data-callout=note'],
    }
    expect(meets(one, seen(all))).toBe(true)
    expect(meets(one, seen({ ...all, tags: ['div'] }))).toBe(false)
    expect(
      meets(one, seen({ ...all, attributes: ['data-callout=warning'] })),
    ).toBe(false)
    expect(meets(needs({ ids: ['x'] }), seen({}))).toBe(false)
  })
})
