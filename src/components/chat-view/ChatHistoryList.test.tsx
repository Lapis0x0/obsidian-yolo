let mockSearchQuery = ''

jest.mock('react', () => {
  const actual = jest.requireActual<typeof import('react')>('react')
  return {
    ...actual,
    useCallback: <T,>(callback: T) => callback,
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    useId: () => 'test-id',
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(initialValue: T) => ({ current: initialValue }),
    useState: <T,>(initialValue: T | (() => T)) => {
      const resolvedValue =
        typeof initialValue === 'function'
          ? (initialValue as () => T)()
          : initialValue
      return [resolvedValue === '' ? mockSearchQuery : resolvedValue, jest.fn()]
    },
  }
})

// 这些用例把 ChatListItem 当普通函数调用，拿不到 framer-motion 需要的 React
// dispatcher；动效不在断言范围内，直接退化成原生标签即可。
jest.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: unknown }) => children,
  motion: { li: 'li' },
  useIsPresent: () => true,
  useReducedMotion: () => false,
}))

jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

jest.mock('../../hooks/useJsonManagers', () => ({
  useChatManager: () => ({ findById: jest.fn() }),
}))

jest.mock('../../hooks/useChatHistory', () => ({
  getConversationDisplayTitle: (title: string, fallback: string) =>
    title.trim() || fallback,
}))

jest.mock('../../contexts/app-context', () => ({
  useApp: () => ({
    keymap: {
      scope: {},
      pushScope: jest.fn(),
      popScope: jest.fn(),
    },
  }),
}))

import type {
  KeymapContext,
  KeymapEventHandler,
  KeymapEventListener,
  Modifier,
} from 'obsidian'
import {
  Children,
  type ReactElement,
  type ReactNode,
  isValidElement,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ChatConversationMetadata } from '../../database/json/chat/types'

import {
  ChatHistoryList,
  clampContextMenuPosition,
  computeMiddleTruncatedTitle,
  computeNextHighlightedIndex,
  navigateContextMenu,
  registerChatListMenuKeys,
  registerChatListPanelKeys,
  resolveChatListDeleteConfirmation,
  resolveChatListSearchKeyboardAction,
  splitTitleForMiddleTruncation,
} from './ChatHistoryList'

const chat = (
  id: string,
  title: string,
  cliSession?: ChatConversationMetadata['cliSession'],
): ChatConversationMetadata => ({
  id,
  title,
  updatedAt: 100,
  schemaVersion: 1,
  cliSession,
})

const walkElements = (node: ReactNode): ReactElement[] => {
  if (!isValidElement(node)) return []
  const element = node as ReactElement<{ children?: ReactNode }>
  return [
    element,
    ...Children.toArray(element.props.children).flatMap(walkElements),
  ]
}

const createTree = (
  chatList: ChatConversationMetadata[],
  onSelect = jest.fn(),
) =>
  ChatHistoryList({
    chatList,
    currentConversationId: '',
    runSummariesByConversationId: new Map(),
    onSelect,
    onDelete: jest.fn(),
    onUpdateTitle: jest.fn(),
    onTogglePinned: jest.fn(),
    onRetryTitle: jest.fn(),
    onExportConversation: jest.fn(),
  })

// ChatListItem 由 React.memo 包装：元素的 type 是 memo 对象，内层组件函数在
// 其 .type 字段上。
const unwrapMemoType = (type: unknown): unknown =>
  typeof type === 'object' && type !== null && 'type' in type
    ? (type as { type: unknown }).type
    : type

const historyRows = (tree: ReactElement) =>
  walkElements(tree).filter((element) => {
    const inner = unwrapMemoType(element.type)
    return typeof inner === 'function' && inner.name === 'ChatListItem'
  })

// issue #567：点击误触治理的测试需要拿到行内每个操作按钮真正的
// onClick/onMouseDown 处理函数（不能用 renderToStaticMarkup，那会丢掉函数）。
// 把 row（ChatHistoryList 传给 ChatListItem 的 props）实际调用一次，拿到
// ChatListItem 渲染出的真实元素树，再在树里按 className 找目标按钮。
const renderRow = (row: ReactElement) =>
  (unwrapMemoType(row.type) as (props: typeof row.props) => ReactElement)(
    row.props,
  )

const classNames = (props: unknown): string[] => {
  const className = (props as { className?: unknown } | null)?.className
  return typeof className === 'string' ? className.split(/\s+/) : []
}

const findButtonByClass = (root: ReactElement, cls: string) =>
  walkElements(root).find(
    (element) =>
      element.type === 'button' && classNames(element.props).includes(cls),
  )

const findDivByClass = (root: ReactElement, cls: string) =>
  walkElements(root).find(
    (element) =>
      element.type === 'div' && classNames(element.props).includes(cls),
  )

