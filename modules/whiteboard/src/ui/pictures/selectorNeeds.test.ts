import { meets, selectorListNeeds, selectorNeeds } from './selectorNeeds'

const set = (...names: string[]) => new Set(names)

describe('selectorNeeds', () => {
  it('needs the classes and element names a selector names', () => {
    expect(selectorNeeds('.markdown-rendered pre > code.hljs')).toEqual({
      classes: ['markdown-rendered', 'hljs'],
      tags: ['pre', 'code'],
    })
  })

  it('asks nothing of attributes, ids and functional pseudo-classes', () => {
    expect(
      selectorNeeds('.callout[data-callout="note"] #x :is(.a, .b):not(.c)'),
    ).toEqual({ classes: ['callout'], tags: [] })
    expect(selectorNeeds('li:nth-child(2n+1)::marker')).toEqual({
      classes: [],
      tags: ['li'],
    })
  })

  it('rules out what never matches in a still picture', () => {
    expect(selectorNeeds('a:hover')).toBeNull()
    expect(selectorNeeds('.x:focus-within .y')).toBeNull()
    expect(selectorNeeds(':root')).toBeNull()
    expect(selectorNeeds('body.theme-dark .x')).toBeNull()
    // A state named inside a functional pseudo-class is not the selector's.
    expect(selectorNeeds('.x:not(:hover)')).toEqual({
      classes: ['x'],
      tags: [],
    })
  })

  it('keeps a selector it cannot read', () => {
    expect(selectorNeeds('.w-1\\/2')).toEqual({ classes: [], tags: [] })
  })

  it('splits a list at its own commas only', () => {
    expect(selectorListNeeds('.a, :is(.b, .c) .d, a:hover')).toEqual([
      { classes: ['a'], tags: [] },
      { classes: ['d'], tags: [] },
    ])
  })

  it('is met once every class and element it needs has been seen', () => {
    const needs = { classes: ['callout'], tags: ['p'] }
    expect(meets(needs, set('callout'), set('p', 'div'))).toBe(true)
    expect(meets(needs, set('callout'), set('div'))).toBe(false)
    expect(meets(needs, set(), set('p'))).toBe(false)
  })
})
