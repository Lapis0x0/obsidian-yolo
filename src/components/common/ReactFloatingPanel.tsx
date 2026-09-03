import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Root, createRoot } from 'react-dom/client'

import { LanguageProvider } from '../../contexts/language-context'
import { PluginProvider } from '../../contexts/plugin-context'
import type YoloPlugin from '../../main'

export type FloatingPanelOptions = {
  title?: string
  initialPosition?: { x: number; y: number }
  width?: number
  height?: number
  closeOnEscape?: boolean
  closeOnOutsideClick?: boolean
  minimal?: boolean
}

type FloatingPanelProps<T extends Record<string, unknown>> = {
  Component: React.ComponentType<T & { onClose: () => void }>
  props: T
  plugin?: YoloPlugin
  options?: FloatingPanelOptions
}

export class ReactFloatingPanel<T extends Record<string, unknown>> {
  private root: Root | null = null
  private container: HTMLDivElement | null = null
  private Component: React.ComponentType<T & { onClose: () => void }>
  private props: T
  private options?: FloatingPanelOptions
  private plugin?: YoloPlugin

  constructor({ Component, props, options, plugin }: FloatingPanelProps<T>) {
    this.Component = Component
    this.props = props
    this.options = options
    this.plugin = plugin
  }

  open() {
    if (this.container) return

    this.container = document.createElement('div')
    this.container.className = 'yolo-floating-panel-container'
    document.body.appendChild(this.container)

    this.root = createRoot(this.container)

    const options = this.options
    const PanelShell: React.FC<{ onClose: () => void }> = ({ onClose }) => {
      const [pos, setPos] = useState<{ x: number; y: number }>(
        options?.initialPosition ?? {
          x: window.innerWidth / 2 - 180,
          y: window.innerHeight / 2 - 120,
        },
      )
      const [size, setSize] = useState<{ width: number; height?: number }>({
        width: options?.width ?? 360,
        height: options?.height,
      })
      const [dragging, setDragging] = useState(false)
      const dragOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
      const [resizing, setResizing] = useState(false)
      const resizeStart = useRef<{
        x: number
        y: number
        width: number
        height: number | undefined
      } | null>(null)
      const panelRef = useRef<HTMLDivElement>(null)
      const panelStyleVars = useMemo(() => {
        const vars: Record<string, string | undefined> = {
          '--yolo-panel-top': `${Math.round(pos.y)}px`,
          '--yolo-panel-left': `${Math.round(pos.x)}px`,
          '--yolo-panel-width': `${Math.round(size.width)}px`,
        }
        vars['--yolo-panel-height'] =
          typeof size.height === 'number'
            ? `${Math.round(size.height)}px`
            : undefined
        return vars
      }, [pos.x, pos.y, size.height, size.width])

      const panelClassName = 'yolo-floating-panel'
      const shouldCloseOnEscape = options?.closeOnEscape ?? true
      const shouldCloseOnOutsideClick = options?.closeOnOutsideClick ?? true

      useEffect(() => {
        if (!shouldCloseOnEscape) {
          return
        }
        const onKeyDown = (e: KeyboardEvent) => {
          if (e.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [onClose, shouldCloseOnEscape])

      // Close on outside click
      useEffect(() => {
        if (!shouldCloseOnOutsideClick) return
        const onMouseDown = (e: MouseEvent) => {
          const el = panelRef.current
          if (el && !el.contains(e.target as Node)) {
            onClose()
          }
        }
        document.addEventListener('mousedown', onMouseDown)
        return () => document.removeEventListener('mousedown', onMouseDown)
      }, [onClose, shouldCloseOnOutsideClick])

      const onHeaderPointerDown = (e: React.PointerEvent) => {
        setDragging(true)
        dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
      }
      const onHeaderPointerMove = (e: React.PointerEvent) => {
        if (!dragging) return
        const next = {
          x: e.clientX - dragOffset.current.x,
          y: e.clientY - dragOffset.current.y,
        }
        setPos(next)
      }
      const onHeaderPointerUp = (e: React.PointerEvent) => {
        setDragging(false)
        ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
      }

      // Resize from bottom-right corner
      const onResizePointerDown = (e: React.PointerEvent) => {
        setResizing(true)
        const rect = panelRef.current?.getBoundingClientRect()
        resizeStart.current = {
          x: e.clientX,
          y: e.clientY,
          width: rect ? rect.width : size.width,
          height: rect ? rect.height : size.height,
        }
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
        e.preventDefault()
      }
      const onResizePointerMove = (e: React.PointerEvent) => {
        if (!resizing || !resizeStart.current) return
        const dx = e.clientX - resizeStart.current.x
        const dy = e.clientY - resizeStart.current.y
        const minW = 280
        const minH = 160
        const nextW = Math.max(minW, Math.round(resizeStart.current.width + dx))
        const nextH = Math.max(
          minH,
          Math.round((resizeStart.current.height ?? minH) + dy),
        )
        setSize({ width: nextW, height: nextH })
      }
      const onResizePointerUp = (e: React.PointerEvent) => {
        setResizing(false)
        resizeStart.current = null
        ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
      }

      const componentProps = {
        ...this.props,
        onClose,
      } as T & { onClose: () => void }

      const panelBody = (
        <LanguageProvider>
          <div ref={panelRef} className={panelClassName} style={panelStyleVars}>
            {/* Minimal headerless mode: add a thin drag handle on top */}
            {options?.minimal ? (
              <div
                className="yolo-floating-panel-drag-handle"
                onPointerDown={onHeaderPointerDown}
                onPointerMove={onHeaderPointerMove}
                onPointerUp={onHeaderPointerUp}
              />
            ) : (
              <div
                className="yolo-floating-panel-header"
                onPointerDown={onHeaderPointerDown}
                onPointerMove={onHeaderPointerMove}
                onPointerUp={onHeaderPointerUp}
              >
                <div className="yolo-floating-panel-title">
                  {options?.title ?? ''}
                </div>
                <button
                  aria-label="Close"
                  className="clickable-icon yolo-floating-panel-close"
                  onClick={onClose}
                >
                  ✕
                </button>
              </div>
            )}
            <div className="yolo-floating-panel-body">
              <this.Component {...componentProps} />
            </div>

            {/* Resize handle */}
            <div
              onPointerDown={onResizePointerDown}
              onPointerMove={onResizePointerMove}
              onPointerUp={onResizePointerUp}
              className="yolo-floating-panel-resize-handle"
              aria-label="Resize"
            />
          </div>
        </LanguageProvider>
      )

      if (!this.plugin) {
        return panelBody
      }

      return <PluginProvider plugin={this.plugin}>{panelBody}</PluginProvider>
    }

    this.root.render(<PanelShell onClose={() => this.close()} />)
  }

  close() {
    if (this.root) {
      this.root.unmount()
      this.root = null
    }
    if (this.container) {
      this.container.remove()
      this.container = null
    }
  }
}
