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
  createLineDiffBlocks,
} from '../../utils/chat/diff'
import type { ApplyViewActions } from './types'

// Decision type for each diff block
type BlockDecision = 'pending' | 'incoming' | 'current'

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
  const diffOffsetsRef = useRef<number[]>([])
  const suppressScrollRef = useRef(false)
  const suppressRafRef = useRef<number | null>(null)
  const scrollRafRef = useRef<number | null>(null)
  const manualNavLockRef = useRef(false)
  const initialViewportAppliedRef = useRef(false)
  const persistInFlightRef = useRef(false)
  const persistOnUnmountRef = useRef(true)
  const preferredFinalContentRef = useRef<string | null>(null)

  const app = useApp()
  const plugin = usePlugin()
  const { t } = useLanguage()

  const isSelectionFocusMode = state.reviewMode === 'selection-focus'
  const diff = useMemo(
    () =>
      splitDiffBlocksByParagraph(
        createLineDiffBlocks(state.originalContent, state.newContent),
      ),
    [state.newContent, state.originalContent],
  )
  const selectionTargetBlockIndex = useMemo(
    () =>
      isSelectionFocusMode
        ? findSelectionTargetBlockIndex(diff, state.selectionRange)
        : null,
    [diff, isSelectionFocusMode, state.selectionRange],
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

  const persistAndClose = useCallback(
    async (finalContent?: string) => {
      if (persistInFlightRef.current) return
      persistInFlightRef.current = true
      if (finalContent !== undefined) {
        preferredFinalContentRef.current = finalContent
      }
      const contentToWrite = finalContent ?? generateFinalContent('current')
      try {
        await app.vault.modify(state.file, contentToWrite)

        persistOnUnmountRef.current = false
      } catch (error) {
        console.error(
          '[ApplyView] Failed to persist changes before close',
          error,
        )
      } finally {
        close()
      }
    },
    [app.vault, close, generateFinalContent, state.file],
  )

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
    autoCloseRef.current = true
    void persistAndClose(state.newContent)
  }, [persistAndClose, state.newContent])

  const acceptAllCurrent = useCallback(() => {
    autoCloseRef.current = true
    void persistAndClose(state.originalContent)
  }, [persistAndClose, state.originalContent])

  useEffect(() => {
    if (autoCloseRef.current) return
    if (modifiedBlockIndices.length === 0) return
    const allDecided = modifiedBlockIndices.every((idx) => {
      const decision = decisions.get(idx)
      return decision && decision !== 'pending'
    })
    if (!allDecided) return
    autoCloseRef.current = true
    void persistAndClose()
  }, [decisions, modifiedBlockIndices, persistAndClose])

  useEffect(() => {
    return () => {
      if (!persistOnUnmountRef.current) return
      const fallbackContent =
        preferredFinalContentRef.current ?? generateFinalContent('current')
      void app.vault.modify(state.file, fallbackContent).catch((error) => {
        console.error('[ApplyView] Failed to persist changes on unmount', error)
      })
    }
  }, [app.vault, generateFinalContent, state.file])

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
    if (isSelectionFocusMode) {
      acceptAllIncoming()
      return
    }
    if (activeBlockIndex === Number.POSITIVE_INFINITY) return
    acceptIncomingBlock(activeBlockIndex)
  }, [
    acceptAllIncoming,
    acceptIncomingBlock,
    activeBlockIndex,
    isSelectionFocusMode,
  ])

  const acceptCurrentActive = useCallback(() => {
    if (isSelectionFocusMode) {
      acceptAllCurrent()
      return
    }
    if (activeBlockIndex === Number.POSITIVE_INFINITY) return
    acceptCurrentBlock(activeBlockIndex)
  }, [
    acceptAllCurrent,
    acceptCurrentBlock,
    activeBlockIndex,
    isSelectionFocusMode,
  ])

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
      close: () => void persistAndClose(),
    })
    return () => onActionsReady(null)
  }, [
    acceptCurrentActive,
    acceptIncomingActive,
    goToNextDiff,
    goToPreviousDiff,
    onActionsReady,
    persistAndClose,
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
  }, [updateCurrentDiffFromScroll, updateDiffOffsets])

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
  }, [updateCurrentDiffFromScroll, updateDiffOffsets])

  useEffect(() => {
    if (initialViewportAppliedRef.current) return
    const scroller = scrollerRef.current
    const initialViewport = state.initialViewport
    if (!scroller || !initialViewport) return

    const applyInitialViewport = () => {
      const currentScroller = scrollerRef.current
      if (!currentScroller) return

      const maxScrollTop = Math.max(
        0,
        currentScroller.scrollHeight - currentScroller.clientHeight,
      )
      const topFromRatio = initialViewport.scrollRatio * maxScrollTop
      const topFromOriginal = initialViewport.scrollTop
      const mergedTop =
        maxScrollTop > 0
          ? clampNumber((topFromOriginal + topFromRatio) / 2, 0, maxScrollTop)
          : 0

      currentScroller.scrollTop = mergedTop
      currentScroller.scrollLeft = Math.max(0, initialViewport.scrollLeft)

      const anchorBlockIndex = findBlockIndexAtOriginalLine(
        diff,
        initialViewport.anchorLine,
      )
      if (anchorBlockIndex !== null) {
        const anchorElement = diffBlockRefs.current[anchorBlockIndex]
        if (anchorElement) {
          const anchorTop = getOffsetTopFromScroller(
            anchorElement,
            currentScroller,
          )
          if (
            Math.abs(anchorTop - mergedTop) >
            currentScroller.clientHeight * 1.4
          ) {
            currentScroller.scrollTop = clampNumber(anchorTop, 0, maxScrollTop)
          }
        }
      }

      initialViewportAppliedRef.current = true
      updateDiffOffsets()
      updateCurrentDiffFromScroll()
    }

    const raf1 = requestAnimationFrame(() => {
      requestAnimationFrame(applyInitialViewport)
    })

    return () => cancelAnimationFrame(raf1)
  }, [
    diff,
    getOffsetTopFromScroller,
    state.initialViewport,
    updateCurrentDiffFromScroll,
    updateDiffOffsets,
  ])

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
                      key={
                        block.type === 'unchanged'
                          ? `unchanged:${index}:${block.value}`
                          : `modified:${index}:${block.blockType}:${block.originalValue ?? ''}:${block.modifiedValue ?? ''}`
                      }
                      block={block}
                      decision={decisions.get(index)}
                      isActive={index === activeBlockIndex}
                      sourcePath={state.file.path}
                      onAcceptIncoming={() => acceptIncomingBlock(index)}
                      onAcceptCurrent={() => acceptCurrentBlock(index)}
                      onUndo={() => undoDecision(index)}
                      isSelectionFocusMode={isSelectionFocusMode}
                      isSelectionTarget={
                        isSelectionFocusMode &&
                        selectionTargetBlockIndex !== null &&
                        index === selectionTargetBlockIndex
                      }
                      onAcceptSelectionIncoming={acceptAllIncoming}
                      onAcceptSelectionCurrent={acceptAllCurrent}
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

      {!isSelectionFocusMode && (
        <div className="smtcmp-apply-toolbar smtcmp-apply-toolbar-bottom">
          <div className="smtcmp-apply-toolbar-pill">
            <div className="smtcmp-apply-toolbar-nav">
              <button
                type="button"
                onClick={goToPreviousDiff}
                className="smtcmp-toolbar-icon-btn"
                title={t('applyView.prevChange', 'Previous change')}
                aria-label={t('applyView.prevChange', 'Previous change')}
                disabled={modifiedBlockIndices.length === 0}
              >
                <span className="smtcmp-toolbar-icon">↑</span>
              </button>
              <span className="smtcmp-apply-progress">
                {modifiedBlockIndices.length === 0
                  ? '0/0'
                  : `${currentDiffIndex + 1}/${modifiedBlockIndices.length}`}
              </span>
              <button
                type="button"
                onClick={goToNextDiff}
                className="smtcmp-toolbar-icon-btn"
                title={t('applyView.nextChange', 'Next change')}
                aria-label={t('applyView.nextChange', 'Next change')}
                disabled={modifiedBlockIndices.length === 0}
              >
                <span className="smtcmp-toolbar-icon">↓</span>
              </button>
            </div>
            <div className="smtcmp-apply-toolbar-actions">
              <button
                type="button"
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
                type="button"
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
      )}
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
    isSelectionFocusMode: boolean
    isSelectionTarget: boolean
    onAcceptSelectionIncoming: () => void
    onAcceptSelectionCurrent: () => void
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
      isSelectionFocusMode,
      isSelectionTarget,
      onAcceptSelectionIncoming,
      onAcceptSelectionCurrent,
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
    const firstChangedParagraphIndex = useMemo(
      () => inlineParagraphs.findIndex((paragraph) => paragraph.hasChanges),
      [inlineParagraphs],
    )
    const actionParagraphIndex = useMemo(() => {
      if (firstChangedParagraphIndex >= 0) return firstChangedParagraphIndex
      if (!isSelectionFocusMode || !isSelectionTarget) return -1
      const firstNonEmptyParagraphIndex = inlineParagraphs.findIndex(
        (paragraph) => !paragraph.isEmpty,
      )
      if (firstNonEmptyParagraphIndex >= 0) return firstNonEmptyParagraphIndex
      return inlineParagraphs.length > 0 ? 0 : -1
    }, [
      firstChangedParagraphIndex,
      inlineParagraphs,
      isSelectionFocusMode,
      isSelectionTarget,
    ])

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
          className={`smtcmp-diff-block-container${isActive ? ' is-active' : ''}${
            isSelectionTarget ? ' is-selection-focus-target' : ''
          }`}
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
                    const showActionsForParagraph =
                      paragraphIndex === actionParagraphIndex &&
                      (!isSelectionFocusMode || isSelectionTarget) &&
                      (paragraph.hasChanges ||
                        (isSelectionFocusMode &&
                          firstChangedParagraphIndex < 0))
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
                        {showActionsForParagraph && (
                          <span className="smtcmp-apply-paragraph-indicator" />
                        )}
                        {showActionsForParagraph && (
                          <div className="smtcmp-diff-block-actions">
                            <button
                              type="button"
                              onClick={
                                isSelectionFocusMode
                                  ? onAcceptSelectionIncoming
                                  : onAcceptIncoming
                              }
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
                              type="button"
                              onClick={
                                isSelectionFocusMode
                                  ? onAcceptSelectionCurrent
                                  : onAcceptCurrent
                              }
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
                    {(!isSelectionFocusMode || isSelectionTarget) && (
                      <div className="smtcmp-diff-block-actions">
                        <button
                          type="button"
                          onClick={
                            isSelectionFocusMode
                              ? onAcceptSelectionIncoming
                              : onAcceptIncoming
                          }
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
                          type="button"
                          onClick={
                            isSelectionFocusMode
                              ? onAcceptSelectionCurrent
                              : onAcceptCurrent
                          }
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
                    )}
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

  const paragraphs: ApplyParagraph[] = []
  let currentLines: InlineDiffLine[] = []
  let currentHasChanges = false

  const pushCurrentParagraph = () => {
    if (currentLines.length === 0) return
    paragraphs.push({
      lines: currentLines,
      hasChanges: currentHasChanges,
      isEmpty: false,
    })
    currentLines = []
    currentHasChanges = false
  }

  lines.forEach((line) => {
    if (isInlineLineEmpty(line)) {
      pushCurrentParagraph()
      paragraphs.push({
        lines: [],
        hasChanges: false,
        isEmpty: true,
      })
      return
    }

    currentLines.push(line)
    currentHasChanges = currentHasChanges || lineHasChanges(line)
  })

  pushCurrentParagraph()

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

function splitDiffBlocksByParagraph(blocks: DiffBlock[]): DiffBlock[] {
  const paragraphBlocks: DiffBlock[] = []

  blocks.forEach((block) => {
    if (block.type === 'unchanged') {
      paragraphBlocks.push(block)
      return
    }

    const paragraphs = splitInlineLinesIntoParagraphs(block.inlineLines)
    if (paragraphs.length === 0) {
      paragraphBlocks.push(block)
      return
    }

    paragraphs.forEach((paragraph) => {
      if (paragraph.isEmpty) {
        paragraphBlocks.push({
          type: 'unchanged',
          value: '',
        })
        return
      }

      if (!paragraph.hasChanges) {
        paragraphBlocks.push({
          type: 'unchanged',
          value: inlineLinesToText(paragraph.lines, 'original'),
        })
        return
      }

      const hasOriginalLines = paragraph.lines.some(
        (line) => line.type !== 'added',
      )
      const hasModifiedLines = paragraph.lines.some(
        (line) => line.type !== 'removed',
      )
      const originalValue = hasOriginalLines
        ? inlineLinesToText(paragraph.lines, 'original')
        : undefined
      const modifiedValue = hasModifiedLines
        ? inlineLinesToText(paragraph.lines, 'modified')
        : undefined
      paragraphBlocks.push({
        type: 'modified',
        originalValue,
        modifiedValue,
        inlineLines: paragraph.lines,
        presentation: 'inline',
        blockType: 'paragraph',
      })
    })
  })

  return mergeAdjacentUnchangedBlocks(paragraphBlocks)
}

function inlineLinesToText(
  lines: InlineDiffLine[],
  variant: 'original' | 'modified',
): string {
  return lines
    .map((line) => inlineTokensToText(line.tokens, variant))
    .join('\n')
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

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function findBlockIndexAtOriginalLine(
  blocks: DiffBlock[],
  targetLine: number,
): number | null {
  if (targetLine < 0) return null

  let cursorLine = 0
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const lineCount = countOriginalLines(block)
    if (lineCount <= 0) continue

    const blockStart = cursorLine
    const blockEnd = cursorLine + lineCount - 1
    if (targetLine >= blockStart && targetLine <= blockEnd) {
      return index
    }
    cursorLine += lineCount
  }
  return null
}

function countOriginalLines(block: DiffBlock): number {
  if (block.type === 'unchanged') {
    return block.value.split('\n').length
  }
  if (block.originalValue === undefined) return 0
  return block.originalValue.split('\n').length
}

function findSelectionTargetBlockIndex(
  blocks: DiffBlock[],
  selectionRange: ApplyViewState['selectionRange'],
): number | null {
  if (!selectionRange) return null

  const selectionStartLine = Math.min(
    selectionRange.from.line,
    selectionRange.to.line,
  )
  const selectionEndLine = Math.max(
    selectionRange.from.line,
    selectionRange.to.line,
  )

  let cursorLine = 0
  let fallbackModifiedIndex: number | null = null

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block.type !== 'modified') {
      cursorLine += countOriginalLines(block)
      continue
    }

    if (fallbackModifiedIndex === null) {
      fallbackModifiedIndex = index
    }

    const lineCount = countOriginalLines(block)
    const blockStart = cursorLine
    const blockEnd = lineCount > 0 ? cursorLine + lineCount - 1 : cursorLine
    const intersects =
      blockStart <= selectionEndLine && blockEnd >= selectionStartLine

    if (intersects) {
      return index
    }

    cursorLine += lineCount
  }

  return fallbackModifiedIndex
}
