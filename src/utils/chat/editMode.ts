import { TFile } from 'obsidian'

import { TextEditPlan } from '../../core/edits/textEditEngine'
import { BaseLLMProvider } from '../../core/llm/base'
import { ChatModel } from '../../types/chat-model.types'
import { RequestMessage } from '../../types/llm/request'
import { LLMProvider } from '../../types/provider.types'
import {
  extractTopLevelJsonObjects,
  parseJsonObjectText,
} from './tool-arguments'

const EDIT_MODE_SYSTEM_PROMPT = `You are an intelligent markdown editor.

Return ONLY a single JSON object with this shape:
{
  "operations": [
    {
      "type": "replace",
      "oldText": "exact text to replace",
      "newText": "replacement text",
      "expectedOccurrences": 1
    }
  ]
}

Supported operation types:
1. replace
   - Replace exact text.
   - Fields: type, oldText, newText, optional expectedOccurrences.

2. insert_after
   - Insert content after exact anchor text.
   - Fields: type, anchor, content, optional expectedOccurrences.

3. append
   - Append content to the end of the document.
   - Fields: type, content.

Rules:
- Output valid JSON only. No markdown fences. No explanation.
- Keep edits minimal and localized.
- Prefer replace for modifications, insert_after for inserting near existing text, append only for true continuation.
- oldText/anchor must include enough surrounding context to match uniquely.
- For repeated text, set expectedOccurrences explicitly.
- Preserve markdown structure unless the instruction requires changing it.`

type JsonObject = Record<string, unknown>

const asObject = (value: unknown): JsonObject | null => {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    return null
  }
  return value as JsonObject
}

const asPositiveInteger = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  const normalized = Math.floor(value)
  return normalized > 0 ? normalized : undefined
}

const getString = (record: JsonObject, key: string): string => {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

const normalizeOperation = (value: unknown) => {
  const record = asObject(value)
  if (!record) {
    return null
  }

  const rawType = getString(record, 'type').trim().toLowerCase()
  if (rawType === 'replace') {
    return {
      type: 'replace' as const,
      oldText: getString(record, 'oldText') || getString(record, 'search'),
      newText: getString(record, 'newText') || getString(record, 'replace'),
      expectedOccurrences:
        asPositiveInteger(record.expectedOccurrences) ??
        asPositiveInteger(record.occurrences),
    }
  }

  if (rawType === 'insert_after' || rawType === 'insertafter') {
    return {
      type: 'insert_after' as const,
      anchor: getString(record, 'anchor') || getString(record, 'oldText'),
      content: getString(record, 'content') || getString(record, 'newText'),
      expectedOccurrences:
        asPositiveInteger(record.expectedOccurrences) ??
        asPositiveInteger(record.occurrences),
    }
  }

  if (rawType === 'append' || rawType === 'continue') {
    return {
      type: 'append' as const,
      content: getString(record, 'content') || getString(record, 'newText'),
    }
  }

  return null
}

export const parseEditPlan = (content: string): TextEditPlan | null => {
  const trimmed = content.trim()
  if (!trimmed) {
    return null
  }

  const directParsed = parseJsonObjectText(trimmed)
  const parsed = directParsed ?? extractTopLevelJsonObjects(trimmed)[0] ?? null
  const root = asObject(parsed)
  if (!root) {
    return null
  }

  const operationsValue = Array.isArray(root.operations)
    ? root.operations
    : Array.isArray(root.edits)
      ? root.edits
      : null
  if (!operationsValue) {
    return null
  }

  const operations = operationsValue
    .map((item) => normalizeOperation(item))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))

  if (operations.length === 0) {
    return null
  }

  return { operations }
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

  if (!model.isBaseModel) {
    requestMessages.push({
      role: 'system',
      content: EDIT_MODE_SYSTEM_PROMPT,
    })
  }

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
- For broad transformations like translate, rewrite, summarize, or table-wide edits, prefer a single replace operation where oldText is the exact full provided content and newText is the fully transformed result.
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

Return a JSON object with an operations array.
- Use replace for rewriting existing text.
- Use insert_after for inserting new content after existing text.
- Use append only when the user explicitly wants continuation at the end.
- Keep changes minimal.
- Preserve full markdown structures such as tables, lists, and headings when editing them.
- If a markdown table is being transformed, update all affected rows and cells, not just the header.
- oldText in replace should include the exact markdown source, including pipes and separator rows for tables.${selectionGuidance}
- Output JSON only.`
}
