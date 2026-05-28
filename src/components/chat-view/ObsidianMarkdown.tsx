import { App, Keymap, MarkdownRenderer, finishRenderMath } from 'obsidian'
import { memo, useCallback, useEffect, useRef } from 'react'

import { useApp } from '../../contexts/app-context'
import { useChatView } from '../../contexts/chat-view-context'
import { CitationSource } from '../../core/agent/citationRegistry'
import { openMarkdownFile, openPdfFileAtPage } from '../../utils/obsidian'

import {
  annotateRenderedLatex,
  copySelectedLatex,
  syncRenderedLatexSelection,
} from './latex-copy'

type ObsidianMarkdownProps = {
  content: string
  scale?: 'xs' | 'sm' | 'base'
  animateIncrementalText?: boolean
  citationSources?: CitationSource[]
}

// Strict scheme match so we don't collide with web-search citation URLs like
// `https://...?yolo-cite=1`, which share the same substring but should not be
// hijacked as vault citations.
const CITE_HREF_PATTERN = /^yolo-cite:(\d+)(?:\?|$)/

function isVaultCitationHref(href: string): boolean {
  return href.startsWith('yolo-cite:')
}

function findCitationSource(
  href: string,
  sources: CitationSource[] | undefined,
): CitationSource | null {
  if (!sources || sources.length === 0) {
    return null
  }
  const match = href.match(CITE_HREF_PATTERN)
  if (!match) {
    return null
  }
  const ordinal = Number.parseInt(match[1], 10)
  if (!Number.isFinite(ordinal)) {
    return null
  }
  return sources.find((source) => source.ordinal === ordinal) ?? null
}

function openCitationSource(app: App, source: CitationSource): void {
  if (source.path.toLowerCase().endsWith('.pdf') && source.page != null) {
    openPdfFileAtPage(app, source.path, source.page)
    return
  }
  openMarkdownFile(app, source.path, source.startLine)
}

function buildCitationTooltip(source: CitationSource): string {
  const range =
    source.startLine === source.endLine
      ? `L${source.startLine}`
      : `L${source.startLine}-${source.endLine}`
  const header = `${source.path} ${range}`
  const snippet = source.snippet
    ? source.snippet.length > 80
      ? `${source.snippet.slice(0, 80)}…`
      : source.snippet
    : ''
  return snippet ? `${header}\n${snippet}` : header
}

// Detects LaTeX-bearing content so we can switch to two-phase rendering: a
// fast Phase 1 with delimiters escaped (text visible immediately), followed
// by a deferred Phase 2 that does the real MathJax-typesetting pass.
const LATEX_DELIMITER_PATTERN =
  /\$\$[\s\S]+?\$\$|\$[^\s$][^$\n]*\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/

function escapeLatexDelimiters(content: string): string {
  return content
    .replace(/\$/g, '\\$')
    .replace(/\\\[/g, '\\\\[')
    .replace(/\\\]/g, '\\\\]')
    .replace(/\\\(/g, '\\\\(')
    .replace(/\\\)/g, '\\\\)')
}

function yieldToBrowser(): Promise<void> {
  if (typeof window.requestIdleCallback === 'function') {
    return new Promise((resolve) => {
      window.requestIdleCallback(() => resolve(), { timeout: 1000 })
    })
  }
  return new Promise((resolve) => {
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => resolve()),
    )
  })
}

function getAppendedTextLength(
  previousContent: string,
  nextContent: string,
): number {
  if (!previousContent || nextContent.length <= previousContent.length) {
    return 0
  }

  return nextContent.startsWith(previousContent)
    ? nextContent.length - previousContent.length
    : 0
}

function highlightTrailingFreshText(
  containerEl: HTMLElement,
  appendedTextLength: number,
) {
  if (appendedTextLength <= 0) {
    return
  }

  const textNodes: Text[] = []
  const walker = (containerEl.ownerDocument ?? document).createTreeWalker(
    containerEl,
    NodeFilter.SHOW_TEXT,
  )
  let currentNode = walker.nextNode()

  while (currentNode) {
    if (currentNode instanceof Text && currentNode.textContent) {
      textNodes.push(currentNode)
    }
    currentNode = walker.nextNode()
  }

  let remainingLength = appendedTextLength
  for (
    let index = textNodes.length - 1;
    index >= 0 && remainingLength > 0;
    index--
  ) {
    const textNode = textNodes[index]
    const textContent = textNode.textContent ?? ''
    if (!textContent) {
      continue
    }

    const wrapLength = Math.min(remainingLength, textContent.length)
    const wrapStartIndex = textContent.length - wrapLength
    const trailingNode =
      wrapStartIndex > 0 ? textNode.splitText(wrapStartIndex) : textNode
    const trailingParent = trailingNode.parentNode
    if (!trailingParent) {
      remainingLength -= wrapLength
      continue
    }

    const freshTextSpan = document.createElement('span')
    freshTextSpan.className = 'yolo-stream-fresh-text'
    trailingParent.replaceChild(freshTextSpan, trailingNode)
    freshTextSpan.appendChild(trailingNode)
    remainingLength -= wrapLength
  }
}