const findInputByClass = (root: ReactElement, cls: string) =>
  walkElements(root).find(
    (element) =>
      element.type === 'input' && classNames(element.props).includes(cls),
  )

// createTree 只暴露 onSelect（既有用例的需要）；点击误触测试还要断言
// onTogglePinned/onRetryTitle/onExportConversation 等其余动作 prop 有没有被
// 调用，所以单独建一棵能拿到全部 mock 的树，不动 createTree 以免影响既有用例。
const createInteractionTree = (chatList: ChatConversationMetadata[]) => {
  const mocks = {
    onSelect: jest.fn(),
    onDelete: jest.fn(),
    onUpdateTitle: jest.fn(),
    onTogglePinned: jest.fn(),
    onRetryTitle: jest.fn(),
    onExportConversation: jest.fn(),
  }
  const tree = ChatHistoryList({
    chatList,
    currentConversationId: '',
    runSummariesByConversationId: new Map(),
    ...mocks,
  })
  return { tree, mocks }
}

describe('ChatHistoryList', () => {
  beforeEach(() => {
    mockSearchQuery = ''
  })

  it('keeps title filtering and selection on the unified history list', async () => {
    mockSearchQuery = 'alpha'
    const onSelect = jest.fn()
    const rows = historyRows(
      createTree(
        [
          chat('alpha', 'Alpha conversation'),
          chat('beta', 'Beta conversation'),
        ],
        onSelect,
      ),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.props.title).toBe('Alpha conversation')
    ;(rows[0]?.props.onSelect as (conversationId: string) => void)(
      rows[0]?.props.conversationId as string,
    )
    await Promise.resolve()
    expect(onSelect).toHaveBeenCalledWith('alpha')
  })

  it('shows compact runtime badges only for YOLO-owned CLI conversations', () => {
    const rows = historyRows(
      createTree([
        chat('yolo', 'Normal'),
        chat('cc', 'Claude task', {
          runtimeId: 'claude-code',
          nativeSessionId: 'session-1',
        }),
        chat('codex', 'Codex task', {
          runtimeId: 'codex',
          nativeSessionId: 'thread-1',
        }),
        chat('grok', 'Grok task', {
          runtimeId: 'grok',
          nativeSessionId: 'session-grok',
        }),
      ]),
    )
    const html = rows
      .map((row) =>
        renderToStaticMarkup(
          (
            unwrapMemoType(row.type) as (
              props: typeof row.props,
            ) => ReactElement
          )(row.props),
        ),
      )
      .join('')

    expect(html).toContain('data-runtime-id="claude-code"')
    expect(html).toContain('>CC<')
    expect(html).toContain('aria-label="Claude Code"')
    expect(html).toContain('data-runtime-id="codex"')
    expect(html).toContain('>Cx<')
    expect(html).toContain('data-runtime-id="grok"')
    expect(html).toContain('>Gk<')
    expect(html).not.toContain('aria-label="Codex">Grok')
    expect(html.match(/data-runtime-id=/g)).toHaveLength(3)
  })

  // 侧边栏一行只有两百多像素：悬停只露删除和 ⋯，改名 / 置顶 / 重试命名 /
  // 导出都收进 ⋯ 菜单。删除仍常驻行内（issue #567），排在 ⋯ 之前。
  it('renders only delete and more inline, delete first, always reachable by Tab', () => {
    const rows = historyRows(createTree([chat('yolo', 'Normal')]))
    expect(rows).toHaveLength(1)
    const row = rows[0]
    if (!row) throw new Error('expected a row')
    const html = renderToStaticMarkup(
      (unwrapMemoType(row.type) as (props: typeof row.props) => ReactElement)(
        row.props,
      ),
    )

    const deleteIndex = html.indexOf('yolo-chat-list-delete-button')
    const moreIndex = html.indexOf('yolo-chat-list-more-button')
    expect(deleteIndex).toBeGreaterThan(-1)
    expect(moreIndex).toBeGreaterThan(deleteIndex)
    expect(html).not.toContain('aria-label="Edit"')
    expect(html).not.toContain('aria-label="Pin"')
    expect(html).not.toContain('aria-label="Retry title"')

    const tagStart = html.lastIndexOf('<button', deleteIndex)
    const tagEnd = html.indexOf('>', tagStart)
    const deleteButtonTag = html.slice(tagStart, tagEnd + 1)
    expect(deleteButtonTag).toContain('aria-label="Delete"')
    expect(deleteButtonTag).not.toContain('tabindex')
  })

  // issue #567：点击误触治理。选中会话是靠 motion.li 的 onClick 触发的，
  // 所以每个操作图标点击不得冒泡到条目本身——断言的
  // 落点是「点完操作图标之后 onSelect 没被调过」，而不是检查某个内部布尔值。
  // 覆盖面是行内剩下的两个按钮：删除与 ⋯。
  describe('action icon clicks do not select the row or leak past the actions area', () => {
    // itemHandlers.onRetryTitle 的 .finally() 和 useDeleteConfirmation 的
    // request() 都用 window.setTimeout 做反馈时长/自动复位；jest 的
    // testEnvironment 是 'node'（没有 window 全局），这里补一个最小 shim。
    // 用 fake timers（在装 shim 之前开启，让 shim 捕获到的是已经被替换过的
    // fake setTimeout/clearTimeout）避免 useDeleteConfirmation 那个 3 秒
    // 的真实定时器在测试跑完后才触发，导致进程挂起 /（window 已在 afterAll
    // 里还原成 undefined 时）访问 undefined.clearTimeout 崩溃。
    let originalWindow: unknown
    beforeAll(() => {
      jest.useFakeTimers()
      originalWindow = (global as { window?: unknown }).window
      ;(global as { window?: unknown }).window = { setTimeout, clearTimeout }
    })
    afterAll(() => {
      jest.useRealTimers()
      ;(global as { window?: unknown }).window = originalWindow
    })

    const buildRow = () => {
      const { tree, mocks } = createInteractionTree([chat('yolo', 'Normal')])
      const rows = historyRows(tree)
      const row = rows[0]
      if (!row) throw new Error('expected a row')
      return { rendered: renderRow(row), mocks }
    }

    it('stops clicks at the actions container before they can reach the row', () => {
      const { rendered, mocks } = buildRow()
      const actions = findDivByClass(
        rendered,
        'yolo-chat-list-dropdown-item-actions',
      )
      expect(actions).toBeDefined()
      const stopPropagation = jest.fn()
      ;(
        actions?.props as { onClick?: (e: unknown) => void } | undefined
      )?.onClick?.({ stopPropagation })
      expect(stopPropagation).toHaveBeenCalledTimes(1)
      expect(mocks.onSelect).not.toHaveBeenCalled()
    })

    it('inline delete click (first press, entering confirm state) stops propagation and never selects the row', () => {
      const { rendered, mocks } = buildRow()
      const deleteButton = findButtonByClass(
        rendered,
        'yolo-chat-list-delete-button',
      )
      expect(deleteButton).toBeDefined()
      const stopPropagation = jest.fn()
      ;(
        deleteButton?.props as { onClick?: (e: unknown) => void } | undefined
      )?.onClick?.({ stopPropagation })
      expect(stopPropagation).toHaveBeenCalledTimes(1)
      expect(mocks.onSelect).not.toHaveBeenCalled()
    })

    it('"more" (ellipsis) click stops propagation and never selects the row', () => {
      const { rendered, mocks } = buildRow()
      const moreButton = findButtonByClass(
        rendered,
        'yolo-chat-list-more-button',
      )
      expect(moreButton).toBeDefined()
      const stopPropagation = jest.fn()
      ;(
        moreButton?.props as { onClick?: (e: unknown) => void } | undefined
      )?.onClick?.({ stopPropagation })
      expect(stopPropagation).toHaveBeenCalledTimes(1)
      expect(mocks.onSelect).not.toHaveBeenCalled()
    })
  })

  // issue #567：标题中间截断——渲染层是 ghost/overlay 结构（原理见
  // useMiddleTruncatedTitle 注释）：ghost 承载完整标题撑宽度，display 放测量
  // 拼好的可见文本。SSR/未测量阶段 display 就是完整标题；截断字符串的选取
  // 逻辑在 computeMiddleTruncatedTitle 的专门单测里覆盖。
  describe('title middle truncation rendering', () => {
    it('renders a hidden ghost with the full title, a display overlay, and the full-title tooltip', () => {
      const longTitle = 'A very long conversation title that keeps going (copy)'
      const rows = historyRows(createTree([chat('yolo', longTitle)]))
      const row = rows[0]
      if (!row) throw new Error('expected a row')
      const html = renderToStaticMarkup(renderRow(row))
      expect(html).toContain('yolo-chat-list-dropdown-item-title-ghost')
      expect(html).toContain('yolo-chat-list-dropdown-item-title-display')
      expect(html).toContain(`title="${longTitle}"`)
    })
  })

  // issue #567：快捷键改挂 Obsidian keymap scope 后，搜索框 onKeyDown 不再
  // dispatch 动作——只对「不是 scope 已注册的键」stopPropagation，避免打字
  // 漏到宿主热键。动作本身由 registerChatListPanelKeys 覆盖。
  describe('keyboard navigation and shortcuts (issue #567)', () => {
    // 两步删除确认靠 window.setTimeout 做 3 秒自动复位；测试环境是 node（没有
    // window 全局），沿用上面「action icon clicks...」describe 里的同款
    // 最小 shim + fake timers 手法（原因见那里的注释）。
    let originalWindow: unknown
    beforeAll(() => {
      jest.useFakeTimers()
      originalWindow = (global as { window?: unknown }).window
      ;(global as { window?: unknown }).window = { setTimeout, clearTimeout }
    })
    afterAll(() => {
      jest.useRealTimers()
      ;(global as { window?: unknown }).window = originalWindow
    })

    it('requires two presses on the same row before it actually deletes (arm, then confirm)', () => {
      const { tree, mocks } = createInteractionTree([chat('yolo', 'Normal')])
      const row = historyRows(tree)[0]
      if (!row) throw new Error('expected a row')
      const onRequestDelete = row.props.onRequestDelete as (
        conversationId: string,
      ) => void

      onRequestDelete('yolo')
      expect(mocks.onDelete).not.toHaveBeenCalled()

      onRequestDelete('yolo')
      expect(mocks.onDelete).toHaveBeenCalledWith('yolo')
    })

    it('pressing delete on a different row arms that row instead of confirming the first one', () => {
      const { tree, mocks } = createInteractionTree([
        chat('a', 'A'),
        chat('b', 'B'),
      ])
      const rows = historyRows(tree)
      const rowA = rows.find((row) => row.props.conversationId === 'a')
      const rowB = rows.find((row) => row.props.conversationId === 'b')
      if (!rowA || !rowB) throw new Error('expected two rows')
      const onRequestDelete = rowA.props.onRequestDelete as (
        conversationId: string,
      ) => void

      onRequestDelete('a')
      onRequestDelete('b') // 切到另一行：不是「a 的第二下」，b 重新进入待确认
      expect(mocks.onDelete).not.toHaveBeenCalled()
      onRequestDelete('b')
      expect(mocks.onDelete).toHaveBeenCalledWith('b')
      expect(mocks.onDelete).not.toHaveBeenCalledWith('a')
    })

    const buildSearchInputKeyDown = (chatList: ChatConversationMetadata[]) => {
      // 搜索框只在唤出或有搜索词时渲染；mock 的 useState 让空串初值取这个值
      mockSearchQuery = 'n'
      const { tree, mocks } = createInteractionTree(chatList)
      mockSearchQuery = ''
      const searchInput = findInputByClass(tree, 'yolo-chat-list-search-input')
      if (!searchInput) throw new Error('expected the search input')
      return {
        onKeyDown: searchInput.props.onKeyDown as (e: unknown) => void,
        mocks,
      }
    }

    const keyEvent = (
      overrides: Partial<{
        key: string
        metaKey: boolean
        ctrlKey: boolean
        shiftKey: boolean
        altKey: boolean
      }>,
    ) => ({
      key: '',
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
      ...overrides,
    })

    it('Enter is left for the keymap scope (no preventDefault/stopPropagation, no dispatch here)', () => {
      const { onKeyDown, mocks } = buildSearchInputKeyDown([
        chat('alpha', 'Alpha'),
        chat('beta', 'Beta'),
      ])
      const event = keyEvent({ key: 'Enter' })
      onKeyDown(event)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(event.stopPropagation).not.toHaveBeenCalled()
      expect(mocks.onSelect).not.toHaveBeenCalled()
    })

    it('an unrecognized key (normal typing) only stops propagation, never preventDefault', () => {
      const { onKeyDown } = buildSearchInputKeyDown([chat('yolo', 'Normal')])
      const event = keyEvent({ key: 'a' })
      onKeyDown(event)
      expect(event.stopPropagation).toHaveBeenCalledTimes(1)
      expect(event.preventDefault).not.toHaveBeenCalled()
    })

    it('Backspace without a modifier is left alone so normal text editing keeps working', () => {
      const { onKeyDown } = buildSearchInputKeyDown([chat('yolo', 'Normal')])
      const event = keyEvent({ key: 'Backspace' })
      onKeyDown(event)
      expect(event.stopPropagation).toHaveBeenCalledTimes(1)
      expect(event.preventDefault).not.toHaveBeenCalled()
    })

    it('Escape is left for the keymap scope so the panel/menu layers can consume it', () => {
      const { onKeyDown } = buildSearchInputKeyDown([chat('yolo', 'Normal')])
      const event = keyEvent({ key: 'Escape' })
      onKeyDown(event)
      expect(event.stopPropagation).not.toHaveBeenCalled()
      expect(event.preventDefault).not.toHaveBeenCalled()
    })
  })
})

