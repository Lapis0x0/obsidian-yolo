/**
 * Read the rendered contents of an open Obsidian webview.
 *
 * Used by `fs_read` when the path uses the `browser://` prefix after
 * resolving a `<page_id>` from the passive `<browser_context>` injection.
 *
 * Implementation notes:
 *   - We run an extraction script inside the webview via `executeJavaScript`.
 *     The script branches by format so each path only computes the payload it
 *     actually returns.
 *   - HTML→markdown happens on the host via Obsidian's `htmlToMarkdown` to
 *     match `web_scrape`'s output format for `readable`.
 *   - Cookies / localStorage / sessionStorage are NEVER read — they only live
 *     in JS state and our extraction script never touches them.
 */

import { htmlToMarkdown } from 'obsidian'

import type {
  ActiveWebviewHandle,
  BrowserContextSource,
  SupportedViewType,
} from './activeWebviewProbe'
import { isWebviewLoading } from './activeWebviewProbe'

export type BrowserReadFormat = 'readable' | 'key_visible_info'

export type BrowserReadRedaction = {
  kind: 'password' | 'hidden_input' | 'file_input'
  count: number
}

export type BrowserReadHeading = { level: number; text: string }
export type BrowserReadLink = { text: string; href: string }

export type BrowserReadResult = {
  source: BrowserContextSource
  sourceViewType: SupportedViewType
  url: string
  title: string
  format: BrowserReadFormat
  loading: boolean
  capturedAt: number
  text?: string
  headings?: BrowserReadHeading[]
  links?: BrowserReadLink[]
  partial?: { reason: 'page_loading'; message: string }
  redactions: BrowserReadRedaction[]
}

export type BrowserReadHtmlResult = {
  url: string
  title: string
  html: string
  byteLength: number
}

export type BrowserReadError =
  | 'page_not_ready'
  | 'extraction_failed'
  | 'extraction_timeout'
  | 'content_too_large'

export class BrowserReadFailure extends Error {
  constructor(
    public readonly code: BrowserReadError,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'BrowserReadFailure'
  }
}

const DEFAULT_EXTRACTION_TIMEOUT_MS = 5000
const LOADING_EXTRACTION_TIMEOUT_MS = 750

type RawRedactionCounts = {
  password: number
  hidden_input: number
  file_input: number
}

type RawReadableExtractionResult = {
  kind: 'readable'
  url: string
  title: string
  html: string
  headings: BrowserReadHeading[]
  links: BrowserReadLink[]
  counts: RawRedactionCounts
}

type RawKeyVisibleInfoExtractionResult = {
  kind: 'key_visible_info'
  url: string
  title: string
  keyInfo: string
  counts: RawRedactionCounts
}

type RawExtractionResult =
  | RawReadableExtractionResult
  | RawKeyVisibleInfoExtractionResult

type RawHtmlExtractionResult =
  | {
      kind: 'html'
      url: string
      title: string
      html: string
      byteLength: number
    }
  | {
      kind: 'html_too_large'
      url: string
      title: string
      byteLength: number
      maxBytes: number
    }

const isRawExtractionResult = (
  value: unknown,
): value is RawExtractionResult => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (
    typeof v.kind !== 'string' ||
    typeof v.url !== 'string' ||
    typeof v.title !== 'string' ||
    typeof v.counts !== 'object' ||
    v.counts === null
  ) {
    return false
  }
  if (v.kind === 'readable') {
    return (
      typeof v.html === 'string' &&
      Array.isArray(v.headings) &&
      Array.isArray(v.links)
    )
  }
  if (v.kind === 'key_visible_info') {
    return typeof v.keyInfo === 'string'
  }
  return false
}

