---
name: interactive-page-cards
description: Build an interactive explanation, demo, simulation, visualization or small tool as a self-contained HTML page and put it on a whiteboard (.yoloboard) as a live card. Use when the user wants something they can play with — sliders, step-through animations, explorable diagrams, calculators — rather than text to read.
---

# Interactive page cards

A whiteboard card can show an HTML file from the vault as a live page: its scripts run, the user scrolls and clicks inside it, and the board remembers where they left it. This skill is how to make one.

## When to use it

- Use a page when the content has something to *do*: change a parameter and watch the result, step through an algorithm, explore a chart, drag things around, try a formula.
- Do not use a page for text the user will only read. Long prose, notes and summaries belong in a Markdown note (a note card), which the user can search, link and edit. A page that is mostly paragraphs is the wrong tool.

## The page must be one self-contained file

- Write a single `.html` file. Put CSS in a `<style>` element and JavaScript in `<script>` elements, inline.
- Libraries may come from a CDN with an absolute `https://` URL (for example `https://cdn.jsdelivr.net/npm/...`). `fetch` to `https://` works too.
- Nothing relative loads: no `./style.css`, no `img/x.png`, no second HTML file. Inline images as `data:` URIs or SVG.
- The page runs sandboxed. It cannot reach Obsidian, the vault or other files, and `window.parent` is off limits. Do not try.
- Start with `<!DOCTYPE html>` and `<meta charset="utf-8">`.

## Keep the user's state in localStorage

The board keeps each card's `localStorage` and gives it back every time the page loads: after the board is closed and reopened, after Obsidian restarts, and after you edit the file. Anything kept only in JavaScript variables is lost on the next load.

- Every value the user can change (slider positions, selected tab, current step, inputs, toggles) must be written to `localStorage` when it changes and read back on load to restore the page.
- `getItem`, `setItem`, `removeItem`, `clear`, `key`, `length`, `localStorage.name = value` and `Object.keys(localStorage)` all work. Values are strings; use `JSON.stringify` / `JSON.parse` for structures.
- Each card has a 64K-character budget (keys plus values). Past it, `setItem` throws `QuotaExceededError`. Store settings and small state, not datasets or generated output.
- Two cards showing the same file keep separate storage.
- `sessionStorage` works but is not kept.

## Long content: one continuous scroll

If the page is long, make it a single page that scrolls vertically (the document itself scrolls, not an inner `overflow: auto` box). The board remembers how far down the user scrolled and restores it once the page has loaded. Do not build your own pagination or scroll-restoring code.

## Follow light and dark mode

The page sees Obsidian's light or dark theme through the standard media query, and it changes live without reloading.

- Declare `<meta name="color-scheme" content="light dark">` so the browser's default colors (background, text, form controls) follow too.
- Style with `@media (prefers-color-scheme: dark) { ... }`, or CSS variables switched by it.
- For canvas or SVG drawn by script, read `matchMedia('(prefers-color-scheme: dark)').matches` and redraw on its `change` event.

## Workflow

1. Write the HTML file into the vault with your file-writing tool.
   - Location: if the user named a place, use it. Otherwise follow the user's attachment location setting, `attachmentFolderPath` in the vault config folder's `app.json` (usually `.obsidian/app.json`): `./` means the board's own folder, `./name` a subfolder next to the board, any other value a vault folder. If you cannot read it, put the page in the same folder as the board.
   - Give it a descriptive file name, such as `Fourier series explorer.html`.
2. Put it on the board with the whiteboard `edit_board` tool: a card in `create` with `file` set to the page's vault path, plus `x`/`y` and a `w`/`h` that suit the page. Read the board first to find free space. Typical sizes are about 480×360 for a small widget and 800×600 for a full demo. A card can be resized later, so lay the page out responsively (relative widths, no fixed large pixel widths).
3. To change the page later, edit the same file. Every card showing it reloads by itself, with its scroll position and `localStorage` intact. Keep storage keys stable across edits so saved state still applies.