describe('clampContextMenuPosition', () => {
  const viewport = { width: 1000, height: 800 }

  it('leaves an in-bounds position untouched', () => {
    const result = clampContextMenuPosition({
      position: { top: 100, left: 100 },
      menuSize: { width: 200, height: 150 },
      viewport,
      anchorMode: 'pointer',
      cardTop: null,
    })
    expect(result).toEqual({ top: 100, left: 100 })
  })

  it('clamps the left edge against the viewport when the menu would overflow the right side (not the narrow parent popover)', () => {
    // 母弹层本身可能只有几百 px 宽，但这里给的 viewport 明显更宽——断言钳制
    // 只看 viewport，不会被一个更窄的母弹层提前夹住。
    const result = clampContextMenuPosition({
      position: { top: 100, left: 950 },
      menuSize: { width: 200, height: 150 },
      viewport,
      anchorMode: 'pointer',
      cardTop: null,
    })
    expect(result.left).toBe(viewport.width - 200 - 8)
  })

  it('clamps the top edge against the viewport bottom without flipping when triggered by a pointer (right-click)', () => {
    const result = clampContextMenuPosition({
      position: { top: 700, left: 100 },
      menuSize: { width: 200, height: 150 },
      viewport,
      anchorMode: 'pointer',
      cardTop: 650,
    })
    // 右键场景锚在点击处，只做越界钳制，不翻转到卡片上方
    expect(result.top).toBe(viewport.height - 150 - 8)
  })

  it('flips above the card when triggered by long-press (no pointer) and the menu would overflow the bottom', () => {
    const cardTop = 750
    const result = clampContextMenuPosition({
      position: { top: 760, left: 100 },
      menuSize: { width: 200, height: 150 },
      viewport,
      anchorMode: 'anchor',
      cardTop,
    })
    expect(result.top).toBe(cardTop - 150 - 6)
  })

  it('floors both axes at the 8px inset near the top-left corner', () => {
    const result = clampContextMenuPosition({
      position: { top: -20, left: -20 },
      menuSize: { width: 200, height: 150 },
      viewport,
      anchorMode: 'pointer',
      cardTop: null,
    })
    expect(result).toEqual({ top: 8, left: 8 })
  })
})

