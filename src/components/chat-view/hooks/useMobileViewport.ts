import { Platform } from 'obsidian'
import { useLayoutEffect, useState } from 'react'

const MOBILE_KEYBOARD_MIN_INSET_PX = 80
const MOBILE_CHAT_MIN_VIEWPORT_HEIGHT = 160

export const parseCssPixelValue = (value: string): number => {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function useMobileKeyboardViewportHeight(
  containerElement: HTMLDivElement | null,
): number | null {
  const [viewportHeight, setViewportHeight] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (!Platform.isMobile) {
      setViewportHeight(null)
      return
    }

    if (!containerElement) {
      setViewportHeight(null)
      return
    }

    const ownerWindow = containerElement.ownerDocument.defaultView ?? window
    const visualViewport = ownerWindow.visualViewport
    if (!visualViewport) {
      setViewportHeight(null)
      return
    }

    let animationFrameId: number | null = null

    const publishHeight = () => {
      animationFrameId = null

      const rootStyle = ownerWindow.getComputedStyle(
        containerElement.ownerDocument.documentElement,
      )
      const keyboardHeight = parseCssPixelValue(
        rootStyle.getPropertyValue('--keyboard-height'),
      )
      const visualViewportInset = Math.max(
        0,
        ownerWindow.innerHeight -
          visualViewport.height -
          visualViewport.offsetTop,
      )
      const keyboardInset = Math.max(keyboardHeight, visualViewportInset)

      if (keyboardInset < MOBILE_KEYBOARD_MIN_INSET_PX) {
        setViewportHeight(null)
        return
      }

      const viewportBottom = Math.min(
        visualViewport.offsetTop + visualViewport.height,
        ownerWindow.innerHeight - keyboardInset,
      )
      const nextHeight = Math.floor(
        viewportBottom - containerElement.getBoundingClientRect().top,
      )

      if (nextHeight < MOBILE_CHAT_MIN_VIEWPORT_HEIGHT) {
        setViewportHeight(null)
        return
      }

      setViewportHeight((previous) =>
        previous === nextHeight ? previous : nextHeight,
      )
    }

    const schedulePublish = () => {
      if (animationFrameId !== null) {
        ownerWindow.cancelAnimationFrame(animationFrameId)
      }
      animationFrameId = ownerWindow.requestAnimationFrame(publishHeight)
    }

    schedulePublish()

    visualViewport.addEventListener('resize', schedulePublish)
    visualViewport.addEventListener('scroll', schedulePublish)
    ownerWindow.addEventListener('resize', schedulePublish)
    ownerWindow.addEventListener('orientationchange', schedulePublish)
    ownerWindow.addEventListener('focusin', schedulePublish)
    ownerWindow.addEventListener('focusout', schedulePublish)

    const rootObserver = new MutationObserver(schedulePublish)
    rootObserver.observe(containerElement.ownerDocument.documentElement, {
      attributeFilter: ['style'],
      attributes: true,
    })

    return () => {
      rootObserver.disconnect()
      visualViewport.removeEventListener('resize', schedulePublish)
      visualViewport.removeEventListener('scroll', schedulePublish)
      ownerWindow.removeEventListener('resize', schedulePublish)
      ownerWindow.removeEventListener('orientationchange', schedulePublish)
      ownerWindow.removeEventListener('focusin', schedulePublish)
      ownerWindow.removeEventListener('focusout', schedulePublish)
      if (animationFrameId !== null) {
        ownerWindow.cancelAnimationFrame(animationFrameId)
      }
    }
  }, [containerElement])

  return viewportHeight
}

export function useMobileChatViewContentClass(
  containerElement: HTMLDivElement | null,
  keyboardManaged: boolean,
): void {
  useLayoutEffect(() => {
    if (!Platform.isMobile) return

    const viewContent = containerElement?.closest('.view-content')
    if (!(viewContent instanceof HTMLElement)) return

    viewContent.classList.add('yolo-chat-view-content')
    return () => {
      viewContent.classList.remove(
        'yolo-chat-view-content',
        'yolo-chat-view-content--keyboard-managed',
      )
    }
  }, [containerElement])

  useLayoutEffect(() => {
    if (!Platform.isMobile) return

    const viewContent = containerElement?.closest('.view-content')
    if (!(viewContent instanceof HTMLElement)) return

    viewContent.classList.toggle(
      'yolo-chat-view-content--keyboard-managed',
      keyboardManaged,
    )

    return () => {
      viewContent.classList.remove('yolo-chat-view-content--keyboard-managed')
    }
  }, [containerElement, keyboardManaged])
}
