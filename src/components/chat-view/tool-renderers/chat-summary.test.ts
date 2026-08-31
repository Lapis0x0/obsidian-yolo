// Pins the chat-surface header summary text for all 16 active built-in
// tools (docs/plans/2026-08-15-tool-registry/phase2-migration.md D8). Each
// expected value below was read directly off the pre-D8 `if` chain in
// `ToolMessage.tsx`'s private `getLocalToolSummaryText` before it was
// replaced by a `TOOL_RENDERERS` lookup — this file is the regression net
// for that rewrite: it must keep passing with the exact same strings.
//
// Tools with no summary (memory_add/update/delete, context_compact,
// context_prune_tool_results, ask_user_question) had no branch in that `if`
// chain either — `TOOL_RENDERERS[name].summary` must be `undefined` for
// them, same as before. `delegate_subagent`'s header summary is computed
// elsewhere (`ToolMessage.tsx`'s own `getDelegateSubagentSummary`, applied
// as a response-independent override in `getHeadlineDisplayInfo`) and is
// deliberately not wired into this table — see `tool-renderers/index.ts`'s
// doc comment.

// `TOOL_RENDERERS` (imported below) transitively pulls in the real
// `SubagentCard` / `LiveTaskCard` React components (via
// `delegate_subagent/ui.tsx` and `terminal_command/ui.tsx`). This suite only
// exercises the plain-function `summary` fields and the `kind` discriminant,
// so — matching `ToolMessage.test.ts`'s own mocking of these same two
// modules — stub them out rather than let Jest's `node` test environment
// load their full component trees (which reach `app-context.tsx` and fail
// outside a DOM environment).
jest.mock('../tool-cards/SubagentCard', () => ({
  SubagentCard: (_: unknown) => null,
}))
jest.mock('../tool-cards/LiveTaskCard', () => ({
  LiveTaskCard: (_: unknown) => null,
}))

import { getLoadToolSchemasChatSummary } from '../../../core/tools/internal/load_tool_schemas/definition'

import type { ToolChatSummaryLabels } from './types'

import { TOOL_RENDERERS } from './index'

const labels: ToolChatSummaryLabels = {
  todoWriteCleared: 'Cleared list',
  todoWriteAllCompleted: (count: number) => `All completed (${count})`,
  todoWriteCreated: (count: number) => `Planned ${count} tasks`,
  todoWriteProgress: (done: number, total: number) =>
    `Progress ${done}/${total}`,
  terminalCommandSessionPoll: (sessionId: number) =>
    `Session ${sessionId} · Poll`,
  terminalCommandSessionKill: (sessionId: number) =>
    `Session ${sessionId} · Kill`,
  terminalCommandSessionInput: (sessionId: number, inputPreview: string) =>
    `Session ${sessionId} · Input: ${inputPreview}`,
}

const summarize = (
  toolName: keyof typeof TOOL_RENDERERS,
  argumentsObject: Record<string, unknown> | null,
): string | undefined =>
  TOOL_RENDERERS[toolName].summary?.({ argumentsObject, labels })

describe('TOOL_RENDERERS summary — tools with no header summary (unchanged)', () => {
  it.each([
    'memory_add',
    'memory_update',
    'memory_delete',
    'context_compact',
    'context_prune_tool_results',
    'ask_user_question',
    'delegate_subagent',
  ] as const)('%s has no summary function wired', (toolName) => {
    expect(TOOL_RENDERERS[toolName].summary).toBeUndefined()
  })
})

describe('TOOL_RENDERERS summary — fs_read', () => {
  it('single path', () => {
    expect(summarize('fs_read', { paths: ['docs/plan.md'] })).toBe(
      'docs/plan.md',
    )
  })

  it('up to 4 paths: lists all of them', () => {
    expect(
      summarize('fs_read', {
        paths: ['a.md', 'b.md', 'c.md', 'd.md'],
      }),
    ).toBe('a.md, b.md, c.md, d.md')
  })

  it('more than 4 paths: shows first 4 plus an omission count', () => {
    expect(
      summarize('fs_read', {
        paths: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'],
      }),
    ).toBe('a.md, b.md, c.md, d.md +1')
  })

  it('empty/missing paths: no summary', () => {
    expect(summarize('fs_read', { paths: [] })).toBeUndefined()
    expect(summarize('fs_read', {})).toBeUndefined()
  })
})

describe('TOOL_RENDERERS summary — fs_edit / fs_write (shared path summary)', () => {
  it.each(['fs_edit', 'fs_write'] as const)(
    '%s: uses the path arg',
    (toolName) => {
      expect(summarize(toolName, { path: 'docs/new-note.md' })).toBe(
        'docs/new-note.md',
      )
    },
  )

  it.each(['fs_edit', 'fs_write'] as const)(
    '%s: no summary when path is missing/empty',
    (toolName) => {
      expect(summarize(toolName, {})).toBeUndefined()
      expect(summarize(toolName, { path: '' })).toBeUndefined()
    },
  )
})

describe('TOOL_RENDERERS summary — web_search', () => {
  it('query only', () => {
    expect(summarize('web_search', { query: 'obsidian plugin api' })).toBe(
      'obsidian plugin api',
    )
  })

  it('topic + query', () => {
    expect(
      summarize('web_search', {
        query: 'obsidian plugin api',
        topic: 'docs',
      }),
    ).toBe('docs | obsidian plugin api')
  })

  it('empty query: no summary', () => {
    expect(summarize('web_search', { query: '  ' })).toBeUndefined()
    expect(summarize('web_search', {})).toBeUndefined()
  })
})

