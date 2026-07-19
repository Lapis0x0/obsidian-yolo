const notice = jest.fn()
const componentLoad = jest.fn()
const componentUnload = jest.fn()
const markdownRender = jest.fn(() => Promise.resolve())
const keymapIsModEvent = jest.fn(() => false)
const convertHtmlToMarkdown = jest.fn((html: string) => `md:${html}`)

const fakeDocument = {
  createElement: () => createElement(),
} as unknown as Document

const createElement = (): HTMLElement =>
  ({
    nodeType: 1,
    ownerDocument: fakeDocument,
    childNodes: [],
    textContent: '',
    replaceChildren(...children: Node[]) {
      this.childNodes = children
      this.textContent = ''
    },
  }) as unknown as HTMLElement

jest.mock('obsidian', () => ({
  App: jest.fn(),
  Component: jest.fn().mockImplementation(() => ({
    load: componentLoad,
    unload: componentUnload,
  })),
  Keymap: { isModEvent: keymapIsModEvent },
  MarkdownRenderer: { render: markdownRender },
  Notice: jest.fn().mockImplementation(notice),
  TFile: class {},
  htmlToMarkdown: convertHtmlToMarkdown,
  normalizePath: (path: string) => path,
}))

type ModalOptions = {
  title: string
  message: string
  ctaText?: string
  cancelText?: string
  onConfirm(): void
  onCancel?(): void
}

const modals: MockConfirmModal[] = []

class MockConfirmModal {
  readonly open = jest.fn()
  readonly close = jest.fn(() => this.options.onCancel?.())

  constructor(
    readonly app: unknown,
    readonly options: ModalOptions,
  ) {
    modals.push(this)
  }
}

import { type App, TFile } from 'obsidian'

import { ModuleLifecycleScope } from './lifecycleScope'
import { ObsidianModuleUiCapabilityProvider } from './moduleUi'

