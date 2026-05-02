/**
 * Unit tests for getPdfSelectionData.ts
 *
 * The test environment is Node (not jsdom), so DOM types are mocked manually.
 * The function now takes `app: App` and reverse-looks up the owning leaf from
 * DOM, so we mock `app.workspace.getLeavesOfType('pdf')`.
 */

import { getPdfSelectionData } from './getPdfSelectionData'

// ──────────────────────────────────────────────────────────────────────────────
// Minimal DOM node helpers
// ──────────────────────────────────────────────────────────────────────────────

type FakeNode = {
  nodeType?: number // 1 = ELEMENT_NODE
  classList?: { contains: (cls: string) => boolean }
  matches?: (selector: string) => boolean
  closest?: (selector: string) => FakeNode | null
  getAttribute?: (name: string) => string | null
  contains?: (other: FakeNode) => boolean
  parentNode: FakeNode | null
}

/**
 * Build a DOM chain: leafContent > container > page > textLayer > span > textNode
 *
 * Returns the leafContent element (used as view.containerEl in fake leaf),
 * the textNode (used as anchorNode / commonAncestorContainer),
 * and span (used as commonAncestorContainer for some tests).
 */
function makePdfDomChain(pageNum: number): {
  textNode: FakeNode
  span: FakeNode
  container: FakeNode
  leafContent: FakeNode
} {
  // text nodes do NOT have nodeType=1
  const textNode: FakeNode = { nodeType: 3, parentNode: null }

  const span: FakeNode = {
    nodeType: 1,
    classList: { contains: () => false },
    matches: () => false,
    closest: (_sel: string) => null, // set below after leafContent is created
    getAttribute: () => null,
    parentNode: null,
  }
  textNode.parentNode = span

  // .page[data-page-number]
  const page: FakeNode = {
    nodeType: 1,
    classList: { contains: (cls: string) => cls === 'page' },
    matches: () => false,
    closest: (_sel: string) => null, // set below
    getAttribute: (name: string) =>
      name === 'data-page-number' ? String(pageNum) : null,
    parentNode: null,
  }
  span.parentNode = page

  // .pdf-viewer-container
  const container: FakeNode = {
    nodeType: 1,
    classList: { contains: (cls: string) => cls === 'pdf-viewer-container' },
    matches: (sel: string) => sel.includes('pdf-viewer-container'),
    closest: (_sel: string) => null, // set below
    getAttribute: () => null,
    parentNode: null,
  }
  page.parentNode = container

  // .workspace-leaf-content[data-type="pdf"]
  const leafContent: FakeNode = {
    nodeType: 1,
    classList: {
      contains: (cls: string) => cls === 'workspace-leaf-content',
    },
    matches: (sel: string) =>
      sel.includes('workspace-leaf-content') && sel.includes('data-type="pdf"'),
    closest: (_sel: string) => null,
    getAttribute: (name: string) => (name === 'data-type' ? 'pdf' : null),
    contains: (other: FakeNode) => {
      // Walk the parentNode chain to check containment
      let cur: FakeNode | null = other
      while (cur) {
        if (cur === leafContent) return true
        cur = cur.parentNode
      }
      return false
    },
    parentNode: null,
  }
  container.parentNode = leafContent

  // Wire up closest() for each node to find leafContent
  const findLeafContent = (sel: string): FakeNode | null => {
    if (
      sel.includes('workspace-leaf-content') &&
      sel.includes('data-type="pdf"]')
    ) {
      return leafContent
    }
    if (sel.includes('pdf-viewer-container')) return container
    return null
  }
  span.closest = findLeafContent
  page.closest = findLeafContent
  container.closest = findLeafContent

  return { textNode, span, container, leafContent }
}

// ──────────────────────────────────────────────────────────────────────────────
// Fake App / leaf factory
// ──────────────────────────────────────────────────────────────────────────────

function makePdfLeaf(filePath: string, containerEl: FakeNode) {
  return {
    view: {
      file: { path: filePath, basename: filePath.split('/').pop(), name: filePath.split('/').pop() },
      containerEl,
      getViewType: () => 'pdf',
    },
    getViewState: () => ({ type: 'pdf' }),
  }
}

