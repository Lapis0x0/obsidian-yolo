import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

import {
  MOTION_DURATION_ENTER_S,
  MOTION_DURATION_EXIT_S,
  MOTION_EASE_OUT_CSS,
} from '../../../styles/tokens/motion'

/** 项目卡片此刻显示成什么样：展开与否，展开时列出前几个对话 */
export type ProjectCardDisclosure = { expanded: boolean; count: number }

/** 对话行在收起时比卡片边缘先淡完 */
const ROW_FADE_OUT_MS = 100
const ROW_FADE_OUT_EASING = 'cubic-bezier(0.4, 0, 1, 1)'

const CONVERSATIONS_SELECTOR =
  ':scope > .yolo-chat-sidebar-project-conversations'
const ROW_SELECTOR =
  ':scope > li:not(.yolo-chat-sidebar-project-more-row, .yolo-chat-sidebar-project-conversations-empty)'

/**
 * 「再显示 / 收起」那一行贴着卡片底边走时的底色：卡片底色（projects.css 里
 * 展开卡片的 ::before，8% 项目色）叠在侧边栏底色上的实色，盖住它滑过的行
 */
const MORE_ROW_RIDING_BACKGROUND =
  'color-mix(in srgb, var(--yolo-project-color) 8%, var(--yolo-chat-sidebar-background))'

const moreRowOf = (card: HTMLElement): HTMLElement | null =>
  card.querySelector<HTMLElement>(
    `${CONVERSATIONS_SELECTOR} > .yolo-chat-sidebar-project-more-row`,
  )

/** 卡片的排版位置，不受 transform 影响 */
type Geometry = { top: number; height: number; outerBottom: number }

const measure = (card: HTMLElement): Geometry => {
  const marginBottom = parseFloat(
    card.ownerDocument.defaultView?.getComputedStyle(card).marginBottom ?? '0',
  )
  return {
    top: card.offsetTop,
    height: card.offsetHeight,
    outerBottom: card.offsetTop + card.offsetHeight + marginBottom,
  }
}

const conversationRows = (card: HTMLElement): HTMLElement[] => {
  const list = card.querySelector<HTMLElement>(CONVERSATIONS_SELECTOR)
  return list
    ? Array.from(list.querySelectorAll<HTMLElement>(ROW_SELECTOR))
    : []
}

/**
 * 卡片显示成 state 时的位置：临时把 DOM 改成那个样子（收起时去掉展开的
 * class、藏起对话列表；少列几个时藏起多出的行）量一次，再改回来。量完同步
 * 复原，不会画出来。
 */
const measureAs = (
  card: HTMLElement,
  state: ProjectCardDisclosure,
): Geometry => {
  const undo: (() => void)[] = []
  if (!state.expanded) {
    const list = card.querySelector<HTMLElement>(CONVERSATIONS_SELECTOR)
    if (card.classList.contains('is-expanded')) {
      card.classList.remove('is-expanded')
      undo.push(() => card.classList.add('is-expanded'))
    }
    if (list) {
      list.setCssProps({ display: 'none' })
      undo.push(() => list.setCssProps({ display: '' }))
    }
  } else {
    for (const row of conversationRows(card).slice(state.count)) {
      row.setCssProps({ display: 'none' })
      undo.push(() => row.setCssProps({ display: '' }))
    }
  }
  const geometry = measure(card)
  for (const step of undo.reverse()) step()
  return geometry
}

/** 卡片后面跟着让位的元素：同列表里后面的项目，和项目区之后的整块（对话列表） */
const followersOf = (card: HTMLElement): HTMLElement[] => {
  const followers: HTMLElement[] = []
  for (
    let next = card.nextElementSibling;
    next instanceof HTMLElement;
    next = next.nextElementSibling
  ) {
    followers.push(next)
  }
  const section = card.closest('.yolo-chat-sidebar-projects')
  for (
    let next = section?.nextElementSibling;
    next instanceof HTMLElement;
    next = next.nextElementSibling
  ) {
    followers.push(next)
  }
  return followers
}

const isGrowth = (
  from: ProjectCardDisclosure,
  to: ProjectCardDisclosure,
): boolean =>
  (!from.expanded && to.expanded) ||
  (from.expanded && to.expanded && to.count > from.count)

/**
 * 项目卡片展开、收起（以及就地「再显示」「收起」）的动画。卡片像抽屉：底边
 * 拉开或合上，对话行被底边裁出或收进，后面的内容贴着底边上下走，三者同一条
 * 曲线。
 *
 * 返回此刻该渲染的状态：变大时立即换成目标状态，渲染后再从旧的样子动画过去；
 * 变小时先保持旧的样子播完动画，再换成目标状态，对话行才有东西可以收。
 * 这里只管形状；底色跟着 target.expanded 立即换，由 CSS 过渡（见
 * projects.css 里项目条目的 ::before）。disclosing 是展开、收起动画进行中的
 * 方向，卡片据此打开底色的过渡，平时悬停仍然立即变色。
 *
 * 动画规则的两处例外：后面内容的位移用和底边同一条曲线而不是 spring，否则
 * 会和底边分开；对话行用 clip-path 裁，它只重画这张卡片、不重排。拖动放下时
 * 展开的项目不在这里动画：落位的 FLIP 已经在挪后面的内容（见
 * useSidebarConversationSort）。
 */
