import { Component, MarkdownRenderer } from 'obsidian'
import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import type { ApplyViewState } from '../../types/apply-view.types'
import {
  DiffBlock,
  InlineDiffLine,
  InlineDiffToken,
  createDiffBlocks,
} from '../../utils/chat/diff'

// Decision type for each diff block
type BlockDecision = 'pending' | 'incoming' | 'current'

export type ApplyViewActions = {
  goToPreviousDiff: () => void
  goToNextDiff: () => void
  acceptIncomingActive: () => void
  acceptCurrentActive: () => void
  undoActive: () => void
  close: () => void
}

export default function ApplyViewRoot({
  state,
  close,
  onActionsReady,
  useRootId = true,
  showHeader = true,
}: {
  state: ApplyViewState
  close: () => void
  onActionsReady?: (actions: ApplyViewActions | null) => void
  useRootId?: boolean
  showHeader?: boolean
}) {
  const [currentDiffIndex, setCurrentDiffIndex] = useState(0)
  const diffBlockRefs = useRef<(HTMLDivElement | null)[]>([])
  const scrollerRef = useRef<HTMLDivElement>(null)
  const applyChangesRef = useRef<() => Promise<void>>(() => Promise.resolve())
  const diffOffsetsRef = useRef<number[]>([])
  const suppressScrollRef = useRef(false)
  const suppressRafRef = useRef<number | null>(null)
  const scrollRafRef = useRef<number | null>(null)
  const manualNavLockRef = useRef(false)

  const app = useApp()
  const plugin = usePlugin()
  const { t } = useLanguage()

  const diff = useMemo(
    () =>
      splitDiffBlocksByLine(
        createDiffBlocks(state.originalContent, state.newContent),
      ),
    [state.newContent, state.originalContent],
  )

  // Track decisions for each modified block
  const [decisions, setDecisions] = useState<Map<number, BlockDecision>>(
    () => new Map(),
  )

  const modifiedBlockIndices = useMemo(
    () =>
      diff.reduce<number[]>((acc, block, index) => {
        if (block.type !== 'unchanged') {
          acc.push(index)
        }
        return acc
      }, []),
    [diff],
  )

  const activeBlockIndex =
    modifiedBlockIndices[currentDiffIndex] ?? Number.POSITIVE_INFINITY
  const autoCloseRef = useRef(false)

  // Count of decided and pending blocks

  // Generate final content based on decisions
  const generateFinalContent = useCallback(
    (defaultDecision: 'incoming' | 'current' = 'current') => {
      return diff
        .map((block, index) => {
          if (block.type === 'unchanged') return block.value
          const original = block.originalValue
          const incoming = block.modifiedValue
          const decision = decisions.get(index) ?? defaultDecision
          const resolveIncoming = () =>
            incoming !== undefined ? incoming : (original ?? '')
          const resolveCurrent = () => original ?? ''

          switch (decision) {
            case 'incoming':
              return resolveIncoming()
            case 'current':
            case 'pending':
              return decision === 'pending' && defaultDecision === 'incoming'
                ? resolveIncoming()
                : resolveCurrent()
            default:
              return resolveCurrent()
          }
        })
        .join('\n')
    },
    [diff, decisions],
  )

  const applyChanges = useCallback(async () => {
    const newContent = generateFinalContent('current')
    await app.vault.modify(state.file, newContent)
  }, [app.vault, generateFinalContent, state.file])

  // Individual block decisions (don't close, just mark decision)
  const makeDecision = useCallback((index: number, decision: BlockDecision) => {
    setDecisions((prev) => {
      const next = new Map(prev)
      next.set(index, decision)
      return next
    })
  }, [])

  const acceptIncomingBlock = useCallback(
    (index: number) => {
      makeDecision(index, 'incoming')
    },
    [makeDecision],
  )

  const acceptCurrentBlock = useCallback(
    (index: number) => {
      makeDecision(index, 'current')
    },
    [makeDecision],
  )

  // Undo a decision
  const undoDecision = useCallback((index: number) => {
    setDecisions((prev) => {
      const next = new Map(prev)
      next.delete(index)
      return next
    })
  }, [])

  // Global actions
  const acceptAllIncoming = useCallback(() => {
    const newDecisions = new Map<number, BlockDecision>()
    modifiedBlockIndices.forEach((idx) => {
      newDecisions.set(idx, 'incoming')
    })
    setDecisions(newDecisions)
  }, [modifiedBlockIndices])

  const acceptAllCurrent = useCallback(() => {
    const newDecisions = new Map<number, BlockDecision>()
    modifiedBlockIndices.forEach((idx) => {
      newDecisions.set(idx, 'current')
    })
    setDecisions(newDecisions)
  }, [modifiedBlockIndices])

  useEffect(() => {
    applyChangesRef.current = applyChanges
  }, [applyChanges])

  useEffect(() => {
    if (autoCloseRef.current) return
    if (modifiedBlockIndices.length === 0) return
    const allDecided = modifiedBlockIndices.every((idx) => {
      const decision = decisions.get(idx)
      return decision && decision !== 'pending'
    })
    if (!allDecided) return
    autoCloseRef.current = true
    close()
  }, [close, decisions, modifiedBlockIndices])

  useEffect(() => {
    return () => {
      void applyChangesRef.current()
    }
  }, [])

  const getOffsetTopFromScroller = useCallback(
    (element: HTMLElement, scroller: HTMLElement) => {
      let offset = 0
      let current: HTMLElement | null = element
      while (current && current !== scroller) {
        offset += current.offsetTop
        current = current.offsetParent as HTMLElement | null
      }
      if (current === scroller) {
        return offset
      }
      const scrollerRect = scroller.getBoundingClientRect()
      const rect = element.getBoundingClientRect()
      return scroller.scrollTop + (rect.top - scrollerRect.top)
    },
    [],
  )

  const updateDiffOffsets = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    let lastOffset = 0
    diffOffsetsRef.current = modifiedBlockIndices.map((blockIndex) => {
      const element = diffBlockRefs.current[blockIndex]
      if (!element) return lastOffset
      const offset = getOffsetTopFromScroller(element, scroller)
      lastOffset = offset
      return offset
    })
  }, [getOffsetTopFromScroller, modifiedBlockIndices])

  const findClosestDiffIndex = useCallback(
    (scrollTop: number, anchorOffset: number) => {
      const offsets = diffOffsetsRef.current
      if (offsets.length === 0) return 0
      const target = scrollTop + anchorOffset

      let left = 0
      let right = offsets.length - 1
      while (left < right) {
        const mid = Math.floor((left + right) / 2)
        if (offsets[mid] < target) {
          left = mid + 1
        } else {
          right = mid
        }
      }

      const nextIndex = left
      const prevIndex = Math.max(0, left - 1)
      const nextDistance = Math.abs(offsets[nextIndex] - target)
      const prevDistance = Math.abs(offsets[prevIndex] - target)
      return nextDistance < prevDistance ? nextIndex : prevIndex
    },
    [],
  )

  const updateCurrentDiffFromScroll = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    if (suppressScrollRef.current) return
    if (manualNavLockRef.current) return
    updateDiffOffsets()
    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight
    if (maxScrollTop <= 0) {
      setCurrentDiffIndex(0)
      return
    }
    const distanceToTop = scroller.scrollTop
    const distanceToBottom = maxScrollTop - scroller.scrollTop
    let anchorOffset = scroller.clientHeight / 2
    if (distanceToTop < anchorOffset) {
      anchorOffset = distanceToTop
    }
    if (distanceToBottom < anchorOffset) {
      anchorOffset = scroller.clientHeight - distanceToBottom
    }
    const nextIndex = findClosestDiffIndex(scroller.scrollTop, anchorOffset)
    setCurrentDiffIndex(nextIndex)
  }, [findClosestDiffIndex, updateDiffOffsets])

  const scrollToDiffIndex = useCallback(
    (index: number) => {
      const blockIndex = modifiedBlockIndices[index]
      if (blockIndex === undefined) return
      const element = diffBlockRefs.current[blockIndex]
      if (!element) return
      const scroller = scrollerRef.current
      if (!scroller) return
      manualNavLockRef.current = true
      const elementOffsetTop = getOffsetTopFromScroller(element, scroller)
      const targetTop =
        elementOffsetTop -
        (scroller.clientHeight / 2 - element.offsetHeight / 2)
      const maxScrollTop = scroller.scrollHeight - scroller.clientHeight
      const clampedTop = Math.max(0, Math.min(maxScrollTop, targetTop))
      if (suppressRafRef.current) {
        cancelAnimationFrame(suppressRafRef.current)
      }
      suppressScrollRef.current = true
      const start = performance.now()
      const releaseWhenSettled = () => {
        const currentScroller = scrollerRef.current
        if (!currentScroller) {
          suppressScrollRef.current = false
          suppressRafRef.current = null
          return
        }
        const diff = Math.abs(currentScroller.scrollTop - clampedTop)
        const elapsed = performance.now() - start
        if (diff < 1 || elapsed > 700) {
          suppressScrollRef.current = false
          suppressRafRef.current = null
          return
        }
        suppressRafRef.current = requestAnimationFrame(releaseWhenSettled)
      }
      suppressRafRef.current = requestAnimationFrame(releaseWhenSettled)
      scroller.scrollTo({ top: clampedTop, behavior: 'smooth' })
      setCurrentDiffIndex(index)
    },
    [getOffsetTopFromScroller, modifiedBlockIndices],
  )

  const goToPreviousDiff = useCallback(() => {
    if (modifiedBlockIndices.length === 0) return
    const nextIndex = Math.max(0, currentDiffIndex - 1)
    scrollToDiffIndex(nextIndex)
  }, [currentDiffIndex, modifiedBlockIndices.length, scrollToDiffIndex])

  const goToNextDiff = useCallback(() => {
    if (modifiedBlockIndices.length === 0) return
    const nextIndex = Math.min(
      modifiedBlockIndices.length - 1,
      currentDiffIndex + 1,
    )
    scrollToDiffIndex(nextIndex)
  }, [currentDiffIndex, modifiedBlockIndices.length, scrollToDiffIndex])

  const acceptIncomingActive = useCallback(() => {
    if (activeBlockIndex === Number.POSITIVE_INFINITY) return
    acceptIncomingBlock(activeBlockIndex)
  }, [acceptIncomingBlock, activeBlockIndex])

  const acceptCurrentActive = useCallback(() => {
    if (activeBlockIndex === Number.POSITIVE_INFINITY) return
    acceptCurrentBlock(activeBlockIndex)
  }, [acceptCurrentBlock, activeBlockIndex])

  const undoActive = useCallback(() => {
    if (activeBlockIndex === Number.POSITIVE_INFINITY) return
    undoDecision(activeBlockIndex)
  }, [activeBlockIndex, undoDecision])

  useEffect(() => {
    if (!onActionsReady) return
    onActionsReady({
      goToPreviousDiff,
      goToNextDiff,
      acceptIncomingActive,
      acceptCurrentActive,
      undoActive,
      close,
    })
    return () => onActionsReady(null)
  }, [
    acceptCurrentActive,
    acceptIncomingActive,
    close,
    goToNextDiff,
    goToPreviousDiff,
    onActionsReady,
    undoActive,
  ])

  useEffect(() => {
    if (modifiedBlockIndices.length === 0) {
      setCurrentDiffIndex(0)
      return
    }
    if (currentDiffIndex > modifiedBlockIndices.length - 1) {
      setCurrentDiffIndex(modifiedBlockIndices.length - 1)
    }
  }, [currentDiffIndex, modifiedBlockIndices.length])

  useEffect(() => {
    return () => {
      if (suppressRafRef.current) {
        cancelAnimationFrame(suppressRafRef.current)
      }
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    const updateAll = () => {
      updateDiffOffsets()
      updateCurrentDiffFromScroll()
    }

    const scheduleUpdate = () => {
      requestAnimationFrame(updateAll)
    }

    scheduleUpdate()
    window.addEventListener('resize', scheduleUpdate)
    return () => window.removeEventListener('resize', scheduleUpdate)
  }, [updateCurrentDiffFromScroll, updateDiffOffsets])

  useEffect(() => {
    const scheduleUpdate = () => {
      requestAnimationFrame(() => {
        updateDiffOffsets()
        updateCurrentDiffFromScroll()
      })
    }

    scheduleUpdate()
  }, [decisions, diff, updateCurrentDiffFromScroll, updateDiffOffsets])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    updateDiffOffsets()
    updateCurrentDiffFromScroll()

    const handleScroll = () => {
      if (scrollRafRef.current) return
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null
        updateCurrentDiffFromScroll()
      })
    }

    const handleUserScrollIntent = () => {
      if (!manualNavLockRef.current) return
      manualNavLockRef.current = false
      updateCurrentDiffFromScroll()
    }

    scroller.addEventListener('scroll', handleScroll)
    scroller.addEventListener('wheel', handleUserScrollIntent, {
      passive: true,
    })
    scroller.addEventListener('touchmove', handleUserScrollIntent, {
      passive: true,
    })
    scroller.addEventListener('pointerdown', handleUserScrollIntent)
    return () => {
      scroller.removeEventListener('scroll', handleScroll)
      scroller.removeEventListener('wheel', handleUserScrollIntent)
      scroller.removeEventListener('touchmove', handleUserScrollIntent)
      scroller.removeEventListener('pointerdown', handleUserScrollIntent)
    }
  }, [updateCurrentDiffFromScroll])

  return (
    <div
      id={useRootId ? 'smtcmp-apply-view' : undefined}
      className="smtcmp-apply-view-root"
    >
      {showHeader && (
        <div className="view-header">
          <div className="view-header-title-container mod-at-start">
            <div className="view-header-title">
              {t('applyView.applying', 'Applying')}: {state?.file?.name ?? ''}
            </div>
          </div>
        </div>
      )}

      <div className="view-content">
        <div className="markdown-source-view cm-s-obsidian mod-cm6 node-insert-event is-readable-line-width is-live-preview is-folding show-properties">
          <div className="cm-editor">
            <div className="cm-scroller" ref={scrollerRef}>
              <div className="cm-sizer">
                <div className="smtcmp-apply-content">
                  <div className="inline-title smtcmp-inline-title">
                    {state?.file?.name
                      ? state.file.name.replace(/\.[^/.]+$/, '')
                      : ''}
                  </div>

                  {diff.map((block, index) => (
                    <DiffBlockView
                      key={index}
                      block={block}
                      decision={decisions.get(index)}
                      isActive={index === activeBlockIndex}
                      sourcePath={state.file.path}
                      onAcceptIncoming={() => acceptIncomingBlock(index)}
                      onAcceptCurrent={() => acceptCurrentBlock(index)}
                      onUndo={() => undoDecision(index)}
                      t={t}
                      pluginComponent={plugin}
                      ref={(el) => {
                        diffBlockRefs.current[index] = el
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Global actions toolbar (bottom) */}
      <div className="smtcmp-apply-toolbar smtcmp-apply-toolbar-bottom">
        <div className="smtcmp-apply-toolbar-pill" role="group">
          <div className="smtcmp-apply-toolbar-nav">
            <button
              onClick={goToPreviousDiff}
              className="smtcmp-toolbar-icon-btn"
              title={t('applyView.prevChange', 'Previous change')}
              aria-label={t('applyView.prevChange', 'Previous change')}
              disabled={
                modifiedBlockIndices.length === 0 || currentDiffIndex === 0
              }
            >
              <span className="smtcmp-toolbar-icon">↑</span>
            </button>
            <span className="smtcmp-apply-progress">
              {modifiedBlockIndices.length === 0
                ? '0/0'
                : `${currentDiffIndex + 1}/${modifiedBlockIndices.length}`}
            </span>
            <button
              onClick={goToNextDiff}
              className="smtcmp-toolbar-icon-btn"
              title={t('applyView.nextChange', 'Next change')}
              aria-label={t('applyView.nextChange', 'Next change')}
              disabled={
                modifiedBlockIndices.length === 0 ||
                currentDiffIndex >= modifiedBlockIndices.length - 1
              }
            >
              <span className="smtcmp-toolbar-icon">↓</span>
            </button>
          </div>
          <div className="smtcmp-apply-toolbar-actions">
            <button
              onClick={acceptAllIncoming}
              className="smtcmp-toolbar-btn smtcmp-accept"
              title={t(
                'applyView.acceptAllIncoming',
                'Accept all incoming changes',
              )}
              disabled={modifiedBlockIndices.length === 0}
            >
              {t('applyView.acceptAllIncoming', 'Accept All Incoming')}
            </button>
            <button
              onClick={acceptAllCurrent}
              className="smtcmp-toolbar-btn smtcmp-exclude"
              title={t(
                'applyView.rejectAll',
                'Reject all changes (keep original)',
              )}
              disabled={modifiedBlockIndices.length === 0}
            >
              {t('applyView.rejectAll', 'Reject All')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const DiffBlockView = forwardRef<
  HTMLDivElement,
  {
    block: DiffBlock
    decision?: BlockDecision
    isActive: boolean
    sourcePath: string
    onAcceptIncoming: () => void
    onAcceptCurrent: () => void
    onUndo: () => void
    t: (keyPath: string, fallback?: string) => string
    pluginComponent: Component
  }
>(
  (
    {
      block: part,
      decision,
      isActive,
      sourcePath,
      onAcceptIncoming,
      onAcceptCurrent,

      onUndo: _onUndo,
      t,
      pluginComponent,
    },
    ref,
  ) => {
    const inlineLines = part.type === 'modified' ? part.inlineLines : undefined
    const modifiedValue =
      part.type === 'modified' ? part.modifiedValue : undefined
    const originalValue =
      part.type === 'modified' ? part.originalValue : undefined
    const inlineMarkdown = useMemo(() => {
      if (part.type !== 'modified') return ''
      const markdown = buildInlineDiffMarkdown(inlineLines ?? [])
      if (markdown.trim().length > 0) return markdown
      return modifiedValue ?? originalValue ?? ''
    }, [inlineLines, modifiedValue, originalValue, part.type])
    const inlineParagraphs = useMemo<ApplyParagraph[]>(() => {
      if (part.type !== 'modified') return []
      return splitInlineLinesIntoParagraphs(inlineLines ?? [])
    }, [inlineLines, part.type])

    if (part.type === 'unchanged') {
      return (
        <div className="smtcmp-diff-block">
          <div className="smtcmp-diff-block-content">
            <ApplyMarkdownContent
              content={part.value}
              component={pluginComponent}
              sourcePath={sourcePath}
              className="smtcmp-apply-markdown"
            />
          </div>
        </div>
      )
    } else if (part.type === 'modified') {
      const isDecided = decision && decision !== 'pending'

      // Show preview of the decision result
      const getDecisionPreview = () => {
        if (!isDecided) return null
        const original = part.originalValue
        const incoming = part.modifiedValue
        const resolveIncoming = () =>
          incoming !== undefined ? incoming : (original ?? '')
        const resolveCurrent = () => original ?? ''

        switch (decision) {
          case 'incoming':
            return resolveIncoming()
          case 'current':
            return resolveCurrent()
          default:
            return null
        }
      }

      return (
        <div
          className={`smtcmp-diff-block-container${isActive ? ' is-active' : ''}`}
          ref={ref}
        >
          {isDecided ? (
            // Show resolved content only
            <>
              <div className="smtcmp-diff-block smtcmp-diff-block--resolved">
                <div className="smtcmp-diff-block-content">
                  <ApplyMarkdownContent
                    content={getDecisionPreview() ?? ''}
                    component={pluginComponent}
                    sourcePath={sourcePath}
                    className="smtcmp-apply-markdown smtcmp-apply-markdown-preview"
                  />
                </div>
              </div>
            </>
          ) : (
            // Show original diff view with actions
            <>
              <div className="smtcmp-diff-block smtcmp-diff-block--inline">
                {inlineParagraphs.length > 0 ? (
                  inlineParagraphs.map((paragraph, paragraphIndex) => {
                    const paragraphContent = paragraph.isEmpty
                      ? ''
                      : buildInlineDiffMarkdown(paragraph.lines)
                    return (
                      <div
                        key={`${paragraphIndex}-${paragraph.isEmpty ? 'empty' : 'content'}`}
                        className={`smtcmp-apply-paragraph${
                          paragraph.isEmpty ? ' is-empty' : ''
                        }${paragraph.hasChanges ? ' has-changes' : ''}${
                          isActive ? ' is-active' : ''
                        }`}
                      >
                        <div className="smtcmp-diff-block-content">
                          {paragraph.isEmpty ? (
                            <div className="smtcmp-apply-empty-line" />
                          ) : (
                            <ApplyMarkdownContent
                              content={paragraphContent}
                              component={pluginComponent}
                              sourcePath={sourcePath}
                              className="smtcmp-apply-markdown smtcmp-apply-inline-markdown"
                            />
                          )}
                        </div>
                        {paragraph.hasChanges && (
                          <span className="smtcmp-apply-paragraph-indicator" />
                        )}
                        {paragraph.hasChanges && (
                          <div className="smtcmp-diff-block-actions">
                            <button
                              onClick={onAcceptIncoming}
                              className="smtcmp-apply-action smtcmp-apply-action-accept"
                              title={t(
                                'applyView.acceptIncoming',
                                'Accept incoming',
                              )}
                              aria-label={t(
                                'applyView.acceptIncoming',
                                'Accept incoming',
                              )}
                            >
                              <span
                                className="smtcmp-apply-action-icon"
                                aria-hidden="true"
                              >
                                ✓
                              </span>
                            </button>
                            <button
                              onClick={onAcceptCurrent}
                              className="smtcmp-apply-action smtcmp-apply-action-reject"
                              title={t(
                                'applyView.acceptCurrent',
                                'Accept current',
                              )}
                              aria-label={t(
                                'applyView.acceptCurrent',
                                'Accept current',
                              )}
                            >
                              <span
                                className="smtcmp-apply-action-icon"
                                aria-hidden="true"
                              >
                                ×
                              </span>
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })
                ) : (
                  <div
                    className={`smtcmp-apply-paragraph has-changes${
                      isActive ? ' is-active' : ''
                    }`}
                  >
                    <div className="smtcmp-diff-block-content">
                      <ApplyMarkdownContent
                        content={inlineMarkdown}
                        component={pluginComponent}
                        sourcePath={sourcePath}
                        className="smtcmp-apply-markdown smtcmp-apply-inline-markdown"
                      />
                    </div>
                    <span className="smtcmp-apply-paragraph-indicator" />
                    <div className="smtcmp-diff-block-actions">
                      <button
                        onClick={onAcceptIncoming}
                        className="smtcmp-apply-action smtcmp-apply-action-accept"
                        title={t('applyView.acceptIncoming', 'Accept incoming')}
                        aria-label={t(
                          'applyView.acceptIncoming',
                          'Accept incoming',
                        )}
                      >
                        <span
                          className="smtcmp-apply-action-icon"
                          aria-hidden="true"
                        >
                          ✓
                        </span>
                      </button>
                      <button
                        onClick={onAcceptCurrent}
                        className="smtcmp-apply-action smtcmp-apply-action-reject"
                        title={t('applyView.acceptCurrent', 'Accept current')}
                        aria-label={t(
                          'applyView.acceptCurrent',
                          'Accept current',
                        )}
                      >
                        <span
                          className="smtcmp-apply-action-icon"
                          aria-hidden="true"
                        >
                          ×
                        </span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )
    }
  },
)

DiffBlockView.displayName = 'DiffBlockView'

function ApplyMarkdownContent({
  content,
  component,
  sourcePath,
  className,
}: {
  content: string
  component: Component
  sourcePath: string
  className?: string
}) {
  const app = useApp()
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return
    containerRef.current.replaceChildren()
    void MarkdownRenderer.render(
      app,
      content,
      containerRef.current,
      sourcePath,
      component,
    )
  }, [app, component, content, sourcePath])

  return (
    <div
      ref={containerRef}
      className={`markdown-rendered smtcmp-markdown-rendered ${className ?? ''}`}
    />
  )
}

type ApplyParagraph = {
  lines: InlineDiffLine[]
  hasChanges: boolean
  isEmpty: boolean
}

function splitInlineLinesIntoParagraphs(
  lines: InlineDiffLine[],
): ApplyParagraph[] {
  if (lines.length === 0) return []

  const paragraphs: ApplyParagraph[] = lines.map((line) => {
    const isEmpty = isInlineLineEmpty(line)
    return {
      lines: isEmpty ? [] : [line],
      hasChanges: lineHasChanges(line),
      isEmpty,
    }
  })
  const hasAnyChanges = paragraphs.some(
    (paragraph) => !paragraph.isEmpty && paragraph.hasChanges,
  )
  if (!hasAnyChanges) {
    const firstContentParagraph = paragraphs.find(
      (paragraph) => !paragraph.isEmpty,
    )
    if (firstContentParagraph) {
      firstContentParagraph.hasChanges = true
    }
  }
  return paragraphs
}

function isInlineLineEmpty(line: InlineDiffLine): boolean {
  const content = line.tokens.map((token) => token.text).join('')
  return content.trim().length === 0
}

function lineHasChanges(line: InlineDiffLine): boolean {
  if (line.type === 'added' || line.type === 'removed') return true
  return line.tokens.some(
    (token) => token.type === 'add' || token.type === 'del',
  )
}

function splitDiffBlocksByLine(blocks: DiffBlock[]): DiffBlock[] {
  const lineBlocks: DiffBlock[] = []

  blocks.forEach((block) => {
    if (block.type === 'unchanged') {
      lineBlocks.push(block)
      return
    }

    if (block.inlineLines.length === 0) {
      lineBlocks.push(block)
      return
    }

    block.inlineLines.forEach((line) => {
      if (line.type === 'unchanged') {
        lineBlocks.push({
          type: 'unchanged',
          value: inlineLineToText(line, 'original'),
        })
        return
      }

      const originalLine =
        line.type === 'added' ? undefined : inlineLineToText(line, 'original')
      const modifiedLine =
        line.type === 'removed' ? undefined : inlineLineToText(line, 'modified')

      const isBlankLineChange =
        (originalLine === undefined || originalLine.trim().length === 0) &&
        (modifiedLine === undefined || modifiedLine.trim().length === 0)
      if (isBlankLineChange) {
        return
      }

      lineBlocks.push({
        type: 'modified',
        originalValue: originalLine,
        modifiedValue: modifiedLine,
        inlineLines: [line],
      })
    })
  })

  return mergeAdjacentUnchangedBlocks(lineBlocks)
}

function mergeAdjacentUnchangedBlocks(blocks: DiffBlock[]): DiffBlock[] {
  const merged: DiffBlock[] = []
  blocks.forEach((block) => {
    const last = merged[merged.length - 1]
    if (block.type === 'unchanged' && last?.type === 'unchanged') {
      last.value = `${last.value}\n${block.value}`
      return
    }
    merged.push(block)
  })
  return merged
}

function inlineLineToText(
  line: InlineDiffLine,
  variant: 'original' | 'modified',
): string {
  return inlineTokensToText(line.tokens, variant)
}

function inlineTokensToText(
  tokens: InlineDiffToken[],
  variant: 'original' | 'modified',
): string {
  return tokens
    .filter((token) =>
      variant === 'original' ? token.type !== 'add' : token.type !== 'del',
    )
    .map((token) => token.text)
    .join('')
}

function buildInlineDiffMarkdown(lines: InlineDiffLine[]): string {
  return lines.map((line) => inlineTokensToMarkdown(line.tokens)).join('\n')
}

function inlineTokensToMarkdown(tokens: InlineDiffToken[]): string {
  return tokens
    .map((token) => {
      const text = escapeHtml(token.text)
      if (token.type === 'add') {
        return `<span class="smtcmp-inline-diff smtcmp-inline-diff-add">${text}</span>`
      }
      if (token.type === 'del') {
        return `<span class="smtcmp-inline-diff smtcmp-inline-diff-del">${text}</span>`
      }
      return text
    })
    .join('')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
