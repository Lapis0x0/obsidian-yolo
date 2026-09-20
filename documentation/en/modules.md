# Modules

Modules are feature packages that install and update independently. They don't ship inside the plugin itself — you install them when you need them.

Where to manage them: **Settings → YOLO → Modules**.

## Installing and managing

Modules come from the officially maintained module catalog, not from arbitrary third-party repositories. The settings page splits them into three groups: **Enabled**, **Disabled** and **Available**.

Each module card carries an icon, a name, a version number, a description, and action buttons that change with its state: Install / Enable / Update / Update and enable / Disable / Uninstall.

When an update is available the version number is highlighted in the form `v1.2 → v1.3`.

**When a module can't be installed** the reason is spelled out: the platform isn't supported, you need to update YOLO Core first, or the data schema is incompatible. In those cases you don't get an install button at all.

If a download or activation fails, you're told exactly which step broke (download timed out / download failed / integrity check failed / could not start), and you can retry.

Once a module is installed, if it has settings of its own they show up as a separate entry in the left-hand navigation of the Modules page.

> After installing a module you may notice new tools in chat, or new options in the mode dropdown — that's expected. Modules can contribute their own tools and chat modes to conversations.

---

# Learning module

Turns a topic and a pile of materials into structured study content: an outline, knowledge points, flashcards, exercises and a knowledge map, with spaced repetition on top so you actually remember it.

> The Learning module is currently in **public beta**. The first time you open it you get an explanation you have to acknowledge — the button reads **I understand, enter learning mode** — before you can continue.

## Opening it

The graduation-cap icon in the left ribbon, or the **Open learning mode** command in the command palette.

## Creating a learning project

Click **New project** in the learning center. You need to fill in:

- **Learning topic** — "React", say, or "General principles of criminal law"
- **Learning mode** — **Standard mode** is available today (generates a knowledge structure + cards + exercises); **Project mode** is marked Coming soon
- **Current level** — Beginner / Know the basics / Some experience / Advanced
- **Learning goal and notes** — free text. Put your schedule or use case in here, or spell out what you don't want to study
- **Reference materials** (optional) — drag in PDF, Word or Markdown files, 20MB per file max. If you upload materials, the AI tailors the outline to them

### Generation happens in steps

It isn't produced in one shot — you get to confirm along the way:

1. Click **Create and generate outline** and the AI plans the learning path and chapter structure first
2. **Once the outline is out, you can change it** — add or remove chapters, drag them into order, edit chapter titles and their coverage descriptions
3. When it looks right, click **Confirm outline and generate knowledge points** and it works through the chapters one by one
4. Cards come after that

That "outline first, so you can fix it" design earns its keep: if the outline is wrong everything downstream is wrong, and fixing an outline is far cheaper than fixing a hundred cards.

**Generation can run in the background** — switch to something else and it keeps going, and you get a notification when it's done.

**If it gets interrupted you can resume** — reopen the project and you'll see a banner saying generation is unfinished, with "N/M chapters generated"; click **Continue from where it stopped** to carry on. Note that this capability was added later, so projects created before it shipped can't be resumed automatically.

## What's inside a project

Open a project and you get four tabs:

| Tab | What's in it |
|------|------|
| **Outline** | A tree of chapters and knowledge points. You can search it, regenerate a single knowledge point, see each point's card count and mastery, and jump to the matching note |
| **Knowledge map** | A graph of how the knowledge points relate to each other |
| **Cards** | Flashcards. Click or hit space to flip, then rate with **Forgot / Again / Fuzzy / Got it / Easy**. You can filter by chapter, and add, edit, delete or suspend individual cards by hand |
| **Exercises** | Question-and-answer practice. You write an answer and the AI gives you a point-by-point comparison, what you missed or got wrong, a full explanation and a reference answer |

## Spaced repetition

Both cards and exercises are scheduled by the FSRS algorithm.

The learning center home page has **Start today's review**, which drops you straight into everything due today — **merged across projects**, so you don't have to go into them one at a time. The Cards tab inside a project can also review that project only.

