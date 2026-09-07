// The camera's "I moved" notification, which is what a screen-space follower
// that is not the toolbar hangs off (master.md §6.3: the Quick Ask panel
// anchored to an open card editor). Covered here rather than through the
// canvas because the contract is the camera's: every transform write, once
// each, and nothing after the disposer runs.

import { DEFAULT_CAMERA } from '../../domain/fileFormat'

import { CameraController } from './cameraController'

function fakeElement(): HTMLElement {
  return {
    style: { setProperty: () => undefined },
  } as unknown as HTMLElement
}

function createController(): CameraController {
  const win = {
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    matchMedia: () => ({ matches: false }),
  }
  const context = {
    getWindow: () => win,
  } as unknown as YoloModuleHostFileViewContextV1
  return new CameraController(
    context,
    fakeElement(),
    fakeElement(),
    fakeElement(),
    [],
    [],
    {
      isParseFailed: () => false,
      isEditingWheelTarget: () => false,
      scrollFocusedCardBy: () => false,
      positionToolbar: () => undefined,
      setInteracting: () => undefined,
      getSelectedNodes: () => [],
      getAllNodes: () => [],
      commitCamera: () => undefined,
      afterCameraReset: () => undefined,
      isOverviewActive: () => false,
    },
  )
}

describe('CameraController.subscribeViewChange', () => {
  it('notifies on every camera write and stops once disposed', () => {
    const controller = createController()
    let moves = 0
    const unsubscribe = controller.subscribeViewChange(() => {
      moves += 1
    })

    controller.loadCamera({ ...DEFAULT_CAMERA, x: 40 })
    expect(moves).toBe(1)

    // A pan writes the transform per frame, and each of those is a move.
    controller.updatePan(controller.view, { x: 0, y: 0 }, { x: 12, y: 0 })
    controller.updatePan(controller.view, { x: 0, y: 0 }, { x: 24, y: 0 })
    expect(moves).toBe(3)

    unsubscribe()
    controller.loadCamera({ ...DEFAULT_CAMERA, x: 80 })
    expect(moves).toBe(3)
  })

  it('keeps subscribers independent', () => {
    const controller = createController()
    let first = 0
    let second = 0
    const disposeFirst = controller.subscribeViewChange(() => {
      first += 1
    })
    controller.subscribeViewChange(() => {
      second += 1
    })

    controller.loadCamera({ ...DEFAULT_CAMERA, x: 10 })
    disposeFirst()
    controller.loadCamera({ ...DEFAULT_CAMERA, x: 20 })

    expect(first).toBe(1)
    expect(second).toBe(2)
  })
})
