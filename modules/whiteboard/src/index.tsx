// Module entry point for YOLO Whiteboard.
//
// M1 canvas milestone (docs/plans/08-25-yolo-whiteboard/p1-design.md):
// registers the `.yoloboard` file view via the Host API's
// `registerFileView` (added in host API 1.8.0; the declared floor is 1.9.0,
// where `vault.getResourceUrl` — what a media card points an <img>/<audio>/
// <video> at — first exists). All the actual camera/virtualization/card-lifecycle
// behavior lives in `./ui/canvas.ts`; this file only wires the thin
// `YoloModuleFileViewInstanceV1` adapter around it.
//
// The file is named index.tsx (not .ts) because the module build's entry
// point is fixed at that path (scripts/build-first-party-modules.mjs), not
// because it uses JSX.

import { registerWhiteboardAgentTools } from './host/boardTools'
import { createWhiteboard } from './host/createWhiteboard'
import {
  importAllCanvasFiles,
  importCanvasFileAndOpen,
} from './host/importCanvasFile'
import { OpenBoards } from './host/openBoards'
import { registerWhiteboardRenameRewriter } from './host/renameRewriter'
import { createWhiteboardLocalizedText } from './i18n'
import { WhiteboardCanvas } from './ui/canvas'

const MODULE_ID = 'whiteboard'
const VIEW_TYPE = 'yolo-whiteboard'

/** The whiteboard's identity everywhere the host draws it — file view, ribbon
 * and both context-menu entries — so a board is recognizable as one thing.
 * Not `layout-grid`: the canvas already spends that icon on "tidy" (see
 * `ui/canvas.ts`), and a module should not say two things with one drawing. */
const WHITEBOARD_ICON = 'waypoints'

yolo.registerModule({
  id: MODULE_ID,
  activate(host) {
    // Per-activation, not module scope: a deactivate must leave no view
    // behind for the next one to find.
    const openBoards = new OpenBoards()

    host.workspace.registerFileView({
      viewType: VIEW_TYPE,
      extensions: ['yoloboard'],
      name: createWhiteboardLocalizedText('module.name'),
      icon: WHITEBOARD_ICON,
      factory: (context) => {
        const canvas = new WhiteboardCanvas(context, host)
        const forgetOpenBoard = openBoards.add(canvas)
        return {
          setViewData: (data, clear) => canvas.setViewData(data, clear),
          getViewData: () => canvas.getViewData(),
          clear: () => canvas.clear(),
          onResize: () => canvas.onResize(),
          dispose: () => {
            forgetOpenBoard()
            canvas.dispose()
          },
        }
      },
    })

    // The agent's view of a board: `fs_read` renders it as a summary, and
    // `edit_board` / `create_board` are how it writes one
    // (docs/plans/09-03-whiteboard-agent-tools/master.md D2, D3).
    registerWhiteboardAgentTools(host, openBoards)

    // Event-layer reference resilience (p1-design §1.2): keeps every
    // `.yoloboard` file's card references correct across renames/moves for
    // as long as the module is active, independent of any open leaf.
    host.lifecycle.add(registerWhiteboardRenameRewriter(host))

    // Creation entries (p1-design §5): command and ribbon create at the vault
    // root; the folder context menu action creates inside the target folder.
    // The ribbon is a creation entry rather than an "open" one because a board
    // is a file — there is no home surface for it to open.
    host.workspace.registerCommand({
      id: 'new-whiteboard',
      name: createWhiteboardLocalizedText('command.newWhiteboard'),
      callback: () => createWhiteboard(host, ''),
    })
    // The ribbon says "YOLO whiteboard", not just "whiteboard": Obsidian's own
    // Canvas ribbon action sits in the same strip under that exact name in
    // several locales, and two identical tooltips make the strip unreadable.
    host.workspace.registerRibbonAction({
      icon: WHITEBOARD_ICON,
      title: createWhiteboardLocalizedText('menu.newWhiteboard'),
      onClick: () => void createWhiteboard(host, ''),
    })
    host.workspace.registerFileMenuAction({
      id: 'whiteboard-new-in-folder',
      title: createWhiteboardLocalizedText('menu.newWhiteboard'),
      icon: WHITEBOARD_ICON,
      appliesTo: 'folder',
      onSelect: (entry) => createWhiteboard(host, entry.path),
    })

    // `.canvas` import (p3-canvas-parity D4): one-way, never registers a view
    // for `.canvas` and never writes one. Two entries because they answer two
    // different questions — "bring this canvas across" (right-click one) and
    // "bring my canvases across" (the migration a command can express, since
    // a command has no file to act on).
    host.workspace.registerFileMenuAction({
      id: 'whiteboard-import-canvas',
      title: createWhiteboardLocalizedText('menu.importCanvas'),
      icon: WHITEBOARD_ICON,
      appliesTo: 'file',
      extensions: ['canvas'],
      onSelect: (entry) => importCanvasFileAndOpen(host, entry.path),
    })
    host.workspace.registerCommand({
      id: 'import-all-canvas',
      name: createWhiteboardLocalizedText('command.importAllCanvas'),
      callback: () => importAllCanvasFiles(host),
    })
  },
})
