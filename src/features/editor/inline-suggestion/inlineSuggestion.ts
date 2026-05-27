import { StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view'

export type InlineSuggestionGhostVariant =
  | 'default'
  | 'voice-asr'
  | 'voice-polished'

export type InlineSuggestionGhostPayload = {
  from: number
  text: string
  variant?: InlineSuggestionGhostVariant
} | null

export const inlineSuggestionGhostEffect =
  StateEffect.define<InlineSuggestionGhostPayload>()

export type ThinkingIndicatorPayload = {
  from: number
  label: string
  snippet?: string
} | null

export const thinkingIndicatorEffect =
  StateEffect.define<ThinkingIndicatorPayload>()

export type VoiceStatusChipState =
  | 'recording'
  | 'transcribing'
  | 'polishing'
  | 'ready'

export type VoiceStatusChipPayload = {
  from: number
  state: VoiceStatusChipState
  /** Display label shown inside the chip; localised by the caller. */
  label: string
  /** Optional second line (e.g. "Tab 已暂停 · Esc 取消"). */
  hint?: string
  /** Elapsed time in milliseconds, shown only while recording. */
  elapsedMs?: number
  /** Callback invoked when the user clicks the cancel/stop button. */
  onCancel?: () => void
} | null

export const voiceStatusChipEffect =
  StateEffect.define<VoiceStatusChipPayload>()

class VoiceStatusChipWidget extends WidgetType {
  constructor(private readonly payload: NonNullable<VoiceStatusChipPayload>) {
    super()
  }

  eq(other: VoiceStatusChipWidget) {
    return (
      this.payload.state === other.payload.state &&
      this.payload.label === other.payload.label &&
      this.payload.hint === other.payload.hint &&
      this.payload.elapsedMs === other.payload.elapsedMs &&
      this.payload.onCancel === other.payload.onCancel
    )
  }

  ignoreEvent(event: Event): boolean {
    // Allow clicks on the cancel button to reach our handler; suppress other
    // CodeMirror routing so the widget doesn't move the caret.
    if (event.type === 'mousedown' || event.type === 'click') {
      return false
    }
    return true
  }

  toDOM(): HTMLElement {
    const root = document.createElement('span')
    root.className = `yolo-voice-status-chip yolo-voice-status-chip--${this.payload.state}`

    const dot = document.createElement('span')
    dot.className = 'yolo-voice-status-chip__dot'
    root.appendChild(dot)

    const label = document.createElement('span')
    label.className = 'yolo-voice-status-chip__label'
    label.textContent = this.payload.label
    root.appendChild(label)

    if (typeof this.payload.elapsedMs === 'number') {
      const timer = document.createElement('span')
      timer.className = 'yolo-voice-status-chip__timer'
      timer.textContent = formatChipTimer(this.payload.elapsedMs)
      root.appendChild(timer)
    }

    if (this.payload.hint) {
      const hint = document.createElement('span')
      hint.className = 'yolo-voice-status-chip__hint'
      hint.textContent = this.payload.hint
      root.appendChild(hint)
    }

    if (this.payload.onCancel) {
      const cancel = document.createElement('button')
      cancel.className = 'yolo-voice-status-chip__cancel'
      cancel.type = 'button'
      cancel.setAttribute('aria-label', 'Cancel voice input')
      cancel.textContent = '✕'
      cancel.addEventListener('mousedown', (e) => {
        // Prevent CodeMirror from stealing focus / moving the caret.
        e.preventDefault()
        e.stopPropagation()
      })
      cancel.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.payload.onCancel?.()
      })
      root.appendChild(cancel)
    }

    return root
  }
}

const formatChipTimer = (elapsedMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export const voiceStatusChipField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(value, tr) {
    let decorations = value.map(tr.changes)

    for (const effect of tr.effects) {
      if (effect.is(voiceStatusChipEffect)) {
        const payload = effect.value
        if (!payload) {
          decorations = Decoration.none
          continue
        }
        const widget = Decoration.widget({
          widget: new VoiceStatusChipWidget(payload),
          side: 1,
        }).range(payload.from)
        decorations = Decoration.set([widget])
      }
    }

    return decorations
  },
  provide: (field) => EditorView.decorations.from(field),
})

class ThinkingIndicatorWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly snippet?: string,
  ) {
    super()
  }

  eq(other: ThinkingIndicatorWidget) {
    return this.label === other.label && this.snippet === other.snippet
  }

  ignoreEvent(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const container = document.createElement('span')
    container.className = 'yolo-thinking-indicator-inline'

    // 创建思考动画容器
    const loader = document.createElement('span')
    loader.className = 'yolo-thinking-loader'

    // 图标容器
    const icon = document.createElement('span')
    icon.className = 'yolo-thinking-icon'

    // SVG 图标 (Sparkles)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '12')
    svg.setAttribute('height', '12')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.classList.add('yolo-thinking-icon-svg')

    const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path1.setAttribute(
      'd',
      'm12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z',
    )
    const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path2.setAttribute('d', 'M5 3v4')
    const path3 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path3.setAttribute('d', 'M19 17v4')
    const path4 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path4.setAttribute('d', 'M3 5h4')
    const path5 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path5.setAttribute('d', 'M17 19h4')

    svg.appendChild(path1)
    svg.appendChild(path2)
    svg.appendChild(path3)
    svg.appendChild(path4)
    svg.appendChild(path5)

    icon.appendChild(svg)

    // 文字
    const textEl = document.createElement('span')
    textEl.className = 'yolo-thinking-text'
    textEl.textContent = this.label

    loader.appendChild(icon)
    loader.appendChild(textEl)
    if (this.snippet) {
      const snippetEl = document.createElement('span')
      snippetEl.className = 'yolo-thinking-snippet'
      snippetEl.textContent = this.snippet
      loader.appendChild(snippetEl)
    }
    container.appendChild(loader)

    return container
  }
}

export const thinkingIndicatorField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(value, tr) {
    let decorations = value.map(tr.changes)

    for (const effect of tr.effects) {
      if (effect.is(thinkingIndicatorEffect)) {
        const payload = effect.value
        if (!payload) {
          decorations = Decoration.none
          continue
        }
        const widget = Decoration.widget({
          widget: new ThinkingIndicatorWidget(payload.label, payload.snippet),
          side: 1,
        }).range(payload.from)
        decorations = Decoration.set([widget])
      }
    }

    if (tr.docChanged) {
      decorations = Decoration.none
    }

    return decorations
  },
  provide: (field) => EditorView.decorations.from(field),
})

export type TabLoadingDotsPayload = { from: number } | null

export const tabLoadingDotsEffect = StateEffect.define<TabLoadingDotsPayload>()

class TabLoadingDotsWidget extends WidgetType {
  eq(_other: TabLoadingDotsWidget) {
    return true
  }

  ignoreEvent(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const container = document.createElement('span')
    container.className = 'yolo-tab-loading-dots'
    container.setAttribute('aria-hidden', 'true')
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span')
      dot.className = 'yolo-tab-loading-dots__dot'
      container.appendChild(dot)
    }
    return container
  }
}

export const tabLoadingDotsField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(value, tr) {
    let decorations = value.map(tr.changes)

    for (const effect of tr.effects) {
      if (effect.is(tabLoadingDotsEffect)) {
        const payload = effect.value
        if (!payload) {
          decorations = Decoration.none
          continue
        }
        const widget = Decoration.widget({
          widget: new TabLoadingDotsWidget(),
          side: 1,
        }).range(payload.from)
        decorations = Decoration.set([widget])
      }
    }

    if (tr.docChanged) {
      decorations = Decoration.none
    }

    return decorations
  },
  provide: (field) => EditorView.decorations.from(field),
})

class InlineSuggestionGhostWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly variant: InlineSuggestionGhostVariant = 'default',
  ) {
    super()
  }

  eq(other: InlineSuggestionGhostWidget) {
    return this.text === other.text && this.variant === other.variant
  }

  ignoreEvent(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    const baseClass = 'yolo-ghost-text'
    const variantClass =
      this.variant === 'voice-asr'
        ? `${baseClass}--voice-asr`
        : this.variant === 'voice-polished'
          ? `${baseClass}--voice-polished`
          : null
    span.className = variantClass ? `${baseClass} ${variantClass}` : baseClass
    span.textContent = this.text
    return span
  }
}

export const inlineSuggestionGhostField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(value, tr) {
    let decorations = value.map(tr.changes)

    for (const effect of tr.effects) {
      if (effect.is(inlineSuggestionGhostEffect)) {
        const payload = effect.value
        if (!payload) {
          decorations = Decoration.none
          continue
        }
        const widget = Decoration.widget({
          widget: new InlineSuggestionGhostWidget(
            payload.text,
            payload.variant ?? 'default',
          ),
          side: 1,
        }).range(payload.from)
        decorations = Decoration.set([widget])
      }
    }

    if (tr.docChanged) {
      decorations = Decoration.none
    }

    return decorations
  },
  provide: (field) => EditorView.decorations.from(field),
})
