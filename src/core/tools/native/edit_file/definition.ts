import { Platform } from 'obsidian'

import type { McpTool } from '../../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../../types/tool-call.types'
import {
  buildReplaceMatchErrorHint,
  materializeTextEditPlan,
} from '../../../edits/textEditEngine'
import { defineTool } from '../../define'
import { describeStructuredVaultFormatDenial } from '../../structured-vault-formats'
import {
  MAX_FILE_SIZE_BYTES,
  formatJsonResult,
  getTextArg,
} from '../../tool-args'
import { NATIVE_PATH_ARG_DESCRIPTION, resolveNativeFilePathArg } from '../paths'
import { assertDecodableAsText } from '../text'

const EDIT_FILE_DESCRIPTION = [
  'Replace an exact piece of text in an existing file on the local filesystem. Desktop-only.',
  '',
  'Unrelated to fs_edit: this never touches the Obsidian vault index, so it edits any extension and any path, inside the vault or outside it.',
  '',
  'oldText must match the file exactly, whitespace included, and must match exactly once unless replaceAll is true — include enough surrounding context to make it unique. Prefer this over shell text surgery (sed/awk/python one-liners): those silently rewrite the wrong lines and leave no diff. The file must already exist; use write_file to create one.',
].join('\n')

export const editFileDefinition = defineTool({
  name: 'edit_file',
  getMcpTool: () =>
    ({
      description: EDIT_FILE_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: NATIVE_PATH_ARG_DESCRIPTION,
          },
          oldText: {
            type: 'string',
            description:
              'The existing text to find and replace. Must match the file exactly.',
          },
          newText: {
            type: 'string',
            description:
              'Replacement text. Use an empty string to delete the matched text.',
          },
          replaceAll: {
            type: 'boolean',
            description:
              'Replace every exact occurrence instead of requiring a single unique match. Defaults to false.',
          },
        },
        required: ['path', 'oldText', 'newText'],
      },
    }) satisfies Omit<McpTool, 'name'>,
  chatLabel: {
    key: 'settings.agent.builtinEditFileLabel',
    fallback: 'Edit Local File',
  },
  contextPrunable: true,
  isAvailable: () => Platform.isDesktop,
  filesystemPathArg: 'path',
  execute: async (args, ctx) => {
    const absolutePath = await resolveNativeFilePathArg(ctx.app, args)

    const structuredFormatDenial =
      describeStructuredVaultFormatDenial(absolutePath)
    if (structuredFormatDenial) {
      throw new Error(structuredFormatDenial)
    }

    const oldText = getTextArg(args, 'oldText')
    const newText = getTextArg(args, 'newText')
    const replaceAll = getOptionalBooleanArg(args, 'replaceAll') ?? false
    if (oldText.length === 0) {
      throw new Error('oldText must not be empty.')
    }

    // eslint-disable-next-line import/no-nodejs-modules -- desktop-only tool, dynamically imported so mobile never loads it
    const fs = await import('node:fs/promises')
    const stat = await fs.stat(absolutePath)
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${absolutePath}`)
    }
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `File too large (${stat.size} bytes). Max allowed is ${MAX_FILE_SIZE_BYTES}.`,
      )
    }

    const bytes = new Uint8Array(await fs.readFile(absolutePath))
    assertDecodableAsText(bytes, absolutePath)
    const content = new TextDecoder().decode(bytes)

    const { nextContent, occurrences } = replaceAll
      ? replaceEveryOccurrence({ content, oldText, newText, absolutePath })
      : replaceUniqueOccurrence({ content, oldText, newText, absolutePath })

    if (nextContent.length > MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `Content too large after edit (${nextContent.length} chars). Max allowed is ${MAX_FILE_SIZE_BYTES}.`,
      )
    }

    await fs.writeFile(absolutePath, nextContent, 'utf-8')

    return {
      status: ToolCallResponseStatus.Success,
      text: formatJsonResult({
        tool: 'edit_file',
        path: absolutePath,
        replacements: occurrences,
        changed: nextContent !== content,
        message: 'Applied edit.',
      }),
    }
  },
})

const getOptionalBooleanArg = (
  args: Record<string, unknown>,
  key: string,
): boolean | undefined => {
  const value = args[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${key} must be a boolean.`)
  }
  return value
}

/**
 * The single-match path runs the same engine `fs_edit` runs
 * (`core/edits/textEditEngine.ts`), so the uniqueness rule, the tolerated
 * near-misses (line endings, trailing whitespace, escaped control
 * characters), and the failure text a model has already learned to react to
 * are one implementation rather than two.
 */
const replaceUniqueOccurrence = ({
  content,
  oldText,
  newText,
  absolutePath,
}: {
  content: string
  oldText: string
  newText: string
  absolutePath: string
}): { nextContent: string; occurrences: number } => {
  const materialized = materializeTextEditPlan({
    content,
    plan: { operations: [{ type: 'replace', oldText, newText }] },
  })

  if (materialized.errors.length > 0) {
    const noMatch = materialized.failures?.some(
      (failure) =>
        failure.operation.type === 'replace' && failure.kind === 'no_match',
    )
    throw new Error(
      noMatch
        ? `${absolutePath}: ${buildReplaceMatchErrorHint({ content, oldText })}`
        : `${absolutePath}: ${materialized.errors[0]}`,
    )
  }

  return {
    nextContent: materialized.newContent,
    occurrences: materialized.operationResults[0]?.actualOccurrences ?? 1,
  }
}

/**
 * `replaceAll` is exact-match only — deliberately narrower than the single
 * -match path. The engine's near-miss recovery exists to rescue one
 * identifiable target; applying it to an unbounded number of fuzzy matches
 * would rewrite text the model never actually saw.
 */
const replaceEveryOccurrence = ({
  content,
  oldText,
  newText,
  absolutePath,
}: {
  content: string
  oldText: string
  newText: string
  absolutePath: string
}): { nextContent: string; occurrences: number } => {
  const segments = content.split(oldText)
  const occurrences = segments.length - 1
  if (occurrences === 0) {
    throw new Error(
      `${absolutePath}: ${buildReplaceMatchErrorHint({ content, oldText })}`,
    )
  }
  return { nextContent: segments.join(newText), occurrences }
}
