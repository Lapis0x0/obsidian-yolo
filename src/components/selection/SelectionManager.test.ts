import { SelectionManager } from './SelectionManager'

describe('SelectionManager', () => {
  test('listens for selections in the editor container document', () => {
    const addEventListener = jest.fn()
    const removeEventListener = jest.fn()
    const popoutWindow = {
      clearTimeout: jest.fn(),
      setTimeout: jest.fn(),
      getSelection: jest.fn(),
    } as unknown as Window
    const popoutDocument = {
      addEventListener,
      removeEventListener,
      defaultView: popoutWindow,
    } as unknown as Document
    const editorContainer = {
      ownerDocument: popoutDocument,
    } as HTMLElement
    const manager = new SelectionManager(editorContainer)

    manager.init(jest.fn())
    manager.destroy()

    expect(addEventListener).toHaveBeenCalledWith(
      'selectionchange',
      expect.any(Function),
    )
    expect(removeEventListener).toHaveBeenCalledWith(
      'selectionchange',
      expect.any(Function),
    )
  })
})
