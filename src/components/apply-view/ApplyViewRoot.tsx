import { Component, MarkdownRenderer } from '../../runtime/react-compat'
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
import {
  type ApplyParagraph,
  type ReviewDecision,
  buildFullReviewBlocks,
  findSelectionTargetBlockIndex,
  splitInlineLinesIntoParagraphs,
} from '../../features/editor/diff-review/review-model'
import { ReviewSession } from '../../features/editor/diff-review/review-session'
import type { ApplyViewState } from '../../types/apply-view.types'
import {
  DiffBlock,
  InlineDiffLine,
  InlineDiffToken,
} from '../../utils/chat/diff'

import type { ApplyViewActions } from './types'

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
  const [decisions, setDecisions] = useState<
    ReadonlyMap<number, ReviewDecision>
  >(() => new Map())

  const app = useApp()
  const plugin = usePlugin()
  const { t } = useLanguage()

  const isSelectionFocusMode = state.reviewMode === 'selection-focus'
  const isRevertReviewMode = state.viewMode === 'revert-review'
  const defaultDecision = isRevertReviewMode ? 'incoming' : 'current'
  const diff = useMemo(
    () => buildFullReviewBlocks(state.originalContent, state.newContent),
    [state.newContent, state.originalContent],
  )
  const selectionTargetBlockIndex = useMemo(
    () =>
      isSelectionFocusMode
        ? findSelectionTargetBlockIndex(diff, state.selectionRange)
        : null,
    [diff, isSelectionFocusMode, state.selectionRange],
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
  const session = useMemo(
    () =>
      new ReviewSession({ file: state.file, vault: app.vault, blocks: diff }),
    [app.vault, diff, state.file],
  )

  const activeBlockIndex =
    modifiedBlockIndices[currentDiffIndex] ?? Number.POSITIVE_INFINITY
  const autoCloseRef = useRef(false)
  const decisionCount = decisions.size
  const headerTitle = isRevertReviewMode
    ? t('applyView.reviewTitle', 'Review changes')
    : t('applyView.applying', 'Applying')
  const acceptIncomingLabel = isRevertReviewMode
    ? t('applyView.keepChange', 'Keep this change')
    : t('applyView.acceptIncoming', 'Accept incoming')
  const acceptCurrentLabel = isRevertReviewMode
    ? t('applyView.revertChange', 'Revert this change')
    : t('applyView.acceptCurrent', 'Accept current')
  const acceptAllIncomingLabel = isRevertReviewMode
    ? t('applyView.keepAllChanges', 'Keep all changes')
    : t('applyView.acceptAllIncoming', 'Accept all incoming')
  const acceptAllCurrentLabel = isRevertReviewMode
    ? t('applyView.revertAllChanges', 'Revert all changes')
    : t('applyView.rejectAll', 'Reject all')

  const touchSession = useCallback(() => {
    setDecisions(new Map(session.getDecisions()))
  }, [session])

  useEffect(() => {
    setDecisions(new Map(session.getDecisions()))
  }, [session])

  // Count of decided and pending blocks

  // Generate final content based on decisions
  const persistAndClose = useCallback(
    async (finalContent?: string) => {
      const resolvedContent =
        finalContent ?? session.getFinalContent(defaultDecision)
      try {
        await session.persist(resolvedContent, state.abortSignal)
        if (state.abortSignal?.aborted) {
          return
        }
        state.callbacks?.onComplete?.({
          finalContent: resolvedContent,
        })
      } catch (error) {
        console.error(
          '[ApplyView] Failed to persist changes before close',
          error,
        )
      } finally {
        close()
      }
    },
    [close, defaultDecision, session, state.abortSignal, state.callbacks],
  )

  useEffect(() => {
    const signal = state.abortSignal
    if (!signal) return
    if (signal.aborted) {
      close()
      return
    }

    const handleAbort = () => {
      close()
    }

    signal.addEventListener('abort', handleAbort, { once: true })
    return () => {
      signal.removeEventListener('abort', handleAbort)
    }
  }, [close, state.abortSignal])

  // Individual block decisions (don't close, just mark decision)
  const makeDecision = useCallback(
    (index: number, decision: ReviewDecision) => {
      session.setDecision(index, decision)
      touchSession()
    },
    [session, touchSession],
  )

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
  const undoDecision = useCallback(
    (index: number) => {
      session.clearDecision(index)
      touchSession()
    },
    [session, touchSession],
  )

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
    if (modifiedBlockIndices.length === 0) {
      // Nothing to review — close immediately to prevent the user from
      // being stranded on a "0/0" overlay with all buttons disabled.
      autoCloseRef.current = true
      void persistAndClose(state.originalContent)
      return
    }
    if (decisionCount < modifiedBlockIndices.length) return
    const allDecided = session.areAllModifiedBlocksDecided()
    if (!allDecided) return
    autoCloseRef.current = true
    void persistAndClose(session.getFinalContent(defaultDecision))
  }, [
    decisionCount,
    defaultDecision,
    modifiedBlockIndices.length,
    persistAndClose,
    session,
    state.originalContent,
  ])

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

  return (
    <div
      id={useRootId ? 'smtcmp-apply-view' : undefined}
      className="smtcmp-apply-view-root"
    >
      {showHeader && (
        <div className="view-header">
          <div className="view-header-title-container mod-at-start">
            <div className="view-header-title">
              {headerTitle}: {state?.file?.name ?? ''}
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
                      isRevertReviewMode={isRevertReviewMode}
                      acceptIncomingLabel={acceptIncomingLabel}
                      acceptCurrentLabel={acceptCurrentLabel}
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
                  isRevertReviewMode
                    ? 'applyView.keepAllChanges'
                    : 'applyView.acceptAllIncoming',
                  isRevertReviewMode
                    ? 'Keep all changes'
                    : 'Accept all incoming changes',
                )}
                disabled={modifiedBlockIndices.length === 0}
              >
                {acceptAllIncomingLabel}
              </button>
              <button
                type="button"
                onClick={acceptAllCurrent}
                className="smtcmp-toolbar-btn smtcmp-exclude"
                title={t(
                  isRevertReviewMode
                    ? 'applyView.revertAllChanges'
                    : 'applyView.rejectAll',
                  isRevertReviewMode
                    ? 'Revert all changes'
                    : 'Reject all changes (keep original)',
                )}
                disabled={modifiedBlockIndices.length === 0}
              >
                {acceptAllCurrentLabel}
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
    decision?: ReviewDecision
    isActive: boolean
    sourcePath: string
    onAcceptIncoming: () => void
    onAcceptCurrent: () => void
    onUndo: () => void
    isSelectionFocusMode: boolean
    isSelectionTarget: boolean
    onAcceptSelectionIncoming: () => void
    onAcceptSelectionCurrent: () => void
    isRevertReviewMode: boolean
    acceptIncomingLabel: string
    acceptCurrentLabel: string
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
      isRevertReviewMode,
      acceptIncomingLabel,
      acceptCurrentLabel,
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
      const decisionStatusText = decision
        ? decision === 'incoming'
          ? isRevertReviewMode
            ? t('applyView.keptChange', 'Kept this change')
            : t('applyView.acceptedIncoming', 'Accepted incoming')
          : isRevertReviewMode
            ? t('applyView.revertedChange', 'Reverted this change')
            : t('applyView.keptCurrent', 'Kept current')
        : null

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
                  {decisionStatusText && (
                    <div className="smtcmp-apply-decision-status">
                      {decisionStatusText}
                    </div>
                  )}
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
                              title={acceptIncomingLabel}
                              aria-label={acceptIncomingLabel}
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
                              title={acceptCurrentLabel}
                              aria-label={acceptCurrentLabel}
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
                          title={acceptIncomingLabel}
                          aria-label={acceptIncomingLabel}
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
                          title={acceptCurrentLabel}
                          aria-label={acceptCurrentLabel}
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
