import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const CHAT_SCHEMA_VERSION = 1
const DEFAULT_TITLE = '长对话性能压测样本'
const DEFAULT_TURNS = 120
const DEFAULT_ASSISTANT_PARAGRAPHS = 6
const DEFAULT_TARGET_SIZE_MB = 3
const DEFAULT_VAULT_ROOT = path.resolve(process.cwd(), '../../..')
const DEFAULT_DB_ROOT = path.join(
  DEFAULT_VAULT_ROOT,
  'YOLO',
  '.yolo_json_db',
  'chats',
)

function parseArgs(argv) {
  const options = {
    vaultRoot: DEFAULT_VAULT_ROOT,
    dbRoot: DEFAULT_DB_ROOT,
    title: DEFAULT_TITLE,
    turns: DEFAULT_TURNS,
    assistantParagraphs: DEFAULT_ASSISTANT_PARAGRAPHS,
    targetSizeMb: DEFAULT_TARGET_SIZE_MB,
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
      case '--assistant-paragraphs':
        options.assistantParagraphs = Number.parseInt(next, 10)
        index += 1
        break
      case '--target-size-mb':
        options.targetSizeMb = Number.parseFloat(next)
        index += 1
        break
      default:
        break
    }
  }

  return options
}

function createTextEditorState(text) {
  return {
    root: {
      children: [
        {
          children: [
            {
              detail: 0,
              format: 0,
              mode: 'normal',
              style: '',
              text,
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
        },
      ],
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  }
}

function createUserMessage(turn, topic) {
  const text = [
    `第 ${turn} 轮问题：请继续分析「${topic}」在真实产品环境里的性能瓶颈。`,
    '请重点关注渲染、状态更新、滚动、消息体积、引用内容和历史回放。',
    `我希望你这轮给出更细的拆分，并且补充第 ${turn} 轮和前文之间的承接关系。`,
  ].join('\n')

  return {
    role: 'user',
    content: createTextEditorState(text),
    promptContent: null,
    id: crypto.randomUUID(),
    mentionables: [],
    selectedSkills: [],
    selectedModelIds: [],
    reasoningLevel: 'off',
  }
}

function createAssistantParagraph(turn, paragraphIndex, topic) {
  return [
    `### 第 ${turn} 轮分析块 ${paragraphIndex + 1}`,
    `围绕「${topic}」的长会话性能压测，这一段专门用来放大历史消息渲染成本。当前观察点包括：长 Markdown 段落、重复结构、代码块、列表和多段落内容在 React 树中的累计影响。`,
    `当会话进入第 ${turn} 轮时，旧消息如果仍然完整参与 reconciliation，那么输入区每次变动都可能让主线程重新遍历整棵消息树，尤其在存在大量历史用户输入、长 assistant 回复和工具输出时，开销会显著上升。`,
    `这里额外补充一段冗长文本用于模拟真实用户环境：我们希望验证在消息总量、段落层级、可见区域切换、滚动跟随、历史编辑进入退出、代码块高亮和引用块渲染共同叠加时，界面是否还能保持丝滑、稳定、不抖动，并且不会影响 Obsidian 其他区域的输入响应。`,
    `进一步地，这一段也模拟“模型不断复述前文并补充细节”的真实场景，所以文本会刻意较长、句式重复、信息密集。这样在渲染器、选择器、memo 边界或虚拟列表策略设计得不够好时，就更容易暴露掉帧、卡顿、自动滚动失效、布局抖动或输入延迟。`,
    `结论性建议 ${paragraphIndex + 1}：把历史消息展示与编辑器实例分离、按需挂载重型组件、仅渲染视口附近消息、把流式更新限制在尾部活跃片段，并避免让底部 composer 的输入状态驱动整个长列表重渲染。`,
  ].join('\n\n')
}

function createAssistantMessage(turn, topic, assistantParagraphs) {
  const content = Array.from({ length: assistantParagraphs }, (_, index) =>
    createAssistantParagraph(turn, index, topic),
  ).join('\n\n')

  return {
    role: 'assistant',
    content,
    id: crypto.randomUUID(),
    metadata: {
      generationState: 'completed',
      durationMs: 1000 + turn * 17,
    },
  }
}

function approximateConversationSize(messages, title) {
  const conversation = {
    id: crypto.randomUUID(),
    title,
    messages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    schemaVersion: CHAT_SCHEMA_VERSION,
    isPinned: false,
  }
  return Buffer.byteLength(JSON.stringify(conversation), 'utf8')
}

function buildMessages({
  turns,
  topic,
  assistantParagraphs,
  targetSizeMb,
}) {
  const targetSizeBytes = Math.max(1, targetSizeMb) * 1024 * 1024
  let effectiveParagraphs = Math.max(1, assistantParagraphs)
  let messages = []

  while (true) {
    messages = []
    for (let turn = 1; turn <= turns; turn += 1) {
      messages.push(createUserMessage(turn, topic))
      messages.push(createAssistantMessage(turn, topic, effectiveParagraphs))
    }

    if (
      approximateConversationSize(messages, DEFAULT_TITLE) >= targetSizeBytes ||
      effectiveParagraphs >= 48
    ) {
      return {
        messages,
        effectiveParagraphs,
      }
    }

    effectiveParagraphs += 2
  }
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

  const topic = `${options.title} / ${new Date().toISOString().slice(0, 10)}`
  const { messages, effectiveParagraphs } = buildMessages({
    turns: options.turns,
    topic,
    assistantParagraphs: options.assistantParagraphs,
    targetSizeMb: options.targetSizeMb,
  })

  const now = Date.now()
  const conversationId = crypto.randomUUID()
  const conversation = {
    id: conversationId,
    title: options.title,
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
      title: options.title,
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
        title: options.title,
        turns: options.turns,
        assistantParagraphs: effectiveParagraphs,
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
