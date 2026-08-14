import * as Popover from '@radix-ui/react-popover'
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from 'framer-motion'
import {
  Check,
  Download,
  Ellipsis,
  Pencil,
  RotateCcw,
  Search,
  Star,
  Trash2,
} from 'lucide-react'
import { Platform, Scope } from 'obsidian'
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import type { AgentConversationRunSummary } from '../../core/agent/service'
import {
  type CliRuntimeId,
  getCliRuntimeDescriptor,
} from '../../core/cli-runtime'
import {
  type ChatConversationMetadata,
  getChatConversationOrigin,
} from '../../database/json/chat/types'
import { getConversationDisplayTitle } from '../../hooks/useChatHistory'
import { useChatManager } from '../../hooks/useJsonManagers'
import {
  MOTION_DURATION_EXIT_S,
  MOTION_EASE_OUT,
  MOTION_LAYOUT_SPRING,
} from '../../styles/tokens/motion'
import type { SerializedChatMessage } from '../../types/chat'
import type { ContentPart } from '../../types/llm/request'
import {
  getNodeBody,
  getNodeDocument,
  getNodeWindow,
} from '../../utils/dom/window-context'
import { YoloPopoverContent } from '../common/popover'

import {
  type ChatHistorySection,
  type ChatListOrderSnapshot,
  type TaskConversationOrigin,
  type TaskOriginFilter,
  captureChatListOrder,
  partitionChatHistory,
  sortChatListForDisplay,
} from './chat-history-list'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'

let rememberedHistorySection: ChatHistorySection = 'user'
let rememberedTaskOriginFilter: TaskOriginFilter = 'all'

function useLatestRef<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

/**
 * issue #567：Esc 改由 Obsidian keymap scope 分层消费（弹层一层、自绘右键
 * 菜单一层），不再靠 Radix 的 onEscapeKeyDown 自己数「这是第几次 Esc」。
 * Radix 的 document 捕获监听在 popout 窗口里对不上，而且和自绘菜单的开关
 * 时序叠在一起会把两次不同菜单的 Esc 算成「Esc 两次 → 关弹层」。
 *
 * 这里只做一件事：永远 preventDefault，让 Radix 不要 dismiss。真正的关闭
 * 由 panel / menu scope 的 Escape 绑定负责。
 */
export function handlePopoverEscapeKeyDown(
  event: Pick<KeyboardEvent, 'preventDefault'>,
): void {
  event.preventDefault()
}

type ChatListKeymapScope = {
  register: Scope['register']
}

export type ChatListPanelKeyHandlers = {
  /** 改名编辑态中：取消改名。否则：关闭弹层。 */
  onEscape: () => void
  /**
   * 改名输入框持有焦点时，方向键 / Enter / 快捷键必须放行给输入框，
   * 不能当成列表导航。返回 true 时对应绑定不 preventDefault。
   */
  shouldIgnoreListKeys: () => boolean
  onNavigate: (direction: 'up' | 'down') => void
  onOpen: () => void
  onDelete: () => void
  onTogglePin: () => void
  onRename: () => void
}

/**
 * 历史弹层打开期间 push 的 keymap scope。键位与
 * `resolveChatListSearchKeyboardAction` 一致，但挂在 `app.keymap` 上——
 * 主窗口 / popout 共用同一套 scope 栈，不再依赖弹层 DOM 是否收到 keydown。
 */
export function registerChatListPanelKeys(
  scope: ChatListKeymapScope,
  handlers: ChatListPanelKeyHandlers,
): void {
  const runListAction = (action: () => void): false | undefined => {
    if (handlers.shouldIgnoreListKeys()) return undefined
    action()
    return false
  }

  scope.register([], 'Escape', () => {
    handlers.onEscape()
    return false
  })
  scope.register([], 'ArrowUp', () =>
    runListAction(() => handlers.onNavigate('up')),
  )
  scope.register([], 'ArrowDown', () =>
    runListAction(() => handlers.onNavigate('down')),
  )
  scope.register([], 'Enter', () => runListAction(handlers.onOpen))
  scope.register(['Mod'], 'Backspace', () => runListAction(handlers.onDelete))
  scope.register(['Mod', 'Shift'], 'S', () =>
    runListAction(handlers.onTogglePin),
  )
  scope.register(['Mod'], 'R', () => runListAction(handlers.onRename))
}

export type ChatListMenuKeyHandlers = {
  onEscape: () => void
  onMove: (key: 'ArrowUp' | 'ArrowDown' | 'Home' | 'End') => void
}

/**
 * 自绘右键 / 长按菜单打开期间 push 的子 scope。Escape 只关菜单，不落到
 * 下面的弹层 scope——这就是「Esc 两次关弹层」在两次不同右键之间串号的根因
 * 修法。箭头在菜单项之间移动，不改列表高亮。
 */
export function registerChatListMenuKeys(
  scope: ChatListKeymapScope,
  handlers: ChatListMenuKeyHandlers,
): void {
  scope.register([], 'Escape', () => {
    handlers.onEscape()
    return false
  })
  const move = (key: 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'): false => {
    handlers.onMove(key)
    return false
  }
  scope.register([], 'ArrowUp', () => move('ArrowUp'))
  scope.register([], 'ArrowDown', () => move('ArrowDown'))
  scope.register([], 'Home', () => move('Home'))
  scope.register([], 'End', () => move('End'))
}

/**
 * 自绘菜单项的键盘移动，从原先挂在菜单 DOM 上的 onKeyDown 抽出来，改由
 * menu scope 调用。菜单本身仍要能被聚焦（打开时 focus），但按键分发不再
 * 依赖那个节点是否在 popout 里接到了 React 事件。
 */
export function navigateContextMenu(
  menu: HTMLElement,
  key: 'ArrowUp' | 'ArrowDown' | 'Home' | 'End',
): void {
  const items = Array.from(
    menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
  )
  if (items.length === 0) return
  const currentIndex = items.findIndex(
    (item) => item === menu.ownerDocument.activeElement,
  )
  let nextIndex = 0
  if (key === 'End') {
    nextIndex = items.length - 1
  } else if (key === 'ArrowUp') {
    nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1
  } else if (key === 'ArrowDown') {
    nextIndex =
      currentIndex === -1 || currentIndex === items.length - 1
        ? 0
        : currentIndex + 1
  }
  items[nextIndex]?.focus({ preventScroll: true })
}

/**
 * issue #567 Step 3（追加需求）：ctx-menu 越界钳制的纯计算，从
 * useLayoutEffect 里抽出来单独测。基准是视口（viewport），不是母弹层的
 * contentRect——菜单已经 Portal 到 <body>（见 ChatListDropdown 组件里
 * createPortal 调用旁的注释），母弹层多窄都不该反过来钳住菜单，只需不超出
 * 屏幕。anchorMode 是 openContextMenu 记录的触发方式：'anchor'（长按，没有
 * 指针坐标，锚点取卡片底部）在下方放不下时整体翻到卡片上方；'pointer'
 * （鼠标右键）保持锚在点击处，不做翻转，只做越界钳制。
 */
export function clampContextMenuPosition(params: {
  position: { top: number; left: number }
  menuSize: { width: number; height: number }
  viewport: { width: number; height: number }
  anchorMode: 'pointer' | 'anchor'
  cardTop: number | null
}): { top: number; left: number } {
  const { position, menuSize, viewport, anchorMode, cardTop } = params
  const maxLeft = Math.max(8, viewport.width - menuSize.width - 8)
  const maxTop = Math.max(8, viewport.height - menuSize.height - 8)
  let nextTop = position.top
  if (
    anchorMode === 'anchor' &&
    cardTop !== null &&
    position.top + menuSize.height > viewport.height
  ) {
    nextTop = Math.max(8, cardTop - menuSize.height - 6)
  }
  const nextLeft = Math.min(Math.max(8, position.left), maxLeft)
  nextTop = Math.min(Math.max(8, nextTop), maxTop)
  return { top: nextTop, left: nextLeft }
}

/**
 * issue #567 Step 5：↑/↓ 移动高亮的下一个索引，纯函数——panel keymap
 * scope 的 ArrowUp/ArrowDown 绑定使用。到底/到顶不回绕（clamp，不取模），
 * currentIndex 传 -1 表示还没有高亮项，从第一条开始移动。
 */
export function computeNextHighlightedIndex(
  currentIndex: number,
  direction: 'up' | 'down',
  length: number,
): number {
  if (length === 0) return -1
  const base = currentIndex < 0 ? 0 : currentIndex
  return direction === 'up'
    ? Math.max(0, base - 1)
    : Math.min(length - 1, base + 1)
}

/**
 * issue #567 Step 5：快捷键 → 动作的判定，纯函数。搜索框 onKeyDown 用它
 * 判断「这是不是已经交给 panel scope 的键」：是则放行给 keymap，不是则
 * stopPropagation，避免打字漏到宿主热键。真正执行动作的是
 * `registerChatListPanelKeys`，不再走 React 事件。
 *
 * 键位取舍（审计结论,详见计划文档 Step 5 实施备忘）：
 * - 置顶用 Mod+Shift+S（Star 助记），前两版都被推翻：最初的 Mod+P 是
 *   Obsidian「打开命令面板」默认全局热键；第二版 Mod+Shift+P 在用户系统上
 *   被 macOS 级全局快捷键吞掉（window 捕获层探针实测：修饰键 keydown 到达、
 *   字母 P 的事件根本没进渲染进程——这类系统级占用 App 层面无从拦截）。
 * - 删除用 Mod+Backspace：未发现与 Obsidian 默认热键冲突。
 * - 改名用 Mod+R，不用最初实现的 F2：F2 是 Obsidian 默认热键
 *   workspace:edit-file-title，宿主 keymap 在捕获层就把事件消费掉（实测
 *   keydown 根本到不了弹层的 React 委托层）；且 mac 默认键盘布局下 F2 是
 *   亮度键、需要按 Fn 才发得出来，双重不可用。Mod+R 在默认与自定义热键
 *   注册表中均空闲。
 */
export type ChatListSearchKeyboardAction =
  | { type: 'navigate'; direction: 'up' | 'down' }
  | { type: 'open' }
  | { type: 'delete' }
  | { type: 'togglePin' }
  | { type: 'rename' }

export function resolveChatListSearchKeyboardAction(
  event: Pick<
    KeyboardEvent,
    'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'
  >,
  isMac: boolean,
): ChatListSearchKeyboardAction | null {
  const modKey = isMac ? event.metaKey : event.ctrlKey
  if (event.key === 'ArrowUp') return { type: 'navigate', direction: 'up' }
  if (event.key === 'ArrowDown') {
    return { type: 'navigate', direction: 'down' }
  }
  if (event.key === 'Enter' && !modKey && !event.altKey) {
    return { type: 'open' }
  }
  if (modKey && !event.shiftKey && event.key === 'Backspace') {
    return { type: 'delete' }
  }
  if (modKey && event.shiftKey && event.key.toLowerCase() === 's') {
    return { type: 'togglePin' }
  }
  if (
    modKey &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'r'
  ) {
    return { type: 'rename' }
  }
  return null
}

