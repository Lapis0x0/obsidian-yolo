// Which freshly imported boards should open framed on their whole content
// (P3 batch 3 wave B, feature 8).
//
// The problem: a `.canvas` carries no camera, so the importer has to invent
// one. It parks the world origin near the content's top-left corner at 1:1
// (domain/canvasImport.ts's `cameraForBounds`), which is right for a board
// laid out around the origin and useless for one spread over ten thousand
// units — the user opens it and sees empty space or one corner. Shift+1 fixes
// it, but having to know that is the bug.
//
// The fix has to happen where the viewport size is known, which is the view,
// not the importer. Three ways to get it there, and this is the third:
//
//   1. have the importer compute a fit camera against an assumed viewport —
//      cheapest, but the assumption is wrong for every window that is not the
//      assumed size, and it bakes a guess into the file permanently;
//   2. write a "fit me on first open" flag into the `.yoloboard` — accurate,
//      but it puts a piece of transient UI intent into a persisted document,
//      where it lingers forever on a board nobody ever opens;
//   3. remember it in memory, here.
//
// In-memory wins because the state genuinely is transient: it means "this
// board was just created and has never been looked at", which is a fact about
// this session, not about the file. It self-clears on consumption, costs a
// string per import, and its worst failure is benign — a module reload before
// the board is opened simply drops the request, and the board opens at the
// importer's own camera exactly as it did before this existed.
//
// Registered by both import entry points, not just the one that opens a board:
// "import all" opens nothing, but the first time the user does open one of its
// boards is still that board's first open, and the same framing is what they
// need. Consumed on the first `setViewData` for that path, so every later open
// honours the camera the file has by then stored.

const pendingFitPaths = new Set<string>()

/** Marks a board as never-yet-looked-at, so its first view frames all of it. */
export function markPendingFit(path: string): void {
  pendingFitPaths.add(path)
}

/** True once per registered path: asking consumes the request. */
export function takePendingFit(path: string): boolean {
  return pendingFitPaths.delete(path)
}
