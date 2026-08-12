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

import {
  Children,
  type ReactElement,
  type ReactNode,
  isValidElement,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ChatConversationMetadata } from '../../database/json/chat/types'

import {
  ChatListDropdown,
  clampContextMenuPosition,
  computeMiddleTruncatedTitle,
  handlePopoverEscapeKeyDown,
  splitTitleForMiddleTruncation,
} from './ChatListDropdown'

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
  ChatListDropdown({
    chatList,
    currentConversationId: '',
    runSummariesByConversationId: new Map(),
    onSelect,
    onDelete: jest.fn(),
    onUpdateTitle: jest.fn(),
    onTogglePinned: jest.fn(),
    onRetryTitle: jest.fn(),
    onExportConversation: jest.fn(),
    children: <span>History</span>,
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

// YoloPopoverContent 是 forwardRef 组件：元素的 type 是 forwardRef 对象，内层
// 渲染函数在 .render 字段上。
const findByRenderName = (tree: ReactElement, name: string) =>
  walkElements(tree).find((element) => {
    const type = element.type as { render?: { name?: string } } | undefined
    return (
      typeof type === 'object' && type !== null && type.render?.name === name
    )
  })

// issue #567 Step 4：点击误触治理的测试需要拿到行内每个操作按钮真正的
// onClick/onMouseDown 处理函数（不能用 renderToStaticMarkup，那会丢掉函数）。
// 把 row（ChatListDropdown 传给 ChatListItem 的 props）实际调用一次，拿到
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
  const tree = ChatListDropdown({
    chatList,
    currentConversationId: '',
    runSummariesByConversationId: new Map(),
    children: <span>History</span>,
    ...mocks,
  })
  return { tree, mocks }
}

describe('ChatListDropdown', () => {
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
    expect(html).toContain('>Codex<')
    expect(html.match(/data-runtime-id=/g)).toHaveLength(2)
  })

  // issue #567 Step 3：删除图标从「更多」展开组移回常驻行内图标，顺序为
  // 改名 / 置顶 / 删除 / ⋯，不再需要先点「更多」才能看到删除。
  it('renders the delete icon inline between pin and more, always present (not gated by the more-menu toggle)', () => {
    const rows = historyRows(createTree([chat('yolo', 'Normal')]))
    expect(rows).toHaveLength(1)
    const row = rows[0]
    if (!row) throw new Error('expected a row')
    const html = renderToStaticMarkup(
      (unwrapMemoType(row.type) as (props: typeof row.props) => ReactElement)(
        row.props,
      ),
    )

    const pinIndex = html.indexOf('yolo-chat-list-pin-button')
    const deleteIndex = html.indexOf('yolo-chat-list-delete-button')
    const moreIndex = html.indexOf('yolo-chat-list-more-button')

    expect(pinIndex).toBeGreaterThan(-1)
    expect(deleteIndex).toBeGreaterThan(pinIndex)
    expect(moreIndex).toBeGreaterThan(deleteIndex)

    // 挂在展开组里时用 tabIndex={isMoreMenuOpen ? undefined : -1} 防止收起态
    // 被 Tab 到；现在常驻显示，不应该再带这个 -1（与 Pencil/Star 的可达性一致）。
    const tagStart = html.lastIndexOf('<button', deleteIndex)
    const tagEnd = html.indexOf('>', tagStart)
    const deleteButtonTag = html.slice(tagStart, tagEnd + 1)
    expect(deleteButtonTag).toContain('aria-label="Delete"')
    expect(deleteButtonTag).not.toContain('tabindex')
  })

  // issue #567 Step 4：点击误触治理。选中会话是靠 motion.li 的 onMouseDown
  // 触发的（不是 onClick），所以每个操作图标点击不得冒泡到条目本身——断言的
  // 落点是「点完操作图标之后 onSelect 没被调过」，而不是检查某个内部布尔值。
  // 覆盖面对齐任务里点名的元素：改名铅笔 / 置顶星标 / 行内删除 / ⋯ 展开条
  // 内部按钮（RetryTitle、Export）/ ⋯ 本身；右键菜单触发的 Esc 分层已经在下面
  // 的 handlePopoverEscapeKeyDown 用例里覆盖，这里不重复。
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

    it('stops mousedown at the actions container before it can reach the row', () => {
      const { rendered, mocks } = buildRow()
      const actions = findDivByClass(
        rendered,
        'yolo-chat-list-dropdown-item-actions',
      )
      expect(actions).toBeDefined()
      const stopPropagation = jest.fn()
      ;(
        actions?.props as { onMouseDown?: (e: unknown) => void } | undefined
      )?.onMouseDown?.({ stopPropagation })
      expect(stopPropagation).toHaveBeenCalledTimes(1)
      expect(mocks.onSelect).not.toHaveBeenCalled()
    })

    it('pin (star) click toggles pin, stops propagation, and never selects the row', async () => {
      const { rendered, mocks } = buildRow()
      const pinButton = findButtonByClass(rendered, 'yolo-chat-list-pin-button')
      expect(pinButton).toBeDefined()
      const stopPropagation = jest.fn()
      ;(
        pinButton?.props as { onClick?: (e: unknown) => void } | undefined
      )?.onClick?.({ stopPropagation })
      await Promise.resolve()
      expect(stopPropagation).toHaveBeenCalledTimes(1)
      expect(mocks.onTogglePinned).toHaveBeenCalledWith('yolo')
      expect(mocks.onSelect).not.toHaveBeenCalled()
    })

    it('rename (pencil) click stops propagation and never selects the row', () => {
      const { rendered, mocks } = buildRow()
      const editButton = findButtonByClass(
        rendered,
        'yolo-chat-list-dropdown-item-icon',
      )
      expect(editButton).toBeDefined()
      const stopPropagation = jest.fn()
      ;(
        editButton?.props as { onClick?: (e: unknown) => void } | undefined
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

    it('retry-title click inside the "more" strip stops propagation and never selects the row', async () => {
      const { rendered, mocks } = buildRow()
      // .yolo-chat-list-dropdown-item-icon 命中好几个按钮（改名/删除/retry/
      // export/更多都带这个类），Retry title 要按 aria-label 精确匹配。
      const retryButton = walkElements(rendered).find(
        (el) =>
          el.type === 'button' &&
          (el.props as { 'aria-label'?: string })['aria-label'] ===
            'Retry title',
      )
      expect(retryButton).toBeDefined()
      const stopPropagation = jest.fn()
      ;(
        retryButton?.props as { onClick?: (e: unknown) => void } | undefined
      )?.onClick?.({ stopPropagation })
      await Promise.resolve()
      expect(stopPropagation).toHaveBeenCalledTimes(1)
      expect(mocks.onRetryTitle).toHaveBeenCalledWith('yolo')
      expect(mocks.onSelect).not.toHaveBeenCalled()
    })

    it('export click inside the "more" strip stops propagation and never selects the row', async () => {
      const { rendered, mocks } = buildRow()
      const exportButton = walkElements(rendered).find(
        (el) =>
          el.type === 'button' &&
          (el.props as { 'aria-label'?: string })['aria-label'] ===
            'Export conversation to vault',
      )
      expect(exportButton).toBeDefined()
      const stopPropagation = jest.fn()
      ;(
        exportButton?.props as { onClick?: (e: unknown) => void } | undefined
      )?.onClick?.({ stopPropagation })
      await Promise.resolve()
      expect(stopPropagation).toHaveBeenCalledTimes(1)
      expect(mocks.onExportConversation).toHaveBeenCalledWith('yolo')
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

  // issue #567 Step 4：标题中间截断——渲染层是 ghost/overlay 结构（原理见
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
})

// issue #567 Step 3：Esc 分层。Radix Popover 的 Escape 探测挂在 document 捕获
// 阶段，比自绘 ctx-menu 冒泡阶段的 onKeyDown 更早跑完判定，菜单内部再怎么
// stopPropagation 都拦不住外层弹层一起关闭（详见 ChatListDropdown.tsx 里
// handleContextMenuKeyDown 和 handlePopoverEscapeKeyDown 边上的注释）。真正
// 能拦截的钩子是 Popover.Content 的 onEscapeKeyDown，这里直接测它的判定逻辑。
describe('handlePopoverEscapeKeyDown', () => {
  it('suppresses the popover dismissal and closes only the context menu while it is open', () => {
    const preventDefault = jest.fn()
    const closeContextMenu = jest.fn()

    handlePopoverEscapeKeyDown({ preventDefault }, true, closeContextMenu)

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(closeContextMenu).toHaveBeenCalledTimes(1)
  })

  it('lets the popover close as usual on Escape when no context menu is open', () => {
    const preventDefault = jest.fn()
    const closeContextMenu = jest.fn()

    handlePopoverEscapeKeyDown({ preventDefault }, false, closeContextMenu)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(closeContextMenu).not.toHaveBeenCalled()
  })

  it('wires the popover content onEscapeKeyDown prop so the layering fix is actually reachable', () => {
    const content = findByRenderName(
      createTree([chat('yolo', 'Normal')]),
      'YoloPopoverContent',
    )
    expect(content).toBeDefined()
    expect(typeof content?.props.onEscapeKeyDown).toBe('function')
  })

  it('wires the popover content onInteractOutside prop so clicks inside the portaled menu do not close the popover', () => {
    const content = findByRenderName(
      createTree([chat('yolo', 'Normal')]),
      'YoloPopoverContent',
    )
    expect(content).toBeDefined()
    expect(typeof content?.props.onInteractOutside).toBe('function')
  })
})

// issue #567 Step 3（追加需求）：菜单不再钳在母弹层范围内，只需不超出视口——
// 母弹层可能很窄，越靠边缘的会话右键时菜单应该允许溢出母弹层但不能越过屏幕。
// 钳制的纯计算见 ChatListDropdown.tsx 的 clampContextMenuPosition。
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

// issue #567 Step 4：弹层宽度不再钳在母容器（聊天侧边栏）宽度内，只受弹层所在
// 窗口的视口宽度约束——窄侧边栏下弹层不该跟着变窄。这条走纯 CSS
// （width: min(420px, calc(100vw - 24px))，见 popover.css
// .yolo-chat-list-dropdown-content 的注释），不是可单测的 JS 纯函数：早先的
// JS 方案（useLayoutEffect 读 window.innerWidth 后设 inline style）在真实
// Obsidian 里被 Radix Popover.Content 背后 floating-ui 的异步定位重渲染盖掉，
// 实测不可靠，改成 CSS 表达式后就不存在这个时序问题——纯 CSS 值本身没有可测的
// 分支逻辑，靠人工测试清单里的窄侧边栏/超窄窗口两项覆盖。

// issue #567 Step 4：中间截断保住尾部——分支会话的 "xxx (copy)" 后缀原先被
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

// issue #567 Step 4 追加：省略号两侧像素级贴合。text-overflow: ellipsis 只能
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
