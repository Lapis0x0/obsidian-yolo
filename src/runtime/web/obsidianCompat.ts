/**
 * Comprehensive mock-obsidian implementation
 *
 * DOM structures reverse-engineered from Obsidian app.js (v1.8.4+)
 * to ensure CSS class compatibility with styles.css.
 *
 * Type signatures sourced from the official obsidian.d.ts public API.
 */

import {
  normalizePath,
  TAbstractFile,
  TFile,
  TFolder,
} from './obsidianFileModel';
import {
  createDiv,
  createEl,
  createSpan,
  installDomCompat,
} from './obsidianDomCompat';
import type { CreateElOptions } from './obsidianDomCompat';
import {
  AbstractTextComponent,
  BaseComponent,
  ButtonComponent,
  Component,
  DropdownComponent,
  Setting as SettingBase,
  TextAreaComponent,
  TextComponent,
  ToggleComponent,
  ValueComponent,
} from './obsidianUiCompat';
import { htmlToMarkdown } from './obsidianTextCompat';
export { htmlToMarkdown };

installDomCompat();

// ============================================================================
// Types
// ============================================================================

export type IconName = string;
export type PaneType = 'tab' | 'split' | 'window' | boolean;
export type Modifier = 'Mod' | 'Ctrl' | 'Meta' | 'Shift' | 'Alt';
export type KeymapEventListener = (evt: KeyboardEvent, ctx: KeymapContext) => false | any;
export type HexString = string;
export type MarkdownViewModeType = 'source' | 'preview';
export type EditorCommandName =
  | 'goUp' | 'goDown' | 'goLeft' | 'goRight'
  | 'goStart' | 'goEnd' | 'goWordLeft' | 'goWordRight'
  | 'indentMore' | 'indentLess' | 'newlineAndIndent'
  | 'swapLineUp' | 'swapLineDown' | 'deleteLine'
  | 'toggleFold' | 'foldAll' | 'unfoldAll';

// ============================================================================
// Interfaces
// ============================================================================

export interface EventRef {}

export interface CloseableComponent {
  close(): void;
}

export interface HoverParent {
  hoverPopover: HoverPopover | null;
}

export interface MarkdownFileInfo extends HoverParent {
  app: App;
  get file(): TFile | null;
  editor?: Editor;
}

export interface MarkdownPreviewEvents extends Component {}

export interface EditorPosition {
  line: number;
  ch: number;
}

export interface EditorRange {
  from: EditorPosition;
  to: EditorPosition;
}

export interface EditorRangeOrCaret {
  from: EditorPosition;
  to?: EditorPosition;
}

export interface EditorSelection {
  anchor: EditorPosition;
  head: EditorPosition;
}

export interface EditorSelectionOrCaret {
  anchor: EditorPosition;
  head?: EditorPosition;
}

export interface EditorScrollInfo {
  left: number;
  top: number;
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
}

export interface EditorChange extends EditorRangeOrCaret {
  text: string;
}

export interface EditorTransaction {
  changes?: EditorChange[];
  selection?: EditorSelectionOrCaret;
}

export interface MarkdownSectionInformation {
  text: string;
  lineStart: number;
  lineEnd: number;
}

export interface MenuPositionDef {
  x: number;
  y: number;
  width?: number;
  overlap?: boolean;
  left?: boolean;
}

export interface KeymapInfo {
  modifiers: string | null;
  key: string | null;
}

export interface KeymapContext extends KeymapInfo {
  vkey: string;
}

export interface KeymapEventHandler extends KeymapInfo {
  scope: Scope;
}

export interface Point {
  x: number;
  y: number;
}

export interface Loc {
  line: number;
  col: number;
  offset: number;
}

export interface Pos {
  start: Loc;
  end: Loc;
}

export interface SearchResult {
  score: number;
  matches: SearchMatches;
}

export type SearchMatches = SearchMatchPart[];
export type SearchMatchPart = [number, number];

export interface SearchResultContainer {
  match: SearchResult;
}

export interface Stat {
  ctime: number;
  mtime: number;
  size: number;
}

export interface FileStats {
  ctime: number;
  mtime: number;
  size: number;
}

export interface ListedFiles {
  files: string[];
  folders: string[];
}

export interface DataWriteOptions {
  ctime?: number;
  mtime?: number;
}

export interface OpenViewState {
  state?: Record<string, unknown>;
  eState?: Record<string, unknown>;
  active?: boolean;
  group?: string;
}

export interface ViewState {
  type: string;
  state?: Record<string, unknown>;
  active?: boolean;
  pinned?: boolean;
  group?: string;
}

export interface ViewStateResult {
  history: boolean;
}

export interface TooltipOptions {
  placement?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}

export interface UserEvent {
  type: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

// ============================================================================
// Core classes
// ============================================================================

export class Events {
  private _handlers: Map<string, Array<{ cb: (...data: unknown[]) => unknown; ctx?: any }>> = new Map();
  private _refs: EventRef[] = [];

  on(name: string, callback: (...data: unknown[]) => unknown, ctx?: any): EventRef {
    if (!this._handlers.has(name)) {
      this._handlers.set(name, []);
    }
    this._handlers.get(name)!.push({ cb: callback, ctx });
    const ref: EventRef = {};
    this._refs.push(ref);
    return ref;
  }

  off(name: string, callback: (...data: unknown[]) => unknown): void {
    const handlers = this._handlers.get(name);
    if (handlers) {
      const idx = handlers.findIndex((h) => h.cb === callback);
      if (idx !== -1) handlers.splice(idx, 1);
    }
  }

  offref(ref: EventRef): void {
    const idx = this._refs.indexOf(ref);
    if (idx !== -1) this._refs.splice(idx, 1);
  }

  trigger(name: string, ...data: unknown[]): void {
    const handlers = this._handlers.get(name);
    if (handlers) {
      for (const h of [...handlers]) {
        h.cb.call(h.ctx, ...data);
      }
    }
  }

  tryTrigger(evt: EventRef, args: unknown[]): void {
    if (this._refs.includes(evt)) {
      this.trigger('', ...args);
    }
  }
}

export { AbstractTextComponent, BaseComponent, ButtonComponent, Component, DropdownComponent, TextAreaComponent, TextComponent, ToggleComponent, ValueComponent };

export class SearchComponent extends AbstractTextComponent<HTMLInputElement> {
  /**
   * DOM: div.search-input-container > input[type="search"] + div.search-input-clear-button
   */
  clearButtonEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    const wrapper = createDiv(containerEl, 'search-input-container');
    const inputEl = createEl(wrapper, 'input', {
      type: 'search',
      attr: { enterkeyhint: 'search' },
    }) as HTMLInputElement;
    super(inputEl);

