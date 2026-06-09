import type { Annotation } from '../../types/llm/response'
import { injectAnnotationMarkers } from './inject-annotation-markers'

const url = (end: number, suffix = ''): Annotation => ({
  type: 'url_citation',
  url_citation: {
    url: `https://example.com/${suffix}`,
    end_index: end,
  },
})

describe('injectAnnotationMarkers', () => {
  it('returns content unchanged when no annotations', () => {
    expect(injectAnnotationMarkers('hello', undefined)).toBe('hello')
    expect(injectAnnotationMarkers('hello', [])).toBe('hello')
  })

  it('inserts a single markdown-link marker at end_index (end of content)', () => {
    expect(injectAnnotationMarkers('Sky is blue', [url(11)])).toBe(
      'Sky is blue[1](https://example.com/?yolo-cite=1)',
    )
  })

  it('snaps before sentence punctuation when end_index lands past it', () => {
    expect(
      injectAnnotationMarkers('A. B. C.', [url(2, 'a'), url(5, 'b')]),
    ).toBe(
      'A[1](https://example.com/a?yolo-cite=1). B[2](https://example.com/b?yolo-cite=2). C.',
    )
  })

  it('chains multiple markers at the same anchor as [1][2] left-to-right', () => {
    expect(injectAnnotationMarkers('fact.', [url(5, 'a'), url(5, 'b')])).toBe(
      'fact[1](https://example.com/a?yolo-cite=1)[2](https://example.com/b?yolo-cite=2).',
    )
  })

  it('snaps forward past a mid-CJK-word position to the next punctuation', () => {
    const content = '保加利亚国家系统集成商，通过Google合作'
    // end_index lands mid-word between 系 and 统
    expect(injectAnnotationMarkers(content, [url(7)])).toBe(
      '保加利亚国家系统集成商[1](https://example.com/?yolo-cite=1)，通过Google合作',
    )
  })

  it('snaps forward to end-of-sentence period when mid-word', () => {
    const content = '附近爆发了一场猛烈的荒火。下一段'
    // end_index lands mid-word between 爆 and 发
    expect(injectAnnotationMarkers(content, [url(3)])).toBe(
      '附近爆发了一场猛烈的荒火[1](https://example.com/?yolo-cite=1)。下一段',
    )
  })

  it('keeps marker at end_index when it is already right before punctuation', () => {
    const content = '事件，下一句'
    // end_index = 2 (after 事件), prev=件 letter, curr=, → already clean
    expect(injectAnnotationMarkers(content, [url(2)])).toBe(
      '事件[1](https://example.com/?yolo-cite=1)，下一句',
    )
  })

  it('does not snap forward when the next break is beyond the window', () => {
    // 40-char run with no punctuation — window is 30, so we give up
    const content = 'a'.repeat(40) + 'X.'
    // end_index inside the run
    expect(injectAnnotationMarkers(content, [url(5)])).toBe(
      'aaaaa[1](https://example.com/?yolo-cite=1)' + 'a'.repeat(35) + 'X.',
    )
  })

  it('orders by ordinal numerically (not lexically) at same anchor', () => {
    const ann = Array.from({ length: 11 }, (_, i) => url(5, String(i)))
    const out = injectAnnotationMarkers('fact.', ann)
    // Ordinals 1..11 should appear left-to-right
    const matches = Array.from(out.matchAll(/\[(\d+)\]/g)).map((m) => m[1])
    expect(matches).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
    ])
  })

  it('drops annotations whose end_index exceeds current content length (streaming)', () => {
    expect(injectAnnotationMarkers('short', [url(100)])).toBe('short')
  })

  it('drops end_index === 0 (no useful anchor)', () => {
    expect(injectAnnotationMarkers('hello', [url(0)])).toBe('hello')
  })

  it('drops annotations with empty url', () => {
    const bad: Annotation = {
      type: 'url_citation',
      url_citation: { url: '', end_index: 3 },
    }
    expect(injectAnnotationMarkers('hello', [bad])).toBe('hello')
  })

  it('pushes a marker past a fenced code block', () => {
    const content = 'Before\n```\ncode line\n```'
    const result = injectAnnotationMarkers(content, [url(15)])
    expect(result).toBe(
      'Before\n```\ncode line\n```[1](https://example.com/?yolo-cite=1)',
    )
  })

  it('pushes a marker past inline code', () => {
    const content = 'See `x = 1` here'
    const result = injectAnnotationMarkers(content, [url(7)])
    expect(result).toBe('See `x = 1`[1](https://example.com/?yolo-cite=1) here')
  })

  it('pushes a marker past inline math', () => {
    const content = 'See $x^2$ result'
    const result = injectAnnotationMarkers(content, [url(6)])
    expect(result).toBe('See $x^2$[1](https://example.com/?yolo-cite=1) result')
  })

  it('pushes a marker past display math', () => {
    const content = 'Above $$\nx + y\n$$ below'
    const result = injectAnnotationMarkers(content, [url(12)])
    expect(result).toBe(
      'Above $$\nx + y\n$$[1](https://example.com/?yolo-cite=1) below',
    )
  })

  it('pushes a marker past \\(…\\) inline math', () => {
    const content = 'See \\(x^2\\) result'
    const result = injectAnnotationMarkers(content, [url(8)])
    expect(result).toBe(
      'See \\(x^2\\)[1](https://example.com/?yolo-cite=1) result',
    )
  })

  it('pushes a marker past \\[…\\] display math', () => {
    const content = 'Above \\[x + y\\] below'
    const result = injectAnnotationMarkers(content, [url(10)])
    expect(result).toBe(
      'Above \\[x + y\\][1](https://example.com/?yolo-cite=1) below',
    )
  })

  it('pushes a marker past <think>...</think>', () => {
    const content = 'pre <think>hidden</think> post'
    const result = injectAnnotationMarkers(content, [url(12)])
    expect(result).toBe(
      'pre <think>hidden</think>[1](https://example.com/?yolo-cite=1) post',
    )
  })

  it('pushes a marker past <yolo_block ...>...</yolo_block>', () => {
    const content = 'pre <yolo_block filename="a.md">edit</yolo_block> post'
    const result = injectAnnotationMarkers(content, [url(35)])
    expect(result).toBe(
      'pre <yolo_block filename="a.md">edit</yolo_block>[1](https://example.com/?yolo-cite=1) post',
    )
  })

  it('leaves markers outside protected ranges, snapping to before the comma', () => {
    const content = 'Plain text, `code`, and more.'
    expect(injectAnnotationMarkers(content, [url(11)])).toBe(
      'Plain text[1](https://example.com/?yolo-cite=1), `code`, and more.',
    )
  })

  it('preserves existing fragment in source URL', () => {
    const ann: Annotation = {
      type: 'url_citation',
      url_citation: {
        url: 'https://example.com/page#section',
        end_index: 4,
      },
    }
    expect(injectAnnotationMarkers('test', [ann])).toBe(
      'test[1](https://example.com/page?yolo-cite=1#section)',
    )
  })

  it('appends with & when source URL already has query', () => {
    const ann: Annotation = {
      type: 'url_citation',
      url_citation: {
        url: 'https://example.com/?a=1',
        end_index: 4,
      },
    }
    expect(injectAnnotationMarkers('test', [ann])).toBe(
      'test[1](https://example.com/?a=1&yolo-cite=1)',
    )
  })

  it('escapes parentheses in URL to keep markdown link syntax intact', () => {
    const ann: Annotation = {
      type: 'url_citation',
      url_citation: {
        url: 'https://example.com/foo(bar)',
        end_index: 4,
      },
    }
    expect(injectAnnotationMarkers('test', [ann])).toBe(
      'test[1](https://example.com/foo(bar%29?yolo-cite=1)',
    )
  })

  it('skips annotations that are not url_citation', () => {
    const bogus = {
      type: 'other',
      url_citation: { url: 'x', end_index: 3 },
    } as unknown as Annotation
    expect(injectAnnotationMarkers('hello', [bogus])).toBe('hello')
  })

  it('skips annotations with non-finite end_index', () => {
    const bad: Annotation = {
      type: 'url_citation',
      url_citation: { url: 'x', end_index: NaN },
    }
    expect(injectAnnotationMarkers('hello', [bad])).toBe('hello')
  })
})