// Note: the script body is embedded as a string template. Keep it
// self-contained and JSON-safe — it must serialize and run inside the
// remote Electron context.
const EXTRACTION_SCRIPT = `((format) => {
  const doc = document;
  const getCounts = (root) => ({
    password: root ? root.querySelectorAll('input[type="password"]').length : 0,
    hidden_input: root ? root.querySelectorAll('input[type="hidden"]').length : 0,
    file_input: root ? root.querySelectorAll('input[type="file"]').length : 0,
  });
  const basePayload = () => ({
    url: location.href,
    title: doc.title || '',
  });

  if (format === 'readable') {
    const root = doc.body || doc.documentElement;
    const cloned = root ? root.cloneNode(true) : doc.createElement('div');
    const counts = { password: 0, hidden_input: 0, file_input: 0 };

    const removeMatching = (selector, key) => {
      cloned.querySelectorAll(selector).forEach((el) => {
        counts[key]++;
        el.remove();
      });
    };
    removeMatching('input[type="password"]', 'password');
    removeMatching('input[type="hidden"]', 'hidden_input');
    removeMatching('input[type="file"]', 'file_input');
    cloned.querySelectorAll('script,style,noscript,[hidden],[aria-hidden="true"]').forEach((el) => el.remove());

    const headings = [];
    cloned.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((el) => {
      const level = parseInt(el.tagName.slice(1), 10);
      const text = (el.textContent || '').trim();
      if (text) headings.push({ level: level, text: text });
    });
    const links = [];
    cloned.querySelectorAll('a[href]').forEach((el) => {
      const href = el.getAttribute('href');
      const text = (el.textContent || '').trim();
      if (href && text) links.push({ text: text, href: href });
    });

    return {
      kind: 'readable',
      ...basePayload(),
      html: cloned.innerHTML,
      headings: headings,
      links: links,
      counts: counts,
    };
  }

  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const directTextOf = (el) => Array.from(el.childNodes || [])
    .filter((node) => node && node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent || '')
    .join(' ')
    .replace(/\\s+/g, ' ')
    .trim();
  const keyRoot = doc.body || doc.documentElement || doc.createElement('div');
  const isVisibleForKeyInfo = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
      return false;
    }
    if (/^(SCRIPT|STYLE|NOSCRIPT|META|LINK)$/.test(el.tagName)) return false;
    if (/^(HTML|BODY|ARTICLE|SECTION|MAIN|DIV|UL|OL|TABLE|TBODY|THEAD|TFOOT|TR)$/.test(el.tagName)) {
      return true;
    }
    const rects = el.getClientRects ? el.getClientRects() : [];
    return rects.length > 0;
  };
  const seen = new Set();
  const keyLines = [];
  const pushLine = (line) => {
    const normalized = String(line || '').replace(/\\s+/g, ' ').trim();
    if (!normalized || normalized.length < 2 || seen.has(normalized)) return;
    seen.add(normalized);
    keyLines.push(normalized);
  };

  const formulaSelector = [
    'math',
    '.katex',
    '.MathJax',
    'script[type^="math/tex"]',
    'annotation[encoding*="tex" i]',
    '[data-tex]',
    '[aria-label*="formula" i]',
    '[aria-label*="equation" i]',
  ].join(',');
  keyRoot.querySelectorAll(formulaSelector).forEach((el) => {
    if (!isVisibleForKeyInfo(el) && !(el.closest && isVisibleForKeyInfo(el.closest('.katex,.MathJax,math')))) {
      return;
    }
    const annotation = el.querySelector
      ? el.querySelector('annotation[encoding*="tex" i]')
      : null;
    const raw =
      el.getAttribute('data-tex') ||
      el.getAttribute('alttext') ||
      el.getAttribute('aria-label') ||
      (annotation ? annotation.textContent : '') ||
      el.textContent ||
      '';
    const formula = String(raw).replace(/\\s+/g, ' ').trim();
    if (formula) pushLine('Formula: ' + formula);
  });

  const blockSelector = [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'li',
    'blockquote',
    'pre',
    'code',
    'figcaption',
    'caption',
    'summary',
    'dt',
    'dd',
    'th',
    'td',
  ].join(',');
  keyRoot.querySelectorAll(blockSelector).forEach((el) => {
    if (!isVisibleForKeyInfo(el)) return;
    if (el.closest && el.closest(formulaSelector)) return;
    const text = textOf(el);
    if (!text) return;
    if (/^H[1-6]$/.test(el.tagName)) {
      pushLine('#'.repeat(Number(el.tagName.slice(1))) + ' ' + text);
      return;
    }
    if (el.tagName === 'LI') {
      pushLine('- ' + text);
      return;
    }
    pushLine(text);
  });

  const fallbackSelector = [
    'article',
    'section',
    'main',
    'div',
    'span',
    'a',
    'button',
    'label',
    '[role="article"]',
    '[role="main"]',
    '[role="paragraph"]',
    '[role="listitem"]',
    '[role="cell"]',
  ].join(',');
  keyRoot.querySelectorAll(fallbackSelector).forEach((el) => {
    if (!isVisibleForKeyInfo(el)) return;
    if (el.closest && el.closest(formulaSelector)) return;
    if (el.matches && el.matches(blockSelector)) return;
    const directText = directTextOf(el);
    const hasMeaningfulDirectText = directText.length >= 12;
    const hasBlockChildren = el.querySelector && el.querySelector(blockSelector);
    const hasFallbackChildren =
      el.querySelector &&
      el.querySelector('article,section,main,div,span,[role="paragraph"],[role="listitem"],[role="cell"]');
    if (hasMeaningfulDirectText) {
      pushLine(directText);
      return;
    }
    if (hasBlockChildren || hasFallbackChildren) return;
    const text = textOf(el);
    if (text.length >= 12) pushLine(text);
  });

  return {
    kind: 'key_visible_info',
    ...basePayload(),
    keyInfo: keyLines.join('\\n'),
    counts: getCounts(keyRoot),
  };
})`

