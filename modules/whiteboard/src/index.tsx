// Module entry point for YOLO Whiteboard.
//
// M1 skeleton milestone (docs/plans/08-25-yolo-whiteboard/p1-design.md): the
// module must build, install, and activate cleanly, but registers no view,
// command, ribbon action, or setting yet — file-view wiring (host.views /
// registerFileView) lands in a later milestone once that Host API surface
// exists. `activate` is intentionally a no-op beyond that.
//
// The file is named index.tsx (not .ts) because the module build's entry
// point is fixed at that path (scripts/build-first-party-modules.mjs); it
// contains no JSX yet and will pick up real UI in a later milestone.

const MODULE_ID = 'whiteboard'

yolo.registerModule({
  id: MODULE_ID,
  activate() {
    // Intentionally empty for M1: no host surface is registered yet.
  },
})
