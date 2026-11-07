// Images as cards embed them: which embeds are images, by what they name and
// at what size (`![[a.png|200]]`), for the typesetter (./parse.ts) and for
// whoever looks their sizes up before a card is typeset
// (../ui/gpu/gpuBoard.ts). Plain text in, plain data out: no parser here,
// so the main thread can ask without loading one.

import type { InlineImage } from './model'

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i
const IMAGE_SIZE = /^(\d+)(?:x(\d+))?$/

/** An embed's link text as an image, if it names one: its target, and the
 * size written after a `|`. */
export function imageOf(link: string): InlineImage | null {
  const bar = link.indexOf('|')
  const target = (bar === -1 ? link : link.slice(0, bar)).trim()
  const path = target.replace(/#.*$/, '')
  if (!IMAGE_FILE.test(path)) return null
  const size = bar === -1 ? null : IMAGE_SIZE.exec(link.slice(bar + 1).trim())
  return {
    target: path,
    width: size ? Number(size[1]) : null,
    height: size?.[2] ? Number(size[2]) : null,
  }
}

/** A link's address as the vault names the file: `%20` a space. */
export function decodedUrl(url: string): string {
  try {
    return decodeURI(url)
  } catch {
    return url
  }
}

/** An embed: its link text, or an image link's address. */
const EMBEDS = /!\[\[([^\]\n]+)\]\]|!\[[^\]\n]*\]\(([^)\n]+)\)/g

/** Each embed in `markdown`: what it links to, as the vault names it. */
export function embedLinks(markdown: string): string[] {
  const out: string[] = []
  for (const match of markdown.matchAll(EMBEDS)) {
    out.push(match[1] ?? decodedUrl((match[2] ?? '').trim()))
  }
  return out
}

/** The images a card's markdown embeds, by what it names each. */
export function imageTargets(markdown: string): string[] {
  const out = new Set<string>()
  for (const link of embedLinks(markdown)) {
    const image = imageOf(link)
    if (image) out.add(image.target)
  }
  return [...out]
}
