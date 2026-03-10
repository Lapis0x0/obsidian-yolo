jest.mock('obsidian')

import {
  isLocalFsWriteToolName,
  parseLocalFsActionFromToolArgs,
  recoverLikelyEscapedBackslashSequences,
} from './localFileTools'

describe('recoverLikelyEscapedBackslashSequences', () => {
  it('recovers latex commands decoded as control characters', () => {
    const broken = `A=${'\b'}egin{bmatrix}1 & 2${'\t'}imes y`
    const recovered = recoverLikelyEscapedBackslashSequences(broken)

    expect(recovered).toContain('\\begin{bmatrix}')
    expect(recovered).toContain('\\times y')
  })

  it('keeps intended newline and tab characters unchanged when not command-like', () => {
    const input = 'line1\n\nline2\t42'
    const recovered = recoverLikelyEscapedBackslashSequences(input)

    expect(recovered).toBe(input)
  })
})

describe('local fs tool action helpers', () => {
  it('parses split file-op tools to fs actions', () => {
    expect(
      parseLocalFsActionFromToolArgs({
        toolName: 'fs_create_file',
        args: { path: 'a.md', content: 'x' },
      }),
    ).toBe('create_file')
    expect(
      parseLocalFsActionFromToolArgs({
        toolName: 'fs_delete_dir',
        args: { path: 'tmp', recursive: true },
      }),
    ).toBe('delete_dir')
  })

  it('parses legacy fs_file_ops actions from arguments', () => {
    expect(
      parseLocalFsActionFromToolArgs({
        toolName: 'fs_file_ops',
        args: '{"action":"move","items":[{"oldPath":"a.md","newPath":"b.md"}]}',
      }),
    ).toBe('move')
  })

  it('recognizes write tool names with local prefixes', () => {
    expect(isLocalFsWriteToolName('fs_edit')).toBe(true)
    expect(isLocalFsWriteToolName('yolo_local__fs_move')).toBe(true)
    expect(isLocalFsWriteToolName('yolo_local__fs_read')).toBe(false)
  })
})
