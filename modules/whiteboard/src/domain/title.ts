// A node's title: the one bar over a node that says what it is and what it is
// called, and carries what is done to it as a whole — a group's, a PDF's
// (folded into its card or spread out), a portal's (ui/canvas/nodeTitle.ts).
// Here only the room it takes on the board, which the board's layout keeps
// clear for it: a group's frame and an open spread's sheets are placed
// around it.

/**
 * `height` tall, standing `gap` above what it heads, left edges aligned.
 * `room` is the width a title can always count on: a group's frame is never
 * narrower, a collapsed group's box is exactly that wide, and a title over
 * something narrower runs on past it to that width before its name is cut
 * short. Whole cells of the board's 13-unit grid where it can be.
 */
export const NODE_TITLE = Object.freeze({ height: 39, gap: 6, room: 312 })
