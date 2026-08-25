// Module entry point for YOLO Whiteboard.
//
// M1 canvas milestone (docs/plans/08-25-yolo-whiteboard/p1-design.md):
// registers the `.yoloboard` file view via the Host API's
// `registerFileView` (host-sdk.d.ts's `YoloModuleHostApiVersion` is
// '1.8.0', where that surface first exists — see module.config.json's
// `hostApi` bump). All the actual camera/virtualization/card-lifecycle
// behavior lives in `./ui/canvas.ts`; this file only wires the thin
// `YoloModuleFileViewInstanceV1` adapter around it.
//
// The file is named index.tsx (not .ts) because the module build's entry
// point is fixed at that path (scripts/build-first-party-modules.mjs), not
// because it uses JSX.

import { createWhiteboardLocalizedText } from './i18n'
import { WhiteboardCanvas } from './ui/canvas'

const MODULE_ID = 'whiteboard'
const VIEW_TYPE = 'yolo-whiteboard'

yolo.registerModule({
  id: MODULE_ID,
  activate(host) {
    host.workspace.registerFileView({
      viewType: VIEW_TYPE,
      extensions: ['yoloboard'],
      name: createWhiteboardLocalizedText('module.name'),
      icon: 'layout-grid',
      factory: (context) => {
        const canvas = new WhiteboardCanvas(context, host)
        return {
          setViewData: (data, clear) => canvas.setViewData(data, clear),
          getViewData: () => canvas.getViewData(),
          clear: () => canvas.clear(),
          onResize: () => canvas.onResize(),
          dispose: () => canvas.dispose(),
        }
      },
    })
  },
})