// issue #567：弹层宽度不再钳在母容器（聊天侧边栏）宽度内，只受弹层所在
// 窗口的视口宽度约束——窄侧边栏下弹层不该跟着变窄。这条走纯 CSS
// （width: min(420px, calc(100vw - 24px))，见 popover.css
// .yolo-chat-list-dropdown-content 的注释），不是可单测的 JS 纯函数：早先的
// JS 方案（useLayoutEffect 读 window.innerWidth 后设 inline style）在真实
// Obsidian 里被 Radix Popover.Content 背后 floating-ui 的异步定位重渲染盖掉，
// 实测不可靠，改成 CSS 表达式后就不存在这个时序问题——纯 CSS 值本身没有可测的
// 分支逻辑，靠人工测试清单里的窄侧边栏/超窄窗口两项覆盖。

// issue #567：中间截断保住尾部——分支会话的 "xxx (copy)" 后缀原先被
// 尾部 ellipsis 吃掉，副本和原件分不清。按 code point 切，CJK/emoji 不应被
// 劈裂。
describe('splitTitleForMiddleTruncation', () => {
  it('keeps the whole title as the tail (no head) when it is at or under the tail length', () => {
    expect(splitTitleForMiddleTruncation('Short title')).toEqual({
      head: '',
      tail: 'Short title',
    })
  })

  it('splits a long ascii title, keeping the last 12 characters intact for the tail', () => {
    const title = 'A very long conversation title that keeps going (copy)'
    const { head, tail } = splitTitleForMiddleTruncation(title)
    expect(head + tail).toBe(title)
    expect(tail).toHaveLength(12)
    expect(tail).toBe(title.slice(-12))
    expect(tail).toContain('(copy)')
  })

  it('does not split a CJK title mid-character', () => {
    const title = '这是一个非常非常非常长的中文对话标题用来测试中间截断（副本）'
    const { head, tail } = splitTitleForMiddleTruncation(title)
    expect(head + tail).toBe(title)
    // 按 code point 数，不是 UTF-16 code unit 数或字节数
    expect(Array.from(tail)).toHaveLength(12)
    expect(tail).toContain('副本')
  })

  it('does not split an astral-plane emoji (surrogate pair) across the head/tail boundary', () => {
    // 😀 是一个 code point 但占两个 UTF-16 code unit；title.length（UTF-16）
    // 和 Array.from(title).length（code point）在这类字符串上不相等，用来
    // 验证切分是按 code point 而不是按 UTF-16 单元。
    const title = `${'x'.repeat(40)}😀(copy)`
    const { head, tail } = splitTitleForMiddleTruncation(title)
    expect(head + tail).toBe(title)
    expect(Array.from(tail)).toHaveLength(12)
    // emoji 完整落在尾段或头段之一，两个 UTF-16 code unit 没有被拆开
    const emoji = '😀'
    const combined = head + tail
    expect(combined.includes(emoji)).toBe(true)
    expect(
      (head.includes(emoji) && !tail.includes(emoji)) ||
        (!head.includes(emoji) && tail.includes(emoji)),
    ).toBe(true)
  })
})