/**
 * Renders Obsidian Markdown content using the Obsidian MarkdownRenderer.
 *
 * @param content - The Obsidian Markdown content to render.
 * @param scale - The scale of the markdown content.
 * @returns A React component that renders the Obsidian Markdown content.
 */
const ObsidianMarkdown = memo(function ObsidianMarkdown({
  content,
  scale = 'base',
  animateIncrementalText = false,
  citationSources,
}: ObsidianMarkdownProps) {
  const app = useApp()
  const chatView = useChatView()
  const containerRef = useRef<HTMLDivElement>(null)
  const previousContentRef = useRef('')
  const renderTokenRef = useRef(0)
  const citationSourcesRef = useRef(citationSources)
  citationSourcesRef.current = citationSources

  const renderMarkdown = useCallback(async () => {
    const containerEl = containerRef.current
    if (!containerEl) {
      return
    }

    const renderContent = content
    const appendedTextLength = animateIncrementalText
      ? getAppendedTextLength(previousContentRef.current, renderContent)
      : 0

    const renderToken = ++renderTokenRef.current
    const sourcePath = app.workspace.getActiveFile()?.path ?? ''
    // Two-phase render kicks in for static messages with LaTeX. Streaming
    // messages re-render very frequently and don't benefit from a fast first
    // pass — they go straight to single-pass real rendering.
    const useTwoPhase =
      !animateIncrementalText && LATEX_DELIMITER_PATTERN.test(renderContent)

    const swapInto = (
      staging: HTMLDivElement,
      includeLatexAnnotations: boolean,
    ) => {
      const liveContainer = containerRef.current
      if (!liveContainer) return
      // Atomic swap: scrollHeight transitions oldHeight → newHeight in one frame
      // with no zero-height window, so the scroll position is preserved.
      liveContainer.replaceChildren(...Array.from(staging.childNodes))
      setupMarkdownLinks(
        app,
        liveContainer,
        sourcePath,
        false,
        citationSourcesRef.current,
      )
      if (includeLatexAnnotations) {
        annotateRenderedLatex(liveContainer, renderContent)
        syncRenderedLatexSelection(liveContainer)
      }
    }

    // Phase 1: render with LaTeX delimiters escaped — formulas show as raw
    // source temporarily, but the text appears immediately without waiting
    // for MathJax to typeset. Only runs for messages that actually contain
    // LaTeX, so we don't pay an extra render for plain text.
    if (useTwoPhase) {
      const phase1Staging = document.createElement('div')
      await MarkdownRenderer.render(
        app,
        escapeLatexDelimiters(renderContent),
        phase1Staging,
        sourcePath,
        chatView,
      )
      if (renderToken !== renderTokenRef.current || !containerRef.current) {
        return
      }
      swapInto(phase1Staging, false)
      // Yield so Phase 1 actually paints (and other rows can do their Phase 1)
      // before we kick off the expensive MathJax pass.
      await yieldToBrowser()
      if (renderToken !== renderTokenRef.current || !containerRef.current) {
        return
      }
    }

    // Single-pass (no LaTeX or streaming) or Phase 2: real render with MathJax.
    // Render into a detached staging element so the live container keeps its
    // current children (and therefore its scrollHeight) throughout the async
    // render. The previous "replaceChildren() then await render()" pattern
    // briefly emptied the container, which let the browser clamp scrollTop —
    // surfacing as a scroll-jump to the top of long message bubbles when the
    // user scrolled past one (issue #258).
    const staging = document.createElement('div')
    await MarkdownRenderer.render(
      app,
      renderContent,
      staging,
      sourcePath,
      chatView,
    )

    // Drop stale renders (a newer invocation has taken over) and guard against
    // unmount during the await.
    if (renderToken !== renderTokenRef.current || !containerRef.current) {
      return
    }

    swapInto(staging, true)
    highlightTrailingFreshText(containerRef.current, appendedTextLength)

    previousContentRef.current = renderContent

    // Flush MathJax stylesheet so queued LaTeX renders to its final size.
    // Without this, math elements can stay collapsed and the row's first
    // measured height (e.g. 68px for a long bubble) gets persisted into the
    // height cache, poisoning future scroll-space estimates.
    //
    // Gated on `useTwoPhase`: messages without LaTeX have nothing of ours
    // queued, so flushing is pointless — and Obsidian's `finishRenderMath`
    // touches its MathJax bundle without checking whether it's been
    // lazy-loaded yet, throwing `MathJax is not defined` when called before
    // any math has rendered (common right after plugin/app startup).
    if (useTwoPhase) {
      await finishRenderMath()
    }
  }, [animateIncrementalText, app, content, chatView])

  useEffect(() => {
    void renderMarkdown()
  }, [renderMarkdown])

  // Re-bind citation handlers when sources arrive after the initial render
  // (sources are appended to metadata only once the stream completes, so the
  // first `setupMarkdownLinks` pass runs with an empty/stale `citationSources`
  // and would leave the rendered `<a yolo-cite:N>` links without click handlers
  // or tooltips). Scoped strictly to yolo-cite anchors so we don't disturb
  // anything else in the container.
  useEffect(() => {
    const containerEl = containerRef.current
    if (!containerEl) {
      return
    }
    setupCitationLinks(app, containerEl, citationSources)
  }, [app, citationSources])

  useEffect(() => {
    const containerEl = containerRef.current
    if (!containerEl) {
      return
    }

    const handleCopy = (event: ClipboardEvent) => {
      copySelectedLatex(event, containerEl)
    }

    containerEl.addEventListener('copy', handleCopy)

    return () => {
      containerEl.removeEventListener('copy', handleCopy)
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className={`markdown-rendered yolo-markdown-rendered yolo-scale-${scale}`}
    />
  )
})

/**
 * Adds click and hover handlers to internal links rendered by MarkdownRenderer.render().
 * Required because rendered links are not interactive by default.
 *
 * @see https://forum.obsidian.md/t/internal-links-dont-work-in-custom-view/90169/3
 */
function setupMarkdownLinks(
  app: App,
  containerEl: HTMLElement,
  sourcePath: string,
  showLinkHover?: boolean,
  citationSources?: CitationSource[],
) {
  containerEl.querySelectorAll('a.internal-link').forEach((el) => {
    el.addEventListener('click', (evt: MouseEvent) => {
      evt.preventDefault()
      const linktext = el.getAttribute('href')
      if (linktext) {
        void app.workspace.openLinkText(
          linktext,
          sourcePath,
          Keymap.isModEvent(evt),
        )
      }
    })

    if (showLinkHover) {
      el.addEventListener('mouseover', (event: MouseEvent) => {
        event.preventDefault()
        const linktext = el.getAttribute('href')
        if (linktext) {
          app.workspace.trigger('hover-link', {
            event,
            source: 'preview',
            hoverParent: { hoverPopover: null },
            targetEl: event.currentTarget,
            linktext: linktext,
            sourcePath: sourcePath,
          })
        }
      })
    }
  })

  setupCitationLinks(app, containerEl, citationSources)
}

/**
 * Bind click/title for `yolo-cite:N` anchors in the rendered markdown.
 * Idempotent: replaces each anchor with a clone before binding, so callers can
 * re-run this when `citationSources` arrives late (post-stream metadata) or
 * changes, without stacking duplicate listeners.
 */
function setupCitationLinks(
  app: App,
  containerEl: HTMLElement,
  citationSources?: CitationSource[],
) {
  containerEl.querySelectorAll('a').forEach((el) => {
    const href = el.getAttribute('href')
    if (!href || !isVaultCitationHref(href)) {
      return
    }
    // Clear any previous handler/title (from an earlier pass with stale or
    // empty sources) by replacing the node with a clone.
    const fresh = el.cloneNode(true) as HTMLAnchorElement
    el.replaceWith(fresh)

    const source = findCitationSource(href, citationSources)
    if (!source) {
      return
    }
    fresh.setAttribute('title', buildCitationTooltip(source))
    fresh.addEventListener('click', (evt: MouseEvent) => {
      evt.preventDefault()
      openCitationSource(app, source)
    })
  })
}

function ObsidianCodeBlock({
  content,
  language,
  scale = 'sm',
  animateIncrementalText = false,
}: {
  content: string
  language?: string
  scale?: 'xs' | 'sm' | 'base'
  animateIncrementalText?: boolean
}) {
  return (
    <div className="yolo-obsidian-code-block">
      <ObsidianMarkdown
        content={`\`\`\`${language ?? ''}\n${content}\n\`\`\``}
        scale={scale}
        animateIncrementalText={animateIncrementalText}
      />
    </div>
  )
}

export { ObsidianCodeBlock, ObsidianMarkdown }
