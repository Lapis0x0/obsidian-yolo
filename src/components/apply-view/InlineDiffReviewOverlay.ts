import {
  Annotation,
  Compartment,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state'
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view'

import {
  type ReviewSide,
  type ReviewSuggestion,
  type SuggestionChange,
  buildReviewPlanFromEdits,
  buildSnapshotReviewPlan,
  getReviewDraft,
  getReviewDraftDisplay,
  mapReviewSuggestions,
  resolveSuggestionChange,
  setReviewDraft,
  switchReviewSuggestionSide,
  updateReviewSuggestions,
} from '../../features/editor/diff-review/review-model'
import type YoloPlugin from '../../main'
import type { ApplyViewState } from '../../types/apply-view.types'

import type { ApplyViewActions } from './types'

type InlineDiffReviewOverlayOptions = {
  plugin: YoloPlugin
  view: EditorView
  state: ApplyViewState
  requestSave: () => void
  onClose: () => void
  onActionsReady?: (actions: ApplyViewActions | null) => void
}

const FLOATING_RAIL_POSITION_TRANSITION =
  'top 180ms ease, height 180ms ease, left 180ms ease, opacity 140ms ease'
const FLOATING_ACTIONS_POSITION_TRANSITION =
  'top 180ms ease, left 180ms ease, opacity 140ms ease'
const FLOATING_OPACITY_TRANSITION = 'opacity 140ms ease'
const FLOATING_ACTIONS_RAIL_OFFSET = 4
const FLOATING_CONTROLS_EDGE_INSET = 2

class InlineReviewWidget extends WidgetType {
  constructor(
    private readonly suggestion: ReviewSuggestion,
    private readonly onHover: (suggestionId: number) => void,
    private readonly onEdit: (
      suggestionId: number,
      side: ReviewSide,
      offset: number,
    ) => void,
  ) {
    super()
  }

  override eq(other: InlineReviewWidget): boolean {
    return (
      other.suggestion.id === this.suggestion.id &&
      other.suggestion.activeSide === this.suggestion.activeSide &&
      getReviewDraftDisplay(other.suggestion, this.inactiveSide()).text ===
        getReviewDraftDisplay(this.suggestion, this.inactiveSide()).text
    )
  }

  private inactiveSide(): ReviewSide {
    return this.suggestion.activeSide === 'modified' ? 'original' : 'modified'
  }

  override toDOM(): HTMLElement {
    const side = this.inactiveSide()
    const display = getReviewDraftDisplay(this.suggestion, side)
    const text = display.text
    const root = document.createElement('div')
    root.className = `yolo-inline-review-widget is-${side}`
    root.setAttribute('data-review-id', String(this.suggestion.id))

    const content = document.createElement('div')
    content.className = 'yolo-inline-review-content'

    if (text.length === 0) {
      root.classList.add('is-deletion')
      const placeholder = document.createElement('div')
      placeholder.className = 'yolo-inline-review-deletion-placeholder'
      content.appendChild(placeholder)
    } else {
      content.appendChild(
        createBlockSection(
          text,
          side === 'original' ? 'is-removed' : 'is-added',
        ),
      )
    }

    root.appendChild(content)
    root.addEventListener('mouseenter', () => {
      this.onHover(this.suggestion.id)
    })
    root.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      this.onEdit(
        this.suggestion.id,
        side,
        display.offset + getWidgetTextOffset(root, event),
      )
    })
    return root
  }

  override ignoreEvent(): boolean {
    return true
  }
}

function getWidgetTextOffset(root: HTMLElement, event: MouseEvent): number {
  /* eslint-disable @typescript-eslint/no-deprecated -- Older Obsidian Electron versions expose only this caret hit-test API */
  const caretRangeFromPoint = (
    document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
    }
  ).caretRangeFromPoint
  /* eslint-enable @typescript-eslint/no-deprecated -- End compatibility-only caret API access */
  const caret = caretRangeFromPoint?.call(
    document,
    event.clientX,
    event.clientY,
  )
  if (!caret || !root.contains(caret.startContainer)) return 0

  const line = (
    caret.startContainer instanceof Element
      ? caret.startContainer.closest('.yolo-inline-review-line')
      : caret.startContainer.parentElement?.closest('.yolo-inline-review-line')
  ) as HTMLElement | null | undefined
  if (!line) return 0

  const withinLine = document.createRange()
  withinLine.selectNodeContents(line)
  withinLine.setEnd(caret.startContainer, caret.startOffset)
  return Number(line.dataset.textOffset ?? 0) + withinLine.toString().length
}

