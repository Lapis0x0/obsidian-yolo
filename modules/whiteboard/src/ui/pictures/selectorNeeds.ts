// What a CSS selector needs of a document before it can match anything in
// it: the classes, element names, ids and attributes its compounds name. The
// card pictures' shared stylesheet (./pictureStyles.ts) keeps a rule once
// pictures have shown everything one of its selectors needs — a test of a
// few set lookups, where asking the copy itself (`querySelector`) for every
// rule of a 7 000-rule document cost a long task per card. Every rule kept
// is parsed again by every picture, so what is kept for nothing is paid for
// by every card.
//
// Lenient on purpose: whatever a selector says beyond those — `:is()`,
// `:has()`, `:not()`, a sibling, an attribute compared by anything but `=` —
// is not asked about, so a rule is kept whenever it *might* match. A rule
// kept for nothing costs a little text; a rule dropped wrongly costs a
// picture that looks wrong. Only what can never match in a still picture is
// ruled out: a pointer or focus state, the document's own root and body,
// which a picture has none of (its variables and type come from the board
// itself), and the parts of a page a picture never paints — a selection, a
// spelling mark. (A scrollbar is not drawn either, but the room it takes is
// part of the layout: its rules stay.)

/** What one selector needs. Attributes are by name, or by `name=value`
 * where the selector compares with `=`. */
export type SelectorNeeds = Readonly<{
  classes: readonly string[]
  tags: readonly string[]
  ids: readonly string[]
  attributes: readonly string[]
}>

/** What pictures have shown so far, in the terms of `SelectorNeeds`. */
export type SeenSoFar = Readonly<{
  classes: ReadonlySet<string>
  tags: ReadonlySet<string>
  ids: ReadonlySet<string>
  attributes: ReadonlySet<string>
}>

/** A state no still picture is ever in. */
const DYNAMIC =
  /:(?:hover|active|focus|focus-visible|focus-within|target|visited|user-invalid|user-valid|drop)(?![\w-])/i
/** The document's own root, which a picture's copy sits under none of. */
const ROOT = /:root(?![\w-])/i
/** What a still picture never paints, and takes no room: a selection, a
 * spelling mark, a backdrop. */
const UNPAINTED =
  /::(?:selection|target-text|spelling-error|grammar-error|highlight\(|backdrop|-moz-)/i
/** An attribute selector: its name, how it compares, and with what. */
const ATTRIBUTE =
  /^\[\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]*))\s*([is])?\s*)?\]$/i
/** Where an attribute selector stood, until its needs are read: a
 * character of the private use area, which no selector has. */
const MARK = '\ue000'

/**
 * What each of a rule's selectors needs; a selector that can never match in
 * a picture is left out, so an empty list is a rule never kept.
 */
export function selectorListNeeds(selectorText: string): SelectorNeeds[] {
  const needs: SelectorNeeds[] = []
  for (const selector of splitTopLevel(selectorText)) {
    const one = selectorNeeds(selector)
    if (one) needs.push(one)
  }
  return needs
}

/** What one selector needs; null when it can never match in a picture. */
export function selectorNeeds(selector: string): SelectorNeeds | null {
  // Escapes name things this does not read; such a selector is kept
  // whatever it names.
  if (selector.includes('\\')) {
    return { classes: [], tags: [], ids: [], attributes: [] }
  }
  if (UNPAINTED.test(selector)) return null
  // Attribute selectors first, since what they compare with may hold
  // anything — a parenthesis, a colon — and set aside until what is inside
  // a functional pseudo-class has gone with it.
  const brackets: string[] = []
  let rest = selector.replace(/\[[^\]]*\]/g, (attribute) => {
    brackets.push(attribute)
    return `${MARK}${brackets.length - 1}${MARK}`
  })
  // What a functional pseudo-class holds is a condition on something else
  // (`:not()`, `:has()`) or a choice between selectors (`:is()`): it is not
  // asked about.
  rest = stripFunctional(rest)
  if (DYNAMIC.test(rest) || ROOT.test(rest)) return null
  const attributes: string[] = []
  rest = rest.replace(/\ue000(\d+)\ue000/g, (_, at: string) => {
    const match = ATTRIBUTE.exec(brackets[Number(at)])
    if (match) {
      const [, name, operator, ...values] = match
      const caseless = values[3] !== undefined
      const value = values[0] ?? values[1] ?? values[2]
      attributes.push(
        operator === '=' && !caseless
          ? `${name.toLowerCase()}=${value}`
          : name.toLowerCase(),
      )
    }
    return ' '
  })
  rest = rest.replace(/::?[\w-]+/g, ' ')
  const classes: string[] = []
  rest = rest.replace(
    /\.(-?[_a-zA-Z\u00a0-\uffff][\w\u00a0-\uffff-]*)/g,
    (_, name: string) => {
      classes.push(name)
      return ' '
    },
  )
  const ids: string[] = []
  rest = rest.replace(/#([\w\u00a0-\uffff-]+)/g, (_, id: string) => {
    ids.push(id)
    return ' '
  })
  const tags: string[] = []
  for (const part of rest.split(/[\s>+~,()]+/)) {
    if (!/^[a-zA-Z][\w-]*$/.test(part)) continue
    const tag = part.toLowerCase()
    if (tag === 'html' || tag === 'body') return null
    tags.push(tag)
  }
  return { classes, tags, ids, attributes }
}

/** Whether pictures that have shown `seen` meet `needs`. */
export function meets(needs: SelectorNeeds, seen: SeenSoFar): boolean {
  for (const name of needs.classes) if (!seen.classes.has(name)) return false
  for (const name of needs.tags) if (!seen.tags.has(name)) return false
  for (const id of needs.ids) if (!seen.ids.has(id)) return false
  for (const attribute of needs.attributes) {
    if (!seen.attributes.has(attribute)) return false
  }
  return true
}

/** A selector list split at its own commas, not those inside brackets or
 * parentheses. */
function splitTopLevel(text: string): string[] {
  if (!text.includes('(') && !text.includes('[')) return text.split(',')
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ''
  for (const ch of text) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[') depth += 1
    else if (ch === ')' || ch === ']') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts
}

/** `text` without its functional pseudo-classes and their arguments,
 * however deeply nested. */
function stripFunctional(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const match = /:{1,2}[\w-]+\(/.exec(text.slice(i))
    if (!match) {
      out += text.slice(i)
      break
    }
    out += `${text.slice(i, i + match.index)} `
    let depth = 1
    let j = i + match.index + match[0].length
    while (j < text.length && depth > 0) {
      if (text[j] === '(') depth += 1
      else if (text[j] === ')') depth -= 1
      j += 1
    }
    i = j
  }
  return out
}