    this.clearButtonEl = createDiv(wrapper, 'search-input-clear-button', (el) => {
      (el as any).addClass('clickable-icon');
      el.addEventListener('click', () => {
        inputEl.value = '';
        inputEl.dispatchEvent(new Event('input'));
      });
    });
  }
}

export class ExtraButtonComponent extends BaseComponent {
  extraSettingsEl: HTMLElement;
  private clickCallback?: () => any;

  /**
   * DOM: div.clickable-icon.extra-setting-button
   */
  constructor(containerEl: HTMLElement) {
    super();
    this.extraSettingsEl = createDiv(containerEl, 'clickable-icon extra-setting-button');
    this.extraSettingsEl.addEventListener('click', () => {
      this.clickCallback?.();
    });
  }

  setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    return this;
  }

  setTooltip(tooltip: string, _options?: TooltipOptions): this {
    this.extraSettingsEl.setAttr('aria-label', tooltip);
    return this;
  }

  setIcon(icon: IconName): this {
    this.extraSettingsEl.setAttr('data-icon', icon);
    return this;
  }

  onClick(callback: () => any): this {
    this.clickCallback = callback;
    return this;
  }
}


export class SliderComponent extends ValueComponent<number> {
  /**
   * DOM: input[type="range"].slider
   */
  private inputEl: HTMLInputElement;
  private changeCallback?: (value: number) => any;

  constructor(containerEl: HTMLElement) {
    super();
    this.inputEl = createEl(containerEl, 'input', {
      type: 'range',
      cls: 'slider',
    }) as HTMLInputElement;
    this.inputEl.addEventListener('input', () => {
      this.changeCallback?.(Number(this.inputEl.value));
    });
  }

  getValue(): number {
    return Number(this.inputEl.value);
  }

  setValue(value: number): this {
    this.inputEl.value = String(value);
    return this;
  }

  setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.inputEl.disabled = disabled;
    return this;
  }

  setLimits(min: number, max: number, step: number): this {
    this.inputEl.min = String(min);
    this.inputEl.max = String(max);
    this.inputEl.step = String(step);
    return this;
  }

  onChange(callback: (value: number) => any): this {
    this.changeCallback = callback;
    return this;
  }

  getValuePretty(value: number): string {
    return String(value);
  }
}

export class ColorComponent extends ValueComponent<string> {
  /**
   * DOM: input[type="color"]
   */
  private inputEl: HTMLInputElement;
  private changeCallback?: (value: string) => any;

  constructor(containerEl: HTMLElement) {
    super();
    this.inputEl = createEl(containerEl, 'input', { type: 'color' }) as HTMLInputElement;
    this.inputEl.addEventListener('input', () => {
      this.changeCallback?.(this.inputEl.value);
    });
  }

  setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.inputEl.disabled = disabled;
    return this;
  }

  getValue(): HexString {
    return this.inputEl.value as HexString;
  }

  getValueRgb(): { r: number; g: number; b: number } {
    const hex = this.inputEl.value.replace('#', '');
    return {
      r: parseInt(hex.substring(0, 2), 16),
      g: parseInt(hex.substring(2, 4), 16),
      b: parseInt(hex.substring(4, 6), 16),
    };
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  onChange(callback: (value: string) => any): this {
    this.changeCallback = callback;
    return this;
  }
}

export class ProgressBarComponent extends ValueComponent<number> {
  private progressBar: HTMLElement;
  private lineEl: HTMLElement;
  private value = 0;

  /**
   * DOM: div.setting-progress-bar > div.setting-progress-bar-inner
   */
  constructor(containerEl: HTMLElement) {
    super();
    this.progressBar = createDiv(containerEl, 'setting-progress-bar', (bar) => {
      this.lineEl = createDiv(bar, 'setting-progress-bar-inner');
    });
  }

  getValue(): number {
    return this.value;
  }

  setValue(value: number): this {
    this.value = Math.max(0, Math.min(100, value));
    this.lineEl.style.width = `${this.value}%`;
    return this;
  }

  setVisibility(visible: boolean): this {
    (this.progressBar as any).hidden = !visible;
    return this;
  }
}

export class MomentFormatComponent extends ValueComponent<string> {
  /**
   * DOM: select.dropdown
   */
  private selectEl: HTMLSelectElement;
  private changeCallback?: (value: string) => any;

  constructor(containerEl: HTMLElement) {
    super();
    this.selectEl = createEl(containerEl, 'select', 'dropdown') as HTMLSelectElement;
    this.selectEl.addEventListener('change', () => {
      this.changeCallback?.(this.selectEl.value);
    });
  }

  getValue(): string {
    return this.selectEl.value;
  }

  setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }

  setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.selectEl.disabled = disabled;
    return this;
  }

  onChange(callback: (value: string) => any): this {
    this.changeCallback = callback;
    return this;
  }
}

// ============================================================================
// Setting
// ============================================================================

export class Setting extends SettingBase {
  private heading = false;

  /**
   * DOM: div.setting-item > (div.setting-item-info > div.setting-item-name + div.setting-item-description) + div.setting-item-control
   */
  constructor(containerEl: HTMLElement) {
    super(containerEl);
  }

  setName(name: string | DocumentFragment): this {
    this.nameEl.empty();
    if (typeof name === 'string') {
      this.nameEl.setText(name);
    } else {
      this.nameEl.append(name);
    }
    return this;
  }

  setDesc(desc: string | DocumentFragment): this {
    this.descEl.empty();
    if (typeof desc === 'string') {
      this.descEl.setText(desc);
    } else {
      this.descEl.append(desc);
    }
    return this;
  }

  setClass(cls: string): this {
    this.settingEl.addClass(cls);
    return this;
  }

  setTooltip(tooltip: string, _options?: TooltipOptions): this {
    this.settingEl.setAttr('aria-label', tooltip);
    return this;
  }

  setHeading(): this {
    this.heading = true;
    this.settingEl.addClass('setting-item-heading');
    this.infoEl.remove();
    return this;
  }

  setDisabled(disabled: boolean): this {
    for (const comp of this.components) {
      comp.setDisabled(disabled);
    }
    return this;
  }

  addButton(cb: (component: ButtonComponent) => any): this {
    const comp = new ButtonComponent(this.controlEl);
    this.components.push(comp);
    cb(comp);
    return this;
  }