// issue #567 追加：省略号两侧像素级贴合。text-overflow: ellipsis 只能
// 整字截断，flex 盒子宽度与整字排布之间的余数会留在省略号和尾段之间形成
// 可见缝隙；computeMiddleTruncatedTitle 改为自己拼「头…尾」单段字符串，余数
// 自然落到标题末尾（不可见）。测量器注入，这里用「宽度 = code point 数」的
// 假测量器验证选取逻辑。
describe('computeMiddleTruncatedTitle', () => {
  const measureByCodePoints = (text: string) => Array.from(text).length

  it('returns the title unchanged when it fits', () => {
    const title = 'fits entirely'
    expect(computeMiddleTruncatedTitle(title, 100, measureByCodePoints)).toBe(
      title,
    )
  })

  it('keeps the 12-codepoint tail and fills the rest with the longest fitting prefix plus ellipsis', () => {
    const title = `${'a'.repeat(30)}23456 (copy)`
    const result = computeMiddleTruncatedTitle(title, 20, measureByCodePoints)
    // 尾段 12 + 省略号 1 = 13，剩 7 给头部前缀
    expect(result).toBe(`${'a'.repeat(7)}…23456 (copy)`)
    expect(measureByCodePoints(result)).toBeLessThanOrEqual(20)
  })

  it('trims whitespace touching the ellipsis on both sides', () => {
    // 头部前缀恰好切在空格后、尾段以空格开头的场景，不应出现 "x …" 或 "… y"
    const headWithSpaces = `abc ${'x'.repeat(26)}`
    const title = `${headWithSpaces} tail (copy)` // 尾段 = " tail (copy)" 共 12
    // 16 = 前缀 "abc "（trim 后 3）+ 省略号 1 + trim 后尾段 11，再多一个 x 就放不下
    const result = computeMiddleTruncatedTitle(title, 16, measureByCodePoints)
    expect(result).toBe('abc…tail (copy)')
  })

  it('returns short titles unchanged even when they do not fit', () => {
    // 头段为空（标题不超过尾段长度）时中间截断无意义，交给容器裁切
    const title = '短标题不足十二字'
    expect(computeMiddleTruncatedTitle(title, 3, measureByCodePoints)).toBe(
      title,
    )
  })

  it('never splits an astral-plane emoji at the prefix boundary', () => {
    const title = `${'😀'.repeat(20)} final (copy)`
    const result = computeMiddleTruncatedTitle(title, 18, measureByCodePoints)
    // 前缀按 code point 切：不应出现残缺的代理对（单独的 \uD83D 或 \uDE00）
    const beforeEllipsis = result.split('…')[0] ?? ''
    expect(beforeEllipsis).toBe('😀'.repeat(5))
  })
})

