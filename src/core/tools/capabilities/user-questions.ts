import { askUserQuestionDefinition } from '../ask_user_question/definition'
import { defineCapability } from '../define'

// label/description copied from the `ask_user_question` entry in
// `builtinToolUiMeta.ts`; category from `BUILTIN_TOOL_CATEGORY_MAP`
// (`'context'`). The i18n keys are unchanged from the existing locale
// entries (master.md §5). `id: 'user_questions'` is a new capability id
// (decision 16) for this 1:1 tool (decision 14).
//
// defaultEnabled/approval cross-checked the same way as `todo_list`:
// `ask_user_question` is NOT in `BUILTIN_DEFAULT_DISABLED_TOOL_SHORT_NAMES`
// -> defaultEnabled: true. Not in `FULL_ACCESS_LOCAL_TOOLS` /
// `REQUIRE_APPROVAL_LOCAL_TOOLS` / the bash special-case -> defaultMode:
// 'full_access'. Not in `ALWAYS_ALLOW_DISABLED_TOOL_NAMES` ->
// allowAlwaysAllow: true. Not one of the three dedicated-settings tools ->
// hasSettings: false.
export const userQuestionsCapability = defineCapability({
  id: 'user_questions',
  label: {
    key: 'settings.agent.builtinAskUserQuestionLabel',
    fallback: 'Ask User',
  },
  description: {
    key: 'settings.agent.builtinAskUserQuestionDesc',
    fallback:
      'Pause the run and ask the user 1-3 structured questions (free text / single / multi). The agent resumes after the user submits answers.',
  },
  category: 'context',
  defaultEnabled: true,
  approval: {
    defaultMode: 'full_access',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: true,
  },
  hasSettings: false,
  tools: [askUserQuestionDefinition],
})