/**
 * issue #567 Step 5：高亮行删除的两步确认判定，从原先 ChatListItem 内部的
 * useDeleteConfirmation 抽出来的纯逻辑。键盘删除快捷键（Mod+Backspace）和
 * 行内删除按钮现在必须共用同一份确认状态——不允许出现两套确认态各自数「这是
 * 第几下」，否则键盘按一下、鼠标再点一下会互相看不见对方的进度。状态本身也
 * 从 ChatListItem 提升到了 ChatListDropdown：键盘快捷键触发时事件源是搜索框，
 * 不在目标行的 DOM 内，行内 hook 拿不到。
 */
export function resolveChatListDeleteConfirmation(
  currentConfirmingId: string | null,
  conversationId: string,
): 'arm' | 'confirm' {
  return currentConfirmingId === conversationId ? 'confirm' : 'arm'
}

/**
 * issue #567 Step 4：标题从尾部截断改为中间截断，保住末尾若干个字符——分支
 * 会话常见的 "xxx (copy)" 后缀原先被尾部 ellipsis 吃掉，副本和原件在列表里
 * 分辨不出来。TITLE_TAIL_LENGTH 取 12：常见后缀 " (copy)" 是 7 个字符，留出
 * 几个字符余量避免贴边。按 code point（而非 UTF-16 code unit）切，避免劈裂
 * 中文/emoji——与 src/core/project-instructions.ts 里 truncateUtf8ToBytes 的
 * Array.from(text) 处理码点的既有写法保持一致，不引入 Intl.Segmenter 这个新
 * 依赖。
 *
 * 为什么必须测量、不能纯 CSS：任何「头段占固定盒子 + 整字截断」的布局方案，
 * 整字排布都不可能恰好填满 flex 分下来的盒子宽度，余数（最宽一个字形，CJK
 * ≈ 1em）必然留在省略号与尾段之间，正是全场最显眼的位置。原生中间截断
 * （macOS Finder）没有缝，是因为它先算好 `头…尾` 字符串再整段排版——余数
 * 落到整个标题末尾的空白里。这里照此办理：canvas measureText + 二分找最长
 * 可容纳前缀，渲染成单个文本节点。
 */
const TITLE_TAIL_LENGTH = 12
const TITLE_ELLIPSIS = '…'

export function splitTitleForMiddleTruncation(title: string): {
  head: string
  tail: string
} {
  const codePoints = Array.from(title)
  if (codePoints.length <= TITLE_TAIL_LENGTH) {
    return { head: '', tail: title }
  }
  const splitIndex = codePoints.length - TITLE_TAIL_LENGTH
  return {
    head: codePoints.slice(0, splitIndex).join(''),
    tail: codePoints.slice(splitIndex).join(''),
  }
}

/**
 * 拼出 `头部前缀…尾段` 使其宽度不超过 availableWidth。宽度随前缀码点数
 * 单调不减（trimEnd 只会持平或回退），二分成立。省略号两侧的边界空白
 * trim 掉，避免 "… 尾段" 里出现字面空格。纯函数，测量器注入，可单测。
 */
export function computeMiddleTruncatedTitle(
  title: string,
  availableWidth: number,
  measureWidth: (text: string) => number,
): string {
  if (measureWidth(title) <= availableWidth) {
    return title
  }
  const { head, tail } = splitTitleForMiddleTruncation(title)
  if (!head) {
    // 标题本身不超过尾段长度：中间截断无意义，交给容器裁切
    return title
  }
  const trimmedTail = tail.trimStart()
  const headCodePoints = Array.from(head)
  const candidate = (count: number) =>
    `${headCodePoints.slice(0, count).join('').trimEnd()}${TITLE_ELLIPSIS}${trimmedTail}`
  let low = 0
  let high = headCodePoints.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (measureWidth(candidate(mid)) <= availableWidth) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return candidate(low)
}

/** 每个 Document 一个共享的测量 canvas（popout 窗口有自己的 Document）。 */
const titleMeasurementContexts = new WeakMap<
  Document,
  CanvasRenderingContext2D
>()

function getTitleMeasurer(el: HTMLElement): ((text: string) => number) | null {
  const doc = getNodeDocument(el)
  let ctx = titleMeasurementContexts.get(doc) ?? null
  if (!ctx) {
    ctx = doc.createElement('canvas').getContext('2d')
    if (!ctx) {
      return null
    }
    titleMeasurementContexts.set(doc, ctx)
  }
  const style = getNodeWindow(el).getComputedStyle(el)
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  const context = ctx
  return (text) => context.measureText(text).width
}

/**
 * 中间截断的落地钩子。容器里放一个不可见的 ghost span（完整标题）撑出
 * 理想宽度，flex 收缩后的容器实际宽度即截断计算的可用宽度；可见文本
 * 绝对定位铺在同一个盒子上，内容变化不影响布局，不会形成测量反馈环。
 * 元素用 callback ref 接（编辑态会卸载重挂标题节点，useRef 接不到重挂），
 * 状态全部局部于 ChatListItem，不破坏其 memo 契约。
 */
function useMiddleTruncatedTitle(title: string): {
  titleTextRef: (el: HTMLSpanElement | null) => void
  truncatedTitle: string
} {
  const [el, setEl] = useState<HTMLSpanElement | null>(null)
  const [truncatedTitle, setTruncatedTitle] = useState(title)

  useEffect(() => {
    setTruncatedTitle(title)
    if (!el) {
      return
    }
    const recompute = () => {
      // 是否需要截断以 DOM 自己的溢出判定为准（ghost 撑出 scrollWidth），
      // 避免 canvas 与 DOM 排版的亚像素分歧把恰好放得下的标题误截
      if (el.scrollWidth <= el.clientWidth) {
        setTruncatedTitle(title)
        return
      }
      const measure = getTitleMeasurer(el)
      if (!measure) {
        return
      }
      // 1px 余量吸收 canvas 与 DOM 的亚像素差异，防可见文本溢出被裁边
      const available = el.getBoundingClientRect().width - 1
      setTruncatedTitle(computeMiddleTruncatedTitle(title, available, measure))
    }
    // 不手动跑首次 recompute：observe() 对已渲染元素保证补发一次初始回调，
    // 手动再跑等于所有行全都测量两遍（实测占弹层打开长任务的 ~33ms）。
    // content-visibility 跳过的视口外行初始回调可能不来，此时保持完整标题
    // （正确的兜底），滚入视口时尺寸从 0 变化、回调自然触发。
    const observer = new ResizeObserver(recompute)
    observer.observe(el)
    return () => observer.disconnect()
  }, [title, el])

  return { titleTextRef: setEl, truncatedTitle }
}

/**
 * 会话历史面板的动效令牌，与 popover.css 中 .yolo-chat-list-dropdown-content 上的
 * --yolo-chat-list-presence-* 一一对应，两处需保持一致。三层语汇与「只动 opacity
 * 和 transform」的硬规则见 tokens/motion.css 头注释。
 */
const CHAT_LIST_MOTION = {
  /** L2 退场：快速让位，注意力不该停在正在消失的东西上 */
  exit: { duration: MOTION_DURATION_EXIT_S, ease: MOTION_EASE_OUT },
  /**
   * L3 跟随：位移用 spring 而不是 tween。贝塞尔插值的是「某个值」，spring 插值的
   * 是加速度，眼睛读到的才是有质量的东西被推动。阻尼取到接近临界，几乎不回弹——
   * 列表条目回弹显得轻浮，相邻条目回弹不同步更会乱。
   */
  layout: MOTION_LAYOUT_SPRING,
} as const

// 待确认态不应无限挂着，否则下一次不经意的点击就直接删除
const DELETE_CONFIRM_TIMEOUT_MS = 3000

/**
 * 置顶重排时，被移动的那一行最多可见地走这么多行的距离。
 *
 * 置顶的目的地永远是列表第 0 位，而用户常常是滚到列表深处才置顶某一行——真实
 * 行程动辄几百像素，一路横穿整列的位移噪音远大于它携带的信息（何况目的地多半
 * 已经滚出视口，飞过去也没人看得见）。截断只砍行程长度，不改行进方向：行仍然
 * 朝它真正的新位置移动，只是从更近的地方起步。
 */
const PIN_TRAVEL_MAX_ROWS = 3

/**
 * 重排滑行时长，与 popover.css 里 `--yolo-chat-list-reorder-duration` 同一个
 * 数，两处需保持一致。JS 侧只用它判断「飞行结束」，动画本身由 CSS 过渡驱动。
 */
const CHAT_LIST_REORDER_DURATION_MS = 260

function TitleInput({
  value,
  disabled,
  onChange,
  onSubmit,
}: {
  value: string
  disabled?: boolean
  onChange: (value: string) => void
  onSubmit: (title: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.select()
      inputRef.current.scrollLeft = 0
    }
  }, [])

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      disabled={disabled}
      className="yolo-chat-list-dropdown-item-title-input"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') {
          e.stopPropagation()
        }
        if (e.key === 'Enter' && !disabled) {
          onSubmit(value)
        }
      }}
      maxLength={100}
    />
  )
}

function ChatRuntimeBadge({ runtimeId }: { runtimeId: CliRuntimeId }) {
  const { t } = useLanguage()
  const descriptor = getCliRuntimeDescriptor(runtimeId)
  const fullLabel = t(
    descriptor.labelKey,
    runtimeId === 'claude-code' ? 'Claude Code' : 'Codex',
  )

  return (
    <span
      className={`yolo-runtime-badge yolo-runtime-badge--${runtimeId}`}
      data-runtime-id={runtimeId}
      aria-label={fullLabel}
      title={fullLabel}
    >
      {descriptor.shortLabelKey ? t(descriptor.shortLabelKey, 'CC') : fullLabel}
    </span>
  )
}

/**
 * issue #567 Step 5：仿 Obsidian 快速切换器 prompt-instructions 的键位图例，
 * 静态展示、不参与列表的 content-visibility 按需渲染（渲染在 <ul> 外）。
 * 桌面端专属——`Platform.isMobile` 下没有物理键盘，图例没有意义（这里刻意用
 * isMobile 而非组件其余处用的 isMobileApp：图例要跟着「有没有键盘」的布局
 * 判断走，不是「是不是原生 App 壳」）。
 *
 * 键位符号（⌘/Ctrl/⇧/Shift/F2/↑↓/↵/⌫）视为键盘物理标注，不当作语言文本走
 * i18n——同一个惯例在所有主流软件的快捷键图例里都成立（VSCode/JetBrains/
 * Obsidian 自身的 Hotkeys 设置页都不翻译 Ctrl/Shift/F2）；图例每一项的动作
 * 描述（导航/打开/删除/置顶/改名）才是语言文本，走 i18n。
 */
function ChatListKeyboardLegend() {
  const { t } = useLanguage()
  const modLabel = Platform.isMacOS ? '⌘' : 'Ctrl+'
  const shiftLabel = Platform.isMacOS ? '⇧' : 'Shift+'
  const items: { key: string; label: string }[] = [
    {
      key: '↑↓',
      label: t('sidebar.chatList.legend.navigate', 'Navigate'),
    },
    { key: '↵', label: t('sidebar.chatList.legend.open', 'Open') },
    {
      key: `${modLabel}⌫`,
      label: t('sidebar.chatList.legend.delete', 'Delete'),
    },
    {
      key: `${modLabel}${shiftLabel}S`,
      label: t('sidebar.chatList.legend.pin', 'Pin'),
    },
    {
      key: `${modLabel}R`,
      label: t('sidebar.chatList.legend.rename', 'Rename'),
    },
  ]
  return (
    <div className="yolo-chat-list-legend" aria-hidden="true">
      {items.map((item) => (
        <span className="yolo-chat-list-legend-item" key={item.label}>
          <kbd className="yolo-chat-list-legend-key">{item.key}</kbd>
          <span className="yolo-chat-list-legend-label">{item.label}</span>
        </span>
      ))}
    </div>
  )
}

