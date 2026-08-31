import { Check, MessageCircle, Quote, Trash2 } from 'lucide-react'
import type {
  FocusEvent as ReactFocusEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { v4 as uuidv4 } from 'uuid'

import { useLanguage } from '../../contexts/language-context'
import type { MentionableAssistantQuote } from '../../types/mentionable'
import { getMaxAssistantQuoteNumber } from '../../utils/chat/selection-mentionables'

type AssistantQuotePayload = Pick<
  MentionableAssistantQuote,
  | 'id'
  | 'annotationNumber'
  | 'conversationId'
  | 'messageId'
  | 'content'
  | 'comment'
  | 'selector'
>

type AssistantSelectionQuoteButtonProps = {
  messageId: string
  conversationId: string
  disabled?: boolean
  quotes?: readonly MentionableAssistantQuote[]
  onQuote: (payload: AssistantQuotePayload) => void
  onDeleteQuote?: (id: string) => void
  children: ReactNode
}

type Point = {
  left: number
  top: number
}

type SelectionOverlay = Point & {
  content: string
  selector: NonNullable<MentionableAssistantQuote['selector']>
}

type ActiveDraft = AssistantQuotePayload & {
  id: string
  selector: NonNullable<MentionableAssistantQuote['selector']>
  isNew: boolean
}

type LocalRect = {
  left: number
  top: number
  width: number
  height: number
}

const SELECTOR_CONTEXT_LENGTH = 24
const selectionListeners = new Set<() => void>()
const viewportListeners = new Set<() => void>()

type DocumentBinding = {
  refCount: number
  remove: () => void
}

const documentBindings = new Map<Document, DocumentBinding>()

function emitSelectionChange() {
  selectionListeners.forEach((listener) => listener())
}

function emitViewportChange() {
  viewportListeners.forEach((listener) => listener())
}

function acquireDocumentListeners(doc: Document) {
  const existing = documentBindings.get(doc)
  if (existing) {
    existing.refCount += 1
    return
  }
  const win = doc.defaultView ?? window
  doc.addEventListener('selectionchange', emitSelectionChange)
  win.addEventListener('resize', emitViewportChange)
  doc.addEventListener('scroll', emitViewportChange, true)
  documentBindings.set(doc, {
    refCount: 1,
    remove: () => {
      doc.removeEventListener('selectionchange', emitSelectionChange)
      win.removeEventListener('resize', emitViewportChange)
      doc.removeEventListener('scroll', emitViewportChange, true)
    },
  })
}

function releaseDocumentListeners(doc: Document) {
  const binding = documentBindings.get(doc)
  if (!binding) return
  binding.refCount -= 1
  if (binding.refCount <= 0) {
    binding.remove()
    documentBindings.delete(doc)
  }
}

function getTextNodes(container: HTMLElement): Text[] {
  const nodes: Text[] = []
  const walker = container.ownerDocument.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
  )
  let node = walker.nextNode()
  while (node) {
    nodes.push(node as Text)
    node = walker.nextNode()
  }
  return nodes
}

function resolveTextPosition(
  nodes: readonly Text[],
  offset: number,
): { node: Text; offset: number } | null {
  let traversed = 0
  for (const node of nodes) {
    const next = traversed + node.data.length
    if (offset <= next) {
      return { node, offset: Math.max(0, offset - traversed) }
    }
    traversed = next
  }
  const last = nodes.at(-1)
  return last ? { node: last, offset: last.data.length } : null
}

function resolveSelectorRange(
  container: HTMLElement,
  selector: NonNullable<MentionableAssistantQuote['selector']>,
): Range | null {
  const nodes = getTextNodes(container)
  const start = resolveTextPosition(nodes, selector.start)
  const end = resolveTextPosition(nodes, selector.end)
  if (!start || !end) return null

  const range = container.ownerDocument.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  return range.toString() === selector.exact ? range : null
}

function createSelector(
  container: HTMLElement,
  sourceRange: Range,
): NonNullable<MentionableAssistantQuote['selector']> | null {
  const fullText = container.textContent ?? ''
  const prefixRange = container.ownerDocument.createRange()
  prefixRange.selectNodeContents(container)
  try {
    prefixRange.setEnd(sourceRange.startContainer, sourceRange.startOffset)
  } catch {
    return null
  }

  const selectedText = sourceRange.toString()
  const leadingWhitespace =
    selectedText.length - selectedText.trimStart().length
  const exact = selectedText.trim()
  if (!exact) return null

  const start = prefixRange.toString().length + leadingWhitespace
  const end = start + exact.length
  return {
    start,
    end,
    exact,
    prefix: fullText.slice(Math.max(0, start - SELECTOR_CONTEXT_LENGTH), start),
    suffix: fullText.slice(end, end + SELECTOR_CONTEXT_LENGTH),
  }
}

