import { Keymap } from 'obsidian'
import {
  type MouseEvent,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { useApp } from '../../contexts/app-context'
import { CitationSource } from '../../core/agent/citationRegistry'
import { openMarkdownFile, openPdfFileAtPage } from '../../utils/obsidian'

type StreamingMarkdownProps = {
  content: string
  scale?: 'xs' | 'sm' | 'base'
  animateIncrementalText?: boolean
  citationSources?: CitationSource[]
}

// Strict scheme match so web-search citations (https URLs that happen to
// carry a `yolo-cite=N` query param) aren't misrouted into vault navigation.
const CITE_HREF_PATTERN = /^yolo-cite:(\d+)(?:\?|$)/

function isVaultCitationHref(href: string): boolean {
  return href.startsWith('yolo-cite:')
}

function isExternalHref(href: string): boolean {
  return /^(https?:)?\/\//.test(href)
}

function transformCitationUrl(url: string): string {
  // react-markdown@9's defaultUrlTransform drops non-whitelisted schemes, so
  // our `yolo-cite:N` hrefs would be blanked out before they reach the link
  // renderer. Pass them through unchanged; defer everything else to the
  // default sanitizer.
  return isVaultCitationHref(url) ? url : defaultUrlTransform(url)
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

function getNextRevealIndex(
  currentContent: string,
  targetContent: string,
  maxStep: number,
): number {
  const baseNextIndex = Math.min(
    targetContent.length,
    currentContent.length + Math.max(1, maxStep),
  )

  if (baseNextIndex >= targetContent.length) {
    return targetContent.length
  }

  const lookaheadSlice = targetContent.slice(baseNextIndex, baseNextIndex + 12)
  const boundaryOffset = lookaheadSlice.search(
    /[\s,.!?;:，。！？；：、】【」』》）)}\]]/,
  )

  if (boundaryOffset >= 0) {
    return Math.min(targetContent.length, baseNextIndex + boundaryOffset + 1)
  }

  return baseNextIndex
}

const StreamingMarkdown = memo(function StreamingMarkdown({
  content,
  scale = 'base',
  animateIncrementalText = false,
  citationSources,
}: StreamingMarkdownProps) {
  const app = useApp()
  const [displayedContent, setDisplayedContent] = useState(content)
  const displayedContentRef = useRef(content)
  const targetContentRef = useRef(content)
  const animationFrameRef = useRef<number | null>(null)
  const lastFrameTimeRef = useRef<number | null>(null)

  const handleInternalLinkClick = useCallback(
    (href: string, event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault()
      void app.workspace.openLinkText(
        href,
        app.workspace.getActiveFile()?.path ?? '',
        Keymap.isModEvent(event.nativeEvent),
      )
    },
    [app],
  )

  const handleCitationClick = useCallback(
    (source: CitationSource, event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault()
      if (source.path.toLowerCase().endsWith('.pdf') && source.page != null) {
        openPdfFileAtPage(app, source.path, source.page)
        return
      }
      openMarkdownFile(app, source.path, source.startLine)
    },
    [app],
  )

  const cancelRevealAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    lastFrameTimeRef.current = null
  }, [])

  const scheduleRevealAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) {
      return
    }

    const tick = (timestamp: number) => {
      const target = targetContentRef.current
      const current = displayedContentRef.current
      const backlog = target.length - current.length

      if (backlog <= 0) {
        animationFrameRef.current = null
        lastFrameTimeRef.current = null
        return
      }

      const elapsedMs = lastFrameTimeRef.current
        ? Math.min(64, timestamp - lastFrameTimeRef.current)
        : 16
      lastFrameTimeRef.current = timestamp

      const charsPerSecond = Math.min(900, 90 + backlog * 4)
      const maxStep = Math.max(
        1,
        Math.floor((charsPerSecond * elapsedMs) / 1000),
      )
      const nextRevealIndex = getNextRevealIndex(current, target, maxStep)
      const nextContent = target.slice(0, nextRevealIndex)

      if (nextContent !== current) {
        displayedContentRef.current = nextContent
        setDisplayedContent(nextContent)
      }

      animationFrameRef.current =
        nextRevealIndex < target.length ? requestAnimationFrame(tick) : null

      if (nextRevealIndex >= target.length) {
        lastFrameTimeRef.current = null
      }
    }

    animationFrameRef.current = requestAnimationFrame(tick)
  }, [])

  useEffect(() => {
    if (!animateIncrementalText) {
      cancelRevealAnimation()
      displayedContentRef.current = content
      targetContentRef.current = content
      setDisplayedContent(content)
      return
    }

    const currentDisplayed = displayedContentRef.current
    if (
      content.length < currentDisplayed.length ||
      !content.startsWith(currentDisplayed)
    ) {
      cancelRevealAnimation()
      displayedContentRef.current = content
      targetContentRef.current = content
      setDisplayedContent(content)
      return
    }

    targetContentRef.current = content
    scheduleRevealAnimation()
  }, [
    animateIncrementalText,
    cancelRevealAnimation,
    content,
    scheduleRevealAnimation,
  ])

  useEffect(() => {
    return () => {
      cancelRevealAnimation()
    }
  }, [cancelRevealAnimation])

  return (
    <div
      className={`markdown-rendered yolo-markdown-rendered yolo-streaming-markdown yolo-scale-${scale}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={transformCitationUrl}
        components={{
          a: ({ href, children, ...props }) => {
            if (!href) {
              return <a {...props}>{children}</a>
            }

            if (isVaultCitationHref(href)) {
              const source = findCitationSource(href, citationSources)
              if (source) {
                return (
                  <a
                    {...props}
                    href={href}
                    title={buildCitationTooltip(source)}
                    onClick={(event) => handleCitationClick(source, event)}
                  >
                    {children}
                  </a>
                )
              }
            }

            if (isExternalHref(href)) {
              return (
                <a {...props} href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              )
            }

            return (
              <a
                {...props}
                href={href}
                className="internal-link"
                onClick={(event) => {
                  void handleInternalLinkClick(href, event)
                }}
              >
                {children}
              </a>
            )
          },
        }}
      >
        {displayedContent}
      </ReactMarkdown>
    </div>
  )
})

export default StreamingMarkdown
