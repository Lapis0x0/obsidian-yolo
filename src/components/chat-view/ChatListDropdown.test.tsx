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
  handlePopoverEscapeKeyDown,
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