function getRangeRects(range: Range): DOMRect[] {
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  )
  if (rects.length > 0) return rects
  const rect = range.getBoundingClientRect()
  return rect.width > 0 || rect.height > 0 ? [rect] : []
}

function toLocalRect(rect: DOMRect, containerRect: DOMRect): LocalRect {
  return {
    left: rect.left - containerRect.left,
    top: rect.top - containerRect.top,
    width: rect.width,
    height: rect.height,
  }
}

function getAnnotationBoundaryRect(container: HTMLElement): DOMRect {
  return (
    container.closest<HTMLElement>('.yolo-chat-messages') ??
    container.ownerDocument.documentElement
  ).getBoundingClientRect()
}

export default function AssistantSelectionQuoteButton({
  messageId,
  conversationId,
  disabled = false,
  quotes = [],
  onQuote,
  onDeleteQuote,
  children,
}: AssistantSelectionQuoteButtonProps) {
  const { t } = useLanguage()
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const editorRef = useRef<HTMLInputElement>(null)
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const finalizeSelectionFrameRef = useRef<number | null>(null)
  const isSelectingRef = useRef(false)
  const activePointerIdRef = useRef<number | null>(null)
  const isKeyboardSelectingRef = useRef(false)
  const selectionOverlayRef = useRef<SelectionOverlay | null>(null)
  const processSelectionRef = useRef<() => void>(() => {})
  const measureRef = useRef<() => void>(() => {})
  const [selectionOverlay, setSelectionOverlay] =
    useState<SelectionOverlay | null>(null)
  const [isSelectionActionVisible, setIsSelectionActionVisible] =
    useState(false)
  const [markerPositions, setMarkerPositions] = useState<
    ReadonlyMap<string, Point>
  >(new Map())
  const [activeRects, setActiveRects] = useState<LocalRect[]>([])
  const [activeDraft, setActiveDraft] = useState<ActiveDraft | null>(null)
  const [editorPosition, setEditorPosition] = useState<Point | null>(null)

  const messageQuotes = useMemo(
    () =>
      quotes
        .map((quote, index) => ({ quote, index }))
        .filter(
          ({ quote }) =>
            quote.id &&
            quote.selector &&
            quote.messageId === messageId &&
            quote.conversationId === conversationId,
        ) as Array<{
        quote: MentionableAssistantQuote & {
          id: string
          selector: NonNullable<MentionableAssistantQuote['selector']>
        }
        index: number
      }>,
    [conversationId, messageId, quotes],
  )

  // Most assistant messages never get annotated: no quotes, no in-progress
  // draft, no active selection overlay. Gate expensive layout reads
  // (getBoundingClientRect via measureAnnotations) and viewport-broadcast
  // participation behind these so idle instances stay fully inert.
  const hasAnnotationsToTrack = messageQuotes.length > 0 || activeDraft !== null
  const shouldTrackViewport = hasAnnotationsToTrack || selectionOverlay !== null

  const hideSelectionAction = useCallback(() => {
    selectionOverlayRef.current = null
    setIsSelectionActionVisible(false)
    setSelectionOverlay(null)
  }, [])

  const processSelection = useCallback(() => {
    if (disabled) {
      hideSelectionAction()
      return
    }

    const container = containerRef.current
    const content = contentRef.current
    const selection = (
      container?.ownerDocument.defaultView ?? window
    ).getSelection()
    if (
      !container ||
      !content ||
      !selection ||
      selection.rangeCount === 0 ||
      selection.isCollapsed
    ) {
      hideSelectionAction()
      return
    }

    const anchorNode = selection.anchorNode
    const focusNode = selection.focusNode
    if (
      !anchorNode ||
      !focusNode ||
      !content.contains(anchorNode) ||
      !content.contains(focusNode)
    ) {
      hideSelectionAction()
      return
    }

    const range = selection.getRangeAt(0)
    const selector = createSelector(content, range)
    const rects = getRangeRects(range)
    const rect = rects.at(-1)
    if (!selector || !rect) {
      hideSelectionAction()
      return
    }

    const containerRect = container.getBoundingClientRect()
    const boundaryRect = getAnnotationBoundaryRect(container)
    const buttonRect = buttonRef.current?.getBoundingClientRect()
    const buttonWidth = Math.max(buttonRect?.width ?? 92, 92)
    const buttonHeight = Math.max(buttonRect?.height ?? 36, 36)
    const boundaryLeft = boundaryRect.left - containerRect.left + 8
    const boundaryRight = boundaryRect.right - containerRect.left - 8
    const left = Math.min(
      Math.max(rect.right - containerRect.left + 8, boundaryLeft),
      Math.max(boundaryRight - buttonWidth, boundaryLeft),
    )
    const top = Math.min(
      Math.max(
        rect.top - containerRect.top + (rect.height - buttonHeight) / 2,
        8,
      ),
      Math.max(containerRect.height - buttonHeight - 8, 8),
    )

    setSelectionOverlay({
      content: selector.exact,
      selector,
      left,
      top,
    })
  }, [disabled, hideSelectionAction])

  const measureAnnotations = useCallback(() => {
    if (!hasAnnotationsToTrack) {
      // Nothing to measure. Clear any stale positions without forcing a
      // layout read; bail via functional updates so an already-empty state
      // doesn't trigger a re-render.
      setMarkerPositions((prev) => (prev.size === 0 ? prev : new Map()))
      setActiveRects((prev) => (prev.length === 0 ? prev : []))
      return
    }

    const container = containerRef.current
    const content = contentRef.current
    if (!container || !content) return

    const containerRect = container.getBoundingClientRect()
    const nextPositions = new Map<string, Point>()
    let nextActiveRects: LocalRect[] = []

    for (const { quote } of messageQuotes) {
      const range = resolveSelectorRange(content, quote.selector)
      if (!range) continue
      const rects = getRangeRects(range)
      const lastRect = rects.at(-1)
      if (!lastRect) continue
      nextPositions.set(quote.id, {
        left: lastRect.right - containerRect.left,
        top: lastRect.top - containerRect.top,
      })
      if (activeDraft?.id === quote.id) {
        nextActiveRects = rects.map((rect) => toLocalRect(rect, containerRect))
      }
    }

    if (activeDraft && !nextPositions.has(activeDraft.id)) {
      const range = resolveSelectorRange(content, activeDraft.selector)
      if (range) {
        const rects = getRangeRects(range)
        const lastRect = rects.at(-1)
        if (lastRect) {
          nextPositions.set(activeDraft.id, {
            left: lastRect.right - containerRect.left,
            top: lastRect.top - containerRect.top,
          })
          nextActiveRects = rects.map((rect) =>
            toLocalRect(rect, containerRect),
          )
        }
      }
    }

    setMarkerPositions(nextPositions)
    setActiveRects(nextActiveRects)
  }, [activeDraft, hasAnnotationsToTrack, messageQuotes])

  useEffect(() => {
    selectionOverlayRef.current = selectionOverlay
  }, [selectionOverlay])

  useEffect(() => {
    processSelectionRef.current = processSelection
    measureRef.current = measureAnnotations
  }, [measureAnnotations, processSelection])

  // Stable across the component's lifetime: reads only refs, so it never
  // needs to be re-added to `viewportListeners`. Whether it actually
  // participates is controlled separately below by `shouldTrackViewport`.
  const handleViewportChange = useCallback(() => {
    if (selectionOverlayRef.current) processSelectionRef.current()
    measureRef.current()
  }, [])

  // Only join the shared viewport broadcast while there is something this
  // instance needs to react to (an open selection overlay, or annotations
  // to keep positioned). This keeps a document scroll/resize from waking up
  // every idle assistant message's callback.
  useEffect(() => {
    if (!shouldTrackViewport) return
    viewportListeners.add(handleViewportChange)
    return () => {
      viewportListeners.delete(handleViewportChange)
    }
  }, [handleViewportChange, shouldTrackViewport])

  useEffect(() => {
    const doc = containerRef.current?.ownerDocument ?? document
    const win = doc.defaultView ?? window

    const cancelFinalizeSelection = () => {
      if (finalizeSelectionFrameRef.current === null) return
      win.cancelAnimationFrame(finalizeSelectionFrameRef.current)
      finalizeSelectionFrameRef.current = null
    }

    const beginSelection = () => {
      cancelFinalizeSelection()
      isSelectingRef.current = true
      hideSelectionAction()
    }

    const finalizeSelection = () => {
      cancelFinalizeSelection()
      finalizeSelectionFrameRef.current = win.requestAnimationFrame(() => {
        finalizeSelectionFrameRef.current = null
        processSelectionRef.current()
      })
    }

    const handleSelectionChange = () => {
      if (isSelectingRef.current) {
        hideSelectionAction()
      }
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      const NodeCtor = win.Node
      if (!(target instanceof NodeCtor)) return
      if (!contentRef.current?.contains(target)) {
        if (!buttonRef.current?.contains(target)) hideSelectionAction()
        return
      }
      activePointerIdRef.current = event.pointerId
      beginSelection()
    }

    const handlePointerUp = (event: PointerEvent) => {
      if (
        !isSelectingRef.current ||
        (activePointerIdRef.current !== null &&
          activePointerIdRef.current !== event.pointerId)
      ) {
        return
      }
      activePointerIdRef.current = null
      isSelectingRef.current = false
      finalizeSelection()
    }

    const handlePointerCancel = (event: PointerEvent) => {
      if (
        activePointerIdRef.current !== null &&
        activePointerIdRef.current !== event.pointerId
      ) {
        return
      }
      activePointerIdRef.current = null
      isSelectingRef.current = false
      cancelFinalizeSelection()
      hideSelectionAction()
    }

    const cancelSelection = () => {
      activePointerIdRef.current = null
      isKeyboardSelectingRef.current = false
      isSelectingRef.current = false
      cancelFinalizeSelection()
      hideSelectionAction()
    }

    const handleTouchEnd = () => {
      if (!isSelectingRef.current) return
      activePointerIdRef.current = null
      isSelectingRef.current = false
      finalizeSelection()
    }

    const handleSelectStart = (event: Event) => {
      const target = event.target
      const NodeCtor = win.Node
      if (target instanceof NodeCtor && contentRef.current?.contains(target)) {
        beginSelection()
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !event.shiftKey ||
        ![
          'ArrowLeft',
          'ArrowRight',
          'ArrowUp',
          'ArrowDown',
          'Home',
          'End',
          'PageUp',
          'PageDown',
        ].includes(event.key)
      ) {
        return
      }

      const selection = win.getSelection()
      const content = contentRef.current
      if (
        !content ||
        !selection?.anchorNode ||
        !content.contains(selection.anchorNode)
      ) {
        return
      }

      isKeyboardSelectingRef.current = true
      beginSelection()
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Shift' || !isKeyboardSelectingRef.current) return
      isKeyboardSelectingRef.current = false
      isSelectingRef.current = false
      finalizeSelection()
    }

    selectionListeners.add(handleSelectionChange)
    acquireDocumentListeners(doc)
    doc.addEventListener('pointerdown', handlePointerDown, true)
    doc.addEventListener('pointerup', handlePointerUp, true)
    doc.addEventListener('pointercancel', handlePointerCancel, true)
    doc.addEventListener('touchend', handleTouchEnd, true)
    doc.addEventListener('touchcancel', cancelSelection, true)
    doc.addEventListener('selectstart', handleSelectStart, true)
    doc.addEventListener('keydown', handleKeyDown, true)
    doc.addEventListener('keyup', handleKeyUp, true)
    win.addEventListener('blur', cancelSelection)

    return () => {
      cancelFinalizeSelection()
      selectionListeners.delete(handleSelectionChange)
      releaseDocumentListeners(doc)
      doc.removeEventListener('pointerdown', handlePointerDown, true)
      doc.removeEventListener('pointerup', handlePointerUp, true)
      doc.removeEventListener('pointercancel', handlePointerCancel, true)
      doc.removeEventListener('touchend', handleTouchEnd, true)
      doc.removeEventListener('touchcancel', cancelSelection, true)
      doc.removeEventListener('selectstart', handleSelectStart, true)
      doc.removeEventListener('keydown', handleKeyDown, true)
      doc.removeEventListener('keyup', handleKeyUp, true)
      win.removeEventListener('blur', cancelSelection)
    }
  }, [hideSelectionAction])

  useEffect(() => {
    if (disabled) hideSelectionAction()
  }, [disabled, hideSelectionAction])

  useEffect(() => {
    if (!selectionOverlay) return
    const firstFrameId = window.requestAnimationFrame(() => {
      setIsSelectionActionVisible(true)
    })
    return () => window.cancelAnimationFrame(firstFrameId)
  }, [selectionOverlay])

  useLayoutEffect(() => {
    measureAnnotations()
    if (!hasAnnotationsToTrack) return
    const content = contentRef.current
    if (!content) return
    const observer = new ResizeObserver(() => measureRef.current())
    observer.observe(content)
    return () => observer.disconnect()
  }, [hasAnnotationsToTrack, measureAnnotations])

  useEffect(() => {
    if (!activeDraft) return
    const frameId = window.requestAnimationFrame(() =>
      editorRef.current?.focus(),
    )
    return () => window.cancelAnimationFrame(frameId)
  }, [activeDraft?.id])

  const handleMouseDown = useCallback((event: ReactMouseEvent) => {
    event.preventDefault()
  }, [])

  const openEditor = useCallback((draft: ActiveDraft, position: Point) => {
    const container = containerRef.current
    if (!container) return
    const containerRect = container.getBoundingClientRect()
    const boundaryRect = getAnnotationBoundaryRect(container)
    const editorWidth = draft.isNew ? 300 : 320
    const boundaryLeft = boundaryRect.left - containerRect.left + 8
    const boundaryRight = boundaryRect.right - containerRect.left - 8
    setActiveDraft(draft)
    setEditorPosition({
      left: Math.min(
        Math.max(position.left, boundaryLeft),
        Math.max(boundaryRight - editorWidth, boundaryLeft),
      ),
      top: Math.max(position.top + 16, 8),
    })
  }, [])

  const handleCreateQuote = useCallback(() => {
    if (!selectionOverlay) return
    // Shared pool with PDF-quote blocks — see selection-mentionables.ts and
    // docs/plans/2026-08-16-pdf-annotation-quotes.md architecture decision A.
    const annotationNumber = getMaxAssistantQuoteNumber(quotes) + 1
    const draft: ActiveDraft = {
      id: uuidv4(),
      annotationNumber,
      conversationId,
      messageId,
      content: selectionOverlay.content,
      comment: '',
      selector: selectionOverlay.selector,
      isNew: true,
    }
    onQuote(draft)
    ;(containerRef.current?.ownerDocument.defaultView ?? window)
      .getSelection()
      ?.removeAllRanges()
    hideSelectionAction()
    openEditor(draft, selectionOverlay)
  }, [
    conversationId,
    hideSelectionAction,
    messageId,
    onQuote,
    openEditor,
    quotes,
    selectionOverlay,
  ])

  const handleOpenQuote = useCallback(
    (
      quote: MentionableAssistantQuote & {
        id: string
        selector: NonNullable<MentionableAssistantQuote['selector']>
      },
    ) => {
      const position = markerPositions.get(quote.id)
      if (!position) return
      openEditor(
        {
          id: quote.id,
          annotationNumber: quote.annotationNumber,
          conversationId: quote.conversationId,
          messageId: quote.messageId,
          content: quote.content,
          comment: quote.comment ?? '',
          selector: quote.selector,
          isNew: false,
        },
        position,
      )
    },
    [markerPositions, openEditor],
  )

  const handleCommentChange = useCallback(
    (comment: string) => {
      setActiveDraft((current) => {
        if (!current) return current
        const next = { ...current, comment }
        onQuote(next)
        return next
      })
    },
    [onQuote],
  )

  const handleSave = useCallback(() => {
    setActiveDraft(null)
    setEditorPosition(null)
    setActiveRects([])
  }, [])

  const dismissEditor = useCallback(() => {
    if (!activeDraft) return
    handleSave()
  }, [activeDraft, handleSave])

  const handleEditorBlur = useCallback(
    (event: ReactFocusEvent<HTMLInputElement>) => {
      const nextTarget = event.relatedTarget
      const editor = editorContainerRef.current
      const NodeCtor = editor?.ownerDocument.defaultView?.Node ?? Node
      if (nextTarget instanceof NodeCtor && editor?.contains(nextTarget)) {
        return
      }
      dismissEditor()
    },
    [dismissEditor],
  )

  useEffect(() => {
    if (!activeDraft) return
    const doc = containerRef.current?.ownerDocument ?? document
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      const NodeCtor = doc.defaultView?.Node ?? Node
      if (
        target instanceof NodeCtor &&
        editorContainerRef.current?.contains(target)
      ) {
        return
      }
      dismissEditor()
    }
    doc.addEventListener('pointerdown', handlePointerDown, true)
    return () => doc.removeEventListener('pointerdown', handlePointerDown, true)
  }, [activeDraft, dismissEditor])

  const handleDeleteQuote = useCallback(
    (id: string) => {
      onDeleteQuote?.(id)
      if (activeDraft?.id === id) handleSave()
    },
    [activeDraft?.id, handleSave, onDeleteQuote],
  )

  const handleDelete = useCallback(() => {
    if (!activeDraft) return
    handleDeleteQuote(activeDraft.id)
  }, [activeDraft, handleDeleteQuote])

  const buttonLabel = useMemo(() => t('chat.assistantQuote.add', '引用'), [t])
  const commentPlaceholder = t(
    'chat.assistantQuote.commentPlaceholder',
    '添加批注…',
  )
  const saveLabel = t('chat.assistantQuote.save', '保存批注')
  const deleteLabel = t('chat.assistantQuote.delete', '删除批注')

  return (
    <div
      ref={containerRef}
      className="yolo-assistant-message-selectable"
      data-assistant-message-id={messageId}
    >
      <div
        ref={contentRef}
        className="yolo-assistant-message-selectable-content"
      >
        {children}
      </div>

      {activeRects.map((rect, index) => (
        <span
          key={`${activeDraft?.id ?? 'active'}:${index}`}
          className="yolo-assistant-annotation-active-range"
          style={{
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          }}
        />
      ))}

      {messageQuotes.map(({ quote, index }) => {
        const position = markerPositions.get(quote.id)
        if (!position) return null
        const annotationNumber = quote.annotationNumber ?? index + 1
        const accessibleLabelId = `yolo-assistant-annotation-${quote.id}-label`
        return (
          <button
            key={quote.id}
            type="button"
            className={`yolo-assistant-annotation-marker${
              activeDraft?.id === quote.id ? ' is-active' : ''
            }`}
            style={{ left: `${position.left}px`, top: `${position.top}px` }}
            aria-labelledby={accessibleLabelId}
            onMouseDown={handleMouseDown}
            onClick={() => handleOpenQuote(quote)}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              handleDeleteQuote(quote.id)
            }}
          >
            <MessageCircle
              className="yolo-assistant-annotation-marker-shape"
              size={30}
              strokeWidth={2.2}
              aria-hidden="true"
            />
            <span className="yolo-assistant-annotation-marker-index">
              {annotationNumber}
            </span>
            <span id={accessibleLabelId} className="yolo-sr-only">
              {`${annotationNumber}: ${quote.comment || quote.content}`}
            </span>
            {activeDraft?.id !== quote.id && quote.comment?.trim() && (
              <span
                className="yolo-assistant-annotation-marker-preview"
                role="tooltip"
              >
                {quote.comment.trim()}
              </span>
            )}
          </button>
        )
      })}

      {selectionOverlay && (
        <button
          ref={buttonRef}
          type="button"
          className={`yolo-assistant-selection-quote-button ${
            isSelectionActionVisible ? 'visible' : ''
          }`.trim()}
          style={{
            left: `${Math.round(selectionOverlay.left)}px`,
            top: `${Math.round(selectionOverlay.top)}px`,
          }}
          onMouseDown={handleMouseDown}
          onClick={handleCreateQuote}
        >
          <Quote size={12} />
          <span>{buttonLabel}</span>
        </button>
      )}

      {activeDraft && editorPosition && (
        <div
          ref={editorContainerRef}
          className={`yolo-assistant-annotation-editor${
            activeDraft.isNew ? ' is-new' : ''
          }`}
          style={{
            left: `${Math.round(editorPosition.left)}px`,
            top: `${Math.round(editorPosition.top)}px`,
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <input
            ref={editorRef}
            type="text"
            value={activeDraft.comment ?? ''}
            placeholder={commentPlaceholder}
            onChange={(event) => handleCommentChange(event.currentTarget.value)}
            onBlur={handleEditorBlur}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                handleSave()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                if (activeDraft.isNew) {
                  onDeleteQuote?.(activeDraft.id)
                }
                handleSave()
              }
            }}
          />
          {!activeDraft.isNew && (
            <div className="yolo-assistant-annotation-editor-actions">
              <button
                type="button"
                className="clickable-icon"
                aria-label={deleteLabel}
                title={deleteLabel}
                onClick={handleDelete}
              >
                <Trash2 size={14} />
              </button>
              <button
                type="button"
                className="clickable-icon"
                aria-label={saveLabel}
                title={saveLabel}
                onClick={handleSave}
              >
                <Check size={14} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
