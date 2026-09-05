import { Platform } from 'obsidian'

import type { McpTool } from '../../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../../types/tool-call.types'
import { defineTool } from '../../define'
import { describeStructuredVaultFormatDenial } from '../../structured-vault-formats'
import {
  MAX_FILE_SIZE_BYTES,
  formatJsonResult,
  getTextArg,
} from '../../tool-args'
import { NATIVE_PATH_ARG_DESCRIPTION, resolveNativeFilePathArg } from '../paths'

const WRITE_FILE_DESCRIPTION = [
  'Create a file, or replace an existing file with new full content, straight on the local filesystem. Desktop-only. Missing parent directories are created.',
  '',
  'Unrelated to fs_write: this never touches the Obsidian vault index, so it writes any extension and any path, inside the vault or outside it.',
  '',
  'Use edit_file when you only need to change part of an existing file — rewriting a whole file to change a few lines loses content and burns tokens.',
].join('\n')

export const writeFileDefinition = defineTool({
  name: 'write_file',
  getMcpTool: () =>
    ({
      description: WRITE_FILE_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: NATIVE_PATH_ARG_DESCRIPTION,
          },
          content: {
            type: 'string',
            description: 'Full file content, written as UTF-8.',
          },
        },
        required: ['path', 'content'],
      },
    }) satisfies Omit<McpTool, 'name'>,
  chatLabel: {
    key: 'settings.agent.builtinWriteFileLabel',
    fallback: 'Write Local File',
  },
  contextPrunable: true,
  isAvailable: () => Platform.isDesktop,
  execute: async (args, ctx) => {
    const absolutePath = await resolveNativeFilePathArg(ctx.app, args)

    // Structured module-owned formats stay off-limits here for exactly the
    // reason they are off-limits to `fs_write` — the guard is about the
    // format, not about which filesystem API reaches it (see
    // `structured-vault-formats.ts`).
    const structuredFormatDenial =
      describeStructuredVaultFormatDenial(absolutePath)
    if (structuredFormatDenial) {
      throw new Error(structuredFormatDenial)
    }

    const content = getTextArg(args, 'content')
    if (content.length > MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `Content too large (${content.length} chars). Max allowed is ${MAX_FILE_SIZE_BYTES}.`,
      )
    }

    const [fs, path] = await Promise.all([
      // eslint-disable-next-line import/no-nodejs-modules -- desktop-only tool, dynamically imported so mobile never loads it
      import('node:fs/promises'),
      // eslint-disable-next-line import/no-nodejs-modules -- desktop-only tool, dynamically imported so mobile never loads it
      import('node:path'),
    ])

    const existingSize = await statFileSize(fs, absolutePath)
    if (existingSize === 'directory') {
      throw new Error(
        `Path is a directory, cannot overwrite as a file: ${absolutePath}`,
      )
    }

    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.writeFile(absolutePath, content, 'utf-8')

    const byteSize = new TextEncoder().encode(content).length
    return {
      status: ToolCallResponseStatus.Success,
      text: formatJsonResult({
        tool: 'write_file',
        path: absolutePath,
        created: existingSize === null,
        byteSize,
        message:
          existingSize === null
            ? 'Created file.'
            : `Overwrote file (was ${existingSize} bytes).`,
      }),
    }
  },
})

/**
 * `null` when nothing is there, `'directory'` when the path is a directory,
 * otherwise the existing file's size. Any other stat failure propagates —
 * a permission error must not be reported to the model as "created".
 */
const statFileSize = async (
  fs: typeof import('node:fs/promises'),
  absolutePath: string,
): Promise<number | null | 'directory'> => {
  try {
    const stat = await fs.stat(absolutePath)
    return stat.isDirectory() ? 'directory' : stat.size
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return null
    }
    throw error
  }
}
