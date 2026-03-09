import {
  Compartment,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state'
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view'

import type SmartComposerPlugin from '../../main'
import {
  buildInlineReviewBlocks,
  countOriginalLines,
  type ReviewDecision,
} from '../../features/editor/diff-review/review-model'
import { ReviewSession } from '../../features/editor/diff-review/review-session'
import type { ApplyViewState } from '../../types/apply-view.types'
import { type DiffBlock, type InlineDiffToken } from '../../utils/chat/diff'

import type { ApplyViewActions } from './types'

type InlineDiffReviewOverlayOptions = {
  plugin: SmartComposerPlugin
  view: EditorView
  state: ApplyViewState
  onClose: () => void
  onActionsReady?: (actions: ApplyViewActions | null) => void
}

type ModifiedReviewBlock = {
  blockIndex: number
  block: Extract<DiffBlock, { type: 'modified' }>
  from: number
  to: number
  startLine: number
  endLine: number
}

const FLOATING_RAIL_POSITION_TRANSITION =
  'top 180ms ease, height 180ms ease, left 180ms ease, opacity 140ms ease'
const FLOATING_ACTIONS_POSITION_TRANSITION =
  'top 180ms ease, left 180ms ease, opacity 140ms ease'
const FLOATING_OPACITY_TRANSITION = 'opacity 140ms ease'

class InlineReviewWidget extends WidgetType {
  constructor(
    private readonly block: Extract<DiffBlock, { type: 'modified' }>,
    private readonly reviewIndex: number,
    private readonly isActive: boolean,
    private readonly decision: ReviewDecision,
    private readonly onHover: (reviewIndex: number) => void,
  ) {
    super()
  }

  override eq(): boolean {
    return false
  }

  override toDOM(): HTMLElement {
    const root = document.createElement('div')
    root.className = `smtcmp-inline-review-widget${this.isActive ? ' is-active' : ''}`
    root.setAttribute('data-review-index', String(this.reviewIndex))

    if (this.decision !== 'pending') {
      root.classList.add('is-resolved')
      const resolved =
        this.decision === 'incoming'
          ? (this.block.modifiedValue ?? this.block.originalValue ?? '')
          : (this.block.originalValue ?? '')
      const resolvedContainer = document.createElement('div')
      resolvedContainer.className = 'smtcmp-inline-review-resolved'
      const resolvedLines = resolved.split('\n')
      resolvedLines.forEach((line) => {
        const lineEl = document.createElement('div')
        lineEl.className = 'smtcmp-inline-review-line'
        lineEl.textContent = line
        resolvedContainer.appendChild(lineEl)
      })
      root.appendChild(resolvedContainer)
      return root
    }

    const content = document.createElement('div')
    content.className = 'smtcmp-inline-review-content'
    if (this.block.presentation === 'block') {
      if (this.block.originalValue !== undefined) {
        content.appendChild(
          createBlockSection(this.block.originalValue, 'del', 'removed'),
        )
      }
      if (this.block.modifiedValue !== undefined) {
        content.appendChild(
          createBlockSection(this.block.modifiedValue, 'add', 'added'),
        )
      }
    } else {
      this.block.inlineLines.forEach((line) => {
        const lineEl = document.createElement('div')
        lineEl.className = `smtcmp-inline-review-line is-${line.type}`
        line.tokens.forEach((token) => {
          lineEl.appendChild(createTokenElement(token))
        })
        content.appendChild(lineEl)
      })
    }
    root.appendChild(content)

    root.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    root.addEventListener('mouseenter', () => {
      this.onHover(this.reviewIndex)
    })

    return root
  }

  override ignoreEvent(): boolean {
    return true
  }
}

function createTokenElement(token: InlineDiffToken): HTMLElement {
  const span = document.createElement('span')
  span.textContent = token.text
  if (token.type === 'add') {
    span.className = 'smtcmp-inline-diff smtcmp-inline-diff-add'
  } else if (token.type === 'del') {
    span.className = 'smtcmp-inline-diff smtcmp-inline-diff-del'
  } else {
    span.className = 'smtcmp-inline-diff'
  }
  return span
}

function createBlockSection(
  text: string,
  tokenType: 'add' | 'del',
  stateClass: 'added' | 'removed',
): HTMLElement {
  const section = document.createElement('div')
  section.className = `smtcmp-inline-review-section is-${stateClass}`

  text.split('\n').forEach((line) => {
    const lineEl = document.createElement('div')
    lineEl.className = 'smtcmp-inline-review-line'
    lineEl.appendChild(createTokenElement({ type: tokenType, text: line }))
    section.appendChild(lineEl)
  })

  return section
}

function createActionButton(
  icon: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'smtcmp-apply-action'
  if (icon === '✓') {
    button.classList.add('smtcmp-apply-action-accept')
  }
  if (icon === '×') {
    button.classList.add('smtcmp-apply-action-reject')
  }
  button.title = label
  button.setAttribute('aria-label', label)
  const iconEl = document.createElement('span')
  iconEl.className = 'smtcmp-apply-action-icon'
  iconEl.textContent = icon
  button.appendChild(iconEl)
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

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function lineStartOffset(view: EditorView, line: number): number {
  if (line >= view.state.doc.lines) return view.state.doc.length
  return view.state.doc.line(line + 1).from
}

function lineEndOffset(view: EditorView, line: number): number {
  if (line >= view.state.doc.lines) return view.state.doc.length
  return view.state.doc.line(line + 1).to
}

function resolveModifiedBlocks(
  view: EditorView,
  blocks: DiffBlock[],
): ModifiedReviewBlock[] {
  const result: ModifiedReviewBlock[] = []
  let cursorLine = 0

  blocks.forEach((block, blockIndex) => {
    if (block.type !== 'modified') {
      cursorLine += countOriginalLines(block)
      return
    }

    const lineCount = countOriginalLines(block)
    const startLine = cursorLine
    const endLine = lineCount > 0 ? cursorLine + lineCount - 1 : cursorLine
    const from = lineStartOffset(view, startLine)
    const to =
      lineCount > 0
        ? lineEndOffset(view, endLine)
        : lineStartOffset(view, cursorLine)

    result.push({
      blockIndex,
      block,
      from,
      to,
      startLine,
      endLine,
    })

    cursorLine += lineCount
  })

  return result
}

function findSelectionTargetIndex(
  blocks: ModifiedReviewBlock[],
  selectionRange: ApplyViewState['selectionRange'],
): number {
  if (!selectionRange || blocks.length === 0) return 0
  const start = Math.min(selectionRange.from.line, selectionRange.to.line)
  const end = Math.max(selectionRange.from.line, selectionRange.to.line)

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block.startLine <= end && block.endLine >= start) {
      return index
    }
  }
  return 0
}

