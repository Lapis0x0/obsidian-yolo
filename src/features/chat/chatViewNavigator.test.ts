import type { TFile, WorkspaceLeaf } from 'obsidian'

import type SmartComposerPlugin from '../../main'

import { ChatViewNavigator } from './chatViewNavigator'

jest.mock('../../ChatView', () => ({
  ChatView: jest.fn().mockImplementation(function MockChatView(this: {
    addSelectionToInput: jest.Mock
    applySelectionToMainInput: jest.Mock
    appendTextToInput: jest.Mock
    setMainInputText: jest.Mock
    focusMainInput: jest.Mock
    submitMainInput: jest.Mock
  }) {
    this.addSelectionToInput = jest.fn()
    this.applySelectionToMainInput = jest.fn()
    this.appendTextToInput = jest.fn()
    this.setMainInputText = jest.fn()
    this.focusMainInput = jest.fn()
    this.submitMainInput = jest.fn()
  }),
}))

const { ChatView: MockChatView } = jest.requireMock('../../ChatView') as {
  ChatView: jest.Mock
}

describe('ChatViewNavigator', () => {
  const selectedBlock = {
    content: 'Selected content',
    file: {
      path: 'note.md',
      basename: 'note',
      extension: 'md',
    } as unknown as TFile,
    startLine: 1,
    endLine: 1,
  }

  const createPlugin = (
    overrides: {
      resolveTargetLeaf?: () => WorkspaceLeaf | null
      setPendingPayload?: jest.Mock
      registerLeaf?: jest.Mock
      touchLeafInteracted?: jest.Mock
      revealLeaf?: jest.Mock
      getRightLeaf?: () => WorkspaceLeaf
    } = {},
  ) => {
    const sessionManager = {
      resolveTargetLeaf: overrides.resolveTargetLeaf ?? (() => null),
      setPendingPayload: overrides.setPendingPayload ?? jest.fn(),
      registerLeaf: overrides.registerLeaf ?? jest.fn(),
      touchLeafInteracted: overrides.touchLeafInteracted ?? jest.fn(),
    }

    const workspace = {
      revealLeaf:
        overrides.revealLeaf ?? jest.fn().mockResolvedValue(undefined),
      getRightLeaf:
        overrides.getRightLeaf ??
        (() => {
          throw new Error('getRightLeaf should not be called in this test')
        }),
    }

    return {
      app: {
        workspace,
      },
      getChatLeafSessionManager: () => sessionManager,
    } as unknown as SmartComposerPlugin
  }

  beforeEach(() => {
    MockChatView.mockClear()
  })

  it('prefills the main chat input without sending when a chat leaf already exists', async () => {
    const view = new (MockChatView as unknown as new () => {
      addSelectionToInput: jest.Mock
      applySelectionToMainInput: jest.Mock
      appendTextToInput: jest.Mock
      setMainInputText: jest.Mock
      focusMainInput: jest.Mock
      submitMainInput: jest.Mock
    })()
    const leaf = { view } as unknown as WorkspaceLeaf
    const revealLeaf = jest.fn().mockResolvedValue(undefined)
    const touchLeafInteracted = jest.fn()
    const plugin = createPlugin({
      resolveTargetLeaf: () => leaf,
      revealLeaf,
      touchLeafInteracted,
    })

    const navigator = new ChatViewNavigator({ plugin })

    await navigator.openChatWithSelectionAndPrefill(
      selectedBlock,
      'Explain this',
    )

    expect(revealLeaf).toHaveBeenCalledWith(leaf)
    expect(touchLeafInteracted).toHaveBeenCalledWith(leaf)
    expect(view.applySelectionToMainInput).toHaveBeenCalledWith(
      {
        ...selectedBlock,
        source: 'selection-pinned',
      },
      'Explain this',
    )
    expect(view.setMainInputText).not.toHaveBeenCalled()
    expect(view.focusMainInput).not.toHaveBeenCalled()
    expect(view.submitMainInput).not.toHaveBeenCalled()
  })

  it('submits the main chat input immediately when using direct send', async () => {
    const view = new (MockChatView as unknown as new () => {
      addSelectionToInput: jest.Mock
      applySelectionToMainInput: jest.Mock
      appendTextToInput: jest.Mock
      setMainInputText: jest.Mock
      focusMainInput: jest.Mock
      submitMainInput: jest.Mock
    })()
    const leaf = { view } as unknown as WorkspaceLeaf
    const plugin = createPlugin({
      resolveTargetLeaf: () => leaf,
      revealLeaf: jest.fn().mockResolvedValue(undefined),
      touchLeafInteracted: jest.fn(),
    })

    const navigator = new ChatViewNavigator({ plugin })

    await navigator.openChatWithSelectionAndSend(selectedBlock, '')

    expect(view.applySelectionToMainInput).toHaveBeenCalledWith(
      {
        ...selectedBlock,
        source: 'selection-pinned',
      },
      '',
      {
        submit: true,
      },
    )
    expect(view.setMainInputText).not.toHaveBeenCalled()
    expect(view.submitMainInput).not.toHaveBeenCalled()
    expect(view.focusMainInput).not.toHaveBeenCalled()
  })

  it('stores auto-send payload when it needs to create a new chat leaf', async () => {
    const setPendingPayload = jest.fn()
    const registerLeaf = jest.fn()
    const newLeaf = {
      setViewState: jest.fn().mockImplementation(function setViewState() {
        this.view = new (MockChatView as unknown as new () => object)()
        return Promise.resolve()
      }),
    } as unknown as WorkspaceLeaf
    const plugin = createPlugin({
      resolveTargetLeaf: () => null,
      setPendingPayload,
      registerLeaf,
      revealLeaf: jest.fn().mockResolvedValue(undefined),
      getRightLeaf: () => newLeaf,
    })

    const navigator = new ChatViewNavigator({ plugin })

    await navigator.openChatWithSelectionAndSend(selectedBlock, 'Summarize')

    expect(setPendingPayload).toHaveBeenCalledWith(
      newLeaf,
      expect.objectContaining({
        selectedBlock: {
          ...selectedBlock,
          source: 'selection-pinned',
        },
        prefillText: 'Summarize',
        autoSend: true,
        placement: 'sidebar',
      }),
    )
    expect(registerLeaf).toHaveBeenCalledWith(newLeaf, 'sidebar')
  })
})
