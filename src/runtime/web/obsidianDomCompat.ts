export type CreateElOptions = {
  cls?: string | string[]
  text?: string | DocumentFragment
  attr?: Record<string, string | number | undefined>
  type?: string
  value?: string
  href?: string
  title?: string
  placeholder?: string
}

declare global {
  interface HTMLElement {
    createEl(tag: any, options?: any, callback?: any): any
    createDiv(options?: any, callback?: any): any
    createSpan(options?: any, callback?: any): any
    addClass(...classNames: string[]): any
    removeClass(...classNames: string[]): any
    toggleClass(className: string, force?: boolean): any
    empty(): any
    setText(text: string): any
    setAttr(name: string, value: string): any
    setAttrs(attrs: Record<string, string>): any
    setCssProps(props: Record<string, string>): any
  }
}

const DOM_COMPAT_SENTINEL = '__yoloObsidianDomCompatInstalled'

export function applyCreateElOptions(
  el: HTMLElement,
  options?: CreateElOptions | string | DocumentFragment,
): void {
  if (!options) return
  if (typeof options === 'string' || options instanceof DocumentFragment) {
    el.append(options)
    return
  }
  if (options.cls) el.className = Array.isArray(options.cls) ? options.cls.join(' ') : options.cls
  if (options.text) el.append(options.text)
  if (options.attr) {
    for (const [k, v] of Object.entries(options.attr)) {
      if (v !== undefined) el.setAttribute(k, String(v))
    }
  }
  if (options.type && el instanceof HTMLInputElement) el.type = options.type
  if (options.value && el instanceof HTMLInputElement) el.value = options.value
  if (
    options.placeholder &&
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
  ) {
    el.placeholder = options.placeholder
  }
}

export function createCompatElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
): HTMLElementTagNameMap[K] {
  installDomCompat()
  return document.createElement(tagName)
}

export function createEl(
  parent: HTMLElement,
  tag: string,
  options?: CreateElOptions | string | DocumentFragment,
  callback?: (el: HTMLElement) => void,
): HTMLElement {
  const el = document.createElement(tag)
  applyCreateElOptions(el, options)
  parent.append(el)
  callback?.(el)
  return el
}

export function createDiv(
  parent: HTMLElement,
  options?: CreateElOptions | string | DocumentFragment,
  callback?: (el: HTMLElement) => void,
): HTMLElement {
  const el = document.createElement('div')
  if (typeof options === 'string') {
    el.className = options
  } else {
    applyCreateElOptions(el, options)
  }
  parent.append(el)
  callback?.(el)
  return el
}

export function createSpan(
  parent: HTMLElement,
  options?: CreateElOptions | string | DocumentFragment,
  callback?: (el: HTMLElement) => void,
): HTMLElement {
  const el = document.createElement('span')
  if (typeof options === 'string') {
    el.className = options
  } else {
    applyCreateElOptions(el, options)
  }
  parent.append(el)
  callback?.(el)
  return el
}

export function installDomCompat(): void {
  if (typeof HTMLElement === 'undefined') {
    return
  }

  const proto = HTMLElement.prototype as HTMLElement & {
    [DOM_COMPAT_SENTINEL]?: boolean
  }
  if (proto[DOM_COMPAT_SENTINEL]) {
    return
  }
  proto[DOM_COMPAT_SENTINEL] = true

  if (!proto.createEl) {
    proto.createEl = function createElCompat(
      tag,
      options,
      callback,
    ): HTMLElement {
      return createEl(this, tag, options, callback)
    }
  }

  if (!proto.createDiv) {
    proto.createDiv = function createDivCompat(
      options,
      callback,
    ): HTMLElement {
      return createDiv(this, options, callback)
    }
  }

  if (!proto.createSpan) {
    proto.createSpan = function createSpanCompat(
      options,
      callback,
    ): HTMLElement {
      return createSpan(this, options, callback)
    }
  }

  if (!proto.addClass) {
    proto.addClass = function addClassCompat(...classNames: string[]) {
      this.classList.add(
        ...classNames.flatMap((name) => name.split(' ')).filter(Boolean),
      )
    }
  }

  if (!proto.removeClass) {
    proto.removeClass = function removeClassCompat(...classNames: string[]) {
      this.classList.remove(
        ...classNames.flatMap((name) => name.split(' ')).filter(Boolean),
      )
    }
  }

  if (!proto.toggleClass) {
    proto.toggleClass = function toggleClassCompat(
      className: string,
      force?: boolean,
    ) {
      if (force !== undefined) {
        this.classList.toggle(className, force)
      } else {
        this.classList.toggle(className)
      }
    }
  }

  if (!proto.empty) {
    proto.empty = function emptyCompat() {
      this.replaceChildren()
    }
  }

  if (!proto.setText) {
    proto.setText = function setTextCompat(text: string) {
      this.textContent = text
    }
  }

  if (!proto.setAttr) {
    proto.setAttr = function setAttrCompat(name: string, value: string) {
      this.setAttribute(name, value)
    }
  }

  if (!proto.setAttrs) {
    proto.setAttrs = function setAttrsCompat(attrs: Record<string, string>) {
      Object.entries(attrs).forEach(([key, value]) => {
        this.setAttribute(key, value)
      })
    }
  }

  if (!proto.setCssProps) {
    proto.setCssProps = function setCssPropsCompat(
      props: Record<string, string>,
    ) {
      Object.entries(props).forEach(([key, value]) => {
        this.style.setProperty(key, value)
      })
    }
  }
}