export class InlineDiffReviewOverlay {
  private readonly blocks: DiffBlock[]
  private readonly session: ReviewSession
  private readonly modifiedBlocks: ModifiedReviewBlock[]
  private currentIndex = 0
  private closed = false

  private readonly decorationCompartment = new Compartment()
  private readonly setDecorationsEffect = StateEffect.define<DecorationSet>()
  private readonly decorationsField: StateField<DecorationSet>
  private floatingRoot: HTMLDivElement | null = null
  private floatingRail: HTMLDivElement | null = null
  private floatingActions: HTMLDivElement | null = null
  private onViewportChange: (() => void) | null = null
  private onKeydown: ((event: KeyboardEvent) => void) | null = null
  private onEditorMouseDownCapture: ((event: MouseEvent) => void) | null = null
  private previousActiveElement: HTMLElement | null = null
  private previousCaretColor = ''
  private onAbort: (() => void) | null = null

  constructor(private readonly options: InlineDiffReviewOverlayOptions) {
    this.blocks = buildInlineReviewBlocks(
      options.state.originalContent,
      options.state.newContent,
    )
    this.session = new ReviewSession({
      file: options.state.file,
      vault: options.plugin.app.vault,
      blocks: this.blocks,
    })
    this.modifiedBlocks = resolveModifiedBlocks(options.view, this.blocks)
    this.currentIndex = findSelectionTargetIndex(
      this.modifiedBlocks,
      options.state.selectionRange,
    )

    const setDecorationsEffect = this.setDecorationsEffect
    this.decorationsField = StateField.define<DecorationSet>({
      create: () => Decoration.none,
      update: (decorations, tr) => {
        const mapped = decorations.map(tr.changes)
        for (const effect of tr.effects) {
          if (effect.is(setDecorationsEffect)) return effect.value
        }
        return mapped
      },
      provide: (field) => EditorView.decorations.from(field),
    })
  }

