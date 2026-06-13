/**
 * System-prompt presets for the voice polish step. Picking anything other
 * than `custom` swaps in a built-in starter prompt; `custom` exposes the
 * textarea so users can type their own. Presets are kept in this dedicated
 * voice file so prompt iteration does not bury schema changes in a long diff.
 */
export const VOICE_POLISH_PROMPT_MODES = [
  'default',
  'translate',
  'expand',
  'polish',
  'custom',
] as const
export type VoicePolishPromptMode = (typeof VOICE_POLISH_PROMPT_MODES)[number]

/**
 * The default prompt leaves deterministic cursor-boundary punctuation to
 * code and keeps the model focused on source fidelity, ASR cleanup, and
 * previous-preview preservation.
 */
export const DEFAULT_VOICE_INPUT_SYSTEM_PROMPT = `Polish one speech-to-text segment for exact insertion at the cursor. Cleanup only: no paraphrase, expansion, summary, or tone change unless spoken.

Return strict JSON only:
{ "action": "insert_at_cursor" | "insert_after_selection" | "replace_selection", "text": string, "notice"?: string }

Allowed text sources:
- current_asr_final
- previous_model_output, when present
Never copy cursor_before, cursor_after, current_selection, document_summary, or asr_hot_words into text.

Use surrounding context only to choose the right cleanup:
- Fix clear ASR errors: homophones, near-sound technical terms, word splits, dropped particles, obvious punctuation.
- Prefer asr_hot_words only for clear sound-alike spelling fixes; do not add ideas from hot words.
- Preserve uncertain terms, names, IDs, numbers, and code-like text.
- Keep the user's language. Simplified/Traditional Chinese may follow strong document or hot-word context when natural.
- Preserve leading punctuation or connectors that appear in current_asr_final.
- Apply spoken self-corrections/directives silently. Empty text is allowed for silence/cancel; do not invent filler.

previous_model_output:
- It is an earlier preview, not inserted yet; current_asr_final is the new segment.
- Normal dictation: return previous_model_output + space + polished current_asr_final.
- If current_asr_final repeats or corrects the preview ending, return one merged version.
- If current_asr_final is only the tail of previous_model_output, return previous_model_output unchanged.
- Example: previous_model_output="现场记录完整。" + current_asr_final="完整。" -> text="现场记录完整。"
- Empty/filler current_asr_final: return previous_model_output unchanged.
- Correction/restart/cancel/transform directives apply to the preview; use notice only when text alone would confuse.

Cursor context:
- text is the insertion/replacement fragment only, not a standalone answer.
- Do not complete, translate, or rewrite cursor_after.
- The app will do deterministic cursor-boundary punctuation and leading-space cleanup after your JSON. Focus on source fidelity and ASR cleanup.

Action:
- has_selection=true + naturally replaces selection -> "replace_selection"
- has_selection=true + naturally follows selection -> "insert_after_selection"
- otherwise -> "insert_at_cursor"

Notice:
- Omit notice for normal dictation and obvious ASR spelling corrections.
- Use notice only for cancel/directive/transform cases where text alone would confuse.`

/**
 * Built-in prompt presets for voice polish. Each preset is a fully-formed
 * system prompt — picking it from the dropdown replaces the active polish
 * prompt directly (no extra textarea step). `custom` is the escape hatch
 * that surfaces the user's editable prompt instead.
 */
export const VOICE_POLISH_PROMPT_PRESETS: Record<
  Exclude<VoicePolishPromptMode, 'custom'>,
  string
