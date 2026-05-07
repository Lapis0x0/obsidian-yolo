import { createDiv, createEl, type CreateElOptions } from './obsidianDomCompat'

export class Component {
  private _loaded = false
  private _children: Component[] = []
  private _callbacks: Array<() => any> = []
  private _domEventRefs: Array<{
    el: EventTarget
    type: string
    cb: EventListener
    opts?: boolean | AddEventListenerOptions
  }> = []
  private _intervals: number[] = []

  load(): void {
    if (this._loaded) return
    this._loaded = true
    this.onload()
    for (const child of [...this._children]) child.load()
  }

  onload(): void {}

  unload(): void {
    if (!this._loaded) return
    this._loaded = false
    this.onunload()
    for (const child of [...this._children]) child.unload()
    for (const cb of this._callbacks.reverse()) cb()
    this._callbacks = []
    for (const ref of this._domEventRefs) {
      ref.el.removeEventListener(ref.type, ref.cb, ref.opts)
    }
    this._domEventRefs = []
    for (const id of this._intervals) window.clearInterval(id)
    this._intervals = []
    this._children = []
  }

  onunload(): void {}

  addChild<T extends Component>(component: T): T {
    this._children.push(component)
    if (this._loaded) component.load()
    return component
  }

  removeChild<T extends Component>(component: T): T {
    const idx = this._children.indexOf(component)
    if (idx !== -1) {
      this._children.splice(idx, 1)
      component.unload()
    }
    return component
  }

  register(cb: () => any): void {
    this._callbacks.push(cb)
  }

  registerEvent(eventRef: { off?: () => void } | null | undefined): void {
    this.register(() => eventRef?.off?.())
  }

  registerDomEvent(
    el: EventTarget,
    type: string,
    callback: EventListener,
    options?: boolean | AddEventListenerOptions,
  ): void {
    el.addEventListener(type, callback, options)
    this._domEventRefs.push({ el, type, cb: callback, opts: options })
  }

  registerInterval(id: number): number {
    this._intervals.push(id)
    return id
  }
}

export abstract class BaseComponent {
  disabled = false

  then(cb: (component: this) => any): this {
    cb(this)
    return this
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled
    return this
  }
}

export abstract class ValueComponent<T> extends BaseComponent {
  abstract getValue(): T
  abstract setValue(value: T): this

  registerOptionListener(
    _listeners: Record<string, (value?: T) => T>,
    _key: string,
  ): this {
    return this
  }
}

export abstract class AbstractTextComponent<
  T extends HTMLInputElement | HTMLTextAreaElement,
> extends ValueComponent<string> {
  inputEl: T
  private _changeCallback?: (value: string) => any
  private _changedCallback?: () => void

  constructor(inputEl: T) {
    super()
    this.inputEl = inputEl
    this.inputEl.addEventListener('input', () => {
      this._changeCallback?.(this.inputEl.value)
      this._changedCallback?.()
    })
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled)
    this.inputEl.disabled = disabled
    return this
  }

  getValue(): string {
    return this.inputEl.value
  }

  setValue(value: string): this {
    this.inputEl.value = value
    return this
  }

  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder
    return this
  }

  onChanged(): void {
    this._changedCallback?.()
  }

  onChange(callback: (value: string) => any): this {
    this._changeCallback = callback
    return this
  }
}

export class TextComponent extends AbstractTextComponent<HTMLInputElement> {
  constructor(containerEl: HTMLElement) {
    super(createEl(containerEl, 'input', { type: 'text' }) as HTMLInputElement)
  }
}

export class TextAreaComponent extends AbstractTextComponent<HTMLTextAreaElement> {
  constructor(containerEl: HTMLElement) {
    super(createEl(containerEl, 'textarea') as HTMLTextAreaElement)
  }
}

export class ButtonComponent extends BaseComponent {
  buttonEl: HTMLButtonElement
  private clickCallback?: (evt: MouseEvent) => any

  constructor(containerEl: HTMLElement) {
    super()
    this.buttonEl = createEl(containerEl, 'button') as HTMLButtonElement
    this.buttonEl.addEventListener('click', async (evt: MouseEvent) => {
      const cb = this.clickCallback
      if (this.disabled || !cb) return
      this.buttonEl.addClass('mod-loading')
      try {
        await cb(evt)
      } finally {
        this.buttonEl.removeClass('mod-loading')
      }
    })
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled)
    this.buttonEl.disabled = disabled
    return this
  }

  setCta(): this {
    this.buttonEl.addClass('mod-cta')
    return this
  }

  removeCta(): this {
    this.buttonEl.removeClass('mod-cta')
    return this
  }

  setWarning(): this {
    this.buttonEl.addClass('mod-warning')
    return this
  }

  setTooltip(tooltip: string, _options?: unknown): this {
    this.buttonEl.setAttr('aria-label', tooltip)
    this.buttonEl.title = tooltip
    return this
  }

  setButtonText(name: string): this {
    this.buttonEl.empty()
    this.buttonEl.setText(name)
    return this
  }

  setIcon(icon: string): this {
    this.buttonEl.setAttr('data-icon', icon)
    return this
  }

  setClass(cls: string): this {
    this.buttonEl.addClass(cls)
    return this
  }

  onClick(callback: (evt: MouseEvent) => any): this {
    this.clickCallback = callback
    return this
  }
}