const buildExtractionScript = (format: BrowserReadFormat): string =>
  `(${EXTRACTION_SCRIPT})(${JSON.stringify(format)})`

const HTML_EXTRACTION_SCRIPT = `((maxBytes) => {
  const doc = document;
  const html = doc.documentElement
    ? doc.documentElement.outerHTML
    : (doc.body ? doc.body.outerHTML : '');
  const byteLength = typeof TextEncoder !== 'undefined'
    ? new TextEncoder().encode(html).length
    : html.length;
  const base = {
    url: location.href,
    title: doc.title || '',
    byteLength,
  };
  if (Number.isFinite(maxBytes) && maxBytes > 0 && byteLength > maxBytes) {
    return {
      kind: 'html_too_large',
      ...base,
      maxBytes,
    };
  }
  return {
    kind: 'html',
    ...base,
    html,
  };
})`

const buildHtmlExtractionScript = (maxBytes?: number): string =>
  `(${HTML_EXTRACTION_SCRIPT})(${JSON.stringify(maxBytes ?? null)})`

const isRawHtmlExtractionResult = (
  value: unknown,
): value is RawHtmlExtractionResult => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (
    typeof v.kind !== 'string' ||
    typeof v.url !== 'string' ||
    typeof v.title !== 'string' ||
    typeof v.byteLength !== 'number'
  ) {
    return false
  }
  if (v.kind === 'html') {
    return typeof v.html === 'string'
  }
  if (v.kind === 'html_too_large') {
    return typeof v.maxBytes === 'number'
  }
  return false
}

const withTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('Aborted'))
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      reject(
        new BrowserReadFailure(
          'extraction_timeout',
          `Extraction timed out after ${timeoutMs}ms`,
        ),
      )
    }, timeoutMs)
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

const buildRedactions = (
  counts: RawExtractionResult['counts'],
): BrowserReadRedaction[] => {
  const out: BrowserReadRedaction[] = []
  if (counts.password > 0)
    out.push({ kind: 'password', count: counts.password })
  if (counts.hidden_input > 0)
    out.push({ kind: 'hidden_input', count: counts.hidden_input })
  if (counts.file_input > 0)
    out.push({ kind: 'file_input', count: counts.file_input })
  return out
}

/**
 * Read an open webview's rendered page contents via `executeJavaScript`
 * (caller resolves the handle first).
 *
 * Throws `BrowserReadFailure` on timeout / extraction error. Returns null
 * only when the view has no usable URL and no rendered content yet.
 */