// issue #567：↑/↓ 移动高亮的下一个索引，纯函数——panel keymap
// scope 的 ArrowUp/ArrowDown 绑定使用。到底/到顶不回绕。
describe('computeNextHighlightedIndex', () => {
  it('moves down from the current index', () => {
    expect(computeNextHighlightedIndex(1, 'down', 5)).toBe(2)
  })

  it('moves up from the current index', () => {
    expect(computeNextHighlightedIndex(2, 'up', 5)).toBe(1)
  })

  it('treats "nothing highlighted yet" (-1) as if the first item were already the base', () => {
    // 与 panel scope 里 Arrow 绑定的既有行为一致（这里只是把它抽成纯函数，
    // 没有改变语义）：base 取 0，↓ 从 0 再往下移一格到 1，↑ 从 0 停在 0。
    expect(computeNextHighlightedIndex(-1, 'down', 5)).toBe(1)
    expect(computeNextHighlightedIndex(-1, 'up', 5)).toBe(0)
  })

  it('clamps at the bottom without wrapping', () => {
    expect(computeNextHighlightedIndex(4, 'down', 5)).toBe(4)
  })

  it('clamps at the top without wrapping', () => {
    expect(computeNextHighlightedIndex(0, 'up', 5)).toBe(0)
  })

  it('returns -1 for an empty list', () => {
    expect(computeNextHighlightedIndex(0, 'down', 0)).toBe(-1)
  })
})

