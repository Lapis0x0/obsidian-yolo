// What a CSS selector needs of a document before it can match anything in
// it: the classes and element names its compounds name. The card pictures'
// shared stylesheet (./pictureStyles.ts) keeps a rule once a picture has
// shown every class and element one of its selectors needs — a test of a few
// set lookups, where asking the copy itself (`querySelector`) for every rule
// of a 7 000-rule document cost a long task per card.
//
// Lenient on purpose: whatever a selector says that is not a class or an
// element name — an attribute, an id, `:is()`, `:has()`, a sibling — is not
// asked about, so a rule is kept whenever it *might* match. A rule kept for
// nothing costs a little text; a rule dropped wrongly costs a picture that
// looks wrong. Only what can never match in a still picture is ruled out: a
// pointer or focus state, and the document's own root and body, which a
// picture has none of (its variables and type come from the board itself).

/** The classes and element names one selector needs. */
export type SelectorNeeds = Readonly<{
  classes: readonly string[]
  tags: readonly string[]
}>

/** A state no still picture is ever in. */
const DYNAMIC =
  /:(?:hover|active|focus|focus-visible|focus-within|target|visited|user-invalid|user-valid|drop)(?![\w-])/i
/** The document's own root, which a picture's copy sits under none of. */
const ROOT = /:root(?![\w-])/i

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
  // Escapes name classes this does not read; such a selector is kept
  // whatever it names.
  if (selector.includes('\\')) return { classes: [], tags: [] }
  let rest = selector.replace(/\[[^\]]*\]/g, ' ')
  // What a functional pseudo-class holds is a condition on something else
  // (`:not()`, `:has()`) or a choice between selectors (`:is()`): it is not
  // asked about.
  rest = stripFunctional(rest)
  if (DYNAMIC.test(rest) || ROOT.test(rest)) return null
  rest = rest.replace(/::?[\w-]+/g, ' ')
  const classes: string[] = []
  rest = rest.replace(
    /\.(-?[_a-zA-Z\u00a0-\uffff][\w\u00a0-\uffff-]*)/g,
    (_, name: string) => {
      classes.push(name)
      return ' '
    },
  )
  rest = rest.replace(/#[\w\u00a0-\uffff-]+/g, ' ')
  const tags: string[] = []
  for (const part of rest.split(/[\s>+~,()]+/)) {
    if (!/^[a-zA-Z][\w-]*$/.test(part)) continue
    const tag = part.toLowerCase()
    if (tag === 'html' || tag === 'body') return null
    tags.push(tag)
  }
  return { classes, tags }
}

/** Whether a document that has shown `classes` and `tags` meets `needs`. */
export function meets(
  needs: SelectorNeeds,
  classes: ReadonlySet<string>,
  tags: ReadonlySet<string>,
): boolean {
  for (const name of needs.classes) if (!classes.has(name)) return false
  for (const name of needs.tags) if (!tags.has(name)) return false
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