  mount(): void {
    if (this.modifiedBlocks.length === 0) {
      this.options.onClose()
      return
    }

    const abortSignal = this.options.state.abortSignal
    if (abortSignal?.aborted) {
      this.options.onClose()
      return
    }
    if (abortSignal) {
      const onAbort = () => {
        this.options.onClose()
      }
      this.onAbort = onAbort
      abortSignal.addEventListener('abort', onAbort, { once: true })
    }

    this.options.view.dispatch({
      effects: StateEffect.appendConfig.of([
        this.decorationCompartment.of([this.decorationsField]),
      ]),
    })

    this.mountFloatingControls()
    this.renderBlocks({ ensureVisible: true })
    this.options.onActionsReady?.({
      goToPreviousDiff: () => this.goToPrevious(),
      goToNextDiff: () => this.goToNext(),
      acceptIncomingActive: () => this.acceptIncomingActive(),
      acceptCurrentActive: () => this.acceptCurrentActive(),
      undoActive: () => this.undoActive(),
      close: () => {
        void this.persistAndClose()
      },
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
    this.unmountFloatingControls()
    this.options.view.dispatch({
      effects: this.decorationCompartment.reconfigure([]),
    })
  }

  private mountFloatingControls(): void {
    if (this.floatingRoot) return

    const host = this.options.view.dom
    host.classList.add('smtcmp-inline-review-host')

    const root = document.createElement('div')
    root.className = 'smtcmp-inline-review-floating-root'
    root.tabIndex = -1
    root.setAttribute('aria-label', 'Inline review controls')
    root.style.position = 'absolute'
    root.style.inset = '0'
    root.style.pointerEvents = 'none'
    root.style.overflow = 'visible'
    root.style.zIndex = '8'

    const rail = document.createElement('div')
    rail.className = 'smtcmp-inline-review-floating-rail'
    rail.style.position = 'absolute'
    rail.style.width = '2px'
    rail.style.borderRadius = '999px'
    rail.style.background =
      'color-mix(in srgb, var(--interactive-accent) 65%, transparent)'
    rail.style.opacity = '0.95'
    rail.style.transition = FLOATING_RAIL_POSITION_TRANSITION
    root.appendChild(rail)

    const actions = document.createElement('div')
    actions.className = 'smtcmp-inline-review-floating-actions'
    actions.style.position = 'absolute'
    actions.style.display = 'flex'
    actions.style.flexDirection = 'column'
    actions.style.gap = '10px'
    actions.style.pointerEvents = 'auto'
    actions.style.transition = FLOATING_ACTIONS_POSITION_TRANSITION
    actions.appendChild(
      createActionButton('×', 'Accept current', () =>
        this.acceptCurrentActive(),
      ),
    )
    actions.appendChild(
      createActionButton('✓', 'Accept incoming', () =>
        this.acceptIncomingActive(),
      ),
    )
    root.appendChild(actions)

    host.appendChild(root)

    this.floatingRoot = root
    this.floatingRail = rail
    this.floatingActions = actions

    this.previousActiveElement =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    this.previousCaretColor = this.options.view.contentDOM.style.caretColor
    this.options.view.contentDOM.style.caretColor = 'transparent'
    this.options.view.contentDOM.blur()
    root.focus({ preventScroll: true })

    const onEditorMouseDownCapture = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.smtcmp-inline-review-floating-actions')) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      this.options.view.contentDOM.blur()
      this.floatingRoot?.focus({ preventScroll: true })
    }
    this.onEditorMouseDownCapture = onEditorMouseDownCapture
    this.options.view.contentDOM.addEventListener(
      'mousedown',
      onEditorMouseDownCapture,
      true,
    )

    const onViewportChange = () =>
      this.updateFloatingPosition({ animate: false })
    this.onViewportChange = onViewportChange
    this.options.view.scrollDOM.addEventListener('scroll', onViewportChange, {
      passive: true,
    })
    window.addEventListener('resize', onViewportChange)

    const onKeydown = (event: KeyboardEvent) => {
      if (this.closed) return
      const isMod = event.metaKey || event.ctrlKey
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        void this.persistAndClose()
        return
      }
      if (isMod && event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        this.acceptIncomingActive()
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        this.goToPrevious()
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        this.goToNext()
      }
    }
    this.onKeydown = onKeydown
    window.addEventListener('keydown', onKeydown, true)
  }

