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
import { MOTION_DURATION_FEEDBACK_S } from '../../styles/tokens/motion'
import { getNodeWindow } from '../../utils/dom/window-context'
import { openMarkdownFile, openPdfFileAtPage } from '../../utils/obsidian'

import { useLiveEdgeFollow } from './live-edge-follow-context'
import { type MarkdownBlockSplit, splitMarkdownBlocks } from './streamingBlocks'
import {
  normalizeDisplayMathDelimiters,
  preserveUnclosedMathSource,
  renderStreamingMath,
} from './streamingMath'
import {
  type RevealPhase,
  type RevealSegment,
  createStreamingRevealPlugin,
} from './streamingReveal'
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

// 播出帧决定字符多久释放一批。一帧最贵的开销是尾块重解析，它与释放频率同步
// 增长，所以播出压在 30fps。30Hz 硬弹出的阶跃感（字一蹦一蹦）不靠提高播出帧率
// 解决，而由显影尾巴交给浏览器在显示帧上抹平——见 streamingReveal.ts。
const REVEAL_FRAME_INTERVAL_MS = 1000 / 30

// A played-out frame reveals at most REVEAL_MAX_CHARS_PER_SECOND / 30 ≈ 40
// characters; this leaves room for dropped frames while still catching the bulk
// jumps that should not animate at all.
const MAX_REVEAL_CHARS = 120

// How long a character stays inside the fade window. Uses the micro-feedback
// duration — long enough to bridge the ~33ms playout steps, short enough that
// the trail never reads as an effect. The CSS side animates with
// --yolo-anim-duration-feedback; the two must stay in sync or the window would
// be pruned mid-fade.
const REVEAL_FADE_MS = MOTION_DURATION_FEEDBACK_S * 1000

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

/** One frame's worth of streamed characters, and when they arrived. */
type RevealEntry = { from: number; time: number }

type RevealState = {
  blockIndex: number
  length: number
  entries: RevealEntry[]
  /** 播出帧奇偶。span 的动画名随它交替以强制重启——见 streamingReveal.ts。 */
  phase: RevealPhase
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
 *
 * `segments` describes the fade window in this block's own source: the
 * characters past `segments[0].from` are still settling and fade in phased by
 * their age. It is only passed to the trailing block, so a block that the
 * stream has moved past re-renders once without it and sheds its spans.
 */
const MarkdownBlock = memo(function MarkdownBlock({
  content,
  segments,
  revealPhase = 0,
}: {
  content: string
  segments?: RevealSegment[]
  revealPhase?: RevealPhase
}) {
  const rehypePlugins = useMemo(
    () =>
      segments
        ? [createStreamingRevealPlugin(segments, revealPhase)]
        : undefined,
    [segments, revealPhase],
  )

  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={rehypePlugins}
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
  // Bumped once, one fade window after the buffer empties, so the tail
  // re-renders with the expired window pruned and sheds its spans.
  const [, setRevealClock] = useState(0)
  const displayedContentRef = useRef(content)
  const targetContentRef = useRef(content)
  const containerRef = useRef<HTMLDivElement>(null)
  const splitCacheRef = useRef<MarkdownBlockSplit | null>(null)
  const revealStateRef = useRef<RevealState>({
    blockIndex: -1,
    length: 0,
    entries: [],
    phase: 0,
  })
  const settleTimerRef = useRef<number | null>(null)
  const settleWindowRef = useRef<Window | null>(null)
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

  const cancelSettleTimer = useCallback(() => {
    if (settleTimerRef.current !== null) {
      ;(
        settleWindowRef.current ?? getNodeWindow(containerRef.current)
      ).clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
    settleWindowRef.current = null
  }, [])

  // 缓冲放空不等于结算完成：尾窗里的字符还要靠 CSS 动画自己走完淡入，这里只欠
  // 一次延后的重渲染，把过期的窗口剪掉、让尾块蜕掉 span。流在窗口走完前恢复的
  // 话，这次重渲染与正常播出帧重合，无额外成本。
  const scheduleSettleRender = useCallback((ownerWindow: Window) => {
    if (settleTimerRef.current !== null) {
      return
    }
    settleWindowRef.current = ownerWindow
    settleTimerRef.current = ownerWindow.setTimeout(() => {
      settleTimerRef.current = null
      settleWindowRef.current = null
      setRevealClock((clock) => clock + 1)
    }, REVEAL_FADE_MS)
  }, [])

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
      if (revealStateRef.current.entries.length > 0) {
        scheduleSettleRender(ownerWindow)
      }
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
  }, [scheduleSettleRender])

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
      cancelSettleTimer()
    }
  }, [cancelRevealAnimation, cancelSettleTimer])

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

  // The fade window, rebuilt every frame. Each entry is a frame's worth of
  // characters and the moment they arrived; entries older than REVEAL_FADE_MS
  // have settled and drop out, which is what bounds the number of wrapped
  // nodes. Where the trailing block stood on the previous frame is carried in
  // the same ref, and both are written in an effect rather than during render
  // because StrictMode renders twice and would record the same chunk twice.
  const trailingBlockIndex = blocks.length - 1
  const trailingBlockLength = blocks[trailingBlockIndex]?.length ?? 0
  const revealState = revealStateRef.current
  const sameBlock = revealState.blockIndex === trailingBlockIndex
  const previousTrailingLength = sameBlock ? revealState.length : 0
  const now = Date.now()

  // A jump far larger than a frame's worth of characters is not the stream
  // writing — it is reduced motion, a refocus catch-up, or a rewrite dropping
  // the whole answer in at once. Wrapping thousands of characters for a reveal
  // nobody asked for is exactly the cost the block split just removed, so those
  // frames render plain and the tail they land on settles with them.
  const revealing =
    animateIncrementalText &&
    trailingBlockLength - previousTrailingLength <= MAX_REVEAL_CHARS &&
    !prefersReducedMotion(containerRef.current)

  const revealEntries: RevealEntry[] = revealing
    ? [
        ...(sameBlock ? revealState.entries : []).filter(
          (entry) => now - entry.time < REVEAL_FADE_MS,
        ),
        ...(trailingBlockLength > previousTrailingLength
          ? [{ from: previousTrailingLength, time: now }]
          : []),
      ]
    : []

  const revealSegments: RevealSegment[] | undefined =
    revealEntries.length > 0
      ? revealEntries.map((entry) => ({
          from: entry.from,
          ageMs: now - entry.time,
        }))
      : undefined

  // 只要这一帧有 span，动画名奇偶就必须翻转：react-markdown 复用的 DOM 节点在
  // 这一帧对应的往往已是另一段，只有重启动画，负 delay 才会重新对相。
  const revealPhase: RevealPhase =
    revealSegments !== undefined
      ? revealState.phase === 0
        ? 1
        : 0
      : revealState.phase

  useEffect(() => {
    revealStateRef.current = {
      blockIndex: trailingBlockIndex,
      length: trailingBlockLength,
      entries: revealEntries,
      phase: revealPhase,
    }
  })

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
          <MarkdownBlock
            key={index}
            content={block}
            segments={index === trailingBlockIndex ? revealSegments : undefined}
            revealPhase={index === trailingBlockIndex ? revealPhase : 0}
          />
        ))}
      </CitationSourcesContext.Provider>
    </div>
  )
})

export default StreamingMarkdown
