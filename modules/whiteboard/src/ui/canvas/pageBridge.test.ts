// eslint-disable-next-line import/no-nodejs-modules -- the bridge is run in a fresh context, as a page would run it
import * as vm from 'node:vm'

import {
  PAGE_STORAGE_LIMIT,
  type PageMemory,
  readPageMessage,
  scriptJson,
  withPageBridge,
} from './pageBridge'

const EMPTY: PageMemory = { scroll: 0, storage: {} }

/** The bridge's `<script>` element, as it was inserted. */
const BRIDGE = /<script>\(function \(init\)[\s\S]*?<\/script>/

describe('withPageBridge', () => {
  it('goes right after the doctype, so the page stays in standards mode', () => {
    const page = '<!DOCTYPE html>\n<html><head><script>own()</script>'
    const out = withPageBridge(page, EMPTY)
    expect(out.startsWith('<!DOCTYPE html><script>(function (init)')).toBe(true)
    expect(out.indexOf('own()')).toBeGreaterThan(out.search(BRIDGE))
  })

  it('finds a doctype behind a byte-order mark, white space and comments', () => {
    const page = '\uFEFF  <!-- made by hand -->\n<!doctype html><p>x</p>'
    const out = withPageBridge(page, EMPTY)
    const at = out.search(BRIDGE)
    expect(out.slice(0, at)).toBe(
      '\uFEFF  <!-- made by hand -->\n<!doctype html>',
    )
    expect(out.slice(at).replace(BRIDGE, '')).toBe('<p>x</p>')
  })

  it('goes first in a document without a doctype', () => {
    const out = withPageBridge('<p>hello</p>', EMPTY)
    expect(out.search(BRIDGE)).toBe(0)
    expect(out.replace(BRIDGE, '')).toBe('<p>hello</p>')
  })

  it('does not take a doctype in the middle of a page for its own', () => {
    const page = '<p>see <!doctype html> here</p>'
    expect(withPageBridge(page, EMPTY).search(BRIDGE)).toBe(0)
  })

  it('hands the memory over intact, whatever it contains', () => {
    const memory: PageMemory = {
      scroll: 0.5,
      storage: { text: '</script><script>alert(1)</script><!--  ' },
    }
    const out = withPageBridge('', memory)
    // Only the bridge's own closing tag ends a script.
    expect(out.match(/<\/script/gi)).toHaveLength(1)
    const json = /\}\)\((.*)\);<\/script>$/.exec(out)?.[1]
    expect(json).toBeDefined()
    expect(JSON.parse(json ?? '')).toEqual({
      ...memory,
      limit: PAGE_STORAGE_LIMIT,
    })
  })
})

/** The bridge run against a stand-in for the page's window: what it posted,
 * and the hooks a page's own events would fire. */
function runBridge(memory: PageMemory) {
  const posted: unknown[] = []
  const listeners: Record<string, () => void> = {}
  const timers: (() => void)[] = []
  const frames: (() => void)[] = []
  const scroller = { scrollTop: 0, scrollHeight: 1000 }
  const scrolledTo: unknown[] = []
  const win: Record<string, unknown> = {
    parent: { postMessage: (message: unknown) => posted.push(message) },
    addEventListener: (type: string, listener: () => void) => {
      listeners[type] = listener
    },
    scrollTo: (options: { top: number }) => {
      scrolledTo.push(options)
      scroller.scrollTop = options.top
    },
  }
  const script = withPageBridge('', memory)
    .replace(/^<script>/, '')
    .replace(/<\/script>$/, '')
  vm.runInNewContext(script, {
    window: win,
    document: { scrollingElement: scroller },
    setTimeout: (callback: () => void) => timers.push(callback),
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    DOMException,
    Proxy,
    Object,
    Math,
    Number,
    String,
  })
  const flush = (queue: (() => void)[]) => {
    for (const callback of queue.splice(0)) callback()
  }
  return {
    win,
    local: win.localStorage as Storage & Record<string, unknown>,
    session: win.sessionStorage as Storage,
    posted,
    scroller,
    scrolledTo,
    fire: (type: string) => listeners[type]?.(),
    runTimers: () => flush(timers),
    runFrames: () => flush(frames),
  }
}