// memo 是打开面板期间的性能承重墙：流式回复让父组件按帧重渲，列表项必须在
// props 浅比较处全部拦下。契约是所有回调 props 每帧引用稳定（由 itemHandlers
// 的 useLatestRef 层保证）、数据 props 都是原始值或帧间稳定引用（runSummary
// 的 Map 只在语义事件时重建）。往这里新增 props 时不要传每次渲染新建的
// 对象/闭包，否则卡顿会无声复活。
const ChatListItem = memo(function ChatListItem({
  title,
  displayTitle,
  cliRuntimeId,
  runSummary,
  isCurrent,
  isFocused,
  shouldScrollIntoView,
  isEditing,
  isUpdatingTitle,
  isPinned,
  canPin,
  canRetryTitle,
  canExport,
  isRetrying,
  isConfirmingDelete,
  onMouseEnter,
  onMouseLeave,
  isMoreMenuOpen,
  onSelect,
  onRequestDelete,
  onTogglePinned,
  onRetryTitle,
  onExport,
  onStartEdit,
  onFinishEdit,
  onToggleMoreMenu,
  onCloseMoreMenu,
  onLongPress,
  onContextMenu,
  isContextMenuOpen,
  isMobile,
  conversationId,
  shiftY,
  isReordering,
}: {
  title: string
  displayTitle?: string
  cliRuntimeId?: CliRuntimeId
  runSummary?: AgentConversationRunSummary
  isCurrent: boolean
  isFocused: boolean
  shouldScrollIntoView: boolean
  isEditing: boolean
  isUpdatingTitle: boolean
  isPinned: boolean
  canPin: boolean
  canRetryTitle: boolean
  canExport: boolean
  isRetrying: boolean
  /** issue #567 Step 5：确认态提升到 ChatListDropdown，键盘删除快捷键和行内
   *  删除按钮共用同一份状态（见 resolveChatListDeleteConfirmation）。 */
  isConfirmingDelete: boolean
  onMouseEnter: (conversationId: string) => void
  onMouseLeave: (conversationId: string) => void
  isMoreMenuOpen: boolean
  onSelect: (conversationId: string) => void
  onRequestDelete: (conversationId: string) => void
  onTogglePinned: (conversationId: string) => void
  onRetryTitle: (conversationId: string) => void
  onExport: (conversationId: string) => void
  onStartEdit: (conversationId: string) => void
  onFinishEdit: (conversationId: string, title: string) => void
  onToggleMoreMenu: (conversationId: string) => void
  onCloseMoreMenu: (conversationId: string) => void
  onLongPress?: (conversationId: string, cardEl: HTMLElement) => void
  onContextMenu?: (
    conversationId: string,
    cardEl: HTMLElement,
    clientX: number,
    clientY: number,
  ) => void
  isContextMenuOpen?: boolean
  isMobile?: boolean
  conversationId: string
  /** FLIP 的 Invert 量：先把条目摁回重排前的位置，再由 CSS 过渡回 0 */
  shiftY: number
  /** 这一行正在置顶/取消置顶的滑行途中：期间它必须不透明并压在其余行之上 */
  isReordering: boolean
}) {
  const { t } = useLanguage()
  const moreActionsLabelId = useId()
  const itemRef = useRef<HTMLLIElement>(null)
  const pressTimerRef = useRef<number | null>(null)
  const pressStartRef = useRef<{ x: number; y: number; moved: boolean } | null>(
    null,
  )
  const [editingTitle, setEditingTitle] = useState(title)
  /**
   * 星标的 L1 回执（动画本体在 popover.css）。用瞬时态而不是直接挂在 .is-pinned
   * 上：后者会让每次打开面板时所有已置顶的行一起弹一下——回执只属于刚刚发生的
   * 那一次操作。首帧不弹同理（面板打开、列表重挂载都不是"操作"）。
   */
  const [pinPulse, setPinPulse] = useState<'pin' | 'unpin' | null>(null)
  const previousPinnedRef = useRef(isPinned)
  const resolvedTitle = displayTitle ?? title
  const { titleTextRef, truncatedTitle } =
    useMiddleTruncatedTitle(resolvedTitle)
  const reduceMotion = useReducedMotion()
  const isPresent = useIsPresent()
  const deleteActionLabel = isConfirmingDelete
    ? t('sidebar.chatList.confirmDelete', 'Click again to delete')
    : t('common.delete', 'Delete')

  const clearPress = useCallback(() => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current)
      pressTimerRef.current = null
    }
    pressStartRef.current = null
  }, [])

  useEffect(() => {
    if (isFocused && shouldScrollIntoView && itemRef.current) {
      itemRef.current.scrollIntoView({
        block: 'nearest',
      })
    }
  }, [isFocused, shouldScrollIntoView])

  useEffect(() => {
    if (isEditing) {
      setEditingTitle(title)
    }
  }, [isEditing, title])

  useEffect(() => clearPress, [clearPress])

  useEffect(() => {
    if (previousPinnedRef.current === isPinned) return
    previousPinnedRef.current = isPinned
    setPinPulse(isPinned ? 'pin' : 'unpin')
  }, [isPinned])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLLIElement>) => {
      if (!isMobile || !e.isPrimary || e.button !== 0 || isEditing) {
        return
      }
      if (e.target instanceof Element && e.target.closest('button, input')) {
        return
      }
      e.preventDefault()
      pressStartRef.current = { x: e.clientX, y: e.clientY, moved: false }
      pressTimerRef.current = window.setTimeout(() => {
        pressTimerRef.current = null
        pressStartRef.current = null
        if (itemRef.current) {
          onLongPress?.(conversationId, itemRef.current)
        }
      }, 420)
    },
    [conversationId, isEditing, isMobile, onLongPress],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLLIElement>) => {
      if (!isMobile || !pressStartRef.current) {
        return
      }
      const dx = Math.abs(e.clientX - pressStartRef.current.x)
      const dy = Math.abs(e.clientY - pressStartRef.current.y)
      if (dx > 8 || dy > 8) {
        pressStartRef.current.moved = true
        clearPress()
      }
    },
    [clearPress, isMobile],
  )

  const handlePointerUp = useCallback(() => {
    if (!isMobile) {
      return
    }
    if (pressTimerRef.current !== null) {
      clearPress()
      onSelect(conversationId)
    }
  }, [clearPress, conversationId, isMobile, onSelect])

  const handlePointerCancel = useCallback(() => {
    if (isMobile) {
      clearPress()
    }
  }, [clearPress, isMobile])

  return (
    <motion.li
      ref={itemRef}
      data-conversation-id={conversationId}
      // L2 显隐：退场切到 absolute，当帧就把空间让给后面的条目，「让位」和「补位」
      // 因此同一时刻发生，不会先淡完再跳。
      //
      // 补位刻意不用 framer-motion 的 layout：它的 projection 会逐个 measureScroll，
      // 几十条列表下这一项就吃掉 87ms（production 实测），比它替我们躲开的 height
      // reflow 贵得多。补位改由 L3 的 shiftY 手写 FLIP 完成，全列只测一次。
      exit={{ opacity: 0 }}
      style={
        isPresent
          ? shiftY
            ? { transform: `translateY(${shiftY}px)` }
            : undefined
          : { position: 'absolute', left: 0, right: 0 }
      }
      transition={reduceMotion ? { duration: 0 } : CHAT_LIST_MOTION.exit}
      tabIndex={-1}
      onMouseDown={(e) => {
        if (isMobile || e.button !== 0) {
          return
        }
        if (e.target instanceof Element && e.target.closest('button')) {
          return
        }
        onSelect(conversationId)
      }}
      onContextMenu={
        isMobile
          ? undefined
          : (e) => {
              if (
                isEditing ||
                !itemRef.current ||
                (e.target instanceof Element &&
                  e.target.closest('button, input'))
              ) {
                return
              }
              e.preventDefault()
              e.stopPropagation()
              onContextMenu?.(
                conversationId,
                itemRef.current,
                e.clientX,
                e.clientY,
              )
            }
      }
      onPointerDown={isMobile ? handlePointerDown : undefined}
      onPointerMove={isMobile ? handlePointerMove : undefined}
      onPointerUp={isMobile ? handlePointerUp : undefined}
      onPointerCancel={isMobile ? handlePointerCancel : undefined}
      onMouseEnter={() => onMouseEnter(conversationId)}
      onPointerLeave={() => {
        if (isMobile) {
          clearPress()
        }
        // 行内删除按钮常驻显示（不再依赖「更多」展开态），指针移出条目即视作
        // 「移出一段时间」的复位条件之一，另一半是超时自动复位——两者现在都在
        // ChatListDropdown 的 onMouseLeave 里完成（issue #567 Step 5：确认态
        // 提升到父组件后，行内不再持有自己的确认状态，见 resolveChatListDeleteConfirmation
        // 旁的注释）。
        onMouseLeave(conversationId)
        if (isEditing || !itemRef.current) {
          return
        }
        const activeElement = itemRef.current.ownerDocument.activeElement
        if (
          activeElement instanceof HTMLElement &&
          itemRef.current.contains(activeElement)
        ) {
          activeElement.blur()
        }
      }}
      className={`yolo-chat-list-dropdown-item${isFocused ? ' selected' : ''}${
        isContextMenuOpen ? ' is-ctx-open' : ''
      }${isReordering ? ' is-pin-moving' : ''}${
        isEditing ? ' is-editing' : ''
      }`}
      data-highlighted={isFocused ? 'true' : undefined}
    >
      {isEditing ? (
        <TitleInput
          value={editingTitle}
          disabled={isUpdatingTitle}
          onChange={setEditingTitle}
          onSubmit={(nextTitle) => onFinishEdit(conversationId, nextTitle)}
        />
      ) : (
        <div
          className={`yolo-chat-list-dropdown-item-title${
            isRetrying ? ' is-retrying' : ''
          }`}
        >
          <div className="yolo-chat-list-dropdown-item-title-group">
            {/* issue #567 Step 4：中间截断保住尾部（如分支会话的 " (copy)"
                后缀），省略号两侧像素级贴合——原理与结构见
                useMiddleTruncatedTitle。ghost 承载完整标题、不可见，负责撑出
                容器宽度；display 绝对定位铺在同一盒子上，放测量拼好的
                `头…尾` 单段文本。title 属性放完整标题，作为原生 tooltip
                （本文件里 ChatRuntimeBadge/delete 按钮已有同样用法）。 */}
            <span
              className="yolo-chat-list-dropdown-item-title-text"
              title={resolvedTitle}
              ref={titleTextRef}
            >
              <span
                className="yolo-chat-list-dropdown-item-title-ghost"
                aria-hidden="true"
              >
                {resolvedTitle}
              </span>
              <span className="yolo-chat-list-dropdown-item-title-display">
                {truncatedTitle}
              </span>
            </span>
            {cliRuntimeId ? (
              <ChatRuntimeBadge runtimeId={cliRuntimeId} />
            ) : null}
            {isCurrent ? (
              <span className="yolo-chat-list-dropdown-item-current-badge">
                {t('sidebar.chatList.current', 'Current')}
              </span>
            ) : null}
          </div>
          {runSummary?.isActive ? (
            <span
              className={`yolo-chat-list-dropdown-item-status${
                runSummary.isWaitingApproval ? ' is-waiting' : ' is-running'
              }`}
              aria-label={
                runSummary.isWaitingApproval
                  ? 'Waiting approval'
                  : 'Conversation running'
              }
            />
          ) : null}
          {isRetrying && (
            <span
              className="yolo-chat-list-dropdown-item-title-skeleton"
              aria-hidden="true"
            />
          )}
        </div>
      )}
      {/*
       * 置顶态的静息标识。星标按钮只在 hover / 键盘高亮时显形，静息态得有人
       * 把「这条被置顶了」说出来。运行中的行让位给状态点：两者都落在行尾的
       * 同一个位置上，瞬时态优先。样式与定位见 popover.css 的 .pin-marker。
       */}
      {isPinned && canPin && !isEditing && !runSummary?.isActive ? (
        <span className="yolo-chat-list-pin-marker" aria-hidden="true">
          <Star />
        </span>
      ) : null}
      <div
        className={`yolo-chat-list-dropdown-item-actions${
          isMoreMenuOpen ? ' is-more-open' : ''
        }`}
        // issue #567 Step 4：选中会话是靠 motion.li 的 onMouseDown 触发的
        // （见下方 onMouseDown 与它旁边的注释），不是 onClick——mousedown 比
        // click 先完成一整轮事件派发，下面每个操作按钮身上的 stopPropagation
        // 都只挂在 onClick 上，拦不住这条路径；li 自己虽然也用
        // e.target.closest('button') 排除按钮，但按钮之间的空隙、展开条的
        // padding 命中的不是 <button>，那条判断会失手，点击就穿透成「选中这
        // 一行」。修法是在这整个操作区的入口拦一次 mousedown，覆盖区内所有
        // 按钮和空隙，不需要逐个按钮补——单一防线，覆盖面更完整也更好维护。
        onMouseDown={(e) => e.stopPropagation()}
      >
        {isEditing ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              if (isUpdatingTitle) {
                return
              }
              onFinishEdit(conversationId, editingTitle)
            }}
            className="clickable-icon yolo-chat-list-dropdown-item-icon"
            disabled={isUpdatingTitle}
            aria-label={t('common.save', 'Save')}
          >
            <Check />
          </button>
        ) : null}
        {!isMobile ? (
          <>
            {!isEditing ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseMoreMenu(conversationId)
                  onStartEdit(conversationId)
                }}
                className="clickable-icon yolo-chat-list-dropdown-item-icon"
                aria-label={t('common.edit', 'Edit')}
              >
                <Pencil size={16} />
              </button>
            ) : null}
            {canPin ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseMoreMenu(conversationId)
                  onTogglePinned(conversationId)
                }}
                className={`clickable-icon yolo-chat-list-pin-button${
                  isPinned ? ' is-pinned' : ''
                }`}
                aria-label={
                  isPinned
                    ? t('sidebar.chatList.unpinConversation', 'Unpin')
                    : t('sidebar.chatList.pinConversation', 'Pin')
                }
                aria-pressed={isPinned}
                data-pin-pulse={pinPulse ?? undefined}
                onAnimationEnd={() => setPinPulse(null)}
              >
                <Star />
              </button>
            ) : null}
            {/* issue #567 Step 3：删除从 ⋯ 菜单/更多展开组移回常驻行内图标（改名 /
                置顶 / 删除 / ⋯），不再需要先展开才能删。issue #567 Step 5：两步
                确认状态提升到了 ChatListDropdown（onRequestDelete），行内点击
                和 Mod+Backspace 键盘快捷键走同一份状态机
                （resolveChatListDeleteConfirmation），不会各自以为自己是
                「第一下」。 */}
            {!isEditing ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onRequestDelete(conversationId)
                }}
                className={`clickable-icon yolo-chat-list-dropdown-item-icon yolo-chat-list-delete-button${
                  isConfirmingDelete ? ' is-confirming' : ''
                }`}
                aria-label={deleteActionLabel}
                title={deleteActionLabel}
              >
                <Trash2 size={16} />
              </button>
            ) : null}
            {!isEditing ? (
              <div
                className={`yolo-chat-list-inline-actions${
                  isMoreMenuOpen ? ' is-open' : ''
                }`}
                aria-hidden={isMoreMenuOpen ? undefined : 'true'}
              >
                <div className="yolo-chat-list-inline-actions-inner">
                  {canRetryTitle ? (
                    <button
                      type="button"
                      disabled={isRetrying}
                      onClick={(e) => {
                        e.stopPropagation()
                        onCloseMoreMenu(conversationId)
                        onRetryTitle(conversationId)
                      }}
                      className={`clickable-icon yolo-chat-list-dropdown-item-icon${
                        isRetrying ? ' is-pending' : ''
                      }`}
                      aria-label={t(
                        'sidebar.chatList.retryTitle',
                        'Retry title',
                      )}
                      aria-busy={isRetrying ? 'true' : undefined}
                      tabIndex={isMoreMenuOpen ? undefined : -1}
                    >
                      <RotateCcw
                        className={isRetrying ? 'yolo-spinner' : undefined}
                      />
                    </button>
                  ) : null}
                  {canExport ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onCloseMoreMenu(conversationId)
                        onExport(conversationId)
                      }}
                      className="clickable-icon yolo-chat-list-dropdown-item-icon"
                      aria-label={t(
                        'sidebar.chatList.exportConversation',
                        'Export conversation to vault',
                      )}
                      tabIndex={isMoreMenuOpen ? undefined : -1}
                    >
                      <Download size={16} />
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {!isEditing ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleMoreMenu(conversationId)
                }}
                className={`clickable-icon yolo-chat-list-dropdown-item-icon yolo-chat-list-more-button${
                  isMoreMenuOpen ? ' is-open' : ''
                }`}
                aria-labelledby={moreActionsLabelId}
                aria-expanded={isMoreMenuOpen ? 'true' : 'false'}
              >
                <Ellipsis size={16} />
                <span id={moreActionsLabelId} className="yolo-sr-only">
                  {t('sidebar.chatList.moreActions', 'More actions')}
                </span>
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </motion.li>
  )
})

