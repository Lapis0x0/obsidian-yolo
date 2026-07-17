import { migrateFrom73To74 } from './73_to_74'

describe('migrateFrom73To74', () => {
  it('renames persisted extra-high reasoning levels to xhigh', () => {
    const result = migrateFrom73To74({
      version: 73,
      tabCompletionOptions: { reasoningLevel: 'extra-high' },
      chatOptions: {
        reasoningLevelByModelId: {
          legacy: 'extra-high',
          unchanged: 'high',
        },
      },
    })

    expect(result.tabCompletionOptions).toMatchObject({
      reasoningLevel: 'xhigh',
    })
    expect(result.chatOptions).toMatchObject({
      reasoningLevelByModelId: {
        legacy: 'xhigh',
        unchanged: 'high',
      },
    })
  })

  it('preserves legacy file ops write selection without enabling fs_edit', () => {
    const result = migrateFrom73To74({
      version: 73,
      assistants: [
        {
          id: 'a1',
          enabledToolNames: ['yolo_local__fs_file_ops'],
          toolPreferences: {
            yolo_local__fs_file_ops: {
              enabled: true,
              approvalMode: 'require_approval',
            },
          },
        },
      ],
    })

    const assistant = (result.assistants as Array<Record<string, unknown>>)[0]
    expect(assistant.enabledToolNames).toEqual([
      'yolo_local__fs_file_ops',
      'yolo_local__fs_write',
    ])
    expect(assistant.toolPreferences).toMatchObject({
      yolo_local__fs_file_ops: {
        enabled: true,
        approvalMode: 'require_approval',
      },
      yolo_local__fs_write: {
        enabled: true,
        approvalMode: 'require_approval',
      },
    })
    expect(
      (assistant.toolPreferences as Record<string, unknown>)
        .yolo_local__fs_edit,
    ).toBeUndefined()
  })

  it('keeps fs_write disabled when the legacy file ops group was disabled', () => {
    const result = migrateFrom73To74({
      version: 73,
      mcp: {
        builtinToolOptions: {
          fs_file_ops: { disabled: true },
          fs_write: { disabled: false },
          fs_edit: { disabled: false },
        },
      },
    })

    const options = (result.mcp as Record<string, unknown>)
      .builtinToolOptions as Record<string, unknown>
    expect(options.fs_write).toEqual({ disabled: true })
    expect(options.fs_edit).toEqual({ disabled: false })
  })

  it('does not duplicate existing write entries', () => {
    const result = migrateFrom73To74({
      version: 73,
      assistants: [
        {
          id: 'a1',
          enabledToolNames: [
            'fs_file_ops',
            'fs_write',
            'yolo_local__fs_file_ops',
            'yolo_local__fs_write',
          ],
          toolPreferences: {
            yolo_local__fs_file_ops: { enabled: true },
            yolo_local__fs_write: { enabled: false },
          },
        },
      ],
    })

    const assistant = (result.assistants as Array<Record<string, unknown>>)[0]
    expect(
      (assistant.enabledToolNames as string[]).filter(
        (name) => name === 'fs_write',
      ),
    ).toHaveLength(1)
    expect(
      (assistant.enabledToolNames as string[]).filter(
        (name) => name === 'yolo_local__fs_write',
      ),
    ).toHaveLength(1)
    expect(assistant.toolPreferences).toMatchObject({
      yolo_local__fs_write: { enabled: false },
    })
  })
})
