import { scriptJson, withPageBridge } from './pageBridge'

/** The bridge's `<script>` element, as it was inserted. */
const BRIDGE = /<script>\(function \(init\)[\s\S]*?<\/script>/

describe('withPageBridge', () => {
  it('goes right after the doctype, so the page stays in standards mode', () => {
    const page = '<!DOCTYPE html>\n<html><head><script>own()</script>'
    const out = withPageBridge(page, {})
    expect(out.startsWith('<!DOCTYPE html><script>(function (init)')).toBe(true)
    expect(out.indexOf('own()')).toBeGreaterThan(out.search(BRIDGE))
  })

  it('finds a doctype behind a byte-order mark, white space and comments', () => {
    const page = '\uFEFF  <!-- made by hand -->\n<!doctype html><p>x</p>'
    const out = withPageBridge(page, {})
    const at = out.search(BRIDGE)
    expect(out.slice(0, at)).toBe(
      '\uFEFF  <!-- made by hand -->\n<!doctype html>',
    )
    expect(out.slice(at).replace(BRIDGE, '')).toBe('<p>x</p>')
  })

  it('goes first in a document without a doctype', () => {
    const out = withPageBridge('<p>hello</p>', {})
    expect(out.search(BRIDGE)).toBe(0)
    expect(out.replace(BRIDGE, '')).toBe('<p>hello</p>')
  })

  it('does not take a doctype in the middle of a page for its own', () => {
    const page = '<p>see <!doctype html> here</p>'
    expect(withPageBridge(page, {}).search(BRIDGE)).toBe(0)
  })

  it('hands the state over intact, whatever it contains', () => {
    const state = { text: '</script><script>alert(1)</script><!--\u2028\u2029' }
    const out = withPageBridge('', state)
    // Only the bridge's own closing tag ends a script.
    expect(out.match(/<\/script/gi)).toHaveLength(1)
    const json = /\}\)\((.*)\);<\/script>$/.exec(out)?.[1]
    expect(json).toBeDefined()
    expect(JSON.parse(json ?? '')).toEqual(state)
  })
})

describe('scriptJson', () => {
  it('writes no character that could end or bend an inline script', () => {
    const json = scriptJson({ a: '<\u2028\u2029>' })
    expect(json).not.toMatch(/[<\u2028\u2029]/)
    expect(JSON.parse(json)).toEqual({ a: '<\u2028\u2029>' })
  })
})
