import { migrateFrom34To35 } from './34_to_35'

describe('migrateFrom34To35', () => {
  it('renames fs_write references in assistants and builtin tool options', () => {
    const result = migrateFrom34To35({
      version: 34,
      assistants: [
        {
          id: 'a',
          name: 'A',
          enabledToolNames: ['fs_read', 'fs_write'],
        },
      ],
      mcp: {
        builtinToolOptions: {
          fs_write: {
            disabled: true,
          },
        },
      },
    })

    expect(result.version).toBe(35)
    expect(result.assistants).toEqual([
      {
        id: 'a',
        name: 'A',
        enabledToolNames: ['fs_read', 'fs_file_ops'],
      },
    ])
    expect(result.mcp).toEqual({
      builtinToolOptions: {
        fs_file_ops: {
          disabled: true,
        },
      },
    })
  })

  it('renames fully qualified local tool names for assistants', () => {
    const result = migrateFrom34To35({
      version: 34,
      assistants: [
        {
          id: 'a',
          name: 'A',
          enabledToolNames: ['yolo_local__fs_read', 'yolo_local__fs_write'],
        },
      ],
    })

    expect(result.assistants).toEqual([
      {
        id: 'a',
        name: 'A',
        enabledToolNames: ['yolo_local__fs_read', 'yolo_local__fs_file_ops'],
      },
    ])
  })
})
