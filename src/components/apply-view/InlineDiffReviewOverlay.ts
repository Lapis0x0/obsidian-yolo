import { Compartment, StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view'

import {
  type ReviewSuggestion,
  buildReviewSuggestionsFromEdits,
  buildSnapshotReviewSuggestions,
  resolveSuggestionChange,
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

class InlineReviewWidget extends WidgetType {
  constructor(
    private readonly suggestion: ReviewSuggestion,
    private readonly isActive: boolean,
    private readonly onHover: (suggestionId: number) => void,
  ) {
    super()
  }

  override eq(other: InlineReviewWidget): boolean {
    return (
      other.suggestion.id === this.suggestion.id &&
      other.suggestion.modifiedValue === this.suggestion.modifiedValue &&
      other.isActive === this.isActive
    )
  }

  override toDOM(): HTMLElement {
    const root = document.createElement('div')
    root.className = `yolo-inline-review-widget${this.isActive ? ' is-active' : ''}`
    root.setAttribute('data-review-id', String(this.suggestion.id))

    const content = document.createElement('div')
    content.className = 'yolo-inline-review-content'

    if (this.suggestion.modifiedValue === undefined) {
      root.classList.add('is-deletion')
      const placeholder = document.createElement('div')
      placeholder.className = 'yolo-inline-review-deletion-placeholder'
      content.appendChild(placeholder)
    } else {
      content.appendChild(createBlockSection(this.suggestion.modifiedValue))
    }

    root.appendChild(content)
    root.addEventListener('mouseenter', () => {
      this.onHover(this.suggestion.id)
    })
    return root
  }

  override ignoreEvent(): boolean {
    return true
  }
}

function createTokenElement(text: string): HTMLElement {
  const span = document.createElement('span')
  span.textContent = text
  span.className = 'yolo-inline-diff yolo-inline-diff-add'
  return span
}

function createBlockSection(text: string): HTMLElement {
  const section = document.createElement('div')
  section.className = 'yolo-inline-review-section is-added'

  text.split('\n').forEach((line) => {
    const lineEl = document.createElement('div')
    lineEl.className = 'yolo-inline-review-line'
    lineEl.appendChild(createTokenElement(line))
    section.appendChild(lineEl)
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
  private readonly decorationsField: StateField<DecorationSet>
  private suggestions: ReviewSuggestion[]
  private currentIndex = 0
  private closed = false
  private settled = false
  private renderQueued = false

  private floatingRoot: HTMLDivElement | null = null
  private floatingRail: HTMLDivElement | null = null
  private floatingActions: HTMLDivElement | null = null
  private toolbarRoot: HTMLDivElement | null = null
  private progressElement: HTMLSpanElement | null = null
  private onViewportChange: (() => void) | null = null
  private onEditorPointerOver: ((event: Event) => void) | null = null
  private onAbort: (() => void) | null = null

  constructor(private readonly options: InlineDiffReviewOverlayOptions) {
    const isRevertReview = options.state.viewMode === 'revert-review'
    const currentContent = options.view.state.doc.toString()
    const suggestedContent = isRevertReview
      ? options.state.originalContent
      : options.state.newContent
    const exactSuggestions =
      !isRevertReview &&
      currentContent === options.state.originalContent &&
      options.state.reviewEdits
        ? buildReviewSuggestionsFromEdits(
            currentContent,
            options.state.reviewEdits,
          )
        : null

    this.suggestions =
      exactSuggestions ??
      buildSnapshotReviewSuggestions(currentContent, suggestedContent)
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
    if (this.suggestions.length === 0) {
      void this.completeAndClose()
      return
    }

    const abortSignal = this.options.state.abortSignal
    if (abortSignal?.aborted) {
      this.options.onClose()
      return
    }
    if (abortSignal) {
      this.onAbort = () => this.options.onClose()
      abortSignal.addEventListener('abort', this.onAbort, { once: true })
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
      acceptIncomingActive: () => this.acceptIncomingActive(),
      acceptCurrentActive: () => this.acceptCurrentActive(),
      close: () => void this.completeAndClose(),
    })
  }

  destroy(): void {
    this.options.onActionsReady?.(null)
    if (this.closed) return
    this.closed = true
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
        this.acceptCurrentActive(),
      ),
    )
    actions.appendChild(
      createActionButton('✓', this.getAcceptActiveLabel(), () =>
        this.acceptIncomingActive(),
      ),
    )
    root.appendChild(actions)
    host.appendChild(root)

    this.floatingRoot = root
    this.floatingRail = rail
    this.floatingActions = actions

    this.onViewportChange = () =>
      this.updateFloatingPosition({ animate: false })
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
        () => this.acceptAllIncoming(),
      ),
    )
    actions.appendChild(
      createButton(
        'yolo-toolbar-btn yolo-exclude',
        this.getRejectAllLabel(),
        this.getRejectAllLabel(),
        () => this.rejectAll(),
      ),
    )
    pill.appendChild(actions)
    toolbar.appendChild(pill)
    this.options.view.dom.appendChild(toolbar)

    this.toolbarRoot = toolbar
    this.progressElement = progress
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
    if (!update.docChanged || this.closed) return
    this.suggestions = this.suggestions.map((suggestion) => ({
      ...suggestion,
      from: update.changes.mapPos(suggestion.from, -1),
      to: update.changes.mapPos(suggestion.to, 1),
      displayFrom: update.changes.mapPos(suggestion.displayFrom, -1),
      displayTo: update.changes.mapPos(suggestion.displayTo, 1),
    }))
    if (this.renderQueued) return
    this.renderQueued = true
    queueMicrotask(() => {
      this.renderQueued = false
      if (!this.closed && this.suggestions.length > 0) {
        this.renderSuggestions({ ensureVisible: false })
      }
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
    const fromRect = this.options.view.coordsAtPos(active.displayFrom)
    const toProbe =
      active.displayTo > active.displayFrom
        ? active.displayTo - 1
        : active.displayFrom
    const toRect = this.options.view.coordsAtPos(toProbe)
    const widgetRect = this.options.view.dom
      .querySelector(`[data-review-id="${active.id}"]`)
      ?.getBoundingClientRect()

    if (!fromRect && !widgetRect) return

    const top = Math.max(
      6,
      (fromRect?.top ?? widgetRect?.top ?? hostRect.top) - hostRect.top,
    )
    const bottom = Math.min(
      hostRect.height - 6,
      (widgetRect?.bottom ?? toRect?.bottom ?? hostRect.bottom) - hostRect.top,
    )
    const contentRect = this.options.view.contentDOM.getBoundingClientRect()
    const preferredRailLeft = contentRect.right - hostRect.left + 8
    const railLeft = clampNumber(preferredRailLeft, 16, hostRect.width - 84)

    rail.style.left = `${railLeft}px`
    rail.style.top = `${top}px`
    rail.style.height = `${Math.max(20, bottom - top)}px`

    const actionHeight = actions.offsetHeight || 62
    const actionTop = clampNumber(
      top + (bottom - top) / 2 - actionHeight / 2,
      6,
      Math.max(6, hostRect.height - actionHeight - 6),
    )
    const actionsWidth = actions.offsetWidth || 26
    actions.style.left = `${clampNumber(
      railLeft + 14,
      20,
      Math.max(20, hostRect.width - actionsWidth - 8),
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

  private acceptIncomingActive(): void {
    const suggestion = this.suggestions[this.currentIndex]
    if (!suggestion) return
    this.applySuggestion(suggestion)
  }

  private acceptCurrentActive(): void {
    if (!this.suggestions[this.currentIndex]) return
    this.removeCurrentSuggestion()
  }

  private applySuggestion(suggestion: ReviewSuggestion): void {
    const change = resolveSuggestionChange(
      this.options.view.state.doc.toString(),
      suggestion,
    )
    this.removeSuggestionById(suggestion.id, false)
    if (change.from !== change.to || change.insert.length > 0) {
      this.options.view.dispatch({
        changes: change,
      })
    }
    this.finishResolutionStep()
  }

  private removeCurrentSuggestion(): void {
    const suggestion = this.suggestions[this.currentIndex]
    if (!suggestion) return
    this.removeSuggestionById(suggestion.id, false)
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

  private acceptAllIncoming(): void {
    while (this.suggestions.length > 0 && !this.closed) {
      const suggestion = this.suggestions[this.suggestions.length - 1]
      const change = resolveSuggestionChange(
        this.options.view.state.doc.toString(),
        suggestion,
      )
      this.suggestions.pop()
      if (change.from !== change.to || change.insert.length > 0) {
        this.options.view.dispatch({ changes: change })
      }
    }
    void this.completeAndClose()
  }

  private rejectAll(): void {
    this.suggestions = []
    void this.completeAndClose()
  }

  private async completeAndClose(): Promise<void> {
    if (this.closed || this.settled) return
    this.settled = true
    this.suggestions = []
    this.options.onActionsReady?.(null)
    this.options.view.dispatch({
      effects: this.setDecorationsEffect.of(Decoration.none),
    })
    this.unmountControls()

    const finalContent = await this.waitForEditorSave()
    if (this.closed || this.options.state.abortSignal?.aborted) return
    this.options.state.callbacks?.onComplete?.({
      finalContent,
    })
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
      if (suggestion.displayFrom < suggestion.displayTo) {
        decorations.push(
          Decoration.mark({
            class: `yolo-inline-review-current${isActive ? ' is-active' : ''}`,
            attributes: {
              'data-yolo-review-id': String(suggestion.id),
            },
          }).range(suggestion.displayFrom, suggestion.displayTo),
        )
      }
      decorations.push(
        Decoration.widget({
          widget: new InlineReviewWidget(suggestion, isActive, (id) =>
            this.handleHoverActive(id),
          ),
          side: 1,
          block: true,
        }).range(suggestion.displayTo),
      )
      return decorations
    })

    this.options.view.dispatch({
      effects: this.setDecorationsEffect.of(Decoration.set(ranges, true)),
    })

    const active = this.suggestions[this.currentIndex]
    if (active && options.ensureVisible) {
      this.options.view.dispatch({
        effects: EditorView.scrollIntoView(active.displayFrom, {
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
    return this.options.state.viewMode === 'revert-review'
      ? this.options.plugin.t('applyView.revertChange', 'Revert this change')
      : this.options.plugin.t('applyView.acceptIncoming', 'Accept incoming')
  }

  private getRejectActiveLabel(): string {
    return this.options.state.viewMode === 'revert-review'
      ? this.options.plugin.t('applyView.keepChange', 'Keep this change')
      : this.options.plugin.t('applyView.acceptCurrent', 'Accept current')
  }

  private getAcceptAllLabel(): string {
    return this.options.state.viewMode === 'revert-review'
      ? this.options.plugin.t('applyView.revertAllChanges', 'Revert all')
      : this.options.plugin.t(
          'applyView.acceptAllIncoming',
          'Accept all incoming',
        )
  }

  private getRejectAllLabel(): string {
    return this.options.state.viewMode === 'revert-review'
      ? this.options.plugin.t('applyView.keepAllChanges', 'Keep all')
      : this.options.plugin.t('applyView.rejectAll', 'Reject all')
  }
}
