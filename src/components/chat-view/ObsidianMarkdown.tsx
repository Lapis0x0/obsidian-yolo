import { type App, Keymap, MarkdownRenderer, useApp} from '../../runtime/react-compat'
import { memo, useCallback, useEffect, useRef } from 'react'

import { useChatView } from '../../contexts/chat-view-context'

import {
  annotateRenderedLatex,
  copySelectedLatex,
  syncRenderedLatexSelection,
} from './latex-copy'

type ObsidianMarkdownProps = {
  content: string
  scale?: 'xs' | 'sm' | 'base'
  animateIncrementalText?: boolean
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
  const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT)
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
    freshTextSpan.className = 'smtcmp-stream-fresh-text'
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
}: ObsidianMarkdownProps) {
  const app = useApp()
  const chatView = useChatView()
  const containerRef = useRef<HTMLDivElement>(null)
  const previousContentRef = useRef('')
  const renderTokenRef = useRef(0)

  const renderMarkdown = useCallback(async () => {
    const containerEl = containerRef.current
    if (!containerEl) {
      return
    }

    const appendedTextLength = animateIncrementalText
      ? getAppendedTextLength(previousContentRef.current, content)
      : 0

    const renderToken = ++renderTokenRef.current

    // Render into a detached staging element so the live container keeps its
    // current children (and therefore its scrollHeight) throughout the async
    // render. The previous "replaceChildren() then await render()" pattern
    // briefly emptied the container, which let the browser clamp scrollTop —
    // surfacing as a scroll-jump to the top of long message bubbles when the
    // user scrolled past one (issue #258).
    const staging = document.createElement('div')
    await MarkdownRenderer.render(
      app,
      content,
      staging,
      app.workspace.getActiveFile()?.path ?? '',
      chatView,
    )

    // Drop stale renders (a newer invocation has taken over) and guard against
    // unmount during the await.
    if (renderToken !== renderTokenRef.current || !containerRef.current) {
      return
    }

    // Atomic swap: scrollHeight transitions oldHeight → newHeight in one frame
    // with no zero-height window, so the scroll position is preserved.
    containerRef.current.replaceChildren(...Array.from(staging.childNodes))

    setupMarkdownLinks(
      app,
      containerRef.current,
      app.workspace.getActiveFile()?.path ?? '',
    )
    annotateRenderedLatex(containerRef.current, content)
    syncRenderedLatexSelection(containerRef.current)
    highlightTrailingFreshText(containerRef.current, appendedTextLength)

    previousContentRef.current = content
  }, [animateIncrementalText, app, content, chatView])

  useEffect(() => {
    void renderMarkdown()
  }, [renderMarkdown])

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
      className={`markdown-rendered smtcmp-markdown-rendered smtcmp-scale-${scale}`}
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
    <div className="smtcmp-obsidian-code-block">
      <ObsidianMarkdown
        content={`\`\`\`${language ?? ''}\n${content}\n\`\`\``}
        scale={scale}
        animateIncrementalText={animateIncrementalText}
      />
    </div>
  )
}

export { ObsidianCodeBlock, ObsidianMarkdown }
