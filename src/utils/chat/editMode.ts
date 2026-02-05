/**
 * Edit mode for Quick Ask - generates SEARCH/REPLACE blocks for document editing.
 */

import { TFile } from 'obsidian'

import { BaseLLMProvider } from '../../core/llm/base'
import { ChatModel } from '../../types/chat-model.types'
import { RequestMessage } from '../../types/llm/request'
import { LLMProvider } from '../../types/provider.types'

const EDIT_MODE_SYSTEM_PROMPT = `You are an intelligent document editor. Your task is to modify a markdown document based on user instructions.

**Output Formats:**
You have THREE types of edit blocks available:

1. **CONTINUE** - Append new content at the end of the document:
<<<<<<< CONTINUE
=======
[new content to append]
>>>>>>> CONTINUE

2. **REPLACE** - Replace existing text:
<<<<<<< SEARCH
[exact text to find in the document]
=======
[new text to replace it with]
>>>>>>> REPLACE

3. **INSERT AFTER** - Insert content after specific text:
<<<<<<< INSERT AFTER
[exact text to find]
=======
[content to insert after it]
>>>>>>> INSERT

**When to Use Each Format:**
- Use **CONTINUE** for: "续写", "继续写", "补充内容", "continue writing", "add more", "extend"
- Use **REPLACE** for: "修改", "替换", "翻译", "改写", "change", "translate", "rewrite", "fix"
- Use **INSERT AFTER** for: "在...后面添加", "在...之后插入", "insert after", "add after"

**Critical Rules:**
1. For SEARCH sections, text must be EXACT, including all whitespace, line breaks, and punctuation
2. You can use multiple blocks of different types for complex edits
3. Output ONLY edit blocks, no explanations or other text
4. For deletion with REPLACE, leave the replacement section empty (but keep the markers)
5. Keep changes minimal - only modify what's necessary to fulfill the instruction
6. For SEARCH/INSERT AFTER, include enough surrounding context to ensure unique matching
7. Process changes in document order (top to bottom)

**Examples:**

Append content:
<<<<<<< CONTINUE
=======
## New Section
This is additional content at the end.
>>>>>>> CONTINUE

Change existing text:
<<<<<<< SEARCH
Hello world
=======
Hello universe
>>>>>>> REPLACE

Insert after a paragraph:
<<<<<<< INSERT AFTER
This is the end of the first paragraph.
=======

Here is a new paragraph inserted after it.
>>>>>>> INSERT`

/**
 * Generate edit content using edit blocks (CONTINUE/REPLACE/INSERT AFTER).
 *
 * @param params - Parameters for generating edit content
 * @returns The raw model response containing edit blocks
 */
export async function generateEditContent({
  instruction,
  currentFile,
  currentFileContent,
  providerClient,
  model,
}: {
  instruction: string
  currentFile: TFile
  currentFileContent: string
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
}): Promise<string> {
  const hasEditBlockMarkers = (text: string): boolean => {
    if (!text) return false
    const startPattern = /<<<<<<<\s+(CONTINUE|SEARCH|INSERT AFTER)/i
    const endPattern = />>>>>>>\s+(CONTINUE|REPLACE|INSERT)/i
    return startPattern.test(text) && endPattern.test(text)
  }

  const isBaseModel = Boolean(model.isBaseModel)
  const requestMessages: RequestMessage[] = []

  if (!isBaseModel) {
    requestMessages.push({
      role: 'system',
      content: EDIT_MODE_SYSTEM_PROMPT,
    })
  }

  const userPrompt = generateEditPrompt(
    instruction,
    currentFile,
    currentFileContent,
  )

  requestMessages.push({
    role: 'user',
    content: userPrompt,
  })

  const response = await providerClient.generateResponse(model, {
    model: model.model,
    messages: requestMessages,
    stream: false,
  })

  const content = response.choices[0]?.message?.content ?? ''
  if (content.trim().length > 0) {
    return content
  }
  const reasoning = response.choices[0]?.message?.reasoning ?? ''
  if (hasEditBlockMarkers(reasoning)) {
    return reasoning
  }
  return content
}

/**
 * Generate the user prompt for edit mode.
 */
function generateEditPrompt(
  instruction: string,
  currentFile: TFile,
  currentFileContent: string,
): string {
  return `# Document to Edit

**File:** ${currentFile.path}

**Content:**
\`\`\`markdown
${currentFileContent}
\`\`\`

# Instruction

${instruction}

# Your Task

Output appropriate edit blocks (CONTINUE/REPLACE/INSERT) to apply the requested changes. Remember:
- Match text EXACTLY as it appears in the document
- Include enough context for unique matching
- Choose the most appropriate block type based on the instruction
- Output only edit blocks, no explanations`
}