  private unmountFloatingControls(): void {
    if (this.onViewportChange) {
      this.options.view.scrollDOM.removeEventListener(
        'scroll',
        this.onViewportChange,
      )
      window.removeEventListener('resize', this.onViewportChange)
    }
    this.onViewportChange = null

    if (this.onKeydown) {
      window.removeEventListener('keydown', this.onKeydown, true)
    }
    this.onKeydown = null

    if (this.onEditorMouseDownCapture) {
      this.options.view.contentDOM.removeEventListener(
        'mousedown',
        this.onEditorMouseDownCapture,
        true,
      )
    }
    this.onEditorMouseDownCapture = null

    if (this.floatingRoot?.parentNode) {
      this.floatingRoot.parentNode.removeChild(this.floatingRoot)
    }
    this.floatingRoot = null
    this.floatingRail = null
    this.floatingActions = null
    this.options.view.dom.classList.remove('smtcmp-inline-review-host')
    this.options.view.contentDOM.style.caretColor = this.previousCaretColor

    if (this.previousActiveElement?.isConnected) {
      this.previousActiveElement.focus({ preventScroll: true })
    }
    this.previousActiveElement = null
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
    const active = this.modifiedBlocks[this.currentIndex]
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
      .querySelector(
        `.smtcmp-inline-review-widget[data-review-index="${this.currentIndex}"]`,
      )
      ?.getBoundingClientRect()

    if (!fromRect && !widgetRect) return

    const top = Math.max(
      6,
      (fromRect?.top ?? widgetRect?.top ?? hostRect.top) - hostRect.top,
    )
    const bottom = Math.min(
      hostRect.height - 6,
      (toRect?.bottom ?? widgetRect?.bottom ?? hostRect.bottom) - hostRect.top,
    )

    const preferredRailLeft =
      (toRect?.right ?? widgetRect?.right ?? hostRect.right) - hostRect.left + 8
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
    const actionsLeft = clampNumber(
      railLeft + 14,
      20,
      Math.max(20, hostRect.width - actionsWidth - 8),
    )
    actions.style.left = `${actionsLeft}px`
    actions.style.top = `${actionTop}px`
  }

  private goToPrevious(): void {
    if (this.modifiedBlocks.length === 0) return
    this.currentIndex =
      this.currentIndex <= 0
        ? this.modifiedBlocks.length - 1
        : this.currentIndex - 1
    this.renderBlocks({ ensureVisible: true })
  }

  private goToNext(): void {
    if (this.modifiedBlocks.length === 0) return
    this.currentIndex = (this.currentIndex + 1) % this.modifiedBlocks.length
    this.renderBlocks({ ensureVisible: true })
  }

  private acceptIncomingActive(): void {
    this.resolveActive('incoming')
  }