  addExtraButton(cb: (component: ExtraButtonComponent) => any): this {
    const comp = new ExtraButtonComponent(this.controlEl);
    this.components.push(comp);
    cb(comp);
    return this;
  }

  addToggle(cb: (component: ToggleComponent) => any): this {
    const comp = new ToggleComponent(this.controlEl);
    this.components.push(comp);
    cb(comp);
    return this;
  }

  addText(cb: (component: TextComponent) => any): this {
    const comp = new TextComponent(this.controlEl);
    this.components.push(comp);
    cb(comp);
    return this;
  }

  addSearch(cb: (component: SearchComponent) => any): this {
    const comp = new SearchComponent(this.controlEl);
    this.components.push(comp);
    cb(comp);
    return this;
  }

  addTextArea(cb: (component: TextAreaComponent) => any): this {
    const comp = new TextAreaComponent(this.controlEl);
    this.components.push(comp);
    cb(comp);
    return this;
  }

  addMomentFormat(cb: (component: MomentFormatComponent) => any): this {
    const comp = new MomentFormatComponent(this.controlEl);
    this.components.push(comp);
    cb(comp);
    return this;
  }

  addDropdown(cb: (component: DropdownComponent) => any): this {
    const comp = new DropdownComponent(this.controlEl);
    this.components.push(comp);
    cb(comp);
    return this;
  }

  addColorPicker(cb: (component: ColorComponent) => any): this {
    const comp = new ColorComponent(this.controlEl);
    this.components.push(comp);
    cb(comp);
    return this;
  }

  addProgressBar(cb: (component: ProgressBarComponent) => any): this {
    const comp = new ProgressBarComponent(this.controlEl);
    this.components.push(comp);
    cb(comp);
    return this;
  }

  addSlider(cb: (component: SliderComponent) => any): this {
    const comp = new SliderComponent(this.controlEl);
    this.components.push(comp);
    cb(comp);
    return this;
  }

  then(cb: (setting: this) => any): this {
    cb(this);
    return this;
  }

  clear(): this {
    this.controlEl.empty();
    this.components = [];
    return this;
  }
}

// ============================================================================
// Modal
// ============================================================================

export class Modal implements CloseableComponent {
  app: App;
  scope: Scope;
  containerEl: HTMLElement;
  modalEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  shouldRestoreSelection = true;

  private _bgEl: HTMLElement;
  private _closeButtonEl: HTMLElement;

  /**
   * DOM:
   * div.modal
   *   div.modal-bg
   *   div.modal-container
   *     div.modal-header
   *       div.modal-title
   *       div.modal-close-button.mod-raised.clickable-icon
   *     div.modal-content
   *     div.modal-button-container
   */
  constructor(app: App) {
    this.app = app;
    this.scope = new Scope();

    this.containerEl = document.createElement('div');
    this.modalEl = createDiv(this.containerEl, 'modal');
    this._bgEl = createDiv(this.modalEl, 'modal-bg');

    const modalContainer = createDiv(this.modalEl, 'modal-container');
    const modalHeader = createDiv(modalContainer, 'modal-header');
    this.titleEl = createDiv(modalHeader, 'modal-title');
    this._closeButtonEl = createDiv(modalHeader, 'modal-close-button mod-raised clickable-icon');
    this._closeButtonEl.addEventListener('click', () => this.close());

    this.contentEl = createDiv(modalContainer, 'modal-content');
    this._bgEl.addEventListener('click', () => this.close());
  }

  open(): void {
    document.body.appendChild(this.containerEl);
    this.onOpen();
  }

  close(): void {
    this.containerEl.remove();
    this.onClose();
  }

  onOpen(): void {}

  onClose(): void {}

  setTitle(title: string): this {
    this.titleEl.empty();
    this.titleEl.setText(title);
    return this;
  }

  setContent(content: string | DocumentFragment): this {
    this.contentEl.empty();
    if (typeof content === 'string') {
      this.contentEl.setText(content);
    } else {
      this.contentEl.append(content);
    }
    return this;
  }
}

// ============================================================================
// Menu
// ============================================================================

export class Menu extends Component implements CloseableComponent {
  private _menuEl: HTMLElement;
  private _scrollEl: HTMLElement;
  private _hideCallback?: () => any;
  private _isShown = false;

  /**
   * DOM: div.menu > div.menu-grabber + div.menu-scroll
   */
  constructor() {
    super();
    this._menuEl = document.createElement('div');
    this._menuEl.hide = () => this.hide();
    createDiv(this._menuEl, 'menu-grabber');
    this._scrollEl = createDiv(this._menuEl, 'menu-scroll');
  }

  setNoIcon(): this {
    this._menuEl.addClass('no-icon');
    return this;
  }

  setUseNativeMenu(useNativeMenu: boolean): this {
    return this;
  }

  addItem(cb: (item: MenuItem) => any): this {
    const item = new MenuItem();
    cb(item);
    this._scrollEl.append(item.itemEl);
    return this;
  }

  addSeparator(): this {
    createDiv(this._scrollEl, 'menu-separator');
    return this;
  }

  showAtMouseEvent(evt: MouseEvent): this {
    this.showAtPosition({ x: evt.clientX, y: evt.clientY });
    return this;
  }

  showAtPosition(position: MenuPositionDef, _doc?: Document): this {
    const doc = _doc || document;
    doc.body.appendChild(this._menuEl);

    const menuStyle = this._menuEl.style;
    menuStyle.position = 'absolute';
    menuStyle.top = `${position.y}px`;
    menuStyle.left = `${position.x}px`;
    menuStyle.zIndex = '1000';

    this._isShown = true;

    // Close on outside click
    setTimeout(() => {
      const handler = (e: MouseEvent) => {
        if (!this._menuEl.contains(e.target as Node)) {
          this.hide();
          doc.removeEventListener('click', handler);
        }
      };
      doc.addEventListener('click', handler);
    }, 0);

    return this;
  }

  hide(): this {
    this._menuEl.remove();
    this._isShown = false;
    this._hideCallback?.();
    return this;
  }

  close(): void {
    this.hide();
  }

  onHide(callback: () => any): void {
    this._hideCallback = callback;
  }
}

export class MenuItem {
  itemEl: HTMLElement;
  private _iconEl: HTMLElement;
  private _titleEl: HTMLElement;
  private _checked = false;
  private _clickCallback?: (evt: MouseEvent | KeyboardEvent) => any;