export async function readActiveWebviewPage(
  handle: ActiveWebviewHandle,
  options: {
    format: BrowserReadFormat
    signal?: AbortSignal
    executionTimeoutMs?: number
  },
): Promise<BrowserReadResult | null> {
  const loading = isWebviewLoading(handle.webview)
  let raw: unknown
  try {
    raw = await withTimeout(
      handle.webview.executeJavaScript(buildExtractionScript(options.format)),
      options.executionTimeoutMs ??
        (loading
          ? LOADING_EXTRACTION_TIMEOUT_MS
          : DEFAULT_EXTRACTION_TIMEOUT_MS),
      options.signal,
    )
  } catch (error) {
    if (
      loading &&
      error instanceof BrowserReadFailure &&
      error.code === 'extraction_timeout'
    ) {
      const url = handle.webview.getURL()
      const title = handle.webview.getTitle()
      if (!url || url === 'about:blank') return null
      return {
        source: handle.source,
        sourceViewType: handle.viewType,
        url,
        title,
        format: options.format,
        loading,
        capturedAt: Date.now(),
        text: '',
        headings: [],
        links: [],
        partial: {
          reason: 'page_loading',
          message:
            'The page is still loading, and rendered content was not available quickly enough. Try again after the page finishes loading.',
        },
        redactions: [],
      }
    }
    if (error instanceof BrowserReadFailure) throw error
    throw new BrowserReadFailure(
      'extraction_failed',
      `Failed to extract page contents: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    )
  }

  if (!isRawExtractionResult(raw)) {
    throw new BrowserReadFailure(
      'extraction_failed',
      'Extraction script returned an unexpected payload',
    )
  }
  if (raw.kind !== options.format) {
    throw new BrowserReadFailure(
      'extraction_failed',
      'Extraction script returned a payload for the wrong format',
    )
  }

  const hasRenderedContent =
    raw.kind === 'readable'
      ? raw.html.trim().length > 0 ||
        raw.headings.length > 0 ||
        raw.links.length > 0
      : raw.keyInfo.trim().length > 0
  if ((!raw.url || raw.url === 'about:blank') && !hasRenderedContent) {
    return null
  }

  const baseResult: BrowserReadResult = {
    source: handle.source,
    sourceViewType: handle.viewType,
    url: raw.url,
    title: raw.title,
    format: options.format,
    loading,
    capturedAt: Date.now(),
    redactions: buildRedactions(raw.counts),
  }

  if (raw.kind === 'key_visible_info') {
    return {
      ...baseResult,
      text: raw.keyInfo,
    }
  }

  // 'readable': markdownify full page
  return {
    ...baseResult,
    headings: raw.headings,
    links: raw.links,
    text: htmlToMarkdown(raw.html),
  }
}

/**
 * Read the full rendered DOM HTML from an already-open supported webview.
 * This intentionally returns `document.documentElement.outerHTML` without the
 * readable-mode redactions above; callers expose it only behind high-risk
 * capability gates for workflows that need exact page markup.
 */
export async function readActiveWebviewHtml(
  handle: ActiveWebviewHandle,
  options?: {
    signal?: AbortSignal
    executionTimeoutMs?: number
    maxBytes?: number
  },
): Promise<BrowserReadHtmlResult | null> {
  const loading = isWebviewLoading(handle.webview)
  let raw: unknown
  try {
    raw = await withTimeout(
      handle.webview.executeJavaScript(
        buildHtmlExtractionScript(options?.maxBytes),
      ),
      options?.executionTimeoutMs ??
        (loading
          ? LOADING_EXTRACTION_TIMEOUT_MS
          : DEFAULT_EXTRACTION_TIMEOUT_MS),
      options?.signal,
    )
  } catch (error) {
    if (error instanceof BrowserReadFailure) throw error
    throw new BrowserReadFailure(
      'extraction_failed',
      `Failed to extract page HTML: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    )
  }

  if (!isRawHtmlExtractionResult(raw)) {
    throw new BrowserReadFailure(
      'extraction_failed',
      'HTML extraction script returned an unexpected payload',
    )
  }

  if (raw.kind === 'html_too_large') {
    throw new BrowserReadFailure(
      'content_too_large',
      `Browser page HTML is ${raw.byteLength} bytes, above the ${raw.maxBytes} byte cap.`,
    )
  }

  if ((!raw.url || raw.url === 'about:blank') && raw.html.trim().length === 0) {
    return null
  }

  return {
    url: raw.url,
    title: raw.title,
    html: raw.html,
    byteLength: raw.byteLength,
  }
}
