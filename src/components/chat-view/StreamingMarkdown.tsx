import { Keymap } from 'obsidian'
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { useApp } from '../../contexts/app-context'

type StreamingMarkdownProps = {
  content: string
  scale?: 'xs' | 'sm' | 'base'
  animateIncrementalText?: boolean
}

function isExternalHref(href: string): boolean {
  return /^(https?:)?\/\//.test(href)
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
      className={`markdown-rendered smtcmp-markdown-rendered smtcmp-streaming-markdown smtcmp-scale-${scale}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children, ...props }) => {
            if (!href) {
              return <a {...props}>{children}</a>
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