  /**
   * DOM: div.menu-item.tappable > div.menu-item-icon + div.menu-item-title
   * When checked: div.menu-item-icon.mod-checked
   */
  constructor() {
    this.itemEl = document.createElement('div');
    this.itemEl.className = 'menu-item tappable';
    this._iconEl = createDiv(this.itemEl, 'menu-item-icon');
    this._titleEl = createDiv(this.itemEl, 'menu-item-title');

    this.itemEl.addEventListener('click', (evt: MouseEvent) => {
      if (!this.itemEl.hasClass('is-disabled')) {
        this._clickCallback?.(evt);
      }
    });
  }

  setTitle(title: string | DocumentFragment): this {
    this._titleEl.empty();
    if (typeof title === 'string') {
      this._titleEl.setText(title);
    } else {
      this._titleEl.append(title);
    }
    return this;
  }

  setIcon(icon: IconName | null): this {
    if (icon) {
      this._iconEl.setAttr('data-icon', icon);
    }
    return this;
  }

  setChecked(checked: boolean | null): this {
    if (checked !== null) {
      this._checked = checked;
      if (checked) {
        this._iconEl.addClass('mod-checked');
      } else {
        this._iconEl.removeClass('mod-checked');
      }
    }
    return this;
  }

  setDisabled(disabled: boolean): this {
    if (disabled) {
      this.itemEl.addClass('is-disabled');
    } else {
      this.itemEl.removeClass('is-disabled');
    }
    return this;
  }

  setIsLabel(isLabel: boolean): this {
    if (isLabel) {
      this.itemEl.addClass('is-label');
    }
    return this;
  }

  onClick(callback: (evt: MouseEvent | KeyboardEvent) => any): this {
    this._clickCallback = callback;
    return this;
  }

  setSection(section: string): this {
    this.itemEl.setAttr('data-section', section);
    return this;
  }
}

export class MenuSeparator {}

// ============================================================================
// Scope & Keymap
// ============================================================================

export class Scope {
  private _parent?: Scope;
  private _handlers: KeymapEventHandler[] = [];

  constructor(parent?: Scope) {
    this._parent = parent;
  }

  register(
    modifiers: Modifier[] | null,
    key: string | null,
    func: KeymapEventListener,
  ): KeymapEventHandler {
    const handler: KeymapEventHandler = {
      scope: this,
      modifiers: modifiers ? modifiers.join('-') : null,
      key,
    };
    this._handlers.push(handler);
    return handler;
  }

  unregister(handler: KeymapEventHandler): void {
    const idx = this._handlers.indexOf(handler);
    if (idx !== -1) this._handlers.splice(idx, 1);
  }
}

export class Keymap {
  pushScope(scope: Scope): void {}

  popScope(scope: Scope): void {}

  static isModifier(evt: MouseEvent | TouchEvent | KeyboardEvent, modifier: Modifier): boolean {
    switch (modifier) {
      case 'Mod':
        return evt.ctrlKey || evt.metaKey;
      case 'Ctrl':
        return evt.ctrlKey;
      case 'Meta':
        return evt.metaKey;
      case 'Shift':
        return evt.shiftKey;
      case 'Alt':
        return evt.altKey;
      default:
        return false;
    }
  }

  static isModEvent(evt?: UserEvent | null): PaneType {
    if (!evt) return true;
    if (evt.metaKey || evt.ctrlKey) {
      if (evt.altKey) {
        if (evt.shiftKey) return 'window';
        return 'split';
      }
      return 'tab';
    }
    return true;
  }
}

// ============================================================================
// Data classes
// ============================================================================

export { TAbstractFile, TFile, TFolder };

// ============================================================================
// Vault
// ============================================================================

export interface DataAdapter {
  getName(): string;
  exists(normalizedPath: string, sensitive?: boolean): Promise<boolean>;
  stat(normalizedPath: string): Promise<Stat | null>;
  list(normalizedPath: string): Promise<ListedFiles>;
  read(normalizedPath: string): Promise<string>;
  readBinary(normalizedPath: string): Promise<ArrayBuffer>;
  write(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void>;
  writeBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void>;
  append(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void>;
  process(normalizedPath: string, fn: (data: string) => string, options?: DataWriteOptions): Promise<string>;
  getResourcePath(normalizedPath: string): string;
  mkdir(normalizedPath: string): Promise<void>;
  trashSystem(normalizedPath: string): Promise<boolean>;
  trashLocal(normalizedPath: string): Promise<void>;
  rmdir(normalizedPath: string, recursive: boolean): Promise<void>;
  remove(normalizedPath: string): Promise<void>;
  rename(normalizedPath: string, normalizedNewPath: string): Promise<void>;
}

export class Vault extends Events {
  adapter!: DataAdapter;
  configDir = '.obsidian';

  private _files: Map<string, TAbstractFile> = new Map();
  private _root: TFolder;

  constructor() {
    super();
    this._root = new TFolder('/', '');
  }

  getName(): string {
    return 'mock-vault';
  }

  getFileByPath(path: string): TFile | null {
    const file = this._files.get(path);
    return file instanceof TFile ? file : null;
  }

  getFolderByPath(path: string): TFolder | null {
    const file = this._files.get(path);
    return file instanceof TFolder ? file : null;
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this._files.get(path) || null;
  }

  getRoot(): TFolder {
    return this._root;
  }

  async create(path: string, data: string, _options?: DataWriteOptions): Promise<TFile> {
    const parts = path.split('/');
    const name = parts.pop()!;
    const ext = name.includes('.') ? name.split('.').pop()! : '';
    const basename = name.substring(0, name.length - ext.length - 1);
    const file = new TFile(path, basename, ext);
    file.vault = this;
    this._files.set(path, file);
    this.trigger('create', file);
    return file;
  }

  async createBinary(path: string, _data: ArrayBuffer, _options?: DataWriteOptions): Promise<TFile> {
    const file = new TFile(path, path, '');
    file.vault = this;
    this._files.set(path, file);
    this.trigger('create', file);
    return file;
  }

  async createFolder(path: string): Promise<TFolder> {
    const folder = new TFolder(path, path.split('/').pop()!);
    folder.vault = this;
    this._files.set(path, folder);
    return folder;
  }

  async read(_file: TFile): Promise<string> {
    return '';
  }

  async cachedRead(_file: TFile): Promise<string> {
    return '';
  }

  async readBinary(_file: TFile): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }

  getResourcePath(_file: TFile): string {
    return '';
  }

  async delete(file: TAbstractFile, _force?: boolean): Promise<void> {
    this._files.delete(file.path);
    this.trigger('delete', file);
  }

  async trash(file: TAbstractFile, _system: boolean): Promise<void> {
    this._files.delete(file.path);
    this.trigger('delete', file);
  }

  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    const oldPath = file.path;
    file.path = newPath;
    this._files.delete(oldPath);
    this._files.set(newPath, file);
    this.trigger('rename', file, oldPath);
  }

