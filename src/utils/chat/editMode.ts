import { TFile } from 'obsidian'

import { TextEditPlan } from '../../core/edits/textEditEngine'
import { parseTextEditPlan } from '../../core/edits/textEditPlan'
import { BaseLLMProvider } from '../../core/llm/base'
import { ChatModel } from '../../types/chat-model.types'
import { RequestMessage } from '../../types/llm/request'
import { LLMProvider } from '../../types/provider.types'

const EDIT_MODE_SYSTEM_PROMPT = `You are an intelligent markdown editor.

Return ONLY a single edit block in this format:

<<<<<<< REPLACE
[old]
exact text to replace
=======
[new]
replacement text
>>>>>>> END

Supported operation types:
1. REPLACE
   - Replace exact text.
   - Sections: [old], [new].

2. INSERT_AFTER
   - Insert content after exact anchor text.
   - Sections: [anchor], [content].

3. APPEND
   - Append content to the end of the document.
   - Section: [content].

Rules:
- Output only the edit block. No markdown fences. No JSON. No explanation.
- Keep edits minimal and localized.
- Prefer REPLACE for modifications, INSERT_AFTER for inserting near existing text, APPEND only for true continuation.
- old/anchor must include enough surrounding context to match uniquely.
- The marker lines must be exact and appear on their own lines.
- Preserve markdown structure unless the instruction requires changing it.`

export const parseEditPlan = (content: string): TextEditPlan | null => {
  return parseTextEditPlan(content)
}

export async function generateEditPlan({
  instruction,
  currentFile,
  currentFileContent,
  scopedToSelection = false,
  providerClient,
  model,
}: {
  instruction: string
  currentFile: TFile
  currentFileContent: string
  scopedToSelection?: boolean
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
}): Promise<TextEditPlan | null> {
  const requestMessages: RequestMessage[] = []

  requestMessages.push({
    role: 'system',
    content: EDIT_MODE_SYSTEM_PROMPT,
  })

  requestMessages.push({
    role: 'user',
    content: generateEditPrompt({
      instruction,
      currentFile,
      currentFileContent,
      scopedToSelection,
    }),
  })

  const response = await providerClient.generateResponse(model, {
    model: model.model,
    messages: requestMessages,
    stream: false,
  })

  const message = response.choices[0]?.message
  const rawContent = `${message?.content ?? ''}`.trim()
  const rawReasoning = `${message?.reasoning ?? ''}`.trim()

  return parseEditPlan(rawContent) ?? parseEditPlan(rawReasoning)
}

function generateEditPrompt({
  instruction,
  currentFile,
  currentFileContent,
  scopedToSelection,
}: {
  instruction: string
  currentFile: TFile
  currentFileContent: string
  scopedToSelection: boolean
}): string {
  const selectionGuidance = scopedToSelection
    ? `
- The provided content is the selected slice the user wants to edit.
- For broad transformations like translate, rewrite, summarize, or table-wide edits, prefer a single REPLACE block where [old] is the exact full provided content and [new] is the fully transformed result.
- Do not update only the heading or table header if the request clearly applies to the full selected block.`
    : ''

  return `# Document to Edit

File: ${currentFile.path}

Content:
\`\`\`markdown
${currentFileContent}
\`\`\`

# Instruction

${instruction}

# Your Task

Return a single edit block using REPLACE, INSERT_AFTER, or APPEND.
- Use REPLACE for rewriting existing text.
- Use INSERT_AFTER for inserting new content after existing text.
- Use APPEND only when the user explicitly wants continuation at the end.
- Keep changes minimal.
- Preserve full markdown structures such as tables, lists, and headings when editing them.
- If a markdown table is being transformed, update all affected rows and cells, not just the header.
- [old] in REPLACE should include the exact markdown source, including pipes and separator rows for tables.${selectionGuidance}
- Output the edit block only.`
}
