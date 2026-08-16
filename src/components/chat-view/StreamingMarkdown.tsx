import { App, Keymap } from 'obsidian'
import {
  Children,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import ReactMarkdown, {
  type Components,
  defaultUrlTransform,
} from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

import { useApp } from '../../contexts/app-context'
import { CitationSource } from '../../core/agent/citationRegistry'
import { getNodeWindow } from '../../utils/dom/window-context'
import { openMarkdownFile, openPdfFileAtPage } from '../../utils/obsidian'

import { useLiveEdgeFollow } from './live-edge-follow-context'
import { type MarkdownBlockSplit, splitMarkdownBlocks } from './streamingBlocks'
import {
  normalizeDisplayMathDelimiters,
  preserveUnclosedMathSource,
  renderStreamingMath,
} from './streamingMath'
import type { StreamingContentSource } from './useAssistantRenderStream'

type StreamingMarkdownProps = {
  content: string
  /**
   * Imperative target for a live stream. When present, `content` is only the
   * initial/fallback value: token arrival writes the target ref and schedules
   * the playback loop without ever entering React, so the single React beat in
   * the streaming path is this component's ~30Hz reveal frame.
   */
  contentSource?: StreamingContentSource | null
  scale?: 'xs' | 'sm' | 'base'
  animateIncrementalText?: boolean
  /**
   * The upstream stream has ended. Catch up to `content` quickly instead of
   * playing out the jitter buffer at reading speed.
   */
  draining?: boolean
  onDrained?: () => void
  citationSources?: CitationSource[]
}

// Providers deliver chunks unevenly — a burst, then a few hundred milliseconds
// of nothing. Draining the backlog as fast as it arrives empties the buffer
// well before the next chunk lands and freezes the view in between, which is
// what reads as stuttering. Instead we hold roughly REVEAL_TARGET_LATENCY_MS
// worth of characters in reserve and play them out at `backlog / latency`.
// That rate is self-balancing: at steady state it equals the provider's own
// rate, so the reserve stays intact and upstream gaps shorter than the target
// latency never reach the screen.
const REVEAL_TARGET_LATENCY_MS = 450
const REVEAL_MIN_CHARS_PER_SECOND = 24
const REVEAL_MAX_CHARS_PER_SECOND = 1200
// Time constant for smoothing the rate, so a single large chunk raises the
// playback speed gradually instead of stepping it.
const REVEAL_RATE_SMOOTHING_TAU_MS = 200
// Draining keeps the same continuous motion but collapses the reserve, so the
// handoff to the fully rendered message doesn't jump.
const DRAIN_TARGET_LATENCY_MS = 120
const DRAIN_MIN_CHARS_PER_SECOND = 200

// 播出帧决定字符多久释放一批。文字不是运动物体，没有轨迹可追，每 33ms 冒两个
// 字与每 16ms 冒一个字在感知上等价；而一帧最贵的开销是尾块重解析，它与释放频率
// 同步增长。所以按感知下限取 30fps。
const REVEAL_FRAME_INTERVAL_MS = 1000 / 30

// 判据的容差，不能省。1000/30 恰好是 60Hz 与 120Hz 帧周期的整数倍（2 帧 / 4
// 帧），于是「够不够一个播出间隔」正好压在显示帧边界上，timestamp 的亚毫秒抖动
// 会让它有一半概率被判成还差一点，只能整整多等一帧——实测在 120Hz 上稳定退化成
// 41.6ms，即声称 30Hz、实跑 24Hz。留半个 120Hz 帧的余量让压线那帧确定性放行；
// 这个量仍小于常见刷新率的帧周期，不会让循环提前一整帧。
const REVEAL_FRAME_TOLERANCE_MS = 1000 / 120 / 2

function prefersReducedMotion(node: HTMLElement | null): boolean {
  return getNodeWindow(node).matchMedia('(prefers-reduced-motion: reduce)')
    .matches
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

type ElementWithClassName = ReactElement<{ className?: string }>

function hasMathClass(className: string | undefined, name: string): boolean {
  return className?.split(/\s+/).includes(name) ?? false
}

function getTextContent(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : '',
    )
    .join('')
}

const StreamingMath = memo(function StreamingMath({
  source,
  display,
}: {
  source: string
  display: boolean
}) {
  const setContainer = useCallback(
    (container: HTMLElement | null) => {
      if (container) {
        renderStreamingMath(container, source, display)
      }
    },
    [display, source],
  )
  const rawSource = display ? `$$\n${source}\n$$` : `$${source}$`

  return display ? (
    <div
      ref={setContainer}
      className="yolo-streaming-math yolo-streaming-math-display"
    >
      {rawSource}
    </div>
  ) : (
    <span
      ref={setContainer}
      className="yolo-streaming-math yolo-streaming-math-inline"
    >
      {rawSource}
    </span>
  )
})

function StreamingCode({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'code'>) {
  if (
    hasMathClass(className, 'math-inline') ||
    hasMathClass(className, 'math-display')
  ) {
    return (
      <StreamingMath
        source={getTextContent(children).replace(/\n$/, '')}
        display={hasMathClass(className, 'math-display')}
      />
    )
  }

  return (
    <code {...props} className={className}>
      {children}
    </code>
  )
}

function StreamingPre({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const child = isValidElement(children)
    ? (children as ElementWithClassName)
    : null
  if (hasMathClass(child?.props.className, 'math-display')) {
    return <>{children}</>
  }

  return <pre {...props}>{children}</pre>
}

// Citation sources travel through context rather than through props so that the
// per-block renderers keep a single `content` prop. A prop would change
// identity on every streamed frame for the blocks that are already finished and
// defeat their memoization; a context update reaches the link renderers
// directly without re-parsing anything.
const CitationSourcesContext = createContext<CitationSource[] | undefined>(
  undefined,
)

function openInternalLink(
  app: App,
  href: string,
  event: MouseEvent<HTMLAnchorElement>,
): void {
  event.preventDefault()
  void app.workspace.openLinkText(
    href,
    app.workspace.getActiveFile()?.path ?? '',
    Keymap.isModEvent(event.nativeEvent),
  )
}

function openCitationSource(
  app: App,
  source: CitationSource,
  event: MouseEvent<HTMLAnchorElement>,
): void {
  event.preventDefault()
  if (source.path.toLowerCase().endsWith('.pdf') && source.page != null) {
    openPdfFileAtPage(app, source.path, source.page)
    return
  }
  openMarkdownFile(app, source.path, source.startLine)
}

function StreamingLink({
  href,
  children,
  ...props
}: ComponentPropsWithoutRef<'a'>) {
  const app = useApp()
  const citationSources = useContext(CitationSourcesContext)

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
          onClick={(event) => openCitationSource(app, source, event)}
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
        openInternalLink(app, href, event)
      }}
    >
      {children}
    </a>
  )
}

