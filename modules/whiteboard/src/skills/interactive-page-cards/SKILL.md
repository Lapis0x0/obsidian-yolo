---
name: interactive-page-cards
description: Make an interactive page the user can click, drag and play with — what other products call an Artifact or a Canvas — and show it as a live card on a YOLO whiteboard (.yoloboard). Use when the user asks for an AI 卡片 / 互动卡片 / 交互式网页 / artifact / 小工具 / 可视化 / 演示 / 模拟 / 动画讲解, or wants a concept to "动起来", even if they never mention HTML. Also worth a thought when you are explaining something on a whiteboard that is easier to grasp by trying it than by reading about it. Not for Obsidian's own .canvas files.
---

# Interactive page cards

A whiteboard card can show an HTML file from the vault as a live page. The file is an ordinary file that you write; the card is a window onto it. The user clicks, drags and scrolls inside the card, right there among their notes and PDFs.

The board does a few things for the page so you do not have to: it remembers how far the user scrolled, it keeps what the page saves in `localStorage`, it tells the page whether Obsidian is light or dark, and it reloads the card whenever the file changes. The rest of this skill follows from that picture.

## When a page is worth it

The question to ask is whether the user would understand faster by moving something than by reading a paragraph. Usually the answer is no, and a text card is the right thing: it is quick to write, and the user can search it, link it and edit it. A page costs far more time and tokens than a text card, so it is not the default way to explain things.

Sometimes the answer is clearly yes: how a parameter changes a curve, how an algorithm proceeds step by step, how a geometric relation holds as a point moves, what a formula gives for different inputs. When the user asks for one, make it. When they asked for an explanation and you can see that it is this kind of thing, you may make one on your own, or mention the option and let them choose — use your judgment about how much they seem to want it. A page next to a short text card often works better than either alone.

Long text with nothing to operate belongs in a Markdown note, not in a page.

## What a good one looks like

Design for a card, not for a website. The card sits on a board among other cards, usually a few hundred pixels wide, so it has no room for a header, a navigation bar or an introduction. Something should be visibly happening, or ready to be touched, the moment it appears.

One card carries one idea. If you find yourself adding tabs, split it into two cards and connect them with an arrow; the board is where the structure lives.

Put each control next to the thing it changes, label it, and start it at a value that already shows something interesting. Write the interface in the language the user is writing in. Lay the page out with relative widths, because the user can resize the card at any time.

For learning, a few shapes work well: let the user predict before revealing the answer, advance one step at a time with a button, or end with one or two questions they can check themselves against.

You cannot see the page you write, so keep the script simple and sturdy. In particular, saved state that no longer fits (after you changed the page) should fall back to the defaults rather than break the page.

## How a page lives in a card

**One file.** The card loads that one HTML file and nothing next to it: a relative stylesheet, script or image will not load. Put CSS and JavaScript inline, and images as inline SVG or `data:` URIs. Libraries from a CDN over `https://` are fine, and so is `fetch` to `https://`.

**Sandboxed.** The page cannot reach Obsidian, the vault or the board, and there is no channel for it to send anything back. It is a self-contained thing to look at and play with.

**State.** A reload empties every JavaScript variable, and reloads happen: the board is reopened, Obsidian restarts, you edit the file. What the page wrote to `localStorage` is saved with the card and handed back on the next load, on any device the vault syncs to. So whatever the user would be annoyed to lose — the step they reached, the values they set, the answers they gave — goes into `localStorage` as it changes and is read back on load. It is meant for small state, about 64K characters per card; past that `setItem` throws `QuotaExceededError`. Keep the keys stable when you edit the page so the saved state still applies. Two cards showing the same file keep separate state.

**Scrolling.** If the page is long, let the document itself scroll as one continuous page. The board restores the position; pagination you build yourself is not remembered unless you save it as state.

**Theme.** `prefers-color-scheme` inside the page follows Obsidian's theme and changes live. Add `<meta name="color-scheme" content="light dark">` so the default background, text and form controls follow too, and style the rest with the media query. A drawing made by script should redraw when the query changes.

## Putting it on a board

Write the file into the vault with your file tool. If the user named a place, use it; otherwise put it in the same folder as the board, under a name that says what it is, such as `Fourier series explorer.html`.

Then add a card with the whiteboard `edit_board` tool: an item in `create` whose `file` is the page's vault path, with a `w` and `h` that suit it — roughly 480×360 for a small widget, 800×600 for a fuller demo. Read the board first so the card lands in free space, near the cards it relates to, and connect it to them if that helps. If it is not clear which board the user means, ask.

To change the page, edit the same file. Every card showing it reloads on its own and the user keeps their place.
