// The document's `@font-face` rules for the families a card is set in, for
// the typesetting worker (./typesetWorker.ts) to load: a theme's web fonts
// are declared in its stylesheet and loaded by the document alone, and a
// worker measuring without them would break lines where the card does not.

import type { TypesetTokens } from '../../typeset/tokens'

import type { FontSource } from './typesetProtocol'

/** The families `tokens` set text in, lower-cased and unquoted. */
export function familiesOf(tokens: TypesetTokens): Set<string> {
  const stacks = [
    tokens.body.family,
    ...tokens.headings.map((h) => h.family),
    tokens.code.family,
    tokens.tag.family,
    tokens.codeBlock.family,
  ]
  const out = new Set<string>()
  for (const stack of stacks) {
    if (!stack) continue
    for (const name of splitFamilies(stack)) out.add(name.toLowerCase())
  }
  return out
}

/** A `font-family` list's names, unquoted. */
export function splitFamilies(stack: string): string[] {
  return stack
    .split(',')
    .map((name) => name.trim().replace(/^(['"])(.*)\1$/, '$2'))
    .filter((name) => name.length > 0)
}

/** Every `url(…)` in a `src` made absolute against `base`. */
export function absoluteSrc(src: string, base: string): string {
  return src.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
    (_, _quote: string, url: string) => {
      if (/^(data|blob):/i.test(url)) return `url("${url}")`
      try {
        return `url("${new URL(url, base).href}")`
      } catch {
        return `url("${url}")`
      }
    },
  )
}

/** The `@font-face` rules of `doc` for `families`. A stylesheet the
 * document may not read (another origin's) is passed over. */
export function fontSources(
  doc: Document,
  families: ReadonlySet<string>,
): FontSource[] {
  const out: FontSource[] = []
  // Told apart by shape, not by class: a popout's rules are another
  // window's classes (CLAUDE.md, Popout / Multi-window).
  const visit = (rules: CSSRuleList, base: string) => {
    for (const rule of Array.from(rules)) {
      if ('styleSheet' in rule) {
        const sheet = (rule as CSSImportRule).styleSheet
        if (sheet) readSheet(sheet)
        continue
      }
      if ('cssRules' in rule) {
        visit((rule as CSSGroupingRule).cssRules, base)
        continue
      }
      if (!rule.cssText.startsWith('@font-face')) continue
      const style = (rule as CSSFontFaceRule).style
      const family = splitFamilies(style.getPropertyValue('font-family'))[0]
      const src = style.getPropertyValue('src')
      if (!family || !src || !families.has(family.toLowerCase())) continue
      const read = (name: string) => style.getPropertyValue(name) || undefined
      out.push({
        family,
        src: absoluteSrc(src, base),
        descriptors: {
          style: read('font-style'),
          weight: read('font-weight'),
          stretch: read('font-stretch'),
          unicodeRange: read('unicode-range'),
        },
      })
    }
  }
  const readSheet = (sheet: CSSStyleSheet) => {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      return
    }
    visit(rules, sheet.href ?? doc.baseURI)
  }
  for (const sheet of Array.from(doc.styleSheets)) readSheet(sheet)
  return out
}