The rating you give directly determines when a card comes back, and the interface shows you the next interval (in minutes / hours / days).

Mastery has three levels — **New / Learning mode / Mastered** — shown as a percentage in both the outline and the card list.

The home page also sums up how much is due today, what to prioritize, your **30-day estimated retention**, and per-project progress.

## Import from Anki

**Import from Anki** in the learning center: pick a `.apkg` file (**200MB max**).

It parses and previews first, showing chapters, cards, cards with valid history, how many are suspended, media files, plus warnings and anything skipped. When that looks right, fill in a **Project name** and click **Import project**.

**Review history comes across with it** — you aren't starting from zero.

> **Import only for now, no export.** You can't push the Learning module's cards back to Anki.

---

# Whiteboard module

`.yoloboard` is YOLO's own infinite-canvas format.

## Creating and importing

- **New**: the **New whiteboard** command in the command palette, or the new-file entry in the file menu
- **Import from Canvas**: right-click a `.canvas` file and choose **Import as YOLO whiteboard**; for bulk, use the **Import every Canvas as a YOLO whiteboard** command

A bulk import creates a whiteboard with the same name next to each Canvas. **The original `.canvas` files are neither modified nor deleted.**

## How it relates to Obsidian Canvas

The two formats coexist without getting in each other's way. The core difference is what a card actually is:

**A card on a YOLO whiteboard is a viewport onto a note.** The card records which part of that note to look at and how to present it; the note's content is still just an ordinary Markdown file. The whiteboard only stores the window's position and size.

An Obsidian Canvas node is closer to a snapshot with the content embedded in it.

In practice: edit the note and the card on the whiteboard follows; where the card sits on the whiteboard has nothing to do with the note itself.

## Cards

Ways to add one (right-click empty space, or use the toolbar):

- **Add note** — pick an existing note from your vault
- **Add media file** — images, audio and video inside the vault
- **Add web page** — enter an http/https address, or just drag an HTML file in

A card can be turned into a note with **Convert to note**: if the card isn't linked to an existing note yet, its content is written out as a new one.

If the referenced file is deleted or moved, the card shows a **File missing** placeholder; types that can't be previewed show **Not shown yet**.

## Operations

The right-click menu gives you:

- **Grouping** — **Group selection** for several cards at once, or **New group** for an empty one, and groups can be renamed
- **Alignment** — **Align left / Align horizontal centres / Align right / Align top / Align vertical centres / Align bottom**
- **Distribution** — **Distribute horizontally**, **Distribute vertically**
- **Tidy up** — one-click auto layout
- **View** — **Zoom to selection**, **Back to origin**
- **Edges** — draw lines between cards, four arrow styles (**No arrow / Arrow at the end / Arrow at the start / Arrows at both ends**), and you can add a text label
- **Colour** — **Set colour**, with six presets plus **Custom colour** (and **No colour** to clear it)

## What AI can do to a whiteboard

Two paths:

**The whiteboard tools in chat** — the module contributes two tools (the **Whiteboard Toolset**) to conversations: create a whiteboard, and edit the whiteboard that's currently open (add, remove and move cards, draw edges, make groups).

These tools are **disclosed on demand**, so if you've never made a whiteboard you'll never see them taking up context.

The editing tool **only touches cards and their connections; it does not rewrite the text inside a card**. Reading a whiteboard goes through the ordinary file read tool and returns a summary rather than a few hundred kilobytes of raw data.

On top of that, YOLO Core **refuses** to edit a `.yoloboard` file with the plain text-editing tools — that's what keeps structured data from being mangled as if it were plain text.

**The inline AI buttons on a card** — four quick actions aimed at a single card: **Expand / Ideas / Challenge / Summarize**. Click one and the AI reads that card plus its neighbours as context, then writes the generated content back into the card. You can stop it at any point.

---

## Related

- How to manage the tools modules contribute: [Tools and permissions](./tools-and-permissions.md)
- The notes that whiteboard cards point at: [Chat](./chat.md)
