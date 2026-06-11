import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const CHAT_SCHEMA_VERSION = 1
const DEFAULT_TITLE = 'Agent 长对话渲染压测样本'
const DEFAULT_TURNS = 24
const DEFAULT_SEED = 20260611
const DEFAULT_TOOL_DENSITY = 0.9
const DEFAULT_MAX_TOOLS_PER_TURN = 6
const DEFAULT_LONG_BLOCKS = 8
const DEFAULT_ASSISTANT_LONG_BLOCKS = 10
const DEFAULT_VAULT_ROOT = path.resolve(process.cwd(), '../../..')
const DEFAULT_DB_ROOT = path.join(
  DEFAULT_VAULT_ROOT,
  'YOLO',
  '.yolo_json_db',
  'chats',
)
const LOCAL_SERVER = 'yolo_local'

const TOOL_STATUS = {
  PendingApproval: 'pending_approval',
  Rejected: 'rejected',
  Running: 'running',
  Success: 'success',
  Error: 'error',
  Aborted: 'aborted',
  AwaitingUserInput: 'awaiting_user_input',
}

function parseArgs(argv) {
  const options = {
    vaultRoot: DEFAULT_VAULT_ROOT,
    dbRoot: DEFAULT_DB_ROOT,
    title: DEFAULT_TITLE,
    turns: DEFAULT_TURNS,
    seed: DEFAULT_SEED,
    toolDensity: DEFAULT_TOOL_DENSITY,
    maxToolsPerTurn: DEFAULT_MAX_TOOLS_PER_TURN,
    maxLongBlocks: DEFAULT_LONG_BLOCKS,
    assistantLongBlocks: DEFAULT_ASSISTANT_LONG_BLOCKS,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]

    switch (arg) {
      case '--vault-root':
        options.vaultRoot = path.resolve(next)
        options.dbRoot = path.join(
          options.vaultRoot,
          'YOLO',
          '.yolo_json_db',
          'chats',
        )
        index += 1
        break
      case '--db-root':
        options.dbRoot = path.resolve(next)
        index += 1
        break
      case '--title':
        options.title = next
        index += 1
        break
      case '--turns':
        options.turns = Number.parseInt(next, 10)
        index += 1
        break
      case '--seed':
        options.seed = Number.parseInt(next, 10)
        index += 1
        break
      case '--tool-density':
        options.toolDensity = Number.parseFloat(next)
        index += 1
        break
      case '--max-tools-per-turn':
        options.maxToolsPerTurn = Number.parseInt(next, 10)
        index += 1
        break
      case '--max-long-blocks':
        options.maxLongBlocks = Number.parseInt(next, 10)
        index += 1
        break
      case '--assistant-long-blocks':
        options.assistantLongBlocks = Number.parseInt(next, 10)
        index += 1
        break
      default:
        break
    }
  }

  options.turns = Number.isFinite(options.turns)
    ? Math.max(1, options.turns)
    : DEFAULT_TURNS
  options.seed = Number.isFinite(options.seed) ? options.seed : DEFAULT_SEED
  options.toolDensity = Number.isFinite(options.toolDensity)
    ? Math.max(0, Math.min(1, options.toolDensity))
    : DEFAULT_TOOL_DENSITY
  options.maxToolsPerTurn = Number.isFinite(options.maxToolsPerTurn)
    ? Math.max(1, options.maxToolsPerTurn)
    : DEFAULT_MAX_TOOLS_PER_TURN
  options.maxLongBlocks = Number.isFinite(options.maxLongBlocks)
    ? Math.max(0, options.maxLongBlocks)
    : DEFAULT_LONG_BLOCKS
  options.assistantLongBlocks = Number.isFinite(options.assistantLongBlocks)
    ? Math.max(0, options.assistantLongBlocks)
    : DEFAULT_ASSISTANT_LONG_BLOCKS

  return options
}

function createRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function pick(random, values) {
  return values[Math.floor(random() * values.length)]
}

function maybe(random, probability) {
  return random() < probability
}

function randomInt(random, min, max) {
  return min + Math.floor(random() * (max - min + 1))
}

function id(prefix) {
  return `${prefix}-${crypto.randomUUID()}`
}

function toolName(shortName) {
  return `${LOCAL_SERVER}__${shortName}`
}

function completeArguments(value) {
  return {
    kind: 'complete',
    value,
    rawText: JSON.stringify(value),
  }
}

function createTextEditorState(text) {
  return {
    root: {
      children: text.split('\n').map((line) => ({
        children: [
          {
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: line,
            type: 'text',
            version: 1,
          },
        ],
        direction: 'ltr',
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
        textFormat: 0,
        textStyle: '',
      })),
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  }
}

const AREAS = [
  '长对话滚动稳定性',
  '工具调用失败恢复',
  '代码块和 Markdown 渲染',
  '上下文压缩后的历史回放',
  '分支消息和外部任务结果',
  'Quick Ask 与 Sidebar Chat 一致性',
]

const FILES = [
  'src/components/chat-view/ChatTimelineList.tsx',
  'src/components/chat-view/AssistantToolMessageGroupItem.tsx',
  'src/core/agent/service.ts',
  'src/core/mcp/localFileTools.ts',
  'docs/plans/anchored-timeline.md',
  'README.md',
]

const ACTIONS = [
  '先定位现象，再缩小到一个最小可验证路径',
  '比较旧实现和新实现的滚动状态边界',
  '把测量、缓存、hydrate 切换拆开观察',
  '检查工具卡折叠、展开和长 stdout 对布局的影响',
  '验证用户主动滚动后不会被自动跟随拉走',
  '记录一条可以稳定复现的回归用例',
]

function createUserMessage(turn, random) {
  const area = pick(random, AREAS)
  const action = pick(random, ACTIONS)
  const detail = pick(random, [
    '这次请不要只看表面现象，要顺着状态变化完整走一遍。',
    '如果需要读文件、搜索、跑命令，你可以直接用工具。',
    '注意这轮可能跟上一轮结论冲突，先解释为什么。',
    '请把失败路径也写清楚，尤其是工具返回异常时的分支。',
    '我希望最后能给出一个可以手动验收的步骤。',
  ])

  return {
    role: 'user',
    content: createTextEditorState(
      [`第 ${turn} 轮：继续排查「${area}」。`, action, detail].join('\n'),
    ),
    promptContent: null,
    id: id('user'),
    mentionables: [],
    selectedSkills: [],
    selectedModelIds: [],
    reasoningLevel: 'medium',
  }
}

function createAssistantIntro(turn, random, toolRequests) {
  const paragraphs = [
    `我先按第 ${turn} 轮的目标拆一下：这轮重点不是一次性给结论，而是验证「现象 -> 触发条件 -> 工具结果 -> UI 状态」这条链路有没有断点。`,
    pick(random, [
      '如果工具结果很长，我会先看摘要和异常，再决定是否继续展开。',
      '我会把滚动、测量、高度缓存和底部跟随分别看，不把它们混成一个问题。',
      '这里更像真实 Agent 会话：中间可能成功、失败、重试，结论也可能修正。',
      '我会保留一点推理过程，这样长历史里能测试 reasoning block 的折叠和展开。',
    ]),
  ]

  if (toolRequests.length > 0) {
    paragraphs.push(
      `接下来我会调用 ${toolRequests.length} 个工具，先拿到证据再继续。`,
    )
  } else {
    paragraphs.push('这轮先不调用工具，只基于上一轮的观察继续收敛。')
  }

  return {
    role: 'assistant',
    content: paragraphs.join('\n\n'),
    reasoning: [
      `第 ${turn} 轮内部检查：`,
      '- 当前轮次是否应该保持 pinned。',
      '- 工具卡是否会产生高度变化。',
      '- 长内容是否只在附近 hydrate。',
    ].join('\n'),
    toolCallRequests: toolRequests.length > 0 ? toolRequests : undefined,
    id: id('assistant'),
    metadata: {
      generationState: 'completed',
      durationMs: randomInt(random, 900, 5200),
      model: {
        providerId: 'mock',
        model: 'mock-agent-long-chat',
      },
    },
  }
}

function makeToolRequest(turn, random) {
  const kind = pick(random, [
    'fs_read',
    'fs_search',
    'todo_write',
    'terminal_command',
    'delegate_subagent',
    'web_search',
  ])
  const requestId = id(`tool-${kind}`)

  if (kind === 'fs_read') {
    const file = pick(random, FILES)
    const mode = maybe(random, 0.45) ? 'lines' : 'full'
    return {
      id: requestId,
      name: toolName('fs_read'),
      arguments: completeArguments(
        mode === 'lines'
          ? {
              paths: [file],
              mode,
              startLine: randomInt(random, 1, 220),
              endLine: randomInt(random, 230, 520),
            }
          : { paths: [file], mode },
      ),
    }
  }

  if (kind === 'fs_search') {
    return {
      id: requestId,
      name: toolName('fs_search'),
      arguments: completeArguments({
        query: pick(random, [
          'overflow-anchor',
          'ResizeObserver',
          'AssistantToolMessageGroupItem',
          'pending approval',
          'hydrate window',
          'scrollTop compensation',
        ]),
        scope: pick(random, ['src', 'src/components', 'src/core']),
      }),
    }
  }

  if (kind === 'todo_write') {
    const total = randomInt(random, 3, 6)
    return {
      id: requestId,
      name: toolName('todo_write'),
      arguments: completeArguments({
        todos: Array.from({ length: total }, (_, index) => ({
          content: `${turn}.${index + 1} ${pick(random, ACTIONS)}`,
          status:
            index < total - 2
              ? 'completed'
              : index === total - 2
                ? 'in_progress'
                : 'pending',
        })),
      }),
    }
  }

  if (kind === 'terminal_command') {
    return {
      id: requestId,
      name: toolName('terminal_command'),
      arguments: completeArguments({
        command: pick(random, [
          'npm test -- --runTestsByPath src/components/chat-view/ChatTimelineList.test.tsx',
          'rg -n "hydrate|spacer|anchor" src/components/chat-view',
          'node scripts/inspect-chat-history.mjs --limit 20',
          'git diff --stat',
        ]),
        cwd: '.',
      }),
    }
  }

  if (kind === 'delegate_subagent') {
    return {
      id: requestId,
      name: toolName('delegate_subagent'),
      arguments: completeArguments({
        description: `并行检查第 ${turn} 轮附近的长历史渲染风险`,
        prompt: '阅读相关文件，给出可能导致闪动的状态流。',
      }),
    }
  }

  return {
    id: requestId,
    name: toolName('web_search'),
    arguments: completeArguments({
      query: pick(random, [
        'react scroll anchoring virtualization resize observer',
        'browser overflow-anchor manual scroll compensation',
        'React long list markdown rendering performance',
      ]),
    }),
  }
}

function createLongText(turn, random, label, lineCount) {
  const fragments = [
    'hydrate window',
    'committed height cache',
    'pending measurement',
    'programmatic scroll lock',
    'bottom follow',
    'tool card expansion',
    'markdown layout',
    'branch switch',
  ]

  return Array.from({ length: lineCount }, (_, index) => {
    const fragment = pick(random, fragments)
    return `${label} ${turn}.${index + 1}: ${fragment} 在这一轮被反复触发，输出保持较长，用来模拟真实 Agent 的冗余日志、路径、代码片段和解释文本。`
  }).join('\n')
}

function createAssistantLongSection(turn, random, label, lineCount) {
  const sections = [
    `### ${label}：第 ${turn} 轮详细排查`,
    '这段内容故意比普通回答长，用来模拟 Agent 在多轮历史里留下的完整解释、局部假设、反证过程和最终修正。',
    createLongText(turn, random, label, lineCount),
    [
      '```ts',
      'const viewportAnchor = findNearestUserAnchor(scroller)',
      'const hydrateTurns = expandTurnsAround(viewportAnchor, { before: 2, after: 2 })',
      'commitMeasuredHeightsWhenIdle(hydrateTurns)',
      '```',
    ].join('\n'),
    '| 观察点 | 当前判断 | 下一步 |',
    '| --- | --- | --- |',
    '| spacer 高度 | 可能受缓存影响 | 对照真实 DOM anchor |',
    '| 工具卡结果 | 可能撑开布局 | 检查折叠和展开状态 |',
    '| followOutput | 只应在底部触发 | 人工滚动时保持位置 |',
  ]

  return sections.join('\n\n')
}

function maybeUseLongAssistantBlock(random, assistantLongBudget) {
  if (assistantLongBudget.remaining <= 0) {
    return false
  }

  if (!maybe(random, 0.55)) {
    return false
  }

  assistantLongBudget.remaining -= 1
  return true
}

function createToolResponseText(turn, random, request, longBlockBudget) {
  const name = request.name.split('__').at(-1)
  const isLong =
    longBlockBudget.remaining > 0 &&
    ['fs_read', 'terminal_command', 'web_search', 'delegate_subagent'].includes(
      name,
    ) &&
    maybe(random, 0.45)

  if (isLong) {
    longBlockBudget.remaining -= 1
  }

  if (name === 'fs_read') {
    return [
      `# ${pick(random, FILES)}`,
      '读取到的片段包含滚动、测量和工具卡状态。',
      isLong
        ? createLongText(turn, random, 'fs_read long output', 90)
        : createLongText(
            turn,
            random,
            'fs_read snippet',
            randomInt(random, 6, 16),
          ),
    ].join('\n\n')
  }

  if (name === 'fs_search') {
    return Array.from({ length: randomInt(random, 4, 9) }, (_, index) =>
      [
        `- ${pick(random, FILES)}:${randomInt(random, 20, 900)}`,
        `  命中 ${request.arguments?.value?.query ?? 'query'}，附近有状态更新和布局测量逻辑。`,
        `  片段 ${index + 1}: ${pick(random, ACTIONS)}`,
      ].join('\n'),
    ).join('\n')
  }

  if (name === 'todo_write') {
    return 'Todo list accepted and persisted.'
  }

  if (name === 'terminal_command') {
    return [
      '$ ' + (request.arguments?.value?.command ?? 'command'),
      isLong
        ? createLongText(turn, random, 'stdout', 120)
        : createLongText(turn, random, 'stdout', randomInt(random, 5, 18)),
      maybe(random, 0.22) ? 'stderr: warning: simulated flaky output' : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  if (name === 'delegate_subagent') {
    return JSON.stringify(
      {
        taskId: id('task'),
        accepted: true,
        title: request.arguments?.value?.description,
      },
      null,
      2,
    )
  }

  return JSON.stringify(
    {
      query: request.arguments?.value?.query,
      results: Array.from({ length: randomInt(random, 3, 8) }, (_, index) => ({
        title: `Search result ${index + 1}`,
        url: `https://example.com/${turn}/${index + 1}`,
        snippet: pick(random, ACTIONS),
      })),
    },
    null,
    2,
  )
}

function createToolMessage(turn, random, requests, longBlockBudget) {
  return {
    role: 'tool',
    id: id('tool-message'),
    toolCalls: requests.map((request) => {
      const outcome = pick(random, [
        TOOL_STATUS.Success,
        TOOL_STATUS.Success,
        TOOL_STATUS.Success,
        TOOL_STATUS.Error,
        TOOL_STATUS.Aborted,
      ])

      if (outcome === TOOL_STATUS.Error) {
        return {
          request,
          response: {
            status: TOOL_STATUS.Error,
            error: pick(random, [
              'ENOENT: no such file or directory',
              'Command exited with code 1',
              'Schema mismatch: missing required field "paths"',
              'Timed out while reading long output',
            ]),
          },
        }
      }

      if (outcome === TOOL_STATUS.Aborted) {
        return {
          request,
          response: {
            status: TOOL_STATUS.Aborted,
            data: {
              type: 'text',
              text: createLongText(turn, random, 'partial output', 8),
            },
          },
        }
      }

      const text = createToolResponseText(
        turn,
        random,
        request,
        longBlockBudget,
      )
      return {
        request,
        response: {
          status: TOOL_STATUS.Success,
          data: {
            type: 'text',
            text,
            metadata:
              text.length > 9000
                ? {
                    truncated: {
                      totalBytes: text.length + 8000,
                      omittedBytes: 8000,
                    },
                  }
                : undefined,
          },
        },
      }
    }),
  }
}

function maybeCreateAsyncResult(turn, random, request) {
  const shortName = request.name.split('__').at(-1)
  if (shortName === 'terminal_command' && maybe(random, 0.5)) {
    return {
      role: 'terminal_command_result',
      id: id('terminal-result'),
      taskId: id('terminal-task'),
      source: {
        type: 'llm_tool_call',
        toolCallId: request.id,
        assistantMessageId: id('assistant-ref'),
      },
      title: request.arguments?.value?.command ?? 'terminal command',
      status: maybe(random, 0.18) ? 'running' : 'completed',
      exitCode: maybe(random, 0.2) ? 1 : 0,
      stdout: createLongText(
        turn,
        random,
        'background stdout',
        randomInt(random, 8, 36),
      ),
      stderr: maybe(random, 0.25)
        ? createLongText(turn, random, 'background stderr', 6)
        : '',
      durationMs: randomInt(random, 1200, 18000),
      delegateAssistantMessageId: id('assistant-ref'),
      delegateToolCallId: request.id,
    }
  }

  if (shortName === 'delegate_subagent' && maybe(random, 0.6)) {
    return {
      role: 'subagent_result',
      id: id('subagent-result'),
      taskId: id('subagent-task'),
      source: {
        type: 'llm_tool_call',
        toolCallId: request.id,
        assistantMessageId: id('assistant-ref'),
      },
      title: request.arguments?.value?.description ?? 'Subagent result',
      status: pick(random, ['completed', 'failed', 'aborted']),
      content: createLongText(
        turn,
        random,
        'subagent notes',
        randomInt(random, 10, 48),
      ),
      activityLog: createLongText(
        turn,
        random,
        'activity',
        randomInt(random, 4, 14),
      ),
      durationMs: randomInt(random, 3000, 40000),
      toolUseCount: randomInt(random, 2, 14),
      delegateAssistantMessageId: id('assistant-ref'),
      delegateToolCallId: request.id,
    }
  }

  return null
}

function createAssistantFollowup(turn, random, requests, assistantLongBudget) {
  const hasTools = requests.length > 0
  const content = [
    hasTools
      ? `工具结果回来了。第 ${turn} 轮可以收敛成几个观察点：`
      : `第 ${turn} 轮没有工具调用，主要靠前文状态继续推断：`,
    `1. ${pick(random, ACTIONS)}。`,
    `2. ${pick(random, ACTIONS)}。`,
    `3. 如果下方出现大块空白或滚动闪动，优先检查 spacer 高度和 hydrate 邻居窗口。`,
    maybe(random, 0.35)
      ? [
          '```ts',
          'const nextRange = { top, bottom }',
          'hydrateNeighbors(nextRange)',
          '```',
        ].join('\n')
      : '',
    maybeUseLongAssistantBlock(random, assistantLongBudget)
      ? createAssistantLongSection(
          turn,
          random,
          'assistant follow-up long block',
          randomInt(random, 28, 54),
        )
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  return {
    role: 'assistant',
    content,
    id: id('assistant'),
    metadata: {
      generationState: 'completed',
      durationMs: randomInt(random, 700, 3600),
    },
  }
}

function buildMessages({
  turns,
  seed,
  toolDensity,
  maxToolsPerTurn,
  maxLongBlocks,
  assistantLongBlocks,
}) {
  const random = createRandom(seed)
  const messages = []
  const longBlockBudget = { remaining: maxLongBlocks }
  const assistantLongBudget = { remaining: assistantLongBlocks }

  for (let turn = 1; turn <= turns; turn += 1) {
    messages.push(createUserMessage(turn, random))

    const toolCount = maybe(random, toolDensity)
      ? randomInt(
          random,
          maybe(random, 0.25) ? 1 : 2,
          maybe(random, 0.35)
            ? maxToolsPerTurn
            : Math.max(2, Math.ceil(maxToolsPerTurn / 2)),
        )
      : 0
    const requests = Array.from({ length: toolCount }, () =>
      makeToolRequest(turn, random),
    )

    messages.push(createAssistantIntro(turn, random, requests))

    if (requests.length > 0) {
      messages.push(createToolMessage(turn, random, requests, longBlockBudget))

      for (const request of requests) {
        const asyncResult = maybeCreateAsyncResult(turn, random, request)
        if (asyncResult) {
          messages.push(asyncResult)
        }
      }
    }

    messages.push(
      createAssistantFollowup(turn, random, requests, assistantLongBudget),
    )
  }

  return messages
}

function countToolCalls(messages) {
  return messages.reduce((total, message) => {
    if (message.role !== 'tool') {
      return total
    }

    return total + message.toolCalls.length
  }, 0)
}

function countLongAssistantMessages(messages) {
  return messages.filter(
    (message) =>
      message.role === 'assistant' &&
      typeof message.content === 'string' &&
      message.content.length > 3000,
  ).length
}

async function readJson(filePath, fallbackValue) {
  try {
    const content = await readFile(filePath, 'utf8')
    return JSON.parse(content)
  } catch {
    return fallbackValue
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  await mkdir(options.dbRoot, { recursive: true })

  const messages = buildMessages(options)
  const now = Date.now()
  const conversationId = crypto.randomUUID()
  const conversation = {
    id: conversationId,
    title: `${options.title} · seed ${options.seed}`,
    messages,
    createdAt: now,
    updatedAt: now,
    schemaVersion: CHAT_SCHEMA_VERSION,
    isPinned: false,
  }

  const conversationPath = path.join(
    options.dbRoot,
    `v${CHAT_SCHEMA_VERSION}_${conversationId}.json`,
  )
  await writeFile(conversationPath, JSON.stringify(conversation, null, 2))

  const indexPath = path.join(options.dbRoot, 'chat_index.json')
  const index = await readJson(indexPath, [])
  const nextIndex = [
    {
      id: conversationId,
      title: conversation.title,
      updatedAt: now,
      schemaVersion: CHAT_SCHEMA_VERSION,
      isPinned: false,
    },
    ...index.filter((item) => item?.id !== conversationId),
  ]
  await writeFile(indexPath, JSON.stringify(nextIndex, null, 2))

  const fileSize = Buffer.byteLength(JSON.stringify(conversation), 'utf8')
  console.log(
    JSON.stringify(
      {
        conversationId,
        title: conversation.title,
        turns: options.turns,
        seed: options.seed,
        messages: messages.length,
        toolCalls: countToolCalls(messages),
        longAssistantMessages: countLongAssistantMessages(messages),
        bytes: fileSize,
        megabytes: Number((fileSize / 1024 / 1024).toFixed(2)),
        conversationPath,
        indexPath,
      },
      null,
      2,
    ),
  )
}

await main()