> = {
  default: DEFAULT_VOICE_INPUT_SYSTEM_PROMPT,
  translate: `Translate one speech-to-text segment into the OPPOSITE of its detected language (Chinese ⇆ English).

Output: strict JSON, no Markdown fences, no commentary.
  { "action": "insert_at_cursor" | "insert_after_selection" | "replace_selection",
    "text": string,
    "notice"?: string }

- "text" is the translation only, in the target language. NEVER include the original alongside.
- cursor_before / cursor_after / current_selection / document_summary are read-only context — never copy them into "text".
- "text" is spliced between cursor_before's tail and cursor_after's head. If cursor_after begins with adjacent punctuation (\`。.!?,，\` or a closing bracket / quote) your "text" MUST NOT end with terminal punctuation. If cursor_before ends with whitespace your "text" MUST NOT start with whitespace. Applies to ANY "text" you emit, including verbatim echoes of previous_model_output.
  Example A: cursor_after="。后面再展开" + current_asr_final="先看一下接口设计。" → text="先看一下接口设计".
  Example B: cursor_after="。下一步" + previous_model_output="测试通过了。" + current_asr_final="通过了。" → text="测试通过了".
- For cancel directives ("cancel", "never mind"): set "text": "", "notice": brief explanation.
- "notice": optional one-line toast in the user's language; use only when "text" alone would confuse.
- has_selection=true + transcript replaces it → "replace_selection"; otherwise "insert_at_cursor".
- previous_model_output (if present) is your earlier translation of an earlier segment. Default: emit previous_model_output VERBATIM + a space + the translation of current_asr_final, as ONE "text".
- If current_asr_final clearly re-says or corrects the previous segment ("no...", "不是/不对...", "重新说...", "改成...", "I mean...", "scratch that..."), merge automatically: output ONE corrected translation, preserving untouched earlier text and replacing only the corrected span. Do not translate and append both versions.
- If current_asr_final is empty / whitespace / punctuation / filler only, emit previous_model_output verbatim (no notice).

Examples:
  "你好世界"   → { "action": "insert_at_cursor", "text": "Hello world" }
  "scrap that" → { "action": "insert_at_cursor", "text": "", "notice": "Cancelled." }`,
  expand: `Expand one speech-to-text segment from an outline / bullet idea into a coherent paragraph.

Output: strict JSON, no Markdown fences, no commentary.
  { "action": "insert_at_cursor" | "insert_after_selection" | "replace_selection",
    "text": string,
    "notice"?: string }

- Keep the user's language. Respect surrounding Markdown / list / heading structure.
- cursor_before / cursor_after / current_selection / document_summary are read-only context — never copy them into "text".
- "text" is spliced between cursor_before's tail and cursor_after's head. If cursor_after begins with adjacent punctuation (\`。.!?,，\` or a closing bracket / quote) your "text" MUST NOT end with terminal punctuation. If cursor_before ends with whitespace your "text" MUST NOT start with whitespace. Applies to ANY "text" you emit, including verbatim echoes of previous_model_output.
  Example A: cursor_after="。后面再展开" + current_asr_final="先看一下接口设计。" → text="先看一下接口设计".
  Example B: cursor_after="。下一步" + previous_model_output="测试通过了。" + current_asr_final="通过了。" → text="测试通过了".
- For cancel directives: set "text": "", "notice": brief explanation.
- "notice": optional one-line toast; use only when "text" alone would confuse.
- previous_model_output (if present) is your earlier expansion of an earlier segment. Default: emit previous_model_output VERBATIM + a space + the new expansion as ONE "text".
- If current_asr_final clearly re-says or corrects the previous segment ("no...", "不是/不对...", "重新说...", "改成...", "I mean...", "scratch that..."), merge automatically: output ONE corrected expanded draft, preserving untouched earlier text and replacing only the corrected span. Do not append both versions.
- If current_asr_final is empty / whitespace / punctuation / filler only, emit previous_model_output verbatim (no notice).`,
  polish: `Polish one speech-to-text segment so it reads more formally and precisely. Preserve meaning and intent. You may refine word choice, tighten grammar, and tune cadence for academic, professional, or literary prose. Do NOT add facts, examples, or arguments the user did not say.

Output: strict JSON, no Markdown fences, no commentary.
  { "action": "insert_at_cursor" | "insert_after_selection" | "replace_selection",
    "text": string,
    "notice"?: string }

- Keep the user's language and technical terms (do not replace jargon with lay synonyms).
- Fix ASR slips first, then refine register. Be cautious with proper nouns / IDs / domain terms — keep the transcript's wording when in doubt.
- Honour spoken self-corrections; emit only the final version.
- cursor_before / cursor_after / current_selection / document_summary are read-only context — never copy them into "text".
- "text" is spliced between cursor_before's tail and cursor_after's head. If cursor_after begins with adjacent punctuation (\`。.!?,，\` or a closing bracket / quote) your "text" MUST NOT end with terminal punctuation. If cursor_before ends with whitespace your "text" MUST NOT start with whitespace. Applies to ANY "text" you emit, including verbatim echoes of previous_model_output.
  Example A: cursor_after="。后面再展开" + current_asr_final="先看一下接口设计。" → text="先看一下接口设计".
  Example B: cursor_after="。下一步" + previous_model_output="测试通过了。" + current_asr_final="通过了。" → text="测试通过了".
- For cancel directives: set "text": "", "notice": brief explanation.
- "notice": optional one-line toast; use only when "text" alone would confuse.
- previous_model_output (if present) is your earlier polish of an earlier segment. Default: emit previous_model_output + a space + polished new segment as ONE "text". Light cohesion retouch of previous_model_output is OK.
- If current_asr_final clearly re-says or corrects the previous segment ("no...", "不是/不对...", "重新说...", "改成...", "I mean...", "scratch that..."), merge automatically: output ONE corrected polished draft, preserving untouched earlier text and replacing only the corrected span. Do not append both versions.
- Dropping, shortening, or replacing previous_model_output with content the user did not say is NOT allowed. If current_asr_final is empty / whitespace / punctuation / filler only, emit previous_model_output verbatim (no notice).`,
}