export function useProjectCardDisclosure(
  cardRef: RefObject<HTMLElement | null>,
  target: ProjectCardDisclosure,
): {
  display: ProjectCardDisclosure
  disclosing: 'open' | 'close' | null
} {
  const [display, setDisplay] = useState(target)
  // 展开与否一变，同一次渲染里就带上过渡的方向：底色在这次提交里换，过渡
  // 得在换之前就生效
  const [openedTo, setOpenedTo] = useState(target.expanded)
  const [disclosing, setDisclosing] = useState<'open' | 'close' | null>(null)
  if (openedTo !== target.expanded) {
    setOpenedTo(target.expanded)
    setDisclosing(target.expanded ? 'open' : 'close')
  }
  const running = useRef<Animation[]>([])
  /** 刚换成更大的状态，渲染后从它动画过来 */
  const growFrom = useRef<ProjectCardDisclosure | null>(null)

  const stop = () => {
    for (const animation of running.current) animation.cancel()
    running.current = []
  }

  useLayoutEffect(() => {
    if (
      target.expanded === display.expanded &&
      (!target.expanded || target.count === display.count)
    ) {
      return
    }
    stop()
    const card = cardRef.current
    const win = card?.ownerDocument.defaultView
    const still =
      !card ||
      !win ||
      win.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      card.closest('[data-sorting]') !== null
    if (still || isGrowth(display, target)) {
      growFrom.current = still ? null : display
      setDisplay(target)
      if (still) setDisclosing(null)
      return
    }

    // 变小：保持现在的样子，底边合上到目标的位置，播完再换成目标状态
    const from = measure(card)
    const to = measureAs(card, target)
    const radius = win.getComputedStyle(card).borderRadius
    const timing: KeyframeAnimationOptions = {
      duration: MOTION_DURATION_EXIT_S * 1000,
      easing: MOTION_EASE_OUT_CSS,
      fill: 'forwards',
    }
    const fade: KeyframeAnimationOptions = {
      duration: ROW_FADE_OUT_MS,
      easing: ROW_FADE_OUT_EASING,
      fill: 'forwards',
    }
    const edge = card.animate(
      [
        { transform: 'none', clipPath: `inset(0 0 0 0 round ${radius})` },
        {
          transform: `translateY(${to.top - from.top}px)`,
          clipPath: `inset(0 0 ${from.height - to.height}px 0 round ${radius})`,
        },
      ],
      timing,
    )
    const animations = [edge]
    for (const follower of followersOf(card)) {
      animations.push(
        follower.animate(
          [
            { transform: 'none' },
            { transform: `translateY(${to.outerBottom - from.outerBottom}px)` },
          ],
          timing,
        ),
      )
    }
    // 列表在卡片里变短时，「再显示 / 收起」那一行贴着底边往上走，不被底边
    // 先裁掉、播完再突然出现
    const moreRow = target.expanded ? moreRowOf(card) : null
    if (moreRow) {
      animations.push(
        moreRow.animate(
          [
            { transform: 'none', backgroundColor: MORE_ROW_RIDING_BACKGROUND },
            {
              transform: `translateY(${to.height - from.height}px)`,
              backgroundColor: MORE_ROW_RIDING_BACKGROUND,
            },
          ],
          timing,
        ),
      )
    }
    const leaving = target.expanded
      ? conversationRows(card).slice(target.count)
      : [card.querySelector<HTMLElement>(CONVERSATIONS_SELECTOR)]
    for (const element of leaving) {
      if (element) animations.push(element.animate({ opacity: [1, 0] }, fade))
    }
    running.current = animations
    edge.onfinish = () => {
      if (running.current !== animations) return
      flushSync(() => {
        setDisplay(target)
        setDisclosing(null)
      })
      stop()
    }
  }, [target.expanded, target.count, display, cardRef])

  // 变大之后：从旧的样子动画到现在的样子
  useLayoutEffect(() => {
    const from = growFrom.current
    growFrom.current = null
    const card = cardRef.current
    const win = card?.ownerDocument.defaultView
    if (!from || !card || !win) return
    const to = measure(card)
    const before = measureAs(card, from)
    const radius = win.getComputedStyle(card).borderRadius
    const timing: KeyframeAnimationOptions = {
      duration: MOTION_DURATION_ENTER_S * 1000,
      easing: MOTION_EASE_OUT_CSS,
    }
    const animations = [
      card.animate(
        [
          {
            transform: `translateY(${before.top - to.top}px)`,
            clipPath: `inset(0 0 ${to.height - before.height}px 0 round ${radius})`,
          },
          { transform: 'none', clipPath: `inset(0 0 0 0 round ${radius})` },
        ],
        timing,
      ),
    ]
    for (const follower of followersOf(card)) {
      animations.push(
        follower.animate(
          [
            {
              transform: `translateY(${before.outerBottom - to.outerBottom}px)`,
            },
            { transform: 'none' },
          ],
          timing,
        ),
      )
    }
    const moreRow = from.expanded ? moreRowOf(card) : null
    if (moreRow) {
      animations.push(
        moreRow.animate(
          [
            {
              transform: `translateY(${before.height - to.height}px)`,
              backgroundColor: MORE_ROW_RIDING_BACKGROUND,
            },
            { transform: 'none', backgroundColor: MORE_ROW_RIDING_BACKGROUND },
          ],
          timing,
        ),
      )
    }
    const entering = from.expanded
      ? conversationRows(card).slice(from.count)
      : [card.querySelector<HTMLElement>(CONVERSATIONS_SELECTOR)]
    for (const element of entering) {
      if (element) animations.push(element.animate({ opacity: [0, 1] }, timing))
    }
    running.current = animations
    animations[0].onfinish = () => {
      if (running.current === animations) setDisclosing(null)
    }
  }, [display, cardRef])

  useLayoutEffect(() => stop, [])

  return { display, disclosing }
}