// issue #567：搜索框键盘事件 → 动作的判定，纯函数。键位取舍（Mod+P
// 与 Obsidian 命令面板冲突、换成 Mod+Shift+P）见 ChatHistoryList.tsx 里
// resolveChatListSearchKeyboardAction 头注释。
describe('resolveChatListSearchKeyboardAction', () => {
  it('resolves ArrowUp/ArrowDown to navigate actions', () => {
    expect(
      resolveChatListSearchKeyboardAction({ key: 'ArrowUp' } as never, false),
    ).toEqual({ type: 'navigate', direction: 'up' })
    expect(
      resolveChatListSearchKeyboardAction({ key: 'ArrowDown' } as never, false),
    ).toEqual({ type: 'navigate', direction: 'down' })
  })

  it('resolves a plain Enter to open', () => {
    expect(
      resolveChatListSearchKeyboardAction(
        {
          key: 'Enter',
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
        } as never,
        false,
      ),
    ).toEqual({ type: 'open' })
  })

  it('resolves Mod+Backspace to delete, on both mac and non-mac modifier keys', () => {
    expect(
      resolveChatListSearchKeyboardAction(
        { key: 'Backspace', metaKey: true, shiftKey: false } as never,
        true,
      ),
    ).toEqual({ type: 'delete' })
    expect(
      resolveChatListSearchKeyboardAction(
        { key: 'Backspace', ctrlKey: true, shiftKey: false } as never,
        false,
      ),
    ).toEqual({ type: 'delete' })
  })

  it('does not resolve a bare Backspace (no modifier) — normal text editing must keep working', () => {
    expect(
      resolveChatListSearchKeyboardAction(
        { key: 'Backspace', metaKey: false, ctrlKey: false } as never,
        true,
      ),
    ).toBeNull()
  })

  // 置顶键位两次换键的原因见 resolveChatListSearchKeyboardAction 头注释：
  // Mod+P 撞 Obsidian 命令面板，Mod+Shift+P 在用户系统上被 macOS 级全局
  // 快捷键吞掉（字母键事件根本进不了渲染进程），落定 Mod+Shift+S（Star）。
  it('resolves Mod+Shift+S to togglePin, case-insensitively', () => {
    expect(
      resolveChatListSearchKeyboardAction(
        { key: 's', metaKey: true, shiftKey: true } as never,
        true,
      ),
    ).toEqual({ type: 'togglePin' })
    expect(
      resolveChatListSearchKeyboardAction(
        { key: 'S', ctrlKey: true, shiftKey: true } as never,
        false,
      ),
    ).toEqual({ type: 'togglePin' })
  })

  it('does not resolve Mod+S without Shift — that combo is Obsidian’s save-file hotkey', () => {
    expect(
      resolveChatListSearchKeyboardAction(
        { key: 's', metaKey: true, shiftKey: false } as never,
        true,
      ),
    ).toBeNull()
  })

  // 改名不用 F2：Obsidian 默认热键 workspace:edit-file-title 在宿主 keymap
  // 捕获层消费 F2，事件到不了弹层；mac 媒体键布局下 F2 还需要按 Fn。见
  // resolveChatListSearchKeyboardAction 头注释的键位取舍。
  it('resolves Mod+R to rename', () => {
    expect(
      resolveChatListSearchKeyboardAction(
        { key: 'r', metaKey: true, shiftKey: false, altKey: false } as never,
        true,
      ),
    ).toEqual({ type: 'rename' })
    expect(
      resolveChatListSearchKeyboardAction(
        { key: 'R', ctrlKey: true, shiftKey: false, altKey: false } as never,
        false,
      ),
    ).toEqual({ type: 'rename' })
  })

  it('does not resolve F2 (consumed by the host workspace:edit-file-title hotkey)', () => {
    expect(
      resolveChatListSearchKeyboardAction({ key: 'F2' } as never, false),
    ).toBeNull()
  })

  it('returns null for ordinary typing keys', () => {
    expect(
      resolveChatListSearchKeyboardAction(
        { key: 'a', metaKey: false, ctrlKey: false } as never,
        false,
      ),
    ).toBeNull()
  })
})

// issue #567：删除两步确认的判定，从原先 ChatListItem 内部的
// useDeleteConfirmation 提升为纯函数——键盘 Mod+Backspace 和行内删除按钮现在
// 共用同一份状态，见 ChatHistoryList.tsx 里这个函数头注释。
describe('resolveChatListDeleteConfirmation', () => {
  it('arms when nothing is currently pending confirmation', () => {
    expect(resolveChatListDeleteConfirmation(null, 'a')).toBe('arm')
  })

  it('arms when a different row is pending confirmation (switching target does not confirm)', () => {
    expect(resolveChatListDeleteConfirmation('a', 'b')).toBe('arm')
  })

  it('confirms when the same row is pressed again', () => {
    expect(resolveChatListDeleteConfirmation('a', 'a')).toBe('confirm')
  })
})

