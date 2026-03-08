import { App, Keymap, MarkdownRenderer } from 'obsidian'
import { memo, useCallback, useEffect, useRef } from 'react'

import { useApp } from '../../contexts/app-context'
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

  const renderMarkdown = useCallback(async () => {
    if (containerRef.current) {
      const appendedTextLength = animateIncrementalText
        ? getAppendedTextLength(previousContentRef.current, content)
        : 0

      // Use safe DOM API to clear existing children instead of assigning innerHTML
      containerRef.current.replaceChildren()
      await MarkdownRenderer.render(
        app,
        content,
        containerRef.current,
        app.workspace.getActiveFile()?.path ?? '',
        chatView,
      )

      setupMarkdownLinks(
        app,
        containerRef.current,
        app.workspace.getActiveFile()?.path ?? '',
      )
      annotateRenderedLatex(containerRef.current, content)
      syncRenderedLatexSelection(containerRef.current)

      highlightTrailingFreshText(containerRef.current, appendedTextLength)
    }

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

  useEffect(() => {
    const containerEl = containerRef.current
    if (!containerEl) {
      return
    }

    const handleSelectionChange = () => {
      syncRenderedLatexSelection(containerEl)
    }

    document.addEventListener('selectionchange', handleSelectionChange)
    document.addEventListener('mouseup', handleSelectionChange)
    document.addEventListener('keyup', handleSelectionChange)

    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange)
      document.removeEventListener('mouseup', handleSelectionChange)
      document.removeEventListener('keyup', handleSelectionChange)
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