  async modify(_file: TFile, _data: string, _options?: DataWriteOptions): Promise<void> {
    this.trigger('modify', _file);
  }

  async modifyBinary(_file: TFile, _data: ArrayBuffer, _options?: DataWriteOptions): Promise<void> {
    this.trigger('modify', _file);
  }

  async append(_file: TFile, _data: string, _options?: DataWriteOptions): Promise<void> {
    this.trigger('modify', _file);
  }

  async process(file: TFile, fn: (data: string) => string, _options?: DataWriteOptions): Promise<string> {
    const result = fn('');
    return result;
  }

  async copy<T extends TAbstractFile>(file: T, newPath: string): Promise<T> {
    const copy = { ...file, path: newPath };
    this._files.set(newPath, copy);
    return copy as T;
  }

  getAllLoadedFiles(): TAbstractFile[] {
    return Array.from(this._files.values());
  }

  getAllFolders(includeRoot?: boolean): TFolder[] {
    const folders = Array.from(this._files.values()).filter(
      (f): f is TFolder => f instanceof TFolder,
    );
    if (includeRoot) folders.push(this._root);
    return folders;
  }

  static recurseChildren(root: TFolder, cb: (file: TAbstractFile) => any): void {
    for (const child of root.children) {
      cb(child);
    }
  }

  getMarkdownFiles(): TFile[] {
    return Array.from(this._files.values()).filter(
      (f): f is TFile => f instanceof TFile && f.extension === 'md',
    );
  }

  getFiles(): TFile[] {
    return Array.from(this._files.values()).filter(
      (f): f is TFile => f instanceof TFile,
    );
  }

  // Helper to add files for mock setup
  _addFile(file: TAbstractFile): void {
    file.vault = this;
    this._files.set(file.path, file);
  }
}

// ============================================================================
// View hierarchy
// ============================================================================

export abstract class View extends Component {
  app!: App;
  icon: IconName = '';
  navigation = false;
  leaf!: WorkspaceLeaf;
  containerEl: HTMLElement;
  scope: Scope | null = null;

  /**
   * DOM: div.workspace-leaf-content (provided by leaf)
   */
  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.containerEl = document.createElement('div');
  }

  protected async onOpen(): Promise<void> {}
  protected async onClose(): Promise<void> {}

  abstract getViewType(): string;

  getState(): Record<string, unknown> {
    return {};
  }

  async setState(_state: unknown, _result: ViewStateResult): Promise<void> {}

  getEphemeralState(): Record<string, unknown> {
    return {};
  }

  setEphemeralState(_state: unknown): void {}

  getIcon(): IconName {
    return this.icon;
  }
}

export abstract class ItemView extends View {
  /**
   * DOM: div.view-header + div.view-content
   */
  contentEl: HTMLElement;
  private _headerEl: HTMLElement;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this._headerEl = createDiv(this.containerEl, 'view-header');
    this.contentEl = createDiv(this.containerEl, 'view-content');
  }

  addAction(icon: IconName, title: string, callback: (evt: MouseEvent) => any): HTMLElement {
    const actionEl = createDiv(this._headerEl, 'clickable-icon view-action');
    actionEl.setAttr('aria-label', title);
    actionEl.setAttr('data-icon', icon);
    actionEl.addEventListener('click', callback);
    return actionEl;
  }
}

export abstract class FileView extends ItemView {
  allowNoFile = false;
  file: TFile | null = null;
  navigation = true;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getDisplayText(): string {
    return this.file?.name || '';
  }

  onload(): void {
    // Base implementation
  }

  getState(): Record<string, unknown> {
    return { file: this.file?.path };
  }

  async setState(state: any, _result: ViewStateResult): Promise<void> {
    if (state.file) {
      this.file = this.app.vault.getFileByPath(state.file);
    }
  }

  async onLoadFile(file: TFile): Promise<void> {}
  async onUnloadFile(file: TFile): Promise<void> {}
  async onRename(file: TFile): Promise<void> {}

  canAcceptExtension(extension: string): boolean {
    return extension === 'md';
  }
}

export abstract class EditableFileView extends FileView {}

export abstract class TextFileView extends EditableFileView {
  data = '';
  requestSave!: () => void;
  private _saveTimeout: number | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.requestSave = () => {
      if (this._saveTimeout) clearTimeout(this._saveTimeout);
      this._saveTimeout = window.setTimeout(() => {
        void this.save();
      }, 2000);
    };
  }

  async onUnloadFile(_file: TFile): Promise<void> {}
  async onLoadFile(_file: TFile): Promise<void> {}

  async save(clear?: boolean): Promise<void> {
    if (this.file) {
      const data = this.getViewData();
      await this.app.vault.modify(this.file, data);
    }
  }

  abstract getViewData(): string;
  abstract setViewData(data: string, clear: boolean): void;
  abstract clear(): void;
}

// ============================================================================
// MarkdownRenderChild & MarkdownRenderer
// ============================================================================

export class MarkdownRenderChild extends Component {
  containerEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    super();
    this.containerEl = containerEl;
  }
}

export abstract class MarkdownRenderer extends MarkdownRenderChild implements MarkdownPreviewEvents, HoverParent {
  app!: App;
  hoverPopover: HoverPopover | null = null;
  abstract get file(): TFile;

  /**
   * @deprecated Use MarkdownRenderer.render
   */
  static async renderMarkdown(
    markdown: string,
    el: HTMLElement,
    sourcePath: string,
    component: Component,
  ): Promise<void> {
    return MarkdownRenderer.render(null as any, markdown, el, sourcePath, component);
  }

  static async render(
    _app: App,
    markdown: string,
    el: HTMLElement,
    _sourcePath: string,
    _component: Component,
  ): Promise<void> {
    const html = markdown
      .replace(/^######\s+(.+)$/gm, '<h6>$1</h6>')
      .replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>')
      .replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
      .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
      .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
      .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\n/g, '<br>');
    el.innerHTML = html;
  }
}

export class MarkdownPreviewView extends MarkdownRenderer implements MarkdownSubView, MarkdownPreviewEvents {
  containerEl: HTMLElement;

  /**
   * DOM: div.markdown-reading-view
   */
  constructor() {
    super(document.createElement('div'));
    this.containerEl = document.createElement('div');
    this.containerEl.className = 'markdown-reading-view';
  }

