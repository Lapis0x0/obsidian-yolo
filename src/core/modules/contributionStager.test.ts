import { ModuleContributionStager } from './contributionStager'
import type { YoloModuleFileViewV1 } from './types'

const view = {
  type: 'test-view',
  name: 'Test view',
  icon: 'flask-conical',
  render: () => null,
}

describe('ModuleContributionStager', () => {
  it('returns one validated view and ribbon only after staging finishes', () => {
    const stager = new ModuleContributionStager()
    const action = {
      icon: 'flask-conical',
      title: 'Test action',
      onClick: jest.fn(),
    }
    stager.workspace.registerView(view)
    stager.workspace.registerRibbonAction(action)

    expect(stager.finish()).toEqual({ view, ribbonAction: action })
    expect(() => stager.workspace.registerView(view)).toThrow('synchronously')
  })

  it('rejects invalid, duplicate, and empty declarations before commit', () => {
    const duplicate = new ModuleContributionStager()
    duplicate.workspace.registerView(view)
    expect(() => duplicate.workspace.registerView(view)).toThrow(
      'only one view',
    )

    const invalid = new ModuleContributionStager()
    expect(() =>
      invalid.workspace.registerRibbonAction({
        icon: '',
        title: 'Action',
        onClick: () => undefined,
      }),
    ).toThrow('non-empty string')
    expect(() => new ModuleContributionStager().finish()).toThrow(
      'no workspace contributions',
    )
  })

  it('allows capability-only activation when explicitly requested', () => {
    const stager = new ModuleContributionStager()
    expect(stager.finish({ allowEmpty: true })).toEqual({})
  })

  it('stages multiple uniquely named module commands', () => {
    const stager = new ModuleContributionStager()
    const first = { id: 'open', name: 'Open module', callback: jest.fn() }
    const second = {
      id: 'refresh',
      name: 'Refresh module',
      callback: jest.fn(),
    }

    stager.workspace.registerCommand(first)
    stager.workspace.registerCommand(second)

    expect(stager.finish()).toEqual({ commands: [first, second] })
  })

  it('rejects duplicate and unsafe command ids', () => {
    const stager = new ModuleContributionStager()
    stager.workspace.registerCommand({
      id: 'open',
      name: 'Open module',
      callback: jest.fn(),
    })
    expect(() =>
      stager.workspace.registerCommand({
        id: 'open',
        name: 'Duplicate',
        callback: jest.fn(),
      }),
    ).toThrow('already registered')
    expect(() =>
      new ModuleContributionStager().workspace.registerCommand({
        id: '../open',
        name: 'Unsafe',
        callback: jest.fn(),
      }),
    ).toThrow('id is invalid')
  })

  it('stages multiple file views with disjoint extensions', () => {
    const stager = new ModuleContributionStager()
    const board = {
      viewType: 'yolo-whiteboard',
      extensions: ['yoloboard'],
      name: 'Whiteboard',
      icon: 'layout-grid',
      factory: jest.fn(),
    }
    const canvas = {
      viewType: 'yolo-canvas',
      extensions: ['yolocanvas', 'yolocanvas2'],
      name: 'Canvas',
      icon: 'shapes',
      factory: jest.fn(),
    }
    stager.workspace.registerFileView(board)
    stager.workspace.registerFileView(canvas)

    expect(stager.finish()).toEqual({ fileViews: [board, canvas] })
  })

  it('rejects invalid, duplicate, and overlapping file view declarations', () => {
    expect(() =>
      new ModuleContributionStager().workspace.registerFileView({
        viewType: 'board',
        extensions: [],
        name: 'Board',
        icon: 'box',
        factory: jest.fn(),
      }),
    ).toThrow('non-empty array')

    expect(() =>
      new ModuleContributionStager().workspace.registerFileView({
        viewType: 'board',
        extensions: ['YoloBoard'],
        name: 'Board',
        icon: 'box',
        factory: jest.fn(),
      }),
    ).toThrow(/must match/)

    const duplicateViewType = new ModuleContributionStager()
    duplicateViewType.workspace.registerFileView({
      viewType: 'board',
      extensions: ['yoloboard'],
      name: 'Board',
      icon: 'box',
      factory: jest.fn(),
    })
    expect(() =>
      duplicateViewType.workspace.registerFileView({
        viewType: 'board',
        extensions: ['other'],
        name: 'Board again',
        icon: 'box',
        factory: jest.fn(),
      }),
    ).toThrow('already registered')

    const overlappingExtension = new ModuleContributionStager()
    overlappingExtension.workspace.registerFileView({
      viewType: 'board',
      extensions: ['yoloboard'],
      name: 'Board',
      icon: 'box',
      factory: jest.fn(),
    })
    expect(() =>
      overlappingExtension.workspace.registerFileView({
        viewType: 'canvas',
        extensions: ['yoloboard'],
        name: 'Canvas',
        icon: 'box',
        factory: jest.fn(),
      }),
    ).toThrow('already registered to view type "board"')

    expect(() =>
      new ModuleContributionStager().workspace.registerFileView({
        viewType: 'board',
        extensions: ['yoloboard'],
        name: 'Board',
        icon: 'box',
        factory: 'not-a-function' as unknown as YoloModuleFileViewV1['factory'],
      }),
    ).toThrow('factory must be a function')
  })

  it('stages file menu actions and enforces id/appliesTo validity', () => {
    const stager = new ModuleContributionStager()
    const onSelect = jest.fn()
    const openInBoard = {
      id: 'open-in-board',
      title: 'Open in Whiteboard',
      icon: 'layout-grid',
      appliesTo: 'file' as const,
      extensions: ['yoloboard'],
      onSelect,
    }
    stager.workspace.registerFileMenuAction(openInBoard)
    expect(stager.finish()).toEqual({ fileMenuActions: [openInBoard] })

    expect(() =>
      new ModuleContributionStager().workspace.registerFileMenuAction({
        id: 'open',
        title: 'Open',
        icon: 'box',
        appliesTo: 'archipelago' as unknown as 'file',
        onSelect,
      }),
    ).toThrow('appliesTo must be "file" or "folder"')

    const duplicateId = new ModuleContributionStager()
    duplicateId.workspace.registerFileMenuAction({
      id: 'open',
      title: 'Open',
      icon: 'box',
      appliesTo: 'folder',
      onSelect,
    })
    expect(() =>
      duplicateId.workspace.registerFileMenuAction({
        id: 'open',
        title: 'Open again',
        icon: 'box',
        appliesTo: 'folder',
        onSelect,
      }),
    ).toThrow('already registered')
  })

  it('ignores extensions declared on a folder-targeted menu action', () => {
    const stager = new ModuleContributionStager()
    const onSelect = jest.fn()
    stager.workspace.registerFileMenuAction({
      id: 'open',
      title: 'Open',
      icon: 'box',
      appliesTo: 'folder',
      extensions: ['not-a-valid-extension!!'],
      onSelect,
    })

    const [action] = stager.finish().fileMenuActions ?? []
    expect(action).not.toHaveProperty('extensions')
  })
})
