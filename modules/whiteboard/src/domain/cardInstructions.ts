// The four things an empty card offers to do (master.md §5, Q16).
//
// Fixed and built in, on purpose. A card's chips are the lowest-cost AI entry
// on the board — one click, no typing — and what makes that worth having is
// that the four are always the same four. Anything a user wants to *say* is
// what the card's own `@` (rung two) is for, so there is no custom-instruction
// list to manage here, and no settings page for one.
//
// Which four depends on one fact only: whether anything is wired into this
// card. With sources, every instruction has an object — the cards the arrow
// came from. Without, only the two that can go looking for one survive, and
// they say so in their own words ("read the cards around it"), because the
// model reaches those through `read_card` rather than through the context.
//
// Prompts are model-facing and stay in English; the *labels* are keys into
// the module's own i18n (`ui/canvas/cardGeneration.ts` resolves them at click
// time, never caching a locale-bound translator).

export type CardInstructionKey = 'expand' | 'ideas' | 'challenge' | 'summarize'

export type CardInstruction = Readonly<{
  key: CardInstructionKey
  /** i18n key for the chip's label. */
  labelKey: string
  /** What the model is asked to do, appended after the card's context. */
  prompt: string
}>

const WITH_SOURCES: readonly CardInstruction[] = [
  {
    key: 'expand',
    labelKey: 'cardAi.instruction.expand',
    prompt:
      'Expand the source card(s) into what this card should hold: the next level of detail, the reasoning behind them, the concrete form of what they only gesture at. Develop what is there rather than restating it.',
  },
  {
    key: 'ideas',
    labelKey: 'cardAi.instruction.ideas',
    prompt:
      'Give ideas the source card(s) do not already contain: adjacent angles, connections nobody has drawn yet, things worth trying next. Concrete and specific, never a list of generic directions.',
  },
  {
    key: 'challenge',
    labelKey: 'cardAi.instruction.challenge',
    prompt:
      'Challenge the source card(s): what is assumed without warrant, where the reasoning is weakest, what evidence would settle it, and the strongest case against. Be specific rather than polite.',
  },
  {
    key: 'summarize',
    labelKey: 'cardAi.instruction.summarize',
    prompt:
      'Summarize the source card(s): what they amount to, in the fewest words that keep the substance.',
  },
]

const WITHOUT_SOURCES: readonly CardInstruction[] = [
  {
    key: 'ideas',
    labelKey: 'cardAi.instruction.ideas',
    prompt:
      'Nothing is connected to this card, so decide for yourself what it is near: read the cards whose previews or coordinates suggest they belong to the same thought (`read_card`), then write ideas this board is missing — adjacent angles, connections nobody has drawn, what is worth exploring next.',
  },
  {
    key: 'summarize',
    labelKey: 'cardAi.instruction.summarize',
    prompt:
      "Nothing is connected to this card, so read the cards around it (`read_card`, starting from the ones nearest this card's coordinates) and summarize what this board is about: its through-line, its main claims, where it is heading.",
  },
]

/** The chips an empty card offers, given whether anything points into it. */
export function cardInstructions(
  hasSources: boolean,
): readonly CardInstruction[] {
  return hasSources ? WITH_SOURCES : WITHOUT_SOURCES
}

/**
 * The whole system prompt for a card generation — it *replaces* the host's
 * default one (master.md §5, W0), so the role, the output contract and the
 * tool's place in it all have to be stated here.
 */
export function cardGenerationSystemPrompt(locale: string): string {
  return `You are writing the contents of one card on a whiteboard in the user's Obsidian vault.

A whiteboard is a spatial arrangement of cards — short notes, embedded vault notes, groups, and arrows between them. The user has clicked one instruction on a single empty card, and everything you output becomes that card's text. You are not chatting: there is nobody to answer, only a card to fill.

Rules:
- Output the card's finished content and nothing else. No preamble, no sign-off, no commentary about the board or about what you are doing.
- Markdown, and short enough to read on a card: a few short paragraphs or a handful of bullets. A card is one thought, not an essay. Do not add a heading unless the content genuinely needs one.
- Say something the board does not already say. Restating the card that points at this one is the one failure that matters here.
- Write in the language the surrounding cards are written in. When that is unclear, write in the user's interface language (${locale}).
- The context below gives the board's shape and the full text of every card connected to this one. Card previews in it are clipped to 50 characters — use \`read_card\` to read one in full when it looks relevant, and never for a card whose full text you were already given.
- You cannot change the board: you write this one card, and nothing else moves.`
}