function extractPromptContent(
  promptContent: string | ContentPart[] | null | undefined,
): string {
  if (!promptContent) return ''
  if (typeof promptContent === 'string') return promptContent
  return promptContent
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join(' ')
}

function extractConversationText(messages: SerializedChatMessage[]): string {
  const text = messages
    .map((message) => {
      if (message.role === 'assistant') {
        return message.content ?? ''
      }
      if (message.role === 'user') {
        const editorText = message.content
          ? editorStateToPlainText(message.content)
          : ''
        const promptText = extractPromptContent(message.promptContent)
        return `${editorText} ${promptText}`.trim()
      }
      return ''
    })
    .filter(Boolean)
    .join(' ')
  return text.toLowerCase()
}

export function ChatListDropdown({
  chatList,
  currentConversationId,
  runSummariesByConversationId,
  onSelect,
  onDelete,
  onUpdateTitle,
  onTogglePinned,
  onRetryTitle,
  onExportConversation,
  openHandleRef,
  children,
}: {
  chatList: ChatConversationMetadata[]
  currentConversationId: string
  runSummariesByConversationId: Map<string, AgentConversationRunSummary>
  onSelect: (conversationId: string) => void | Promise<void>
  onDelete: (conversationId: string) => void | Promise<void>
  onUpdateTitle: (
    conversationId: string,
    newTitle: string,
  ) => void | Promise<void>
  onTogglePinned: (conversationId: string) => void | Promise<void>
  onRetryTitle: (conversationId: string) => void | Promise<void>
  onExportConversation: (conversationId: string) => void | Promise<void>
  /**
   * issue #567 Step 2：外部（`ChatView` 的 view-header action / 命令 /
   * ⋯ 窗格菜单）需要以编程方式打开这个弹层，但它的 `open` 状态完全是本组件
   * 内部 `useState`（见 `handleOpenChange`）。没有引入受控 prop 或
   * `forwardRef`（会让 `ChatListDropdown.test.tsx` 直接函数调用组件的既有
   * 写法失效）——改为可选的一次性回调 ref：挂载后把「打开」函数写进去，
   * 供 `ChatRef.openChatHistory` 调用。
   */
  openHandleRef?: React.MutableRefObject<(() => void) | null>
  children: React.ReactNode
}) {
  const { t } = useLanguage()
  const app = useApp()
  const chatManager = useChatManager()
  const [open, setOpen] = useState(false)
  const [focusedConversationId, setFocusedConversationId] = useState<
    string | null
  >(null)
  const [scrollIntoViewConversationId, setScrollIntoViewConversationId] =
    useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeSection, setActiveSection] = useState<ChatHistorySection>(
    rememberedHistorySection,
  )
  const [taskOriginFilter, setTaskOriginFilter] = useState<TaskOriginFilter>(
    rememberedTaskOriginFilter,
  )
  const [showArchived, setShowArchived] = useState(false)
  const [isHoveringArchiveRow, setIsHoveringArchiveRow] = useState(false)
  const [updatingTitleIds, setUpdatingTitleIds] = useState<Set<string>>(
    new Set(),
  )
  const [contentMatches, setContentMatches] = useState<Set<string>>(new Set())
  const [retryingConversationIds, setRetryingConversationIds] = useState<
    Set<string>
  >(new Set())
  const [moreMenuConversationId, setMoreMenuConversationId] = useState<
    string | null
  >(null)
  const [orderSnapshot, setOrderSnapshot] =
    useState<ChatListOrderSnapshot | null>(null)
  const [pendingDeletionIds, setPendingDeletionIds] = useState<Set<string>>(
    new Set(),
  )
  const [collapse, setCollapse] = useState<{
    fromIndex: number
    distance: number
  } | null>(null)
  /**
   * 置顶/取消置顶的重排位移（FLIP 的 Invert 量）。与 collapse 同一套机制：
   * 先把所有位置变了的行摁回旧位，下一帧松手交给 CSS 过渡。区别只在受影响的
   * 范围——删除是「removedIndex 之后全部上移」，重排是「起点与终点之间的行
   * 让开一格，被移动的那一行走完全程」。
   */
  const [pinShift, setPinShift] = useState<{
    conversationId: string
    fromIndex: number
    toIndex: number
    /** 行高：被越过的行一律让开这么多 */
    distance: number
    /** 被移动行的 Invert 位移，已按 PIN_TRAVEL_MAX_ROWS 截断 */
    travel: number
    /** invert：摁回旧位的那一帧（禁用过渡）；play：松手滑行中 */
    phase: 'invert' | 'play'
  } | null>(null)
  /**
   * 等待重排的会话 id。写库是异步的，点击时列表还没换位，位移必须等到顺序
   * 真的变化的那一帧才开始——提前动就是和还停在旧位的 DOM 打架。
   */
  const pinFlightIdRef = useRef<string | null>(null)
  const previousDisplayIndexRef = useRef<Map<string, number>>(new Map())
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null)
  const [menuPosition, setMenuPosition] = useState<{
    top: number
    left: number
  } | null>(null)
  // issue #567 Step 5：删除的两步确认状态从 ChatListItem 提升上来（键盘快捷键
  // 和行内按钮共用，见 resolveChatListDeleteConfirmation 旁的注释）。只有一行
  // 能同时处于待确认态，用单个 nullable id 而不是 Set——语义上与 editingId/
  // activeMenuId 是同一类「互斥的单行瞬时态」。
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  )
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const contextMenuAnchorRef = useRef<HTMLElement | null>(null)
  const searchCacheRef = useRef<
    Map<string, { updatedAt: number; text: string }>
  >(new Map())
  const searchIdRef = useRef(0)
  // 焦点所在条目的位置，用于它被删除后把焦点继承给顶上来的那条
  const focusedIndexRef = useRef<number | null>(null)
  // confirmingDeleteId 的同步镜像：键盘快捷键处理器需要在同一次事件里立刻读到
  // 「当前是不是已经在确认这一行」，不能等下一次渲染才看到 state——两次按键
  // 之间没有渲染间隙保证。
  const confirmingDeleteIdRef = useRef<string | null>(null)
  const deleteConfirmTimerRef = useRef<number | null>(null)
  const isMobile = Platform.isMobileApp
  // CSS 侧的过渡有 tokens/motion.css 的全局兜底，这里额外用它跳过整段重排
  // FLIP：过渡被压成 0 之后，飞行态只剩「亮一下底色」的副作用，没有意义。
  const reduceMotion = useReducedMotion()

  const deleteConversation = useCallback(
    (conversationId: string) => {
      // FLIP 的 First：删掉一条，它后面的条目一律上移「这一条的高度」，位移量对所有
      // 条目相同，所以整列只需在这里测这一次——framer-motion 的 layout 之所以贵，
      // 就是因为它不知道这个前提，逐个条目去 measureScroll。
      const items = listRef.current?.querySelectorAll('[data-conversation-id]')
      const removedElement = listRef.current?.querySelector(
        `[data-conversation-id="${CSS.escape(conversationId)}"]`,
      )
      const removedIndex = items
        ? Array.prototype.indexOf.call(items, removedElement)
        : -1
      if (removedElement && removedIndex !== -1) {
        setCollapse({
          fromIndex: removedIndex,
          distance: Math.round(removedElement.getBoundingClientRect().height),
        })
      }
      setPendingDeletionIds((previous) => new Set(previous).add(conversationId))
      void Promise.resolve(onDelete(conversationId)).catch((error) => {
        console.error('Failed to delete conversation', error)
        // 没删成就把条目放回列表，不能让它凭空消失
        setPendingDeletionIds((previous) => {
          if (!previous.has(conversationId)) return previous
          const next = new Set(previous)
          next.delete(conversationId)
          return next
        })
      })
    },
    [onDelete],
  )

  // issue #567 Step 5：删除两步确认的复位（超时/移出行/切换 tab/关闭弹层都
  // 走这一个函数），对应旧 useDeleteConfirmation 里的 reset。
  const resetDeleteConfirmationState = useCallback(() => {
    if (deleteConfirmTimerRef.current !== null) {
      window.clearTimeout(deleteConfirmTimerRef.current)
      deleteConfirmTimerRef.current = null
    }
    confirmingDeleteIdRef.current = null
    setConfirmingDeleteId(null)
  }, [])

  const normalizedQuery = useMemo(
    () => searchQuery.trim().toLowerCase(),
    [searchQuery],
  )

  const userChatList = useMemo(
    () => chatList.filter((chat) => getChatConversationOrigin(chat) === 'user'),
    [chatList],
  )
  const taskChatList = useMemo(
    () => chatList.filter((chat) => getChatConversationOrigin(chat) !== 'user'),
    [chatList],
  )
  const taskOrigins = useMemo(
    () =>
      Array.from(
        new Set(
          taskChatList.map(
            (chat) => getChatConversationOrigin(chat) as TaskConversationOrigin,
          ),
        ),
      ),
    [taskChatList],
  )
  const sectionChatList = activeSection === 'user' ? userChatList : taskChatList
  const scopedChatList = useMemo(() => {
    if (activeSection === 'user') return userChatList
    if (taskOriginFilter === 'all') return taskChatList
    return taskChatList.filter(
      (chat) => getChatConversationOrigin(chat) === taskOriginFilter,
    )
  }, [activeSection, taskChatList, taskOriginFilter, userChatList])

  useEffect(() => {
    if (taskOriginFilter !== 'all' && !taskOrigins.includes(taskOriginFilter)) {
      rememberedTaskOriginFilter = 'all'
      setTaskOriginFilter('all')
    }
  }, [taskOriginFilter, taskOrigins])

  const untitledFallback = t('chat.untitledConversation', 'New chat')
  const getDisplayTitle = useCallback(
    (chat: ChatConversationMetadata) =>
      getConversationDisplayTitle(chat.title, untitledFallback),
    [untitledFallback],
  )

  const titleMatches = useMemo(() => {
    if (!normalizedQuery) return new Set<string>()
    const matches = new Set<string>()
    scopedChatList.forEach((chat) => {
      if (getDisplayTitle(chat).toLowerCase().includes(normalizedQuery)) {
        matches.add(chat.id)
      }
    })
    return matches
  }, [getDisplayTitle, normalizedQuery, scopedChatList])

  const pinnedSortedChatList = useMemo(
    () =>
      sortChatListForDisplay({
        chatList: sectionChatList,
        section: activeSection,
        orderSnapshot,
      }),
    [activeSection, orderSnapshot, sectionChatList],
  )

  const filteredChatList = useMemo(() => {
    if (!normalizedQuery) return scopedChatList
    return scopedChatList.filter(
      (chat) => titleMatches.has(chat.id) || contentMatches.has(chat.id),
    )
  }, [contentMatches, normalizedQuery, scopedChatList, titleMatches])

  const baseDisplayChatList = useMemo(() => {
    if (normalizedQuery) return filteredChatList
    return pinnedSortedChatList
  }, [filteredChatList, normalizedQuery, pinnedSortedChatList])

  const shouldUseArchive = normalizedQuery.length === 0

  const { activeChatList, archivedChatList } = useMemo(() => {
    return partitionChatHistory({
      chatList: baseDisplayChatList,
      currentConversationId,
      section: activeSection,
      originFilter: taskOriginFilter,
      useArchive: shouldUseArchive,
    })
  }, [
    activeSection,
    taskOriginFilter,
    baseDisplayChatList,
    currentConversationId,
    shouldUseArchive,
  ])

  const renderedChatList = useMemo(() => {
    const list = !shouldUseArchive
      ? activeChatList
      : showArchived
        ? [...activeChatList, ...archivedChatList]
        : activeChatList
    // 已确认删除的会话立刻退出列表，不等磁盘：真正的删除要读写文件并重建整个
    // 会话索引，等它返回再开始退场，动画就会被这段同步开销卡在头几帧上
    if (pendingDeletionIds.size === 0) return list
    return list.filter((chat) => !pendingDeletionIds.has(chat.id))
  }, [
    activeChatList,
    archivedChatList,
    pendingDeletionIds,
    shouldUseArchive,
    showArchived,
  ])

  const displayChatIndexById = useMemo(() => {
    const map = new Map<string, number>()
    renderedChatList.forEach((chat, index) => {
      map.set(chat.id, index)
    })
    return map
  }, [renderedChatList])

  /**
   * 每一行当前该被摁住的 Invert 位移。两种重排互斥（删除与置顶不会同帧发生），
   * 所以按优先级依次判定即可。
   */
  const resolveShiftY = (conversationId: string): number => {
    const index = displayChatIndexById.get(conversationId) ?? -1
    if (collapse) {
      return index >= collapse.fromIndex ? collapse.distance : 0
    }
    if (!pinShift || pinShift.phase !== 'invert') return 0
    if (conversationId === pinShift.conversationId) return pinShift.travel
    const { fromIndex, toIndex, distance } = pinShift
    // 置顶（向上走）：起点与终点之间的行整体下移一格，Invert 把它们摁回上方
    if (toIndex < fromIndex) {
      return index > toIndex && index <= fromIndex ? -distance : 0
    }
    // 取消置顶（向下走）：这段区间的行反过来上移一格
    return index >= fromIndex && index < toIndex ? distance : 0
  }

  const clearContentMatches = useCallback(() => {
    setContentMatches((prev) => (prev.size === 0 ? prev : new Set()))
  }, [])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        // 每次打开重新采样排序时间，这是列表顺序唯一的更新时机
        setOrderSnapshot(null)
        setActiveSection(rememberedHistorySection)
        setTaskOriginFilter(rememberedTaskOriginFilter)
        const nextFocusedConversationId =
          pinnedSortedChatList.find((chat) => chat.id === currentConversationId)
            ?.id ??
          pinnedSortedChatList[0]?.id ??
          null
        setFocusedConversationId(nextFocusedConversationId)
        focusedIndexRef.current = null
        setScrollIntoViewConversationId(null)
        setEditingId(null)
        setSearchQuery('')
        setShowArchived(false)
        setIsHoveringArchiveRow(false)
        setMoreMenuConversationId(null)
        setActiveMenuId(null)
        setMenuPosition(null)
        resetDeleteConfirmationState()
        setPendingDeletionIds((previous) =>
          previous.size === 0 ? previous : new Set(),
        )
        clearContentMatches()
      } else {
        setEditingId(null)
        setFocusedConversationId(null)
        setScrollIntoViewConversationId(null)
        setIsHoveringArchiveRow(false)
        setMoreMenuConversationId(null)
        setActiveMenuId(null)
        setMenuPosition(null)
        resetDeleteConfirmationState()
      }
      setOpen(nextOpen)
    },
    [
      clearContentMatches,
      currentConversationId,
      pinnedSortedChatList,
      resetDeleteConfirmationState,
    ],
  )

  useEffect(() => {
    if (!openHandleRef) return
    openHandleRef.current = () => handleOpenChange(true)
    return () => {
      if (openHandleRef.current) {
        openHandleRef.current = null
      }
    }
  }, [openHandleRef, handleOpenChange])

  // issue #567 Step 3（追加需求）：菜单不再钳在母弹层（历史弹层本身很窄）
  // 范围内，只需不超出视口。母弹层的 .yolo-popover-surface 有 overflow:hidden
  // （src/styles/popover/surface.css，所有权归该文件），菜单若继续渲染在弹层
  // DOM 内部会被物理裁剪——所以菜单改为 Portal 到 <body>（见下面 JSX 里的
  // createPortal），定位坐标系随之从"相对弹层内容"换成"相对视口"
  // （position: fixed + 视口坐标），不再需要 contentRect。
  //
  // 菜单宽度随内容自适应（popover.css 的 .yolo-chat-list-ctx-menu 从固定
  // 176px 换成 min/max 夹住的 max-content），意味着这里再也不知道菜单的真实
  // 尺寸——打开的一刻只能先给个粗略锚点，真正的越界钳制交给下面的
  // useLayoutEffect，等菜单真的挂载测出宽高后再修正一次位置，commit 之后、
  // 绘制之前完成，不会有可见的位置跳动。
  // anchorMode 记的是「有没有指针坐标」：长按（无指针）时若下方放不下要整体
  // 翻到卡片上方，鼠标右键（有指针）时保持锚在点击处，不做翻转。
  const contextMenuAnchorModeRef = useRef<'pointer' | 'anchor'>('pointer')

  const closeContextMenu = useCallback(() => {
    setActiveMenuId(null)
    setMenuPosition(null)
    // 焦点回到搜索框，而不是右键那一行。关菜单后如果 focus 停在卡片上，
    // :focus-within 会让原条目继续显示 selected，再 hover / 方向键就会出现
    // 两条同时高亮（pjeby 在 #567 里报的 phantom selection）。
    searchInputRef.current?.focus({ preventScroll: true })
  }, [])

  const openContextMenu = useCallback(
    (
      chatId: string,
      cardEl: HTMLElement,
      pointer?: { clientX: number; clientY: number },
    ) => {
      const cardRect = cardEl.getBoundingClientRect()
      // 视口坐标，不再减去弹层的 contentRect——菜单已经 Portal 到 <body>。
      const anchorLeft = pointer?.clientX ?? cardRect.left
      const anchorTop = pointer?.clientY ?? cardRect.bottom + 6
      setMoreMenuConversationId(null)
      setFocusedConversationId(chatId)
      contextMenuAnchorRef.current = cardEl
      contextMenuAnchorModeRef.current = pointer ? 'pointer' : 'anchor'
      setMenuPosition({
        top: Math.max(8, anchorTop),
        left: Math.max(8, anchorLeft),
      })
      setActiveMenuId(chatId)
    },
    [],
  )

  // 菜单挂载测出真实宽高后的越界钳制 + 翻转，纯计算见上面的
  // clampContextMenuPosition。基准是菜单所在 ownerDocument 的视口尺寸
  // （popout 窗口场景下这不是主窗口），不是母弹层的 contentRect——母弹层多
  // 窄都不该反过来钳住菜单。
  useLayoutEffect(() => {
    if (activeMenuId === null || !menuPosition) return
    const menuEl = contextMenuRef.current
    if (!menuEl) return
    const ownerWindow = getNodeWindow(menuEl)
    const menuRect = menuEl.getBoundingClientRect()
    const cardEl = contextMenuAnchorRef.current
    const next = clampContextMenuPosition({
      position: menuPosition,
      menuSize: { width: menuRect.width, height: menuRect.height },
      viewport: {
        width: ownerWindow.innerWidth,
        height: ownerWindow.innerHeight,
      },
      anchorMode: contextMenuAnchorModeRef.current,
      cardTop: cardEl ? cardEl.getBoundingClientRect().top : null,
    })
    if (next.left !== menuPosition.left || next.top !== menuPosition.top) {
      setMenuPosition(next)
    }
  }, [activeMenuId, menuPosition])

  // ChatListItem 的 memo 契约要求回调 props 每帧引用稳定，但上游传入的动作
  // props（onSelect/onDelete/…）是 ChatHeader 每次渲染新建的内联闭包。这里
  // 用 useLatestRef 承接易变引用，处理器本体只创建一次，按 conversationId
  // 路由；对本组件状态的读取一律走 ref 或函数式 setState，避免 stale closure。
  const itemActionsRef = useLatestRef({
    onSelect,
    onTogglePinned,
    onRetryTitle,
    onExportConversation,
    onUpdateTitle,
    deleteConversation,
    retryingConversationIds,
    updatingTitleIds,
  })

  const itemHandlers = useMemo(
    () => ({
      onMouseEnter: (conversationId: string) => {
        setFocusedConversationId(conversationId)
        setScrollIntoViewConversationId(null)
        setMoreMenuConversationId((prev) =>
          prev !== null && prev !== conversationId ? null : prev,
        )
      },
      onMouseLeave: (conversationId: string) => {
        setMoreMenuConversationId((prev) =>
          prev === conversationId ? null : prev,
        )
        // issue #567 Step 5：指针移出这一行是待确认态的复位条件之一（另一半是
        // 超时），确认态提升到父组件后挪到这里——只复位「正好是这一行」的确认，
        // 不影响别的行（旧的行内 useDeleteConfirmation 天然只管自己，这里用 id
        // 比对复刻同样的效果）。
        if (confirmingDeleteIdRef.current === conversationId) {
          resetDeleteConfirmationState()
        }
      },
      onSelect: (conversationId: string) => {
        void Promise.resolve(itemActionsRef.current.onSelect(conversationId))
          .then(() => {
            setOpen(false)
          })
          .catch((error) => {
            console.error('Failed to select conversation', error)
          })
      },
      // issue #567 Step 5：两步确认——沿用 resolveChatListDeleteConfirmation
      // 的判定，行内删除按钮和 Mod+Backspace 键盘快捷键都走这一个入口，共用
      // 同一份 confirmingDeleteId，不会各自以为自己是「第一下」。
      onRequestDelete: (conversationId: string) => {
        const result = resolveChatListDeleteConfirmation(
          confirmingDeleteIdRef.current,
          conversationId,
        )
        if (result === 'arm') {
          if (deleteConfirmTimerRef.current !== null) {
            window.clearTimeout(deleteConfirmTimerRef.current)
          }
          confirmingDeleteIdRef.current = conversationId
          setConfirmingDeleteId(conversationId)
          deleteConfirmTimerRef.current = window.setTimeout(
            resetDeleteConfirmationState,
            DELETE_CONFIRM_TIMEOUT_MS,
          )
          return
        }
        resetDeleteConfirmationState()
        setMoreMenuConversationId(null)
        itemActionsRef.current.deleteConversation(conversationId)
      },
      onTogglePinned: (conversationId: string) => {
        setMoreMenuConversationId(null)
        // 行内星标、Mod+Shift+S、右键菜单三个入口都走这里，重排位移因此只需
        // 在这一处挂号（真正开始位移的时机见 pinFlightIdRef 旁的 layout effect）
        pinFlightIdRef.current = conversationId
        void Promise.resolve(
          itemActionsRef.current.onTogglePinned(conversationId),
        ).catch((error) => {
          console.error('Failed to toggle pin', error)
        })
      },
      onRetryTitle: (conversationId: string) => {
        if (
          itemActionsRef.current.retryingConversationIds.has(conversationId)
        ) {
          return
        }
        const retryStartedAt = Date.now()
        setRetryingConversationIds((prev) => new Set(prev).add(conversationId))
        void Promise.resolve(
          itemActionsRef.current.onRetryTitle(conversationId),
        )
          .catch((error) => {
            console.error(
              'Failed to retry conversation title generation',
              error,
            )
          })
          .finally(() => {
            const elapsed = Date.now() - retryStartedAt
            const remaining = Math.max(0, 320 - elapsed)
            window.setTimeout(() => {
              setRetryingConversationIds((prev) => {
                if (!prev.has(conversationId)) {
                  return prev
                }
                const next = new Set(prev)
                next.delete(conversationId)
                return next
              })
            }, remaining)
          })
      },
      onExport: (conversationId: string) => {
        setMoreMenuConversationId(null)
        void Promise.resolve(
          itemActionsRef.current.onExportConversation(conversationId),
        ).catch((error) => {
          console.error('Failed to export conversation', error)
        })
      },
      onStartEdit: (conversationId: string) => {
        setMoreMenuConversationId(null)
        setEditingId(conversationId)
      },
      onFinishEdit: (conversationId: string, title: string) => {
        if (itemActionsRef.current.updatingTitleIds.has(conversationId)) {
          return
        }
        setUpdatingTitleIds((prev) => new Set(prev).add(conversationId))
        void Promise.resolve(
          itemActionsRef.current.onUpdateTitle(conversationId, title),
        )
          .then(() => {
            setEditingId(null)
            // issue #567 Step 5：提交改名后把焦点送回搜索框，键盘链路（↑↓/
            // Enter/快捷键）不因为改名而在 <body> 上断掉——与 Esc 取消改名
            // 走的是同一个「焦点回搜索框」终点。
            searchInputRef.current?.focus({ preventScroll: true })
          })
          .catch((error) => {
            console.error('Failed to update conversation title', error)
          })
          .finally(() => {
            setUpdatingTitleIds((prev) => {
              if (!prev.has(conversationId)) {
                return prev
              }
              const next = new Set(prev)
              next.delete(conversationId)
              return next
            })
          })
      },
      onToggleMoreMenu: (conversationId: string) => {
        setMoreMenuConversationId((prev) =>
          prev === conversationId ? null : conversationId,
        )
      },
      onCloseMoreMenu: (conversationId: string) => {
        setMoreMenuConversationId((prev) =>
          prev === conversationId ? null : prev,
        )
      },
      onLongPress: (conversationId: string, cardEl: HTMLElement) => {
        if (!Platform.isMobileApp) {
          return
        }
        openContextMenu(conversationId, cardEl)
      },
      onContextMenu: (
        conversationId: string,
        cardEl: HTMLElement,
        clientX: number,
        clientY: number,
      ) => {
        if (Platform.isMobileApp) {
          return
        }
        openContextMenu(conversationId, cardEl, { clientX, clientY })
      },
    }),
    [itemActionsRef, openContextMenu, resetDeleteConfirmationState],
  )

  useEffect(() => {
    if (activeMenuId !== null) {
      contextMenuRef.current?.focus({ preventScroll: true })
    }
  }, [activeMenuId])

  // 面板打开期间新出现的会话补录一次排序时间，之后它同样不再随运行状态换位
  useEffect(() => {
    if (!open) return
    setOrderSnapshot((previous) => captureChatListOrder(chatList, previous))
  }, [chatList, open])

  // FLIP 的 Play：条目已经被摁回删除前的位置（Invert），下一帧松手，交给 CSS 过渡
  // 平移回 0。全程只动 transform，不触发 layout。
  useEffect(() => {
    if (!collapse) return
    const frame = window.requestAnimationFrame(() => setCollapse(null))
    return () => window.cancelAnimationFrame(frame)
  }, [collapse])

  /**
   * 置顶重排的 FLIP 的 First+Invert：顺序真的变了的那一帧才动手。
   * 在 layout effect 里 setState 会在浏览器绘制前同步补一次渲染，所以「换位」
   * 和「摁回旧位」落在同一帧里，看不到中间态。
   *
   * 行高对全列一致（列表行是单行定高，见 popover.css 的 contain-intrinsic-size），
   * 所以这里只量被移动的那一行——与删除同一个前提，全列仍然只测一次。
   */
  useLayoutEffect(() => {
    const previousIndexById = previousDisplayIndexRef.current
    previousDisplayIndexRef.current = displayChatIndexById
    const conversationId = pinFlightIdRef.current
    if (!conversationId) return
    // 一次性：无论这次列表变化是不是那次置顶带来的，都把挂号销掉，避免过期的
    // 挂号在之后某次无关的重排上放出一段莫名其妙的位移。
    pinFlightIdRef.current = null
    if (reduceMotion) return
    const fromIndex = previousIndexById.get(conversationId)
    const toIndex = displayChatIndexById.get(conversationId)
    if (fromIndex === undefined || toIndex === undefined) return
    if (fromIndex === toIndex) return
    const movedElement = listRef.current?.querySelector(
      `[data-conversation-id="${CSS.escape(conversationId)}"]`,
    )
    const distance = movedElement
      ? Math.round(movedElement.getBoundingClientRect().height)
      : 0
    if (distance === 0) return
    const travel = (fromIndex - toIndex) * distance
    const limit = PIN_TRAVEL_MAX_ROWS * distance
    setPinShift({
      conversationId,
      fromIndex,
      toIndex,
      distance,
      travel: Math.sign(travel) * Math.min(Math.abs(travel), limit),
      phase: 'invert',
    })
  }, [displayChatIndexById, reduceMotion])

  /**
   * 置顶重排 FLIP 的 Play：下一帧松手（与 collapse 的松手同理），再等滑行结束
   * 才收摊——「飞行中」这个状态要一直挂到落位，被移动的行靠它保持不透明，否则
   * 它和被越过的行会在交错的那一瞬互相透出成重影。
   */
  useEffect(() => {
    if (!pinShift) return
    if (pinShift.phase === 'invert') {
      const frame = window.requestAnimationFrame(() =>
        setPinShift((previous) =>
          previous && previous.phase === 'invert'
            ? { ...previous, phase: 'play' }
            : previous,
        ),
      )
      return () => window.cancelAnimationFrame(frame)
    }
    const timer = window.setTimeout(
      () => setPinShift(null),
      CHAT_LIST_REORDER_DURATION_MS,
    )
    return () => window.clearTimeout(timer)
  }, [pinShift])

  // 磁盘上真的删掉之后，乐观移除的记录就没用了
  useEffect(() => {
    setPendingDeletionIds((previous) => {
      if (previous.size === 0) return previous
      let next = previous
      previous.forEach((id) => {
        if (chatList.some((chat) => chat.id === id)) return
        next = next === previous ? new Set(previous) : next
        next.delete(id)
      })
      return next
    })
  }, [chatList])

  useEffect(() => {
    if (!open) return
    if (renderedChatList.length === 0) {
      setFocusedConversationId(null)
      focusedIndexRef.current = null
      return
    }

    const currentFocusedIndex =
      focusedConversationId === null
        ? undefined
        : displayChatIndexById.get(focusedConversationId)
    if (currentFocusedIndex !== undefined) {
      focusedIndexRef.current = currentFocusedIndex
      return
    }

    if (!normalizedQuery) {
      // 焦点所在的会话消失了，通常是刚被删除。把焦点交给顶上来占据同一位置的
      // 那条，视线锚点才是连续的，也才能接着删下一条；否则焦点会跳去当前会话，
      // 而指针仍停在原处——鼠标没移动时浏览器不会补发 mouseenter，错位会一直挂着。
      const inheritedIndex = focusedIndexRef.current
      if (inheritedIndex !== null) {
        setFocusedConversationId(
          renderedChatList[
            Math.min(inheritedIndex, renderedChatList.length - 1)
          ]?.id ?? null,
        )
        setScrollIntoViewConversationId(null)
        return
      }
      setFocusedConversationId(
        displayChatIndexById.has(currentConversationId)
          ? currentConversationId
          : (renderedChatList[0]?.id ?? null),
      )
      setScrollIntoViewConversationId(null)
      return
    }

    // 搜索期间列表是整体换掉的，沿用旧索引没有意义，回到第一条结果
    setFocusedConversationId(renderedChatList[0]?.id ?? null)
    setScrollIntoViewConversationId(null)
  }, [
    currentConversationId,
    displayChatIndexById,
    focusedConversationId,
    normalizedQuery,
    open,
    renderedChatList,
  ])

  useEffect(() => {
    if (!open) return
    if (!normalizedQuery) {
      clearContentMatches()
      return
    }

    const currentSearchId = searchIdRef.current + 1
    searchIdRef.current = currentSearchId
    const timeoutId = window.setTimeout(() => {
      void (async () => {
        const nextMatches = new Set<string>()
        for (const chat of scopedChatList) {
          if (titleMatches.has(chat.id)) continue
          const cached = searchCacheRef.current.get(chat.id)
          if (cached && cached.updatedAt === chat.updatedAt) {
            if (cached.text.includes(normalizedQuery)) {
              nextMatches.add(chat.id)
            }
            continue
          }
          const conversation = await chatManager.findById(chat.id)
          if (!conversation) continue
          const text = extractConversationText(conversation.messages)
          searchCacheRef.current.set(chat.id, {
            updatedAt: chat.updatedAt,
            text,
          })
          if (text.includes(normalizedQuery)) {
            nextMatches.add(chat.id)
          }
          if (searchIdRef.current !== currentSearchId) {
            return
          }
        }
        if (searchIdRef.current === currentSearchId) {
          setContentMatches(nextMatches)
        }
      })()
    }, 160)

    return () => {
      window.clearTimeout(timeoutId)
      searchIdRef.current += 1
    }
  }, [
    chatManager,
    clearContentMatches,
    normalizedQuery,
    open,
    scopedChatList,
    titleMatches,
  ])

  const focusedIndex = useMemo(
    () =>
      focusedConversationId === null
        ? -1
        : (displayChatIndexById.get(focusedConversationId) ?? -1),
    [displayChatIndexById, focusedConversationId],
  )

  const activeMenuChat = useMemo(
    () => renderedChatList.find((chat) => chat.id === activeMenuId) ?? null,
    [activeMenuId, renderedChatList],
  )

  // issue #567：F2 改名走 editingId（与鼠标点铅笔同一条路径），取消用 Esc
  // （panel scope 的 Escape 绑定）、提交用 Enter（TitleInput 自带）——两条
  // 退出路径都要把焦点送回搜索框。
  const cancelEdit = useCallback(() => {
    setEditingId(null)
    searchInputRef.current?.focus({ preventScroll: true })
  }, [])

  const panelKeyHandlersRef = useLatestRef({
    onEscape: () => {
      if (editingId !== null) {
        cancelEdit()
        return
      }
      handleOpenChange(false)
    },
    shouldIgnoreListKeys: () => editingId !== null,
    onNavigate: (direction: 'up' | 'down') => {
      if (renderedChatList.length === 0) return
      const nextIndex = computeNextHighlightedIndex(
        focusedIndex,
        direction,
        renderedChatList.length,
      )
      const nextConversationId = renderedChatList[nextIndex]?.id ?? null
      setFocusedConversationId(nextConversationId)
      setScrollIntoViewConversationId(nextConversationId)
    },
    onOpen: () => {
      const conversationId = focusedConversationId ?? renderedChatList[0]?.id
      if (!conversationId) return
      void Promise.resolve(onSelect(conversationId))
        .then(() => {
          handleOpenChange(false)
        })
        .catch((error) => {
          console.error('Failed to select conversation from list', error)
        })
    },
    onDelete: () => {
      if (!focusedConversationId) return
      itemHandlers.onRequestDelete(focusedConversationId)
    },
    onTogglePin: () => {
      if (!focusedConversationId || activeSection !== 'user') return
      itemHandlers.onTogglePinned(focusedConversationId)
    },
    onRename: () => {
      if (!focusedConversationId) return
      itemHandlers.onStartEdit(focusedConversationId)
    },
  })

  const panelScopeRef = useRef<Scope | null>(null)

  // 弹层打开期间把快捷键挂到 Obsidian keymap scope 上，而不是搜索框的
  // React onKeyDown。popout 窗口里宿主会在捕获层消费 Ctrl/Cmd 组合键，
  // DOM 监听根本收不到；scope 跨窗口有效（issue #567，pjeby）。
  useEffect(() => {
    if (!open) return
    const panelScope = new Scope(app.keymap.scope)
    registerChatListPanelKeys(panelScope, {
      onEscape: () => panelKeyHandlersRef.current.onEscape(),
      shouldIgnoreListKeys: () =>
        panelKeyHandlersRef.current.shouldIgnoreListKeys(),
      onNavigate: (direction) =>
        panelKeyHandlersRef.current.onNavigate(direction),
      onOpen: () => panelKeyHandlersRef.current.onOpen(),
      onDelete: () => panelKeyHandlersRef.current.onDelete(),
      onTogglePin: () => panelKeyHandlersRef.current.onTogglePin(),
      onRename: () => panelKeyHandlersRef.current.onRename(),
    })
    app.keymap.pushScope(panelScope)
    panelScopeRef.current = panelScope
    return () => {
      app.keymap.popScope(panelScope)
      if (panelScopeRef.current === panelScope) {
        panelScopeRef.current = null
      }
    }
  }, [app, open, panelKeyHandlersRef])

  // 自绘右键/长按菜单是独立的一层 scope：Esc 只关菜单。父 scope 是上面
  // 刚 push 的弹层 scope，菜单关掉后自动回到弹层那一层。
  useEffect(() => {
    if (activeMenuId === null) return
    const menuScope = new Scope(panelScopeRef.current ?? app.keymap.scope)
    registerChatListMenuKeys(menuScope, {
      onEscape: closeContextMenu,
      onMove: (key) => {
        const menu = contextMenuRef.current
        if (!menu) return
        navigateContextMenu(menu, key)
      },
    })
    app.keymap.pushScope(menuScope)
    return () => {
      app.keymap.popScope(menuScope)
    }
  }, [activeMenuId, app, closeContextMenu])

  // 搜索框只拦「未注册给 scope 的键」的冒泡，避免打字漏到宿主热键。
  // 已注册的快捷键（含 Escape）不 stopPropagation，让 keymap 能在捕获/
  // 冒泡阶段收到。动作本身由 panel scope 执行，这里不再 dispatch，否则
  // 主窗口会触发两次。
  const handleSearchInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') return
      if (resolveChatListSearchKeyboardAction(e, Platform.isMacOS)) return
      e.stopPropagation()
    },
    [],
  )

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          ref={triggerRef}
          className="clickable-icon"
          aria-label={t('sidebar.chatList.openHistory', 'Chat history')}
        >
          {children}
        </button>
      </Popover.Trigger>

      <YoloPopoverContent
        anchorRef={triggerRef}
        variant="default"
        minWidth={280}
        maxHeight={400}
        className="yolo-chat-list-dropdown-content"
        sideOffset={8}
        onEscapeKeyDown={handlePopoverEscapeKeyDown}
        // issue #567 Step 3（追加需求）：ctx-menu 现在 createPortal 到
        // <body>，DOM 上不再是这个 Popover.Content 的后代。Radix 的
        // outside-interaction 探测（pointerdown-outside / focus-outside，见
        // usePointerDownOutside / useFocusOutside）按 DOM 包含关系判断，会把
        // 点击/聚焦菜单本身判成"在弹层外"，从而连累整个历史弹层一起关闭。
        // onInteractOutside 是 Radix 提供的、专门拦这类误判的钩子（在内部
        // dismiss 判定之前调用，preventDefault 即可让这次交互不触发关闭）：
        // 命中目标在菜单 DOM 内就拦下，其余情况放行、按 Radix 默认行为处理。
        onInteractOutside={(e) => {
          const target = e.detail.originalEvent.target
          if (
            target instanceof Node &&
            contextMenuRef.current?.contains(target)
          ) {
            e.preventDefault()
          }
        }}
      >
        <div className="yolo-chat-list-search">
          <div className="yolo-chat-list-search-field">
            <Search size={13} className="yolo-chat-list-search-icon" />
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              placeholder={t(
                'sidebar.chatList.searchPlaceholder',
                'Search conversations',
              )}
              aria-label={t(
                'sidebar.chatList.searchPlaceholder',
                'Search conversations',
              )}
              className="yolo-chat-list-search-input"
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchInputKeyDown}
            />
          </div>
        </div>
        <div
          className="yolo-chat-list-section-tabs"
          role="group"
          aria-label={t(
            'sidebar.chatList.historySections',
            'Conversation categories',
          )}
        >
          <button
            type="button"
            aria-pressed={activeSection === 'user'}
            className={`yolo-chat-list-section-tab${
              activeSection === 'user' ? ' is-active' : ''
            }`}
            onClick={() => {
              rememberedHistorySection = 'user'
              setActiveSection('user')
              setShowArchived(false)
              setMoreMenuConversationId(null)
              setActiveMenuId(null)
              setMenuPosition(null)
              resetDeleteConfirmationState()
            }}
          >
            <span>
              {t('sidebar.chatList.myConversations', 'My conversations')}
            </span>
            <span className="yolo-chat-list-section-count">
              {userChatList.length}
            </span>
          </button>
          <button
            type="button"
            aria-pressed={activeSection === 'task'}
            className={`yolo-chat-list-section-tab${
              activeSection === 'task' ? ' is-active' : ''
            }`}
            onClick={() => {
              rememberedHistorySection = 'task'
              setActiveSection('task')
              setShowArchived(false)
              setMoreMenuConversationId(null)
              setActiveMenuId(null)
              setMenuPosition(null)
              resetDeleteConfirmationState()
            }}
          >
            <span>
              {t('sidebar.chatList.taskConversations', 'Task conversations')}
            </span>
            <span className="yolo-chat-list-section-count">
              {taskChatList.length}
            </span>
          </button>
        </div>
        {activeSection === 'task' && taskOrigins.length > 1 ? (
          <div
            className="yolo-chat-list-origin-filters"
            aria-label={t(
              'sidebar.chatList.taskConversationSources',
              'Task conversation sources',
            )}
          >
            <button
              type="button"
              className={`yolo-chat-list-origin-filter${
                taskOriginFilter === 'all' ? ' is-active' : ''
              }`}
              aria-pressed={taskOriginFilter === 'all'}
              onClick={() => {
                rememberedTaskOriginFilter = 'all'
                setTaskOriginFilter('all')
                setShowArchived(false)
              }}
            >
              {t('sidebar.chatList.allSources', 'All')}
            </button>
            {taskOrigins.map((origin) => (
              <button
                key={origin}
                type="button"
                className={`yolo-chat-list-origin-filter${
                  taskOriginFilter === origin ? ' is-active' : ''
                }`}
                aria-pressed={taskOriginFilter === origin}
                onClick={() => {
                  rememberedTaskOriginFilter = origin
                  setTaskOriginFilter(origin)
                  setShowArchived(false)
                }}
              >
                {origin === 'external-agent'
                  ? t('sidebar.chatList.externalAgent', 'External Agent')
                  : origin}
              </button>
            ))}
          </div>
        ) : null}
        <ul
          ref={listRef}
          className={`yolo-model-select-list${collapse ? ' is-collapsing' : ''}${
            pinShift?.phase === 'invert' ? ' is-reordering' : ''
          }`}
          onPointerDownCapture={(e) => {
            if (activeMenuId === null) {
              return
            }
            if (
              e.target instanceof Element &&
              e.target.closest('.yolo-chat-list-ctx-menu')
            ) {
              return
            }
            setActiveMenuId(null)
            setMenuPosition(null)
          }}
          onScroll={() => {
            setActiveMenuId(null)
            setMenuPosition(null)
          }}
        >
          {scopedChatList.length === 0 ? (
            <li className="yolo-chat-list-dropdown-empty">
              {activeSection === 'user'
                ? t('sidebar.chatList.empty', 'No conversations')
                : t(
                    'sidebar.chatList.noTaskConversations',
                    'No task conversations',
                  )}
            </li>
          ) : filteredChatList.length === 0 ? (
            <li className="yolo-chat-list-dropdown-empty">
              {t('common.noResults', 'No matches found')}
            </li>
          ) : (
            <>
              {/* initial={false} 让面板打开时条目直接就位，只有删除才播放退场 */}
              {/* presenceAffectsLayout={false}：默认 true 时 AnimatePresence 每次
                  重渲都发布新的 presence context，所有 motion 条目被 context 强制
                  重渲，ChatListItem 的 memo 形同虚设——流式回复期间面板就会退回
                  每帧全量重渲。该开关只服务于 framer 的 layout 动画（退场时让兄弟
                  条目重测布局），本列表的补位是手写 FLIP（shiftY），不依赖它。 */}
              <AnimatePresence initial={false} presenceAffectsLayout={false}>
                {renderedChatList.map((chat) => (
                  <ChatListItem
                    key={chat.id}
                    title={chat.title}
                    displayTitle={getDisplayTitle(chat)}
                    cliRuntimeId={chat.cliSession?.runtimeId}
                    runSummary={runSummariesByConversationId.get(chat.id)}
                    isCurrent={chat.id === currentConversationId}
                    isFocused={
                      focusedConversationId === chat.id &&
                      !isHoveringArchiveRow &&
                      activeMenuId === null
                    }
                    shouldScrollIntoView={
                      scrollIntoViewConversationId === chat.id
                    }
                    isEditing={editingId === chat.id}
                    isUpdatingTitle={updatingTitleIds.has(chat.id)}
                    isPinned={Boolean(chat.isPinned)}
                    canPin={activeSection === 'user'}
                    canRetryTitle={!chat.cliSession}
                    canExport={!chat.cliSession}
                    isRetrying={retryingConversationIds.has(chat.id)}
                    isConfirmingDelete={confirmingDeleteId === chat.id}
                    isMoreMenuOpen={moreMenuConversationId === chat.id}
                    isContextMenuOpen={activeMenuId === chat.id}
                    isMobile={isMobile}
                    conversationId={chat.id}
                    shiftY={resolveShiftY(chat.id)}
                    isReordering={pinShift?.conversationId === chat.id}
                    onMouseEnter={itemHandlers.onMouseEnter}
                    onMouseLeave={itemHandlers.onMouseLeave}
                    onSelect={itemHandlers.onSelect}
                    onRequestDelete={itemHandlers.onRequestDelete}
                    onRetryTitle={itemHandlers.onRetryTitle}
                    onTogglePinned={itemHandlers.onTogglePinned}
                    onExport={itemHandlers.onExport}
                    onStartEdit={itemHandlers.onStartEdit}
                    onFinishEdit={itemHandlers.onFinishEdit}
                    onToggleMoreMenu={itemHandlers.onToggleMoreMenu}
                    onCloseMoreMenu={itemHandlers.onCloseMoreMenu}
                    onLongPress={itemHandlers.onLongPress}
                    onContextMenu={itemHandlers.onContextMenu}
                  />
                ))}
              </AnimatePresence>
              {shouldUseArchive && archivedChatList.length > 0 && (
                <li
                  className="yolo-chat-list-dropdown-archive-row"
                  onMouseEnter={() => {
                    setIsHoveringArchiveRow(true)
                  }}
                  onMouseLeave={() => {
                    setIsHoveringArchiveRow(false)
                  }}
                >
                  <button
                    type="button"
                    className="yolo-chat-list-dropdown-archive-toggle"
                    onClick={() => {
                      setShowArchived((prev) => !prev)
                    }}
                  >
                    <span className="yolo-chat-list-dropdown-archive-toggle-label">
                      {showArchived
                        ? t('sidebar.chatList.hideArchived', 'Hide archived')
                        : `${t('sidebar.chatList.archived', 'Archived')} (${archivedChatList.length})`}
                    </span>
                  </button>
                </li>
              )}
            </>
          )}
        </ul>
        {!Platform.isMobile ? <ChatListKeyboardLegend /> : null}
        {activeMenuChat && menuPosition
          ? createPortal(
              // issue #567 Step 3（追加需求）：Portal 到 <body>，逃出母弹层
              // .yolo-popover-surface 的 overflow:hidden 裁剪（所有权归
              // src/styles/popover/surface.css，本次未改那条规则）。定位坐标
              // 系见 openContextMenu / 下面 useLayoutEffect 顶部注释；
              // onInteractOutside（挂在 YoloPopoverContent 上）负责防止点击
              // 这个已经不在弹层 DOM 内的菜单被 Radix 误判成"点击外部"从而
              // 连累整个历史弹层关闭。
              <div
                ref={contextMenuRef}
                className="yolo-chat-list-ctx-menu is-open"
                style={{ top: menuPosition.top, left: menuPosition.left }}
                role="menu"
                tabIndex={-1}
                aria-label={t('sidebar.chatList.moreActions', 'More actions')}
              >
                {activeSection === 'user' ? (
                  <button
                    type="button"
                    role="menuitem"
                    data-act="pin"
                    onClick={(e) => {
                      e.stopPropagation()
                      setActiveMenuId(null)
                      setMenuPosition(null)
                      // 走 itemHandlers 这一个入口（原先在这里重复了一遍
                      // 置顶逻辑）：重排位移的挂号只在那里做，菜单不能绕过。
                      itemHandlers.onTogglePinned(activeMenuChat.id)
                    }}
                  >
                    <Star size={16} />
                    <span>
                      {activeMenuChat.isPinned
                        ? t('sidebar.chatList.unpinConversation', 'Unpin')
                        : t('sidebar.chatList.pinConversation', 'Pin')}
                    </span>
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  data-act="rename"
                  onClick={(e) => {
                    e.stopPropagation()
                    setActiveMenuId(null)
                    setMenuPosition(null)
                    setMoreMenuConversationId(null)
                    setEditingId(activeMenuChat.id)
                  }}
                >
                  <Pencil size={16} />
                  <span>{t('common.edit', 'Edit')}</span>
                </button>
                {!activeMenuChat.cliSession ? (
                  <button
                    type="button"
                    role="menuitem"
                    data-act="retitle"
                    disabled={retryingConversationIds.has(activeMenuChat.id)}
                    onClick={(e) => {
                      e.stopPropagation()
                      setActiveMenuId(null)
                      setMenuPosition(null)
                      itemHandlers.onRetryTitle(activeMenuChat.id)
                    }}
                  >
                    <RotateCcw size={16} />
                    <span>
                      {t('sidebar.chatList.retryTitle', 'Retry title')}
                    </span>
                  </button>
                ) : null}
                {!activeMenuChat.cliSession ? (
                  <button
                    type="button"
                    role="menuitem"
                    data-act="export"
                    onClick={(e) => {
                      e.stopPropagation()
                      setActiveMenuId(null)
                      setMenuPosition(null)
                      setMoreMenuConversationId(null)
                      void Promise.resolve(
                        onExportConversation(activeMenuChat.id),
                      ).catch((error) => {
                        console.error('Failed to export conversation', error)
                      })
                    }}
                  >
                    <Download size={16} />
                    <span>{t('sidebar.chatList.exportShort', 'Export')}</span>
                  </button>
                ) : null}
              </div>,
              getNodeBody(triggerRef.current),
            )
          : null}
      </YoloPopoverContent>
    </Popover.Root>
  )
}
