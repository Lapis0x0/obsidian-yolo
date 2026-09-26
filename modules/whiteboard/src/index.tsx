// Module entry point for YOLO Whiteboard.
//
// Registers the `.yoloboard` file view via the Host API's
// `registerFileView` (added in host API 1.8.0; the declared floor is 1.9.0,
// where `vault.getResourceUrl` — what a media card points an <img>/<audio>/
// <video> at — first exists). All the actual camera/virtualization/card-lifecycle
// behavior lives in `./ui/canvas.ts`; this file only wires the thin
// `YoloModuleFileViewInstanceV1` adapter around it.
//
// The file is named index.tsx (not .ts) because the module build's entry
// point is fixed at that path (scripts/build-first-party-modules.mjs), not
// because it uses JSX.

import { AnnotationPrefs } from './host/annotationPrefs'
import { AnnotationStores } from './host/annotationStore'
import { registerWhiteboardAgentTools } from './host/boardTools'
import { createWhiteboard } from './host/createWhiteboard'
import { exportAnnotatedPdf } from './host/exportAnnotatedPdf'
import {
  importAllCanvasFiles,
  importCanvasFileAndOpen,
} from './host/importCanvasFile'
import { MinimapPrefs } from './host/minimapPrefs'
import { OpenBoards } from './host/openBoards'
import { PdfThumbnailStore } from './host/pdfThumbnailStore'
import { ReaderPanelPrefs } from './host/readerPanelPrefs'
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
    const readerPanelPrefs = new ReaderPanelPrefs(
      host.privateStorage.deviceLocal,
      (stage, error) =>
        console.error(`[YOLO Whiteboard] ${stage} failed`, error),
    )

    const reportError = (stage: string, error: unknown) =>
      console.error(`[YOLO Whiteboard] ${stage} failed`, error)
    // PDF annotations: one store per PDF shared by every board and reader,
    // and the follower that keeps each annotation file beside its PDF across
    // renames and deletes — for PDFs no board shows, too.
    const annotationStores = new AnnotationStores(host, reportError)
    host.lifecycle.add(() => annotationStores.dispose())
    const minimapPrefs = new MinimapPrefs(
      host.privateStorage.deviceLocal,
      reportError,
    )
    const annotationPrefs = new AnnotationPrefs(
      host.privateStorage.synchronized,
      reportError,
    )
    // PDF page thumbnails, kept on this device for every board.
    const pdfThumbnailStore = new PdfThumbnailStore(
      host.privateStorage.deviceLocal,
      reportError,
    )
    host.lifecycle.add(() => pdfThumbnailStore.dispose())

    host.workspace.registerFileView({
      viewType: VIEW_TYPE,
      extensions: ['yoloboard'],
      name: createWhiteboardLocalizedText('module.name'),
      icon: WHITEBOARD_ICON,
      factory: (context) => {
        // Read on the first board opened, not at activation: private
        // storage only answers once the module is active.
        readerPanelPrefs.load()
        annotationPrefs.load()
        minimapPrefs.load()
        const canvas = new WhiteboardCanvas(
          context,
          host,
          readerPanelPrefs,
          annotationStores,
          annotationPrefs,
          pdfThumbnailStore,
          minimapPrefs,
        )
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
    // `edit_board` / `create_board` are how it writes one.
    registerWhiteboardAgentTools(host, openBoards)

    // Event-layer reference resilience: keeps every
    // `.yoloboard` file's card references correct across renames/moves for
    // as long as the module is active, independent of any open leaf.
    host.lifecycle.add(registerWhiteboardRenameRewriter(host))

    // Creation entries: command and ribbon create at the vault
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

    // A PDF's annotations written into a copy of it, from anywhere the PDF
    // is offered as a file: the file explorer, and the "more options" menu of
    // Obsidian's own PDF tab. The same entry is on a PDF card's context menu
    // and the reading panel's header menu. There is no command for it: a
    // command carries no target (the Host API has no active-file surface).
    host.workspace.registerFileMenuAction({
      id: 'whiteboard-export-annotated-pdf',
      title: createWhiteboardLocalizedText('menu.exportAnnotatedPdf'),
      icon: 'file-output',
      appliesTo: 'file',
      extensions: ['pdf'],
      onSelect: (entry) =>
        exportAnnotatedPdf(host, annotationStores, entry.path),
    })

    // `.canvas` import: one-way, never registers a view
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