function makeApp(pdfLeaves: ReturnType<typeof makePdfLeaf>[]) {
  return {
    workspace: {
      getLeavesOfType: (type: string) => (type === 'pdf' ? pdfLeaves : []),
    },
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// window.getSelection mock
// ──────────────────────────────────────────────────────────────────────────────

function mockGetSelection(sel: Partial<Selection> | null): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test shim
  ;(global as any).window = { getSelection: () => sel }
}

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test shim
  delete (global as any).window
  jest.restoreAllMocks()
})

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('getPdfSelectionData', () => {
  test('returns null when window.getSelection() returns null', () => {
    mockGetSelection(null)
    const { leafContent } = makePdfDomChain(1)
    const leaf = makePdfLeaf('sample.pdf', leafContent)
    const app = makeApp([leaf])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
    expect(getPdfSelectionData(app as any)).toBeNull()
  })

  test('returns null when selection is outside any PDF leaf (not in PDF DOM)', () => {
    // commonAncestorContainer is a plain node with no PDF ancestors
    const plainNode: FakeNode = {
      nodeType: 1,
      classList: { contains: () => false },
      matches: () => false,
      closest: () => null,
      getAttribute: () => null,
      parentNode: null,
    }

    mockGetSelection({
      rangeCount: 1,
      toString: () => 'Some markdown text',
      anchorNode: plainNode as unknown as Node,
      getRangeAt: () =>
        ({ commonAncestorContainer: plainNode }) as unknown as Range,
    } as Partial<Selection>)

    const { leafContent } = makePdfDomChain(1)
    const leaf = makePdfLeaf('sample.pdf', leafContent)
    const app = makeApp([leaf])
    // Must be null (not { kind: 'empty' }) — Markdown badges must not be cleared
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
    expect(getPdfSelectionData(app as any)).toBeNull()
  })

  test('returns { kind: "empty" } when selection is inside PDF but collapsed/empty', () => {
    const { span, leafContent } = makePdfDomChain(2)

    mockGetSelection({
      rangeCount: 1,
      toString: () => '', // empty selection
      anchorNode: span as unknown as Node,
      getRangeAt: () =>
        ({ commonAncestorContainer: span }) as unknown as Range,
    } as Partial<Selection>)

    const leaf = makePdfLeaf('notes/doc.pdf', leafContent)
    const app = makeApp([leaf])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
    const result = getPdfSelectionData(app as any)
    expect(result).toEqual({ kind: 'empty' })
  })

  test('returns { kind: "data" } for a valid single-page PDF selection', () => {
    const { textNode, span, leafContent } = makePdfDomChain(3)

    mockGetSelection({
      rangeCount: 1,
      toString: () => 'Selected text on page 3',
      anchorNode: textNode as unknown as Node,
      getRangeAt: () =>
        ({ commonAncestorContainer: span }) as unknown as Range,
    } as Partial<Selection>)

    const leaf = makePdfLeaf('docs/paper.pdf', leafContent)
    const app = makeApp([leaf])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
    const result = getPdfSelectionData(app as any)
    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      kind: 'data',
      content: 'Selected text on page 3',
      pageNumber: 3,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
    expect((result as any).file.path).toBe('docs/paper.pdf')
  })

  test('cross-page selection: pageNumber comes from anchorNode page', () => {
    const { textNode: anchorText } = makePdfDomChain(2)
    const { container, leafContent } = makePdfDomChain(3)

    mockGetSelection({
      rangeCount: 1,
      toString: () => 'Start of selection\nEnd of selection',
      anchorNode: anchorText as unknown as Node,
      getRangeAt: () =>
        ({ commonAncestorContainer: container }) as unknown as Range,
    } as Partial<Selection>)

    const leaf = makePdfLeaf('book.pdf', leafContent)
    const app = makeApp([leaf])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
    const result = getPdfSelectionData(app as any)
    expect(result).not.toBeNull()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
    expect((result as any).pageNumber).toBe(2) // anchor page, not focus page
  })

  test('multi-PDF: attributes selection to leaf B when anchorNode is in leaf B DOM', () => {
    const chainA = makePdfDomChain(1)
    const chainB = makePdfDomChain(5)

    // Selection is inside leaf B's DOM
    mockGetSelection({
      rangeCount: 1,
      toString: () => 'Text from document B',
      anchorNode: chainB.textNode as unknown as Node,
      getRangeAt: () =>
        ({ commonAncestorContainer: chainB.span }) as unknown as Range,
    } as Partial<Selection>)

    const leafA = makePdfLeaf('file_A.pdf', chainA.leafContent)
    const leafB = makePdfLeaf('file_B.pdf', chainB.leafContent)
    // Both leaves present; leafA is listed first (like active leaf)
    const app = makeApp([leafA, leafB])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
    const result = getPdfSelectionData(app as any)
    expect(result).not.toBeNull()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
    expect((result as any).file.path).toBe('file_B.pdf') // must be B, not A
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
    expect((result as any).pageNumber).toBe(5)
  })

  test('returns { kind: "empty" } when anchor node has no .page ancestor', () => {
    // Span inside pdf-viewer-container but NOT inside a .page element
    // So pageNumber cannot be resolved → kind:'empty'
    const leafContent: FakeNode = {
      nodeType: 1,
      classList: { contains: (cls) => cls === 'workspace-leaf-content' },
      matches: (sel) =>
        sel.includes('workspace-leaf-content') &&
        sel.includes('data-type="pdf"'),
      closest: () => null,
      getAttribute: (n) => (n === 'data-type' ? 'pdf' : null),
      contains: (other: FakeNode) => {
        let cur: FakeNode | null = other
        while (cur) {
          if (cur === leafContent) return true
          cur = cur.parentNode
        }
        return false
      },
      parentNode: null,
    }

    const container: FakeNode = {
      nodeType: 1,
      classList: { contains: (cls) => cls === 'pdf-viewer-container' },
      matches: (sel) => sel.includes('pdf-viewer-container'),
      closest: (sel) =>
        sel.includes('workspace-leaf-content') ? leafContent : null,
      getAttribute: () => null,
      parentNode: leafContent,
    }

    // span directly under container (no .page wrapper)
    const span: FakeNode = {
      nodeType: 1,
      classList: { contains: () => false },
      matches: (sel) => sel.includes('pdf-viewer-container'),
      closest: (sel) => {
        if (sel.includes('workspace-leaf-content') && sel.includes('data-type="pdf"]'))
          return leafContent
        if (sel.includes('pdf-viewer-container')) return container
        return null
      },
      getAttribute: () => null,
      parentNode: container,
    }
    const textNode: FakeNode = { nodeType: 3, parentNode: span }

    mockGetSelection({
      rangeCount: 1,
      toString: () => 'Orphan text',
      anchorNode: textNode as unknown as Node,
      getRangeAt: () =>
        ({ commonAncestorContainer: span }) as unknown as Range,
    } as Partial<Selection>)

    const leaf = makePdfLeaf('orphan.pdf', leafContent)
    const app = makeApp([leaf])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
    const result = getPdfSelectionData(app as any)
    // Page number cannot be resolved → kind:'empty' (not null, since it IS inside PDF)
    expect(result).toEqual({ kind: 'empty' })
  })
})
