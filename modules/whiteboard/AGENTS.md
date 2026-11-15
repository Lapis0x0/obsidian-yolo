# Whiteboard Module Guidelines

Read with the repository's `AGENTS.md`. Where each behavior lives is indexed in `FEATURE_MAP.md` under 白板 / .yoloboard.

## Three Hands Draw the Board

- The overview canvas (`src/ui/canvas/overviewLayer.ts`), at the bottom: which cards show, their surfaces and pictures, titles at a distance, and every group's wash.
- The GPU scene (`src/ui/gpu/`), over it: card frames and typeset content.
- The DOM world layer, on top: group borders and titles, and the cards that need an element (editing, PDFs, HTML, media).

Which hand draws a thing changes with the zoom tier, with mounting, and in the middle of a motion. One thing is often drawn by two hands at once — a group's wash on the canvas under the cards, its border and title in the DOM — or handed from one to another as it moves. Whatever differs between the hands shows up as the seam: a corner that changes, a title that pops, two frames that come apart.

## Define Each Visual Rule Once

Every rule for something more than one hand draws is defined in one place and read by all of them: sizes, corners, colours, title metrics, curves, durations, and the clock.

- Sizes, corners, title metrics and timings: `src/ui/constants.ts`.
- Where a node is shown while it moves: `src/ui/canvas/motions.ts`, the only source of poses for every hand (arithmetic in `src/ui/tween.ts`). Its clock is the document timeline the DOM's Web Animations play on; never sample a motion on another clock.
- How a fold carries what it folds: `src/ui/foldMotion.ts`.

Never write a number, curve or rule into one layer alone. Put it in the shared place and read it from every layer. Where a stylesheet has to repeat a constant (CSS cannot read TypeScript), add the pair to `src/ui/crossLayer.test.ts`.

## Verify in Every Tier

Check a change to how something looks or moves in the DOM tier, on text cards the GPU draws without an element, and in the overview tier (below `OVERVIEW_SCALE_THRESHOLD`) — in motion as well as at rest.