// Module-level constants: every one of these would otherwise be a fresh
// reference on each render and would break `MarkdownBlock`'s memoization.
const REMARK_PLUGINS = [remarkGfm, remarkMath, preserveUnclosedMathSource]
const MARKDOWN_COMPONENTS: Components = {
  code: StreamingCode,
  pre: StreamingPre,
  a: StreamingLink,
}

/**
 * One top-level markdown block. Memoized on its source text so that a streamed
 * frame only re-parses the block the model is still writing into, instead of
 * the whole answer.
 */
const MarkdownBlock = memo(function MarkdownBlock({
  content,
}: {
  content: string
}) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      skipHtml
      urlTransform={transformCitationUrl}
      components={MARKDOWN_COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  )
})

const StreamingMarkdown = memo(function StreamingMarkdown({
  content,
  contentSource = null,
  scale = 'base',
  animateIncrementalText = false,
  draining = false,
  onDrained,
  citationSources,
}: StreamingMarkdownProps) {
  const followLiveEdge = useLiveEdgeFollow()
  const [displayedContent, setDisplayedContent] = useState(content)
  const displayedContentRef = useRef(content)
  const targetContentRef = useRef(content)
  const containerRef = useRef<HTMLDivElement>(null)
  const splitCacheRef = useRef<MarkdownBlockSplit | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const animationWindowRef = useRef<Window | null>(null)
  const lastFrameTimeRef = useRef<number | null>(null)
  const revealRateRef = useRef<number | null>(null)
  const drainingRef = useRef(draining)
  drainingRef.current = draining
  const onDrainedRef = useRef(onDrained)
  onDrainedRef.current = onDrained
  const followLiveEdgeRef = useRef(followLiveEdge)
  followLiveEdgeRef.current = followLiveEdge

  const cancelRevealAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) {
      ;(
        animationWindowRef.current ?? getNodeWindow(containerRef.current)
      ).cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    animationWindowRef.current = null
    lastFrameTimeRef.current = null
    revealRateRef.current = null
  }, [])

  const scheduleRevealAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) {
      return
    }
    const ownerWindow = getNodeWindow(containerRef.current)
    animationWindowRef.current = ownerWindow

    const finish = () => {
      animationFrameRef.current = null
      animationWindowRef.current = null
      lastFrameTimeRef.current = null
      revealRateRef.current = null
      if (drainingRef.current) {
        onDrainedRef.current?.()
      }
    }

    const tick = (timestamp: number) => {
      // rAF still fires every display frame; only every second or third one
      // does any work. Skipped frames cost a callback and nothing else.
      const sinceLastFrame =
        lastFrameTimeRef.current === null
          ? null
          : timestamp - lastFrameTimeRef.current
      if (
        sinceLastFrame !== null &&
        sinceLastFrame < REVEAL_FRAME_INTERVAL_MS - REVEAL_FRAME_TOLERANCE_MS
      ) {
        animationFrameRef.current = ownerWindow.requestAnimationFrame(tick)
        return
      }
      lastFrameTimeRef.current = timestamp

      const target = targetContentRef.current
      const current = displayedContentRef.current
      const backlog = target.length - current.length

      // 缓冲放空即收工：可见内容已经等于目标，没有还在结算的尾巴。
      if (backlog <= 0) {
        finish()
        return
      }

      // Measured between played-out frames, not display frames, so the rate
      // math is unaffected by how many rAF callbacks were skipped.
      const elapsedMs =
        sinceLastFrame === null
          ? REVEAL_FRAME_INTERVAL_MS
          : Math.min(96, sinceLastFrame)

      let charsPerSecond: number
      if (drainingRef.current) {
        // No smoothing and no ceiling: the reserve has to be gone quickly, and
        // its size is bounded by whatever was still buffered when the stream
        // ended.
        charsPerSecond = Math.max(
          DRAIN_MIN_CHARS_PER_SECOND,
          (backlog * 1000) / DRAIN_TARGET_LATENCY_MS,
        )
        revealRateRef.current = null
      } else {
        const targetRate = Math.min(
          REVEAL_MAX_CHARS_PER_SECOND,
          Math.max(
            REVEAL_MIN_CHARS_PER_SECOND,
            (backlog * 1000) / REVEAL_TARGET_LATENCY_MS,
          ),
        )
        const previousRate = revealRateRef.current
        const smoothing =
          1 - Math.exp(-elapsedMs / REVEAL_RATE_SMOOTHING_TAU_MS)
        charsPerSecond =
          previousRate === null
            ? targetRate
            : previousRate + (targetRate - previousRate) * smoothing
        revealRateRef.current = charsPerSecond
      }

      const maxStep = Math.max(
        1,
        Math.floor((charsPerSecond * elapsedMs) / 1000),
      )
      const nextRevealIndex = getNextRevealIndex(current, target, maxStep)
      const nextContent = target.slice(0, nextRevealIndex)

      if (nextContent !== current) {
        displayedContentRef.current = nextContent
        setDisplayedContent(nextContent)
        // 可见内容变长了才通知跟随。回调引用稳定，不参与依赖。
        followLiveEdgeRef.current()
      }

      // The loop runs on even when this frame caught up with the target: the
      // characters it just revealed only enter the fade window when the render
      // that follows commits, so it is the branch above — one frame later —
      // that gets to decide whether anything is still settling.
      animationFrameRef.current = ownerWindow.requestAnimationFrame(tick)
    }

    animationFrameRef.current = ownerWindow.requestAnimationFrame(tick)
  }, [])

  const revealImmediately = useCallback(
    (nextContent: string) => {
      cancelRevealAnimation()
      displayedContentRef.current = nextContent
      targetContentRef.current = nextContent
      setDisplayedContent(nextContent)
      // 减少动效 / 重写路径同样是"可见内容变了"，跟随通知不能只挂在播放循环上。
      followLiveEdgeRef.current()
      if (drainingRef.current) {
        onDrainedRef.current?.()
      }
    },
    [cancelRevealAnimation],
  )

  const applyTargetContent = useCallback(
    (nextTarget: string) => {
      if (
        !animateIncrementalText ||
        prefersReducedMotion(containerRef.current)
      ) {
        revealImmediately(nextTarget)
        return
      }

      // A rewrite (retry, edit, citation rewrite) breaks the prefix relationship
      // the buffer depends on, so there is nothing meaningful left to play out.
      // The loop still gets scheduled: whatever the fade window was holding needs
      // a frame to settle on, and no other content change is coming to give it one.
      const currentDisplayed = displayedContentRef.current
      if (
        nextTarget.length < currentDisplayed.length ||
        !nextTarget.startsWith(currentDisplayed)
      ) {
        revealImmediately(nextTarget)
        scheduleRevealAnimation()
        return
      }

      targetContentRef.current = nextTarget
      scheduleRevealAnimation()
    },
    [animateIncrementalText, revealImmediately, scheduleRevealAnimation],
  )

  useEffect(() => {
    if (!contentSource) {
      applyTargetContent(content)
      return
    }

    // 命令式源：这里读到的就是最新值，所以 render → effect 之间不存在丢更新
    // 窗口；订阅回调只改写目标，可见帧仍然由上面的 rAF 播放循环决定。
    applyTargetContent(contentSource.getContent())
    return contentSource.subscribe(() => {
      applyTargetContent(contentSource.getContent())
    })
  }, [applyTargetContent, content, contentSource, draining])

  useEffect(() => {
    return () => {
      cancelRevealAnimation()
    }
  }, [cancelRevealAnimation])

  // Normalization runs over the whole document before the split, not per
  // block: it is a line scanner that carries display-math and code-fence state
  // across lines, and it rewrites the source, which would invalidate the block
  // offsets if it ran afterwards. Splitting the already-normalized text also
  // guarantees each block is exactly the text a single renderer saw before.
  const blocks = useMemo(() => {
    const normalized = normalizeDisplayMathDelimiters(displayedContent)
    const split = splitMarkdownBlocks(normalized, splitCacheRef.current)
    splitCacheRef.current = split
    return split.blocks
  }, [displayedContent])

  return (
    <div
      ref={containerRef}
      className={`markdown-rendered yolo-markdown-rendered yolo-streaming-markdown yolo-scale-${scale}`}
    >
      <CitationSourcesContext.Provider value={citationSources}>
        {blocks.map((block, index) => (
          // Index keys are deliberate: keying on the content would unmount and
          // remount the trailing block on every streamed character, which
          // flickers and drops rendered math. Memoization on `content` is what
          // decides whether a block re-renders.
          <MarkdownBlock key={index} content={block} />
        ))}
      </CitationSourcesContext.Provider>
    </div>
  )
})

export default StreamingMarkdown