  get file(): TFile {
    return null as any;
  }

  get(): string {
    return this.containerEl.innerText;
  }

  set(data: string, _clear: boolean): void {
    this.containerEl.innerText = data;
  }

  clear(): void {
    this.containerEl.innerText = '';
  }

  rerender(_full?: boolean): void {}

  getScroll(): number {
    return this.containerEl.scrollTop;
  }

  applyScroll(scroll: number): void {
    this.containerEl.scrollTop = scroll;
  }
}

export interface MarkdownSubView {
  getScroll(): number;
  applyScroll(scroll: number): void;
  get(): string;
  set(data: string, clear: boolean): void;
}

export class MarkdownView extends TextFileView implements MarkdownFileInfo {
  editor!: Editor;
  previewMode!: MarkdownPreviewView;
  currentMode!: MarkdownSubView;
  hoverPopover: HoverPopover | null = null;

  /**
   * DOM: div.inline-title + div.embedded-backlinks + the TextFileView structure
   */
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    createDiv(this.containerEl, 'inline-title');
    this.previewMode = new MarkdownPreviewView();
    this.currentMode = this.previewMode;
    createDiv(this.containerEl, 'embedded-backlinks');
  }

  getViewType(): string {
    return 'markdown';
  }

  getMode(): MarkdownViewModeType {
    return 'source';
  }

  getViewData(): string {
    return this.data;
  }

  clear(): void {
    this.data = '';
  }

  setViewData(data: string, clear: boolean): void {
    if (clear) this.clear();
    this.data = data;
    if (this.editor) {
      this.editor.setValue(data);
    }
  }

  showSearch(_replace?: boolean): void {}
}

// ============================================================================
// Workspace
// ============================================================================

export abstract class WorkspaceItem extends Events {
  abstract parent: WorkspaceParent;

  getRoot(): WorkspaceItem {
    return this;
  }

  getContainer(): WorkspaceContainer {
    return this as any;
  }
}

export class WorkspaceLeaf extends WorkspaceItem {
  parent!: WorkspaceTabs | WorkspaceMobileDrawer;
  view!: View;
  private _viewState: ViewState = { type: 'empty' };

  /**
   * Adds class 'workspace-leaf'
   */
  constructor() {
    super();
  }

  async openFile(file: TFile, openState?: OpenViewState): Promise<void> {
    this._viewState = { type: 'markdown', state: openState?.state };
  }

  async open(view: View): Promise<View> {
    this.view = view;
    return view;
  }

  getViewState(): ViewState {
    return this._viewState;
  }

  async setViewState(viewState: ViewState, _eState?: any): Promise<void> {
    this._viewState = viewState;
  }

  get isDeferred(): boolean {
    return false;
  }

  async loadIfDeferred(): Promise<void> {}

  getEphemeralState(): any {
    return {};
  }

  setEphemeralState(_state: any): void {}

  togglePinned(): void {
    this._viewState.pinned = !this._viewState.pinned;
  }

  setPinned(pinned: boolean): void {
    this._viewState.pinned = pinned;
  }

  setGroupMember(_other: WorkspaceLeaf): void {}

  setGroup(group: string): void {
    this._viewState.group = group;
  }
}

export abstract class WorkspaceParent extends WorkspaceItem {}
export abstract class WorkspaceContainer extends WorkspaceParent {}
export abstract class WorkspaceTabs extends WorkspaceParent {}
export abstract class WorkspaceMobileDrawer extends WorkspaceParent {}
export abstract class WorkspaceSplit extends WorkspaceParent {}
export abstract class WorkspaceFloating extends WorkspaceParent {}
export abstract class WorkspaceSidedock extends WorkspaceParent {}
export abstract class WorkspaceRoot extends WorkspaceParent {}
export abstract class WorkspaceWindow extends WorkspaceParent {}
export abstract class WorkspaceRibbon {}

// ============================================================================
// Workspace
// ============================================================================

export class Workspace extends Events {
  getLeaf(newLeaf?: PaneType | boolean): WorkspaceLeaf {
    return new WorkspaceLeaf();
  }

  getLeavesOfType(_type: string): WorkspaceLeaf[] {
    return [];
  }

  getActiveViewOfType<T extends View>(type: abstract new (...args: any[]) => T): T | null {
    return null;
  }

  getActiveFile(): TFile | null {
    return null;
  }

  onLayoutReady(callback: () => any): void {
    callback();
  }

  activeLeaf: WorkspaceLeaf | null = null;
  leftSplit: WorkspaceSplit | null = null;
  rightSplit: WorkspaceSplit | null = null;
  leftRibbon: WorkspaceRibbon | null = null;
  rightRibbon: WorkspaceRibbon | null = null;
  rootSplit: WorkspaceSplit | null = null;
}

// ============================================================================
// Editor (abstract)
// ============================================================================

export abstract class Editor {
  getDoc(): this {
    return this;
  }

  abstract refresh(): void;
  abstract getValue(): string;
  abstract setValue(content: string): void;
  abstract getLine(line: number): string;

  setLine(n: number, text: string): void {
    // Default implementation
  }

  abstract lineCount(): number;
  abstract lastLine(): number;
  abstract getSelection(): string;

  somethingSelected(): boolean {
    return this.getSelection().length > 0;
  }

  abstract getRange(from: EditorPosition, to: EditorPosition): string;
  abstract replaceSelection(replacement: string, origin?: string): void;
  abstract replaceRange(replacement: string, from: EditorPosition, to?: EditorPosition, origin?: string): void;
  abstract getCursor(string?: 'from' | 'to' | 'head' | 'anchor'): EditorPosition;
  abstract listSelections(): EditorSelection[];

  setCursor(pos: EditorPosition | number, ch?: number): void {
    // Default implementation
  }

  abstract setSelection(anchor: EditorPosition, head?: EditorPosition): void;
  abstract setSelections(ranges: EditorSelectionOrCaret[], main?: number): void;
  abstract focus(): void;
  abstract blur(): void;
  abstract hasFocus(): boolean;
  abstract getScrollInfo(): { top: number; left: number };
  abstract scrollTo(x?: number | null, y?: number | null): void;
  abstract scrollIntoView(range: EditorRange, center?: boolean): void;
  abstract undo(): void;
  abstract redo(): void;
  abstract exec(command: EditorCommandName): void;
  abstract transaction(tx: EditorTransaction, origin?: string): void;
  abstract wordAt(pos: EditorPosition): EditorRange | null;
  abstract posToOffset(pos: EditorPosition): number;
  abstract offsetToPos(offset: number): EditorPosition;