const createFakeScope = () => {
  // Mirrors `Scope['register']` exactly: the production helpers take a
  // `{ register: Scope['register'] }`, and a narrower mock signature (one that
  // ignores the listener's arguments) is not assignable to it.
  const handlers = new Map<string, KeymapEventListener>()
  return {
    register: (
      modifiers: Modifier[] | null,
      key: string | null,
      func: KeymapEventListener,
    ): KeymapEventHandler => {
      handlers.set(`${(modifiers ?? []).join('+')}:${key}`, func)
      return {} as KeymapEventHandler
    },
    trigger(modifiers: string[], key: string) {
      const handler = handlers.get(`${modifiers.join('+')}:${key}`)
      // This suite runs on the node environment, so there is no global
      // KeyboardEvent to construct; the bindings only ever need to suppress
      // the default action.
      const event = {
        key,
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      } as unknown as KeyboardEvent
      return handler?.(event, {
        key,
        vkey: key,
        modifiers: modifiers.join('+'),
      } as KeymapContext)
    },
  }
}

describe('registerChatListPanelKeys', () => {
  const handlers = () => ({
    onEscape: jest.fn(),
    shouldIgnoreListKeys: jest.fn(() => false),
    onNavigate: jest.fn(),
    onOpen: jest.fn(),
    onDelete: jest.fn(),
    onTogglePin: jest.fn(),
    onRename: jest.fn(),
  })

  it('consumes Escape by closing the panel (or canceling edit via onEscape)', () => {
    const scope = createFakeScope()
    const h = handlers()
    registerChatListPanelKeys(scope, h)
    expect(scope.trigger([], 'Escape')).toBe(false)
    expect(h.onEscape).toHaveBeenCalledTimes(1)
  })

  it('consumes list keys and dispatches the matching action', () => {
    const scope = createFakeScope()
    const h = handlers()
    registerChatListPanelKeys(scope, h)
    expect(scope.trigger([], 'ArrowDown')).toBe(false)
    expect(h.onNavigate).toHaveBeenCalledWith('down')
    expect(scope.trigger(['Mod'], 'R')).toBe(false)
    expect(h.onRename).toHaveBeenCalledTimes(1)
    expect(scope.trigger(['Mod', 'Shift'], 'S')).toBe(false)
    expect(h.onTogglePin).toHaveBeenCalledTimes(1)
  })

  it('does not consume list keys while renaming, so the title input keeps them', () => {
    const scope = createFakeScope()
    const h = handlers()
    h.shouldIgnoreListKeys.mockReturnValue(true)
    registerChatListPanelKeys(scope, h)
    expect(scope.trigger([], 'Enter')).toBeUndefined()
    expect(h.onOpen).not.toHaveBeenCalled()
    expect(scope.trigger([], 'Escape')).toBe(false)
    expect(h.onEscape).toHaveBeenCalledTimes(1)
  })
})

describe('registerChatListMenuKeys', () => {
  it('consumes Escape by closing only the menu', () => {
    const scope = createFakeScope()
    const onEscape = jest.fn()
    const onMove = jest.fn()
    registerChatListMenuKeys(scope, { onEscape, onMove })
    expect(scope.trigger([], 'Escape')).toBe(false)
    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('moves between menu items with arrows without touching the list', () => {
    const scope = createFakeScope()
    const onEscape = jest.fn()
    const onMove = jest.fn()
    registerChatListMenuKeys(scope, { onEscape, onMove })
    expect(scope.trigger([], 'ArrowUp')).toBe(false)
    expect(onMove).toHaveBeenCalledWith('ArrowUp')
  })
})

describe('navigateContextMenu', () => {
  const button = (): HTMLButtonElement & { focus: jest.Mock } =>
    ({
      disabled: false,
      focus: jest.fn(),
    }) as unknown as HTMLButtonElement & { focus: jest.Mock }

  it('moves from the active item to the next', () => {
    const first = button()
    const second = button()
    const menu = {
      querySelectorAll: () => [first, second],
      ownerDocument: { activeElement: first },
    } as unknown as HTMLElement

    navigateContextMenu(menu, 'ArrowDown')
    expect(second.focus).toHaveBeenCalledTimes(1)
  })

  it('wraps ArrowUp from the first item to the last', () => {
    const first = button()
    const last = button()
    const menu = {
      querySelectorAll: () => [first, button(), last],
      ownerDocument: { activeElement: first },
    } as unknown as HTMLElement

    navigateContextMenu(menu, 'ArrowUp')
    expect(last.focus).toHaveBeenCalledTimes(1)
  })
})
