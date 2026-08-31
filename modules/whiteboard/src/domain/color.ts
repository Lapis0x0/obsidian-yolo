// How a `color` attribute on a node or an edge (domain/fileFormat.ts's
// `NodeColor`, JSON Canvas's `canvasColor`) turns into something that can be
// rendered.
//
// The file format keeps `color` as an unconstrained string on purpose — an
// unknown value round-trips rather than being dropped. This module is the one
// place that decides what a given value *means* on screen: one of the six
// presets, a custom hex, or nothing at all (which is also the answer for a
// value we do not recognize — preserving data and rendering it are different
// jobs, and a card is not improved by guessing).
//
// Zero dependencies, no DOM: the CSS side of this lives in style.css, which
// maps each preset to `--canvas-color-N`, Obsidian's own canvas palette, so a
// theme that restyles Canvas restyles our boards too.

export const COLOR_PRESETS = ['1', '2', '3', '4', '5', '6'] as const

export type ColorPreset = (typeof COLOR_PRESETS)[number]

export type ResolvedColor =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'preset'; preset: ColorPreset }>
  | Readonly<{ kind: 'custom'; hex: string }>

const NONE: ResolvedColor = Object.freeze({ kind: 'none' })

/** `#rgb` or `#rrggbb`, the two forms JSON Canvas's spec shows and the only
 * two `<input type="color">` round-trips. */
const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * The six presets' colours as Obsidian itself defines them (read off
 * `--canvas-color-1`..`-6` in a running Obsidian 1.13.7 with the default
 * theme). They are *fallbacks*, not the source of truth: style.css always
 * asks for `var(--canvas-color-N, <this>)`, so a theme's override wins and
 * these only apply where Obsidian's variables are missing entirely.
 *
 * They are also what seeds the custom-colour input when the current colour is
 * a preset — an OS colour picker has to open on some concrete value.
 */
export const PRESET_HEX: Readonly<Record<ColorPreset, string>> = Object.freeze({
  '1': '#e93147',
  '2': '#ec7500',
  '3': '#e0ac00',
  '4': '#08b94e',
  '5': '#00bfbc',
  '6': '#7852ee',
})

export function resolveColor(color: string | undefined): ResolvedColor {
  if (color === undefined) return NONE
  if ((COLOR_PRESETS as readonly string[]).includes(color)) {
    return { kind: 'preset', preset: color as ColorPreset }
  }
  const hex = normalizeHex(color)
  return hex === null ? NONE : { kind: 'custom', hex }
}

/** A hex colour in the single form the rest of the module uses: lower-case,
 * six digits (`#abc` expanded). Null for anything that is not a hex colour. */
export function normalizeHex(value: string): string | null {
  const trimmed = value.trim()
  if (!HEX_PATTERN.test(trimmed)) return null
  const lower = trimmed.toLowerCase()
  if (lower.length === 7) return lower
  const [, r, g, b] = lower
  return `#${r}${r}${g}${g}${b}${b}`
}

/**
 * The colour shared by a selection, or `undefined` when it has none — either
 * because nothing in it is coloured or because its members disagree.
 *
 * "Disagree" and "uncoloured" deliberately collapse into the same answer: both
 * mean there is no swatch to mark as the current one, and neither stops the
 * next pick from applying to everything.
 */
export function commonColor(
  colors: readonly (string | undefined)[],
): string | undefined {
  if (colors.length === 0) return undefined
  const [first] = colors
  if (first === undefined) return undefined
  return colors.every((color) => color === first) ? first : undefined
}

/** What an `<input type="color">` should open on for the given colour: the
 * colour itself when it is already a hex, the preset's own value when it is a
 * preset, and a neutral mid-grey when there is no colour to start from. */
export function customColorInputValue(color: string | undefined): string {
  const resolved = resolveColor(color)
  switch (resolved.kind) {
    case 'custom':
      return resolved.hex
    case 'preset':
      return PRESET_HEX[resolved.preset]
    case 'none':
      return '#808080'
  }
}
