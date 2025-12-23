import { StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view'

export type InlineSuggestionGhostPayload = { from: number; text: string } | null

export const inlineSuggestionGhostEffect =
  StateEffect.define<InlineSuggestionGhostPayload>()

export type ThinkingIndicatorPayload = {
  from: number
  label: string
  snippet?: string
} | null

export const thinkingIndicatorEffect =
  StateEffect.define<ThinkingIndicatorPayload>()

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
    container.className = 'smtcmp-thinking-indicator-inline'

    // 创建思考动画容器
    const loader = document.createElement('span')
    loader.className = 'smtcmp-thinking-loader'

    // 图标容器
    const icon = document.createElement('span')
    icon.className = 'smtcmp-thinking-icon'

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
    svg.classList.add('smtcmp-thinking-icon-svg')

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
    textEl.className = 'smtcmp-thinking-text'
    textEl.textContent = this.label

    loader.appendChild(icon)
    loader.appendChild(textEl)
    if (this.snippet) {
      const snippetEl = document.createElement('span')
      snippetEl.className = 'smtcmp-thinking-snippet'
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

class InlineSuggestionGhostWidget extends WidgetType {
  constructor(private readonly text: string) {
    super()
  }

  eq(other: InlineSuggestionGhostWidget) {
    return this.text === other.text
  }

  ignoreEvent(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'smtcmp-ghost-text'
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
          widget: new InlineSuggestionGhostWidget(payload.text),
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