  private acceptCurrentActive(): void {
    this.resolveActive('current')
  }

  private undoActive(): void {
    const item = this.modifiedBlocks[this.currentIndex]
    if (!item) return
    this.session.clearDecision(item.blockIndex)
    this.renderBlocks({ ensureVisible: false })
  }

  private resolveActive(decision: 'incoming' | 'current'): void {
    const item = this.modifiedBlocks[this.currentIndex]
    if (!item) return
    this.session.setDecision(item.blockIndex, decision)

    const nextPending = this.findNextPendingIndex(this.currentIndex + 1)
    if (nextPending !== null) {
      this.currentIndex = nextPending
      this.renderBlocks({ ensureVisible: true })
      return
    }

    void this.persistAndClose()
  }

  private findNextPendingIndex(start: number): number | null {
    for (let index = 0; index < this.modifiedBlocks.length; index += 1) {
      const candidate = (start + index) % this.modifiedBlocks.length
      const blockIndex = this.modifiedBlocks[candidate]?.blockIndex
      if (blockIndex === undefined) continue
      const decision = this.session.getDecision(blockIndex)
      if (!decision || decision === 'pending') return candidate
    }
    return null
  }

  private renderBlocks(options: { ensureVisible: boolean }): void {
    const builder = new RangeSetBuilder<Decoration>()
    this.modifiedBlocks.forEach((item, reviewIndex) => {
      const decision = this.session.getDecision(item.blockIndex) ?? 'pending'
      const widget = new InlineReviewWidget(
        item.block,
        reviewIndex,
        reviewIndex === this.currentIndex,
        decision,
        (nextIndex: number) => this.handleHoverActive(nextIndex),
      )

      if (item.from === item.to) {
        builder.add(
          item.from,
          item.from,
          Decoration.widget({ widget, side: 1, block: true }),
        )
      } else {
        builder.add(
          item.from,
          item.to,
          Decoration.replace({ widget, block: true }),
        )
      }
    })

    const active = this.modifiedBlocks[this.currentIndex]
    if (active) {
      this.collapseSelectionNearActive(active)
    }
    if (active && options.ensureVisible) {
      this.options.view.dispatch({
        effects: EditorView.scrollIntoView(active.from, { y: 'nearest' }),
      })
    }

    this.options.view.dispatch({
      effects: this.setDecorationsEffect.of(builder.finish()),
    })

    this.updateFloatingPosition({ animate: true })
  }

  private collapseSelectionNearActive(active: ModifiedReviewBlock): void {
    const docLength = this.options.view.state.doc.length
    let safePos = active.to
    if (safePos < docLength) {
      safePos += 1
    } else if (active.from > 0) {
      safePos = active.from - 1
    }
    safePos = clampNumber(safePos, 0, docLength)

    const selection = this.options.view.state.selection
    if (
      selection.main.from === safePos &&
      selection.main.to === safePos &&
      selection.ranges.length === 1
    ) {
      return
    }

    this.options.view.dispatch({
      selection: {
        anchor: safePos,
        head: safePos,
      },
    })
  }

  private handleHoverActive(nextIndex: number): void {
    if (nextIndex === this.currentIndex) return
    if (nextIndex < 0 || nextIndex >= this.modifiedBlocks.length) return
    this.currentIndex = nextIndex
    this.updateFloatingPosition({ animate: true })
  }

  private async persistAndClose(finalContent?: string): Promise<void> {
    if (this.closed) return
    const resolvedContent =
      finalContent ?? this.session.getFinalContent('current')
    try {
      await this.session.persist(
        resolvedContent,
        this.options.state.abortSignal,
      )
      if (this.options.state.abortSignal?.aborted) {
        return
      }
      this.options.state.callbacks?.onComplete?.({
        finalContent: resolvedContent,
      })
    } catch (error) {
      console.error('[InlineDiffReview] Failed to persist inline review', error)
    } finally {
      this.options.onClose()
    }
  }
}