function createTokenElement(text: string): HTMLElement {
  const span = document.createElement('span')
  span.textContent = text
  span.className = 'yolo-inline-diff yolo-inline-diff-add'
  return span
}

function createBlockSection(
  text: string,
  state: 'is-added' | 'is-removed',
): HTMLElement {
  const section = document.createElement('div')
  section.className = `yolo-inline-review-section ${state}`

  let offset = 0
  text.split('\n').forEach((line) => {
    const lineEl = document.createElement('div')
    lineEl.className = 'yolo-inline-review-line'
    lineEl.dataset.textOffset = String(offset)
    const token = createTokenElement(line)
    if (state === 'is-removed') {
      token.classList.replace('yolo-inline-diff-add', 'yolo-inline-diff-remove')
    }
    lineEl.appendChild(token)
    section.appendChild(lineEl)
    offset += line.length + 1
  })

  return section
}

function createButton(
  className: string,
  label: string,
  content: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.setAttribute('aria-label', label)
  button.textContent = content
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onClick()
  })
  return button
}

function createActionButton(
  icon: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = createButton('yolo-apply-action', label, '', onClick)
  if (icon === '✓') button.classList.add('yolo-apply-action-accept')
  if (icon === '×') button.classList.add('yolo-apply-action-reject')

  const iconEl = document.createElement('span')
  iconEl.className = 'yolo-apply-action-icon'
  iconEl.textContent = icon
  button.appendChild(iconEl)
  return button
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function findSelectionTargetIndex(
  suggestions: ReviewSuggestion[],
  selectionRange: ApplyViewState['selectionRange'],
): number {
  if (!selectionRange || suggestions.length === 0) return 0
  const start = Math.min(selectionRange.from.line, selectionRange.to.line)
  const end = Math.max(selectionRange.from.line, selectionRange.to.line)

  for (let index = 0; index < suggestions.length; index += 1) {
    const suggestion = suggestions[index]
    if (suggestion.startLine <= end && suggestion.endLine >= start) {
      return index
    }
  }
  return 0
}

export class InlineDiffReviewOverlay {
  private readonly decorationCompartment = new Compartment()
  private readonly setDecorationsEffect = StateEffect.define<DecorationSet>()
  private readonly reviewTransaction = Annotation.define<
    { kind: 'map' } | { kind: 'switch'; suggestionId: number; side: ReviewSide }
  >()
  private readonly decorationsField: StateField<DecorationSet>
  private readonly initialChanges: SuggestionChange[]
  private readonly totalReviewChanges: number
  private readonly rejectedChanges = new Map<
    number,
    { index: number; originalText: string; proposedText: string }
  >()
  private suggestions: ReviewSuggestion[]
  private currentIndex = 0
  private closed = false
  private settled = false
  private renderQueued = false
  private positionUpdateQueued = false

  private floatingRoot: HTMLDivElement | null = null
  private floatingRail: HTMLDivElement | null = null
  private floatingActions: HTMLDivElement | null = null
  private toolbarRoot: HTMLDivElement | null = null
  private progressElement: HTMLSpanElement | null = null
  private onViewportChange: (() => void) | null = null
  private onEditorPointerOver: ((event: Event) => void) | null = null
  private onAbort: (() => void) | null = null

  constructor(private readonly options: InlineDiffReviewOverlayOptions) {
    const isAppliedReview = options.state.viewMode === 'applied-review'
    const currentContent = options.view.state.doc.toString()
    const exactSuggestions =
      !isAppliedReview &&
      currentContent === options.state.originalContent &&
      options.state.reviewEdits
        ? buildReviewPlanFromEdits(currentContent, options.state.reviewEdits)
        : null
    const plan = isAppliedReview
      ? buildSnapshotReviewPlan(options.state.originalContent, currentContent)
      : (exactSuggestions ??
        buildSnapshotReviewPlan(currentContent, options.state.newContent))

    this.initialChanges = isAppliedReview ? [] : plan.changes
    this.suggestions = plan.suggestions
    this.totalReviewChanges = plan.suggestions.length
    this.currentIndex = findSelectionTargetIndex(
      this.suggestions,
      options.state.selectionRange,
    )

    const setDecorationsEffect = this.setDecorationsEffect
    this.decorationsField = StateField.define<DecorationSet>({
      create: () => Decoration.none,
      update: (decorations, transaction) => {
        const mapped = decorations.map(transaction.changes)
        for (const effect of transaction.effects) {
          if (effect.is(setDecorationsEffect)) return effect.value
        }
        return mapped
      },
      provide: (field) => EditorView.decorations.from(field),
    })
  }

  mount(): void {
    const abortSignal = this.options.state.abortSignal
    if (abortSignal?.aborted) {
      this.suggestions = []
      this.options.onClose()
      return
    }
    if (abortSignal) {
      this.onAbort = () => void this.completeAndClose()
      abortSignal.addEventListener('abort', this.onAbort, { once: true })
    }

    if (this.initialChanges.length > 0) {
      this.options.view.dispatch({
        changes: this.initialChanges,
        annotations: [
          this.reviewTransaction.of({ kind: 'map' }),
          Transaction.addToHistory.of(false),
        ],
      })
    }

    if (this.suggestions.length === 0) {
      void this.completeAndClose()
      return
    }

    this.options.view.dispatch({
      effects: StateEffect.appendConfig.of([
        this.decorationCompartment.of([
          this.decorationsField,
          EditorView.updateListener.of((update) =>
            this.handleViewUpdate(update),
          ),
        ]),
      ]),
    })

    this.mountFloatingControls()
    this.mountToolbar()
    this.renderSuggestions({ ensureVisible: true })
    this.options.onActionsReady?.({
      goToPreviousDiff: () => this.goToPrevious(),
      goToNextDiff: () => this.goToNext(),
      acceptIncomingActive: () => this.acceptDisplayedActive(),
      acceptCurrentActive: () => this.rejectDisplayedActive(),
      close: () => void this.completeAndClose(),
    })
  }

  destroy(): void {
    this.options.onActionsReady?.(null)
    if (this.closed) return
    this.closed = true
    if (!this.settled) {
      this.materializePendingSide(
        this.isAppliedReview() ? 'modified' : 'original',
      )
    }
    if (this.onAbort) {
      this.options.state.abortSignal?.removeEventListener('abort', this.onAbort)
      this.onAbort = null
    }
    this.unmountControls()
    this.options.view.dispatch({
      effects: this.decorationCompartment.reconfigure([]),
    })
  }

  private mountFloatingControls(): void {
    const host = this.options.view.dom
    host.classList.add('yolo-inline-review-host')

    const root = document.createElement('div')
    root.className = 'yolo-inline-review-floating-root'
    root.setAttribute('aria-label', 'Inline review controls')

    const rail = document.createElement('div')
    rail.className = 'yolo-inline-review-floating-rail'
    rail.style.transition = FLOATING_RAIL_POSITION_TRANSITION
    root.appendChild(rail)

    const actions = document.createElement('div')
    actions.className = 'yolo-inline-review-floating-actions'
    actions.style.transition = FLOATING_ACTIONS_POSITION_TRANSITION
    actions.appendChild(
      createActionButton('×', this.getRejectActiveLabel(), () =>
        this.rejectDisplayedActive(),
      ),
    )
    actions.appendChild(
      createActionButton('✓', this.getAcceptActiveLabel(), () =>
        this.acceptDisplayedActive(),
      ),
    )
    root.appendChild(actions)
    host.appendChild(root)

    this.floatingRoot = root
    this.floatingRail = rail
    this.floatingActions = actions

    this.onViewportChange = () => {
      this.updateFloatingPosition({ animate: false })
      this.updateToolbarPosition()
    }
    this.options.view.scrollDOM.addEventListener(
      'scroll',
      this.onViewportChange,
      { passive: true },
    )
    window.addEventListener('resize', this.onViewportChange)

    this.onEditorPointerOver = (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const reviewElement = target.closest('[data-yolo-review-id]')
      const id = Number(reviewElement?.getAttribute('data-yolo-review-id'))
      if (Number.isInteger(id)) this.handleHoverActive(id)
    }
    this.options.view.contentDOM.addEventListener(
      'pointerover',
      this.onEditorPointerOver,
    )
  }

  private mountToolbar(): void {
    const toolbar = document.createElement('div')
    toolbar.className = 'yolo-inline-review-toolbar'
    const pill = document.createElement('div')
    pill.className = 'yolo-inline-review-toolbar-pill'

    const nav = document.createElement('div')
    nav.className = 'yolo-inline-review-toolbar-nav'
    nav.appendChild(
      createButton(
        'yolo-toolbar-icon-btn',
        this.options.plugin.t('applyView.prevChange', 'Previous change'),
        '↑',
        () => this.goToPrevious(),
      ),
    )
    const progress = document.createElement('span')
    progress.className = 'yolo-apply-progress'
    nav.appendChild(progress)
    nav.appendChild(
      createButton(
        'yolo-toolbar-icon-btn',
        this.options.plugin.t('applyView.nextChange', 'Next change'),
        '↓',
        () => this.goToNext(),
      ),
    )
    pill.appendChild(nav)

    const actions = document.createElement('div')
    actions.className = 'yolo-inline-review-toolbar-actions'
    actions.appendChild(
      createButton(
        'yolo-toolbar-btn yolo-accept',
        this.getAcceptAllLabel(),
        this.getAcceptAllLabel(),
        () => this.acceptAllDisplayed(),
      ),
    )
    actions.appendChild(
      createButton(
        'yolo-toolbar-btn yolo-exclude',
        this.getRejectAllLabel(),
        this.getRejectAllLabel(),
        () => this.rejectAllDisplayed(),
      ),
    )
    pill.appendChild(actions)
    toolbar.appendChild(pill)
    this.options.view.dom.appendChild(toolbar)

    this.toolbarRoot = toolbar
    this.progressElement = progress
    this.updateToolbarPosition()
  }

  private updateToolbarPosition(): void {
    const toolbar = this.toolbarRoot
    const pill = toolbar?.querySelector<HTMLElement>(
      '.yolo-inline-review-toolbar-pill',
    )
    const statusBar = document.querySelector<HTMLElement>('.status-bar')
    if (!toolbar || !pill || !statusBar) return

    const hostRect = this.options.view.dom.getBoundingClientRect()
    const pillRect = pill.getBoundingClientRect()
    const statusBarRect = statusBar.getBoundingClientRect()
    const intersectsHorizontally =
      pillRect.right > statusBarRect.left && pillRect.left < statusBarRect.right
    const intersectsViewBottom =
      hostRect.bottom > statusBarRect.top && hostRect.top < statusBarRect.bottom
    const statusBarOffset =
      intersectsHorizontally && intersectsViewBottom
        ? Math.min(statusBarRect.height, hostRect.bottom - statusBarRect.top)
        : 0

    toolbar.setCssProps({
      '--yolo-inline-review-status-bar-offset': `${statusBarOffset}px`,
    })
  }

  private unmountControls(): void {
    if (this.onViewportChange) {
      this.options.view.scrollDOM.removeEventListener(
        'scroll',
        this.onViewportChange,
      )
      window.removeEventListener('resize', this.onViewportChange)
    }
    this.onViewportChange = null

    if (this.onEditorPointerOver) {
      this.options.view.contentDOM.removeEventListener(
        'pointerover',
        this.onEditorPointerOver,
      )
    }
    this.onEditorPointerOver = null
    this.floatingRoot?.remove()
    this.toolbarRoot?.remove()
    this.floatingRoot = null
    this.floatingRail = null
    this.floatingActions = null
    this.toolbarRoot = null
    this.progressElement = null
    this.options.view.dom.classList.remove('yolo-inline-review-host')
  }

  private handleViewUpdate(update: ViewUpdate): void {
    if (this.closed) return
    const refreshedReviewDecorations = update.transactions.some((transaction) =>
      transaction.effects.some((effect) =>
        effect.is(this.setDecorationsEffect),
      ),
    )
    if (update.geometryChanged && !refreshedReviewDecorations) {
      this.queuePositionUpdate()
    }
    if (!update.docChanged) return
    for (const transaction of update.transactions) {
      if (!transaction.docChanged) continue
      const reviewTransaction = transaction.annotation(this.reviewTransaction)
      if (reviewTransaction?.kind === 'switch') {
        this.suggestions = switchReviewSuggestionSide(
          this.suggestions,
          reviewTransaction.suggestionId,
          reviewTransaction.side,
          transaction.changes,
        )
        continue
      }
      if (reviewTransaction?.kind === 'map') {
        this.suggestions = mapReviewSuggestions(
          this.suggestions,
          transaction.changes,
        )
        continue
      }
      const previousSuggestions = this.suggestions
      const result = updateReviewSuggestions(
        this.suggestions,
        transaction.changes,
        transaction.newDoc.toString(),
      )
      for (const removedId of result.removedIds) {
        const removed = previousSuggestions.find(
          (item) => item.id === removedId,
        )
        if (removed?.activeSide === 'original') {
          this.recordRejectedChange(removed)
        }
      }
      this.suggestions = result.suggestions
    }
    this.currentIndex = Math.min(
      this.currentIndex,
      Math.max(0, this.suggestions.length - 1),
    )
    if (this.suggestions.length === 0) {
      queueMicrotask(() => void this.completeAndClose())
      return
    }
    if (this.renderQueued) return
    this.renderQueued = true
    queueMicrotask(() => {
      this.renderQueued = false
      if (!this.closed && this.suggestions.length > 0) {
        this.renderSuggestions({ ensureVisible: false })
      }
    })
  }

  private queuePositionUpdate(): void {
    if (this.positionUpdateQueued) return
    this.positionUpdateQueued = true
    queueMicrotask(() => {
      this.positionUpdateQueued = false
      if (this.closed) return
      this.updateFloatingPosition({ animate: false })
      this.updateToolbarPosition()
    })
  }

  private setFloatingPositionTransitionEnabled(enabled: boolean): void {
    if (this.floatingRail) {
      this.floatingRail.style.transition = enabled
        ? FLOATING_RAIL_POSITION_TRANSITION
        : FLOATING_OPACITY_TRANSITION
    }
    if (this.floatingActions) {
      this.floatingActions.style.transition = enabled
        ? FLOATING_ACTIONS_POSITION_TRANSITION
        : FLOATING_OPACITY_TRANSITION
    }
  }

  private updateFloatingPosition(
    options: { animate: boolean } = { animate: false },
  ): void {
    const active = this.suggestions[this.currentIndex]
    const root = this.floatingRoot
    const rail = this.floatingRail
    const actions = this.floatingActions
    if (!active || !root || !rail || !actions) return

    this.setFloatingPositionTransitionEnabled(options.animate)

    const hostRect = this.options.view.dom.getBoundingClientRect()
    const fromRect = this.options.view.coordsAtPos(active.from)
    const toProbe = active.to > active.from ? active.to - 1 : active.from
    const toRect = this.options.view.coordsAtPos(toProbe)
    const widgetRect = this.options.view.dom
      .querySelector(`[data-review-id="${active.id}"]`)
      ?.getBoundingClientRect()

    if (!fromRect && !widgetRect) return

    const modifiedIsLive = active.activeSide === 'modified'
    const hasLiveContent = active.to > active.from
    const trackLiveModified = modifiedIsLive && hasLiveContent
    const trackTop = trackLiveModified
      ? (fromRect?.top ?? widgetRect?.top)
      : (widgetRect?.top ?? fromRect?.top)
    const trackBottom = trackLiveModified
      ? (toRect?.bottom ?? fromRect?.bottom)
      : (widgetRect?.bottom ?? fromRect?.bottom)

    const top = Math.max(6, (trackTop ?? hostRect.top) - hostRect.top)
    const bottom = Math.min(
      hostRect.height - 6,
      (trackBottom ?? hostRect.bottom) - hostRect.top,
    )
    const contentRect = this.options.view.contentDOM.getBoundingClientRect()
    const preferredRailLeft = contentRect.right - hostRect.left + 8
    const actionsWidth = actions.offsetWidth || 26
    const scrollRect = this.options.view.scrollDOM.getBoundingClientRect()
    const scrollbarWidth =
      this.options.view.scrollDOM.offsetWidth -
      this.options.view.scrollDOM.clientWidth
    const controlsRight = Math.min(
      hostRect.width,
      scrollRect.right - hostRect.left - scrollbarWidth,
    )
    const maxRailLeft = Math.max(
      16,
      controlsRight -
        FLOATING_ACTIONS_RAIL_OFFSET -
        actionsWidth -
        FLOATING_CONTROLS_EDGE_INSET,
    )
    const railLeft = clampNumber(preferredRailLeft, 16, maxRailLeft)

    rail.style.left = `${railLeft}px`
    rail.style.top = `${top}px`
    rail.style.height = `${Math.max(20, bottom - top)}px`

    const actionHeight = actions.offsetHeight || 62
    const actionTop = clampNumber(
      top + (bottom - top) / 2 - actionHeight / 2,
      6,
      Math.max(6, hostRect.height - actionHeight - 6),
    )
    actions.style.left = `${clampNumber(
      railLeft + FLOATING_ACTIONS_RAIL_OFFSET,
      20,
      Math.max(20, controlsRight - actionsWidth - FLOATING_CONTROLS_EDGE_INSET),
    )}px`
    actions.style.top = `${actionTop}px`
  }

  private goToPrevious(): void {
    if (this.suggestions.length === 0) return
    this.currentIndex =
      this.currentIndex <= 0
        ? this.suggestions.length - 1
        : this.currentIndex - 1
    this.renderSuggestions({ ensureVisible: true })
  }

  private goToNext(): void {
    if (this.suggestions.length === 0) return
    this.currentIndex = (this.currentIndex + 1) % this.suggestions.length
    this.renderSuggestions({ ensureVisible: true })
  }

  private acceptDisplayedActive(): void {
    this.resolveDisplayedActive('modified')
  }

  private rejectDisplayedActive(): void {
    this.resolveDisplayedActive('original')
  }

  private resolveDisplayedActive(side: ReviewSide): void {
    const suggestion = this.suggestions[this.currentIndex]
    if (!suggestion) return
    const captured = this.captureActiveDraft(suggestion)
    if (side === 'original') this.recordRejectedChange(captured)
    const change = resolveSuggestionChange(
      this.options.view.state.doc.toString(),
      captured,
      side,
    )
    this.removeSuggestionById(captured.id, false)
    if (change.from !== change.to || change.insert.length > 0) {
      this.options.view.dispatch({
        changes: change,
        annotations: [
          this.reviewTransaction.of({ kind: 'map' }),
          Transaction.addToHistory.of(false),
        ],
      })
    }
    this.finishResolutionStep()
  }

  private removeSuggestionById(id: number, render: boolean): void {
    const index = this.suggestions.findIndex((item) => item.id === id)
    if (index < 0) return
    this.suggestions.splice(index, 1)
    this.currentIndex = Math.min(
      index,
      Math.max(0, this.suggestions.length - 1),
    )
    if (render) this.renderSuggestions({ ensureVisible: false })
  }

  private finishResolutionStep(): void {
    if (this.suggestions.length === 0) {
      void this.completeAndClose()
      return
    }
    this.renderSuggestions({ ensureVisible: true })
  }

  private acceptAllDisplayed(): void {
    this.materializePendingSide('modified')
    void this.completeAndClose()
  }

  private rejectAllDisplayed(): void {
    this.materializePendingSide('original')
    void this.completeAndClose()
  }

  private restorePendingSuggestions(): void {
    this.materializePendingSide('original')
  }

  private materializePendingSide(side: ReviewSide): void {
    const content = this.options.view.state.doc.toString()
    const changes = this.suggestions
      .map((suggestion) => {
        const captured = this.captureActiveDraft(suggestion)
        if (side === 'original') this.recordRejectedChange(captured)
        return resolveSuggestionChange(content, captured, side)
      })
      .filter(
        (change) => content.slice(change.from, change.to) !== change.insert,
      )
      .sort((left, right) => left.from - right.from)
    this.suggestions = []
    if (changes.length === 0) return
    this.options.view.dispatch({
      changes,
      annotations: [
        this.reviewTransaction.of({ kind: 'map' }),
        Transaction.addToHistory.of(false),
      ],
    })
  }

  private captureActiveDraft(suggestion: ReviewSuggestion): ReviewSuggestion {
    const content = this.options.view.state.doc.toString()
    const captured = setReviewDraft(
      suggestion,
      suggestion.activeSide,
      content.slice(suggestion.from, suggestion.to),
    )
    const index = this.suggestions.findIndex(
      (item) => item.id === suggestion.id,
    )
    if (index >= 0) this.suggestions[index] = captured
    return captured
  }

  private recordRejectedChange(suggestion: ReviewSuggestion): void {
    this.rejectedChanges.set(suggestion.id, {
      index: suggestion.id + 1,
      originalText: suggestion.originalText,
      proposedText: suggestion.modifiedText,
    })
  }

  private activateSuggestionSide(
    suggestionId: number,
    side: ReviewSide,
    offset: number,
  ): void {
    const index = this.suggestions.findIndex((item) => item.id === suggestionId)
    const suggestion = this.suggestions[index]
    if (!suggestion || suggestion.activeSide === side) return

    const captured = this.captureActiveDraft(suggestion)
    const insert = getReviewDraft(captured, side)
    const anchor = captured.from + Math.max(0, Math.min(offset, insert.length))
    const current = this.options.view.state.doc.sliceString(
      captured.from,
      captured.to,
    )

    if (current === insert) {
      this.suggestions[index] = { ...captured, activeSide: side }
      this.options.view.dispatch({ selection: { anchor } })
      this.renderSuggestions({ ensureVisible: false })
      this.options.view.focus()
      return
    }

    this.options.view.dispatch({
      changes: { from: captured.from, to: captured.to, insert },
      selection: { anchor },
      annotations: [
        this.reviewTransaction.of({ kind: 'switch', suggestionId, side }),
        Transaction.addToHistory.of(false),
      ],
    })
    this.options.view.focus()
  }

  private async completeAndClose(): Promise<void> {
    if (this.closed || this.settled) return
    this.settled = true
    if (this.isAppliedReview()) {
      this.materializePendingSide('modified')
    } else if (this.suggestions.length > 0) {
      this.restorePendingSuggestions()
    }
    this.options.onActionsReady?.(null)
    this.options.view.dispatch({
      effects: this.setDecorationsEffect.of(Decoration.none),
    })
    this.unmountControls()

    const finalContent = await this.waitForEditorSave()
    if (this.closed) return
    if (!this.options.state.abortSignal?.aborted) {
      this.options.state.callbacks?.onComplete?.({
        finalContent,
        review: {
          totalChanges: this.totalReviewChanges,
          rejectedChanges: [...this.rejectedChanges.values()].sort(
            (left, right) => left.index - right.index,
          ),
        },
      })
    }
    this.options.onClose()
  }

  private async waitForEditorSave(): Promise<string> {
    const { file } = this.options.state
    const { vault } = this.options.plugin.app
    const editorContent = this.options.view.state.doc.toString()

    return await new Promise<string>((resolve) => {
      let finished = false
      const finish = (content: string) => {
        if (finished) return
        finished = true
        window.clearTimeout(timeoutId)
        vault.offref(modifyRef)
        resolve(content)
      }
      const readSavedContent = async () => {
        try {
          finish(await vault.read(file))
        } catch {
          finish(this.options.view.state.doc.toString())
        }
      }
      const modifyRef = vault.on('modify', (modifiedFile) => {
        if (modifiedFile.path === file.path) void readSavedContent()
      })
      const timeoutId = window.setTimeout(() => {
        finish(this.options.view.state.doc.toString())
      }, 5000)

      void vault
        .read(file)
        .then((savedContent) => {
          if (savedContent === editorContent) {
            finish(savedContent)
            return
          }
          this.options.requestSave()
        })
        .catch(() => this.options.requestSave())
    })
  }

  private renderSuggestions(options: { ensureVisible: boolean }): void {
    const ranges = this.suggestions.flatMap((suggestion, index) => {
      const isActive = index === this.currentIndex
      const decorations = []
      if (suggestion.from < suggestion.to) {
        const activeClass =
          suggestion.activeSide === 'modified' ? ' is-applied' : ''
        decorations.push(
          Decoration.mark({
            class: `yolo-inline-review-current${activeClass}${
              isActive ? ' is-active' : ''
            }`,
            attributes: {
              'data-yolo-review-id': String(suggestion.id),
            },
          }).range(suggestion.from, suggestion.to),
        )
      }
      decorations.push(
        Decoration.widget({
          widget: new InlineReviewWidget(
            suggestion,
            (id) => this.handleHoverActive(id),
            (id, side, offset) => this.activateSuggestionSide(id, side, offset),
          ),
          side: suggestion.activeSide === 'modified' ? -1 : 1,
          block: true,
        }).range(
          suggestion.activeSide === 'modified'
            ? suggestion.from
            : suggestion.to,
        ),
      )
      return decorations
    })

    this.options.view.dispatch({
      effects: this.setDecorationsEffect.of(Decoration.set(ranges, true)),
    })

    const active = this.suggestions[this.currentIndex]
    if (active && options.ensureVisible) {
      this.options.view.dispatch({
        effects: EditorView.scrollIntoView(active.from, {
          y: 'nearest',
        }),
      })
    }
    if (this.progressElement) {
      this.progressElement.textContent = `${this.currentIndex + 1}/${this.suggestions.length}`
    }
    this.updateFloatingPosition({ animate: true })
  }

  private handleHoverActive(suggestionId: number): void {
    const nextIndex = this.suggestions.findIndex(
      (suggestion) => suggestion.id === suggestionId,
    )
    if (nextIndex < 0 || nextIndex === this.currentIndex) return
    this.currentIndex = nextIndex
    this.renderSuggestions({ ensureVisible: false })
  }

  private getAcceptActiveLabel(): string {
    return this.isAppliedReview()
      ? this.options.plugin.t('applyView.acceptChange', 'Accept change')
      : this.options.plugin.t('applyView.acceptIncoming', 'Accept incoming')
  }

  private getRejectActiveLabel(): string {
    return this.isAppliedReview()
      ? this.options.plugin.t('applyView.rejectChange', 'Reject change')
      : this.options.plugin.t('applyView.acceptCurrent', 'Accept current')
  }

  private getAcceptAllLabel(): string {
    return this.isAppliedReview()
      ? this.options.plugin.t(
          'applyView.acceptAllChanges',
          'Accept all changes',
        )
      : this.options.plugin.t(
          'applyView.acceptAllIncoming',
          'Accept all incoming',
        )
  }

  private getRejectAllLabel(): string {
    return this.isAppliedReview()
      ? this.options.plugin.t(
          'applyView.rejectAllChanges',
          'Reject all changes',
        )
      : this.options.plugin.t('applyView.rejectAll', 'Reject all')
  }

  private isAppliedReview(): boolean {
    return this.options.state.viewMode === 'applied-review'
  }
}