describe('TOOL_RENDERERS summary — web_scrape', () => {
  it('url present', () => {
    expect(summarize('web_scrape', { url: 'https://example.com' })).toBe(
      'https://example.com',
    )
  })

  it('url missing: no summary', () => {
    expect(summarize('web_scrape', {})).toBeUndefined()
  })
})

describe('TOOL_RENDERERS summary — js_eval', () => {
  it('code preview, whitespace-collapsed', () => {
    expect(summarize('js_eval', { code: 'const x = 1\n  const y = 2' })).toBe(
      'const x = 1 const y = 2',
    )
  })

  it('empty code: no summary', () => {
    expect(summarize('js_eval', { code: '   ' })).toBeUndefined()
    expect(summarize('js_eval', {})).toBeUndefined()
  })
})

describe('TOOL_RENDERERS summary — bash', () => {
  it('short command: verbatim', () => {
    expect(summarize('bash', { command: 'ls -la' })).toBe('ls -la')
  })

  it('empty command: no summary', () => {
    expect(summarize('bash', { command: '' })).toBeUndefined()
    expect(summarize('bash', {})).toBeUndefined()
  })
})

describe('TOOL_RENDERERS summary — terminal_command', () => {
  it('short command: verbatim', () => {
    expect(summarize('terminal_command', { command: 'git status' })).toBe(
      'git status',
    )
  })

  it('long single command: basename plus arguments', () => {
    expect(
      summarize('terminal_command', {
        command:
          '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli plugin:reload id=yolo',
      }),
    ).toBe('obsidian-cli plugin:reload id=yolo')
  })

  it('long streaming (background) command: command-name summary', () => {
    expect(
      summarize('terminal_command', {
        command:
          'for i in $(seq 1 15); do echo "[$i] $(date +%H:%M:%S)"; sleep 1; done && echo "=== done ===" && pwd && ls -la src | head -8',
        background: true,
      }),
    ).toBe('seq, echo, date, sleep, pwd +2')
  })

  it('session poll/kill/input follow-ups', () => {
    expect(summarize('terminal_command', { session_id: 3 })).toBe(
      'Session 3 · Poll',
    )
    expect(summarize('terminal_command', { session_id: 3, kill: true })).toBe(
      'Session 3 · Kill',
    )
    expect(summarize('terminal_command', { session_id: 3, input: 'y\n' })).toBe(
      'Session 3 · Input: y',
    )
  })

  it('neither command nor session_id: no summary', () => {
    expect(summarize('terminal_command', {})).toBeUndefined()
  })
})

describe('TOOL_RENDERERS summary — todo_write', () => {
  it('empty/cleared list', () => {
    expect(summarize('todo_write', { todos: [] })).toBe('Cleared list')
  })

  it('in-progress item: uses content, truncated to 60 chars', () => {
    expect(
      summarize('todo_write', {
        todos: [
          { content: 'A done', status: 'completed' },
          { content: '完成第二步', status: 'in_progress' },
        ],
      }),
    ).toBe('完成第二步')
  })

  it('all completed', () => {
    expect(
      summarize('todo_write', {
        todos: [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'completed' },
        ],
      }),
    ).toBe('All completed (2)')
  })

  it('none started yet', () => {
    expect(
      summarize('todo_write', {
        todos: [
          { content: 'A', status: 'pending' },
          { content: 'B', status: 'pending' },
        ],
      }),
    ).toBe('Planned 2 tasks')
  })

  it('partially done, none in progress', () => {
    expect(
      summarize('todo_write', {
        todos: [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'pending' },
        ],
      }),
    ).toBe('Progress 1/2')
  })
})

describe('load_tool_schemas summary (internal tool, not in TOOL_RENDERERS)', () => {
  it('one or two servers: lists them', () => {
    expect(
      getLoadToolSchemasChatSummary({
        argumentsObject: { servers: ['context7'] },
      }),
    ).toBe('context7')
    expect(
      getLoadToolSchemasChatSummary({
        argumentsObject: { servers: ['context7', 'deepwiki'] },
      }),
    ).toBe('context7, deepwiki')
  })

  it('more than two servers: shows first 2 plus an omission count', () => {
    expect(
      getLoadToolSchemasChatSummary({
        argumentsObject: { servers: ['a', 'b', 'c'] },
      }),
    ).toBe('a, b +1')
  })

  it('empty/missing servers: no summary', () => {
    expect(
      getLoadToolSchemasChatSummary({ argumentsObject: { servers: [] } }),
    ).toBeUndefined()
    expect(
      getLoadToolSchemasChatSummary({ argumentsObject: {} }),
    ).toBeUndefined()
  })
})

describe('TOOL_RENDERERS completeness (kind wiring)', () => {
  it('terminal_command is the sole body-kind entry', () => {
    expect(TOOL_RENDERERS.terminal_command.kind).toBe('body')
  })

  it('delegate_subagent is the sole replace-kind entry', () => {
    expect(TOOL_RENDERERS.delegate_subagent.kind).toBe('replace')
  })

  it('every other tool is generic-kind', () => {
    const nonGeneric = new Set(['terminal_command', 'delegate_subagent'])
    for (const [name, renderer] of Object.entries(TOOL_RENDERERS)) {
      if (nonGeneric.has(name)) continue
      expect(renderer.kind).toBe('generic')
    }
  })
})