  processLines<T>(
    read: (line: number, lineText: string) => T | null,
    write: (line: number, lineText: string, value: T | null) => EditorChange | void,
    ignoreEmpty?: boolean,
  ): void {
    const count = this.lineCount();
    for (let i = 0; i < count; i++) {
      const lineText = this.getLine(i);
      if (ignoreEmpty && lineText.trim() === '') continue;
      const value = read(i, lineText);
      const change = write(i, lineText, value);
      if (change) {
        this.replaceRange(change.text, change.from, change.to);
      }
    }
  }
}

// ============================================================================
// Mock Editor implementation (for use in tests)
// ============================================================================

export class MockEditor extends Editor {
  private _content = '';
  private _cursor: EditorPosition = { line: 0, ch: 0 };
  private _selection: EditorSelectionOrCaret = { anchor: { line: 0, ch: 0 } };
  private _scroll: { top: number; left: number } = { top: 0, left: 0 };

  refresh(): void {}
  scrollTo(_x?: number | null, _y?: number | null): void {}
  scrollIntoView(_range: EditorRange, _center?: boolean): void {}
  undo(): void {}
  redo(): void {}
  exec(_command: EditorCommandName): void {}
  transaction(_tx: EditorTransaction, _origin?: string): void {}
  focus(): void {}
  blur(): void {}
  hasFocus(): boolean { return false; }

  getValue(): string { return this._content; }
  setValue(content: string): void { this._content = content; }

  getLine(line: number): string {
    const lines = this._content.split('\n');
    return lines[line] || '';
  }

  lineCount(): number {
    return this._content.split('\n').length;
  }

  lastLine(): number {
    return Math.max(0, this.lineCount() - 1);
  }

  getSelection(): string {
    const { anchor, head } = this._selection;
    const hd = head || anchor;
    const from = Math.min(anchor.line, hd.line);
    const to = Math.max(anchor.line, hd.line);
    return this._content.split('\n').slice(from, to + 1).join('\n');
  }

  getRange(from: EditorPosition, to: EditorPosition): string {
    return this._content.substring(
      this.posToOffset(from),
      this.posToOffset(to),
    );
  }

  replaceSelection(replacement: string, _origin?: string): void {
    const { anchor, head } = this._selection;
    const hd = head || anchor;
    this.replaceRange(replacement, anchor, hd);
  }

  replaceRange(replacement: string, from: EditorPosition, to?: EditorPosition, _origin?: string): void {
    const start = this.posToOffset(from);
    const end = to ? this.posToOffset(to) : start;
    this._content = this._content.substring(0, start) + replacement + this._content.substring(end);
  }

  getCursor(_string?: 'from' | 'to' | 'head' | 'anchor'): EditorPosition {
    return this._cursor;
  }

  listSelections(): EditorSelection[] {
    const { anchor, head } = this._selection;
    return [{ anchor, head: head || anchor }];
  }

  setCursor(pos: EditorPosition | number, ch?: number): void {
    if (typeof pos === 'number') {
      this._cursor = { line: pos, ch: ch || 0 };
    } else {
      this._cursor = pos;
    }
  }

  setSelection(anchor: EditorPosition, head?: EditorPosition): void {
    this._selection = { anchor, head };
  }

  setSelections(ranges: EditorSelectionOrCaret[], _main?: number): void {
    if (ranges.length > 0) {
      this._selection = ranges[0];
    }
  }

  getScrollInfo(): { top: number; left: number } {
    return this._scroll;
  }

  wordAt(pos: EditorPosition): EditorRange | null {
    return { from: pos, to: { line: pos.line, ch: pos.ch + 1 } };
  }

  posToOffset(pos: EditorPosition): number {
    const lines = this._content.split('\n');
    let offset = 0;
    for (let i = 0; i < pos.line && i < lines.length; i++) {
      offset += lines[i].length + 1;
    }
    return offset + Math.min(pos.ch, lines[pos.line]?.length || 0);
  }

  offsetToPos(offset: number): EditorPosition {
    const lines = this._content.split('\n');
    let remaining = offset;
    for (let i = 0; i < lines.length; i++) {
      if (remaining <= lines[i].length) {
        return { line: i, ch: remaining };
      }
      remaining -= lines[i].length + 1;
    }
    return { line: lines.length - 1, ch: lines[lines.length - 1]?.length || 0 };
  }
}

// ============================================================================
// SettingTab & PluginSettingTab
// ============================================================================

export abstract class SettingTab {
  app!: App;
  containerEl: HTMLElement;

  /**
   * DOM: div.vertical-tab-content
   */
  constructor() {
    this.containerEl = createDiv(document.body, 'vertical-tab-content');
  }

  abstract display(): void;

  hide(): void {
    this.containerEl.empty();
  }
}

export abstract class PluginSettingTab extends SettingTab {
  plugin: any;

  constructor(app: App, plugin: any) {
    super();
    this.app = app;
    this.plugin = plugin;
  }
}

// ============================================================================
// App
// ============================================================================

export class App {
  keymap: Keymap;
  scope: Scope;
  workspace: any;
  vault: any;
  metadataCache: any;
  fileManager: any;
  setting: any;
  lastEvent: UserEvent | null = null;

  constructor() {
    this.keymap = new Keymap();
    this.scope = new Scope();
    this.workspace = new Workspace();
    this.vault = new Vault();
    this.metadataCache = {};
    this.fileManager = {};
    this.setting = {};
  }

  loadLocalStorage(key: string): any | null {
    const val = localStorage.getItem(`obsidian-mock:${key}`);
    if (val === null) return null;
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }

  saveLocalStorage(key: string, data: unknown | null): void {
    if (data === null) {
      localStorage.removeItem(`obsidian-mock:${key}`);
    } else {
      localStorage.setItem(`obsidian-mock:${key}`, JSON.stringify(data));
    }
  }
}

export class FileSystemAdapter {
  getBasePath(): string {
    return '/';
  }
}

// ============================================================================
// Platform
// ============================================================================

export const Platform = {
  isDesktop: false,
  isDesktopApp: false,
  isPhone: false,
  isIosApp: false,
  isAndroidApp: false,
  isMobile: false,
  isMobileApp: false,
  isMacOS: false,
  isWin: false,
  isLinux: false,
  isSafari: false,
  resourcePathPrefix: '',
};

Platform.isDesktop = false;
Platform.isDesktopApp = true;
Platform.isMacOS =
  typeof navigator !== 'undefined' ? /Mac/.test(navigator.userAgent) : false;
