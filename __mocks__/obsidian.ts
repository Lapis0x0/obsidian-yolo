export const App = jest.fn()
export const apiVersion = '1.8.0'
export const Editor = jest.fn()
export const MarkdownView = jest.fn()
export class Modal {
  app: unknown
  contentEl: { empty: jest.Mock; addClass: jest.Mock; removeClass: jest.Mock }
  titleEl: { setText: jest.Mock }
  modalEl: { classList: { add: jest.Mock; remove: jest.Mock } }

  constructor(app: unknown) {
    this.app = app
    this.contentEl = {
      empty: jest.fn(),
      addClass: jest.fn(),
      removeClass: jest.fn(),
    }
    this.titleEl = { setText: jest.fn() }
    this.modalEl = { classList: { add: jest.fn(), remove: jest.fn() } }
  }

  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}
export const Platform = { isDesktop: true, isMobile: false }
export class Scope {
  constructor(_parent?: unknown) {}
  register(
    _modifiers: unknown,
    _key: unknown,
    _func: unknown,
  ): { modifiers: unknown; key: unknown } {
    return { modifiers: _modifiers, key: _key }
  }
  unregister(_handler: unknown): void {}
}
export const TFile = jest.fn()
export const TFolder = jest.fn()
export const Vault = jest.fn()
export class FileSystemAdapter {
  getBasePath(): string {
    return ''
  }
}
export const normalizePath = jest.fn((path: string) => path)

// Faithful-enough mock of Obsidian's resolveSubpath for tests: supports
// nested heading chains ("#A#B") via ancestor-path matching, and block refs
// ("#^id") via cache.blocks lookup. Consumers that need exact end/next
// boundary semantics should not rely on this mock's `end`/`next` fields —
// resolve-wikilink-target.ts recomputes heading section boundaries itself
// from `cache.headings` rather than trusting them, precisely because that
// behavior isn't nailed down by obsidian.d.ts.
export const resolveSubpath = jest.fn((cache: any, subpath: string): any => {
  if (!subpath || !subpath.startsWith('#')) return null

  if (subpath.startsWith('#^')) {
    const id = subpath.slice(2).trim().toLowerCase()
    const block = cache.blocks?.[id]
    if (!block) return null
    return {
      type: 'block',
      block,
      start: block.position.start,
      end: block.position.end,
    }
  }

  const chain = subpath
    .slice(1)
    .split('#')
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0)
  if (chain.length === 0) return null

  const headings: any[] = cache.headings ?? []
  const stack: { level: number; heading: string }[] = []
  const ancestorPaths: string[][] = headings.map((h: any) => {
    while (stack.length && stack[stack.length - 1].level >= h.level) {
      stack.pop()
    }
    const path = [...stack.map((s) => s.heading), h.heading]
    stack.push({ level: h.level, heading: h.heading })
    return path
  })

  const normalizedChain = chain.map((s: string) => s.toLowerCase())
  let matchIndex = -1
  for (let i = 0; i < headings.length; i++) {
    const tail = ancestorPaths[i]
      .slice(-normalizedChain.length)
      .map((s) => s.toLowerCase())
    if (
      tail.length === normalizedChain.length &&
      tail.every((t, idx) => t === normalizedChain[idx])
    ) {
      matchIndex = i
      break
    }
  }
  if (matchIndex === -1) return null

  const current = headings[matchIndex]
  let next = null
  for (let i = matchIndex + 1; i < headings.length; i++) {
    if (headings[i].level <= current.level) {
      next = headings[i]
      break
    }
  }
  return {
    type: 'heading',
    current,
    next,
    start: current.position.start,
    end: next ? next.position.start : null,
  }
})
export const requestUrl = jest.fn()
export const htmlToMarkdown = jest.fn((html: string) => html)
export const renderMath = jest.fn()
export const finishRenderMath = jest.fn(async () => undefined)
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Jest mock: 复用 js-yaml 与生产环境(Obsidian 内嵌)行为一致
const yaml = require('js-yaml') as { load: (input: string) => unknown }
export const parseYaml = jest.fn((input: string) => yaml.load(input))