describe('ObsidianModuleUiCapabilityProvider', () => {
  const openLinkText = jest.fn(() => Promise.resolve())
  const trigger = jest.fn()
  const app = {
    workspace: { openLinkText, trigger },
  } as unknown as App

  beforeEach(() => {
    jest.clearAllMocks()
    modals.length = 0
    markdownRender.mockImplementation(() => Promise.resolve())
  })

  const create = () => {
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ObsidianModuleUiCapabilityProvider({
      app,
      createConfirmModal: (modalApp, options) =>
        new MockConfirmModal(modalApp, options),
    }).create('learning', lifecycle)
    activation.activate()
    return { lifecycle, activation, ui: activation.api }
  }

  it('delegates stable UI primitives to public Obsidian APIs', async () => {
    const { lifecycle, ui } = create()
    const event = { type: 'mouseover' } as MouseEvent
    const targetEl = createElement()
    keymapIsModEvent.mockReturnValue(true)

    ui.notice('Saved')
    expect(notice).toHaveBeenCalledWith('Saved')
    expect(ui.htmlToMarkdown('<b>text</b>')).toBe('md:<b>text</b>')
    expect(ui.isModEvent(event)).toBe(true)
    await ui.openLink('note#heading', 'source.md', true)
    expect(openLinkText).toHaveBeenCalledWith('note#heading', 'source.md', true)

    ui.hoverLink({ event, targetEl, linktext: 'note', sourcePath: 'source.md' })
    expect(trigger).toHaveBeenCalledWith('hover-link', {
      event,
      targetEl,
      linktext: 'note',
      sourcePath: 'source.md',
      source: 'preview',
      hoverParent: { hoverPopover: null },
    })
    lifecycle.dispose()
  })

  it('opens an exact one-based file location and returns false for missing files', async () => {
    const file = Object.assign(new TFile(), { path: 'cards.md' })
    const openFile = jest.fn(async () => undefined)
    const getLeaf = jest.fn(() => ({ openFile }))
    const locationApp = {
      vault: {
        getAbstractFileByPath: jest.fn((path: string) =>
          path === 'cards.md' ? file : null,
        ),
      },
      workspace: { getLeaf },
    } as unknown as App
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ObsidianModuleUiCapabilityProvider({
      app: locationApp,
      createConfirmModal: (modalApp, options) =>
        new MockConfirmModal(modalApp, options),
    }).create('learning', lifecycle)
    activation.activate()

    await expect(
      activation.api.openFileAt({ path: 'missing.md', line: 1 }),
    ).resolves.toBe(false)
    await expect(
      activation.api.openFileAt({
        path: 'cards.md',
        line: 4,
        column: 3,
        newLeaf: true,
      }),
    ).resolves.toBe(true)
    expect(getLeaf).toHaveBeenCalledWith('tab')
    expect(openFile).toHaveBeenCalledWith(file, { eState: { line: 3, ch: 2 } })
    await expect(
      activation.api.openFileAt({ path: 'cards.md', column: 2 }),
    ).rejects.toThrow('requires a line')
    await expect(
      activation.api.openFileAt({ path: '../outside.md' }),
    ).rejects.toThrow('dot segments')
    lifecycle.dispose()
  })

  it('namespaces action toasts, revokes callbacks, and dismisses on disposal', async () => {
    const show = jest.fn()
    const dismiss = jest.fn()
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ObsidianModuleUiCapabilityProvider({
      app,
      createConfirmModal: (modalApp, options) =>
        new MockConfirmModal(modalApp, options),
      actionToasts: { show, dismiss },
    }).create('learning', lifecycle)
    activation.activate()
    const onAction = jest.fn()
    activation.api.showActionToast({
      id: 'generated',
      tone: 'success',
      title: 'Generated',
      message: 'Ready',
      actionLabel: 'Open',
      dismissLabel: 'Dismiss',
      onAction,
    })
    const shown = show.mock.calls[0][0]
    expect(shown.id).toBe('module:["learning","generated"]')
    await shown.onAction()
    expect(onAction).toHaveBeenCalledTimes(1)

    activation.api.showActionToast({
      id: 'generated',
      tone: 'warning',
      title: 'Replaced',
      message: 'New',
      actionLabel: 'Open',
      dismissLabel: 'Dismiss',
      onAction: jest.fn(),
    })
    await shown.onAction()
    expect(onAction).toHaveBeenCalledTimes(1)

    lifecycle.dispose()
    expect(dismiss).toHaveBeenCalledWith('module:["learning","generated"]')
    await shown.onAction()
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('maps confirm outcomes and dismissal to booleans exactly once', async () => {
    const { lifecycle, ui } = create()
    const confirmed = ui.confirm({ title: 'Delete?', message: 'Cannot undo' })
    expect(modals[0].open).toHaveBeenCalledTimes(1)
    modals[0].options.onConfirm()
    modals[0].options.onCancel?.()
    await expect(confirmed).resolves.toBe(true)

    const cancelled = ui.confirm({ title: 'Delete?', message: 'Cannot undo' })
    modals[1].close()
    await expect(cancelled).resolves.toBe(false)
    lifecycle.dispose()
  })

  it('settles pending confirms as false and closes them on disposal', async () => {
    const { lifecycle, ui } = create()
    const result = ui.confirm({ title: 'Pending', message: 'Waiting' })

    lifecycle.dispose()

    await expect(result).resolves.toBe(false)
    expect(modals[0].close).toHaveBeenCalledTimes(1)
    modals[0].options.onConfirm()
    await expect(result).resolves.toBe(false)
  })

  it('preserves an open failure when close synchronously cancels', async () => {
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ObsidianModuleUiCapabilityProvider({
      app,
      createConfirmModal: (_modalApp, options) => ({
        open: () => {
          throw new Error('open failed')
        },
        close: () => options.onCancel(),
      }),
    }).create('learning', lifecycle)
    activation.activate()

    await expect(
      activation.api.confirm({ title: 'Title', message: 'Message' }),
    ).rejects.toThrow('open failed')
    lifecycle.dispose()
  })

  it('loads renderers, supports explicit unload, and unloads owned renderers', async () => {
    const { lifecycle, ui } = create()
    const first = ui.createMarkdownRenderer()
    const second = ui.createMarkdownRenderer()
    const container = createElement()

    await first.render('# Card', container, 'cards.md')
    expect(markdownRender).toHaveBeenCalledWith(
      app,
      '# Card',
      expect.objectContaining({ nodeType: 1 }),
      'cards.md',
      expect.anything(),
    )
    first.unload()
    first.unload()
    lifecycle.dispose()

    expect(componentLoad).toHaveBeenCalledTimes(2)
    expect(componentUnload).toHaveBeenCalledTimes(2)
    expect(() => first.render('late', container, '')).toThrow(
      'no longer active',
    )
    expect(() => second.render('late', container, '')).toThrow(
      'no longer active',
    )
  })

  it('cancels a pending render when its lifecycle is disposed', async () => {
    let finishRender!: () => void
    markdownRender.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRender = resolve
        }),
    )
    const { lifecycle, ui } = create()
    const renderer = ui.createMarkdownRenderer()
    const container = createElement()
    container.textContent = 'original'
    const result = renderer.render('# Pending', container, 'cards.md')

    lifecycle.dispose()

    await expect(result).resolves.toBeUndefined()
    finishRender()
    await Promise.resolve()
    await Promise.resolve()
    expect(componentUnload).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('original')
  })

  it('rejects every new capability call after disposal', async () => {
    const { lifecycle, ui } = create()
    lifecycle.dispose()

    expect(() => ui.notice('late')).toThrow('no longer active')
    expect(() => ui.confirm({ title: 'Late', message: 'Late' })).toThrow(
      'no longer active',
    )
    expect(() => ui.createMarkdownRenderer()).toThrow('no longer active')
    expect(() => ui.htmlToMarkdown('<b>late</b>')).toThrow('no longer active')
    expect(() => ui.isModEvent({} as MouseEvent)).toThrow('no longer active')
    expect(() =>
      ui.hoverLink({
        event: {} as MouseEvent,
        targetEl: {} as HTMLElement,
        linktext: 'late',
        sourcePath: '',
      }),
    ).toThrow('no longer active')
    expect(() => ui.openLink('late', '', false)).toThrow('no longer active')
    expect(openLinkText).not.toHaveBeenCalled()
  })

  it('rejects calls before activation commits', () => {
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ObsidianModuleUiCapabilityProvider({
      app,
      createConfirmModal: (modalApp, options) =>
        new MockConfirmModal(modalApp, options),
    }).create('learning', lifecycle)
    expect(() => activation.api.notice('early')).toThrow('UI is not active')
    lifecycle.dispose()
  })
})