describe('the bridge', () => {
  it('stands in for localStorage with what the card remembered', () => {
    const page = runBridge({ scroll: 0, storage: { count: '3', mode: 'b' } })
    expect(page.local.getItem('count')).toBe('3')
    expect(page.local.getItem('missing')).toBeNull()
    expect(page.local.length).toBe(2)
    expect(page.local.key(1)).toBe('mode')
    expect(page.local.count).toBe('3')
    expect(Object.keys(page.local)).toEqual(['count', 'mode'])
    expect('mode' in page.local).toBe(true)
  })

  it('reports every change once per task, as the storage then is', () => {
    const page = runBridge(EMPTY)
    page.local.setItem('a', 1 as unknown as string)
    page.local.b = '2'
    delete page.local.a
    expect(page.posted).toEqual([])
    page.runTimers()
    expect(page.posted).toEqual([
      { yoloWhiteboardPage: 1, storage: { b: '2' } },
    ])
    page.local.clear()
    page.runTimers()
    expect(page.posted[1]).toEqual({ yoloWhiteboardPage: 1, storage: {} })
  })

  it('reports nothing for a write that changes nothing', () => {
    const page = runBridge({ scroll: 0, storage: { a: '1' } })
    page.local.setItem('a', '1')
    page.local.removeItem('missing')
    page.runTimers()
    expect(page.posted).toEqual([])
  })

  it('throws QuotaExceededError past the limit and keeps what it had', () => {
    const page = runBridge(EMPTY)
    page.local.setItem('k', 'x'.repeat(PAGE_STORAGE_LIMIT - 1))
    let thrown: unknown
    try {
      page.local.setItem('j', 'y')
    } catch (error) {
      thrown = error
    }
    expect((thrown as DOMException).name).toBe('QuotaExceededError')
    expect(page.local.getItem('j')).toBeNull()
    // Replacing a value is counted against what it replaces.
    page.local.setItem('k', 'z'.repeat(PAGE_STORAGE_LIMIT - 1))
    expect(page.local.getItem('k')?.charAt(0)).toBe('z')
  })

  it('keeps sessionStorage to itself', () => {
    const page = runBridge(EMPTY)
    page.session.setItem('a', '1')
    page.runTimers()
    expect(page.session.getItem('a')).toBe('1')
    expect(page.posted).toEqual([])
  })

  it('puts the scroll back once loaded, and only reports from then on', () => {
    const page = runBridge({ scroll: 0.25, storage: {} })
    page.fire('scroll')
    page.runFrames()
    expect(page.posted).toEqual([])
    page.fire('load')
    expect(page.scrolledTo).toEqual([{ top: 250, behavior: 'instant' }])
    page.scroller.scrollTop = 500
    page.fire('scroll')
    page.fire('scroll')
    page.runFrames()
    expect(page.posted).toEqual([{ yoloWhiteboardPage: 1, scroll: 0.5 }])
  })
})

describe('readPageMessage', () => {
  const mark = { yoloWhiteboardPage: 1 }

  it('reads a scroll and a storage', () => {
    expect(readPageMessage({ ...mark, scroll: 0.3 })).toEqual({ scroll: 0.3 })
    expect(readPageMessage({ ...mark, storage: { a: '1' } })).toEqual({
      storage: { a: '1' },
    })
  })

  it('takes nothing that is not exactly the bridge’s', () => {
    for (const data of [
      null,
      'text',
      { scroll: 0.3 },
      { ...mark, scroll: 2 },
      { ...mark, scroll: NaN },
      { ...mark, storage: { a: 1 } },
      { ...mark, storage: ['a'] },
      { ...mark, storage: 'a' },
      { ...mark },
    ]) {
      expect(readPageMessage(data)).toBeNull()
    }
  })

  it('refuses a storage past the limit', () => {
    const storage = { k: 'x'.repeat(PAGE_STORAGE_LIMIT) }
    expect(readPageMessage({ ...mark, storage })).toBeNull()
  })
})

describe('scriptJson', () => {
  it('writes no character that could end or bend an inline script', () => {
    const json = scriptJson({ a: '<\u2028\u2029>' })
    expect(json).not.toMatch(/[<\u2028\u2029]/)
    expect(JSON.parse(json)).toEqual({ a: '<\u2028\u2029>' })
  })
})