export class DropdownComponent extends ValueComponent<string> {
  selectEl: HTMLSelectElement
  private changeCallback?: (value: string) => any

  constructor(containerEl: HTMLElement) {
    super()
    this.selectEl = createEl(
      containerEl,
      'select',
      'dropdown',
    ) as HTMLSelectElement
    this.selectEl.addEventListener('change', () => {
      this.changeCallback?.(this.selectEl.value)
    })
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled)
    this.selectEl.disabled = disabled
    return this
  }

  addOption(value: string, display: string): this {
    createEl(this.selectEl, 'option', { text: display, attr: { value } })
    return this
  }

  addOptions(options: Record<string, string>): this {
    for (const [value, text] of Object.entries(options)) this.addOption(value, text)
    return this
  }

  getValue(): string {
    return this.selectEl.value
  }

  setValue(value: string): this {
    this.selectEl.value = value
    return this
  }

  onChange(callback: (value: string) => any): this {
    this.changeCallback = callback
    return this
  }
}

export class ToggleComponent extends ValueComponent<boolean> {
  toggleEl: HTMLElement
  private inputEl: HTMLInputElement
  private changeCallback?: (value: boolean) => any

  constructor(containerEl: HTMLElement) {
    super()
    this.toggleEl = createEl(
      containerEl,
      'label',
      {
        cls: 'checkbox-container',
        attr: { tabIndex: 0 },
      } satisfies CreateElOptions,
      (label) => {
        this.inputEl = createEl(label, 'input', {
          attr: { type: 'checkbox', tabIndex: 0 },
        }) as HTMLInputElement
      },
    ) as HTMLElement

    this.inputEl.addEventListener('change', () => {
      this.changeCallback?.(this.inputEl.checked)
    })
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled)
    this.inputEl.disabled = disabled
    return this
  }

  getValue(): boolean {
    return this.inputEl.checked
  }

  setValue(on: boolean): this {
    this.inputEl.checked = on
    return this
  }

  setTooltip(tooltip: string, _options?: unknown): this {
    this.toggleEl.setAttr('aria-label', tooltip)
    return this
  }

  onChange(callback: (value: boolean) => any): this {
    this.changeCallback = callback
    return this
  }
}

export class Setting {
  settingEl: HTMLElement
  infoEl: HTMLElement
  nameEl: HTMLElement
  descEl: HTMLElement
  controlEl: HTMLElement
  components: BaseComponent[] = []

  constructor(containerEl: HTMLElement) {
    this.settingEl = createDiv(containerEl, 'setting-item')
    this.infoEl = createDiv(this.settingEl, 'setting-item-info')
    this.nameEl = createDiv(this.infoEl, 'setting-item-name')
    this.descEl = createDiv(this.infoEl, 'setting-item-description')
    this.controlEl = createDiv(this.settingEl, 'setting-item-control')
  }

  setName(name: string | DocumentFragment): this {
    this.nameEl.empty()
    this.nameEl.append(name)
    return this
  }

  setDesc(desc: string | DocumentFragment): this {
    this.descEl.empty()
    this.descEl.append(desc)
    return this
  }

  setHeading(): this {
    this.settingEl.addClass('setting-item-heading')
    return this
  }

  setClass(cls: string): this {
    this.settingEl.addClass(cls)
    return this
  }

  setDisabled(disabled: boolean): this {
    if (disabled) this.settingEl.addClass('is-disabled')
    else this.settingEl.removeClass('is-disabled')
    this.components.forEach((c) => c.setDisabled(disabled))
    return this
  }

  setTooltip(tooltip: string, _options?: unknown): this {
    this.nameEl.setAttr('aria-label', tooltip)
    return this
  }

  setControl(controlEl: HTMLElement): this {
    this.controlEl.empty()
    this.controlEl.append(controlEl)
    return this
  }

  private _addComponent<T extends BaseComponent>(component: T): T {
    this.components.push(component)
    return component
  }

  addButton(cb: (component: ButtonComponent) => any): this {
    const comp = new ButtonComponent(this.controlEl)
    this._addComponent(comp)
    cb(comp)
    return this
  }

  addToggle(cb: (component: ToggleComponent) => any): this {
    const comp = new ToggleComponent(this.controlEl)
    this._addComponent(comp)
    cb(comp)
    return this
  }

  addText(cb: (component: TextComponent) => any): this {
    const comp = new TextComponent(this.controlEl)
    this._addComponent(comp)
    cb(comp)
    return this
  }

  addTextArea(cb: (component: TextAreaComponent) => any): this {
    const comp = new TextAreaComponent(this.controlEl)
    this._addComponent(comp)
    cb(comp)
    return this
  }

  addDropdown(cb: (component: DropdownComponent) => any): this {
    const comp = new DropdownComponent(this.controlEl)
    this._addComponent(comp)
    cb(comp)
    return this
  }

  then(cb: (setting: this) => any): this {
    cb(this)
    return this
  }

  clear(): this {
    this.controlEl.empty()
    this.components = []
    return this
  }
}