Platform.isMobile =
  typeof navigator !== 'undefined'
    ? /Mobi|Android/i.test(navigator.userAgent)
    : false;
Platform.isMobileApp = false;
Platform.isAndroidApp =
  typeof navigator !== 'undefined' ? /Android/i.test(navigator.userAgent) : false;
Platform.isIosApp =
  typeof navigator !== 'undefined'
    ? /iPhone|iPad|iPod/i.test(navigator.userAgent)
    : false;
Platform.isPhone = Platform.isMobile;
Platform.isWin =
  typeof navigator !== 'undefined' ? /Win/i.test(navigator.userAgent) : false;
Platform.isLinux =
  typeof navigator !== 'undefined' ? /Linux/i.test(navigator.userAgent) : false;
Platform.isSafari =
  typeof navigator !== 'undefined'
    ? /Safari/i.test(navigator.userAgent) &&
      !/Chrome|Chromium|Android/i.test(navigator.userAgent)
    : false;

// ============================================================================
// Notice
// ============================================================================

export class Notice {
  private static _container: HTMLElement | null = null;
  private _el: HTMLElement;
  private _hideTimeout: number | null = null;
  noticeEl: HTMLElement;

  constructor(message: string | DocumentFragment, duration = 4000) {
    const scheduleTimeout =
      typeof window !== 'undefined' && typeof window.setTimeout === 'function'
        ? window.setTimeout.bind(window)
        : globalThis.setTimeout.bind(globalThis);
    this._el = document.createElement('div');
    this.noticeEl = this._el;
    this._el.className = 'notice';
    if (typeof message === 'string') {
      this._el.textContent = message;
    } else {
      this._el.append(message);
    }
    this._el.addEventListener('click', () => this.hide());
    Notice.ensureContainer().appendChild(this._el);
    if (duration > 0) {
      this._hideTimeout = scheduleTimeout(() => this.hide(), duration);
    }
  }

  setMessage(message: string | DocumentFragment): this {
    this._el.replaceChildren();
    if (typeof message === 'string') {
      this._el.textContent = message;
    } else {
      this._el.append(message);
    }
    return this;
  }

  hide(): void {
    if (this._hideTimeout !== null) {
      window.clearTimeout(this._hideTimeout);
      this._hideTimeout = null;
    }
    this._el.remove();
  }

  private static ensureContainer(): HTMLElement {
    if (Notice._container?.isConnected) {
      return Notice._container;
    }
    const container = document.createElement('div');
    container.className = 'notice-container';
    document.body.appendChild(container);
    Notice._container = container;
    return container;
  }
}

// ============================================================================
// HoverPopover
// ============================================================================

export enum PopoverState {
  Hidden = 'hidden',
}

export class HoverPopover extends Component {
  hoverEl: HTMLElement;
  state: PopoverState = PopoverState.Hidden;

  constructor() {
    super();
    this.hoverEl = document.createElement('div');
    this.hoverEl.className = 'hover-popover';
  }
}

// ============================================================================
// Plugin
// ============================================================================

export abstract class Plugin extends Component {
  app!: App;
  manifest!: any;
  private _data: any;

  constructor(app: App, manifest: any) {
    super();
    this.app = app;
    this.manifest = manifest;
  }

  loadData(): Promise<any> {
    return Promise.resolve(this._data || {});
  }

  saveData(data: any): Promise<void> {
    this._data = data;
    return Promise.resolve();
  }

  abstract onload(): Promise<void> | void;
  abstract onunload(): Promise<void> | void;
}

// ============================================================================
// Utility functions
// ============================================================================

export { normalizePath };

export function getLinkpath(linktext: string): string {
  return linktext.split('#')[0].split('|')[0];
}

export function parseLinktext(linktext: string): { path: string; subpath: string } {
  const [path, subpath] = linktext.split('#');
  return { path: path || '', subpath: subpath || '' };
}

export function setIcon(parent: HTMLElement, iconId: IconName): void {
  parent.setAttr('data-icon', iconId);
}

export function getIcon(iconId: IconName): SVGElement | null {
  return null;
}

export function addIcon(iconId: string, svgContent: string): void {}

export function setTooltip(el: HTMLElement, tooltip: string, _options?: TooltipOptions): void {
  el.setAttr('aria-label', tooltip);
  el.title = tooltip;
}

export function sanitizeHTMLToDom(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

export function requireApiVersion(version: string): boolean {
  return true;
}

export let apiVersion: string = '1.8.4';

export function getLanguage(): string {
  return typeof navigator !== 'undefined' ? navigator.language : 'en';
}

export async function requestUrl({
  url,
  method = 'GET',
  headers,
  body,
  throw: shouldThrow = true,
}: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  throw?: boolean;
}): Promise<{
  status: number;
  text: string;
  json: unknown;
  arrayBuffer: ArrayBuffer;
  headers: Record<string, string>;
}> {
  const response = await fetch(url, {
    method,
    headers,
    body,
  });
  const arrayBuffer = await response.arrayBuffer();
  const text = new TextDecoder().decode(arrayBuffer);
  const json = text.length > 0 ? safeJsonParse(text) : null;
  const normalizedHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    normalizedHeaders[key] = value;
  });

  if (shouldThrow && !response.ok) {
    throw new Error(`requestUrl failed: ${response.status}`);
  }

  return {
    status: response.status,
    text,
    json,
    arrayBuffer,
    headers: normalizedHeaders,
  };
}

export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  wait: number,
  immediate?: boolean,
): T {
  let timeout: number | null = null;
  return function (this: any, ...args: any[]) {
    const later = () => {
      timeout = null;
      if (!immediate) fn.apply(this, args);
    };
    const callNow = immediate && !timeout;
    if (timeout) clearTimeout(timeout);
    timeout = window.setTimeout(later, wait);
    if (callNow) fn.apply(this, args);
  } as unknown as T;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function arrayBufferToHex(data: ArrayBuffer): string {
  return Array.from(new Uint8Array(data))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return buffer;
}

export const moment = {
  locale: () => 'en',
  updateLocale: () => {},
};

export function finishRenderMath(): Promise<void> {
  return Promise.resolve();
}

export function renderMath(_el: HTMLElement): Promise<void> {
  return Promise.resolve();
}

export function renderMatches(
  el: HTMLElement,
  text: string,
  matches: SearchMatches,
  offset?: number,
): void {
  el.setText(text);
}

export function sortSearchResults(results: SearchResultContainer[]): SearchResultContainer[] {
  return results.sort((a, b) => b.match.score - a.match.score);
}
