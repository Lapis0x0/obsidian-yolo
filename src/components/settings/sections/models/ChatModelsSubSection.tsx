import { GripVertical, Trash2 } from 'lucide-react'
import { App, Notice } from 'obsidian'
import { type DragEvent, useRef } from 'react'
import { ObsidianToggle } from 'src/components/common/ObsidianToggle'

import { DEFAULT_CHAT_MODELS } from '../../../../constants'
import { useSettings } from '../../../../contexts/settings-context'
import SmartComposerPlugin from '../../../../main'
import { ConfirmModal } from '../../../modals/ConfirmModal'
import { AddChatModelModal } from '../../modals/AddChatModelModal'

type ChatModelsSubSectionProps = {
  app: App
  plugin: SmartComposerPlugin
}

const isEnabled = (enable: boolean | undefined | null) => enable ?? true

export function ChatModelsSubSection({
  app,
  plugin,
}: ChatModelsSubSectionProps) {
  const { settings, setSettings } = useSettings()
  const dragIndexRef = useRef<number | null>(null)
  const dragOverRowRef = useRef<HTMLTableRowElement | null>(null)
  const lastDropPosRef = useRef<'before' | 'after' | null>(null)
  const lastInsertIndexRef = useRef<number | null>(null)

  // Robustly highlight the moved row after DOM re-render
  const triggerDropSuccess = (movedId: string) => {
    const tryFind = (attempt = 0) => {
      const movedRow = document.querySelector(`tr[data-model-id="${movedId}"]`)
      if (movedRow) {
        movedRow.classList.add('smtcmp-row-drop-success')
        window.setTimeout(() => {
          movedRow.classList.remove('smtcmp-row-drop-success')
        }, 700)
      } else if (attempt < 8) {
        window.setTimeout(() => tryFind(attempt + 1), 50)
      }
    }
    requestAnimationFrame(() => tryFind())
  }

  const handleDeleteChatModel = (modelId: string) => {
    if (
      modelId === settings.chatModelId ||
      modelId === settings.chatTitleModelId
    ) {
      new Notice(
        'Cannot remove model that is currently selected as chat model or conversation title model',
      )
      return
    }

    const message = `Are you sure you want to delete model "${modelId}"?`
    new ConfirmModal(app, {
      title: 'Delete chat model',
      message: message,
      ctaText: 'Delete',
      onConfirm: () => {
        void (async () => {
          try {
            await setSettings({
              ...settings,
              chatModels: [...settings.chatModels].filter(
                (v) => v.id !== modelId,
              ),
            })
          } catch (error: unknown) {
            console.error('Failed to delete chat model', error)
            new Notice('Failed to delete chat model.')
          }
        })()
      },
    }).open()
  }

  const handleToggleEnableChatModel = (modelId: string, value: boolean) => {
    void (async () => {
      try {
        if (
          !value &&
          (modelId === settings.chatModelId ||
            modelId === settings.chatTitleModelId)
        ) {
          new Notice(
            'Cannot disable model that is currently selected as chat model or conversation title model',
          )

          await setSettings({
            ...settings,
            chatModels: [...settings.chatModels].map((v) =>
              v.id === modelId ? { ...v, enable: true } : v,
            ),
          })
          return
        }

        await setSettings({
          ...settings,
          chatModels: [...settings.chatModels].map((v) =>
            v.id === modelId ? { ...v, enable: value } : v,
          ),
        })
      } catch (error: unknown) {
        console.error('Failed to toggle chat model', error)
        new Notice('Failed to toggle chat model.')
      }
    })()
  }

  const handleDragStart = (
    event: DragEvent<HTMLTableRowElement>,
    index: number,
  ) => {
    dragIndexRef.current = index
    event.dataTransfer?.setData(
      'text/plain',
      settings.chatModels[index]?.id ?? '',
    )
    event.dataTransfer.effectAllowed = 'move'

    // visual feedback: mark dragging row & handle
    const row = event.currentTarget
    row.classList.add('smtcmp-row-dragging')
    const handle = row.querySelector('.smtcmp-drag-handle')
    if (handle) handle.classList.add('smtcmp-drag-handle--active')
  }

  const handleDragOver = (
    event: DragEvent<HTMLTableRowElement>,
    targetIndex: number,
  ) => {
    event.preventDefault()

    // show insert indicator before/after the hovered row
    const row = event.currentTarget
    const rect = row.getBoundingClientRect()
    const rel = (event.clientY - rect.top) / rect.height

    // If hovering the row being dragged, suppress indicator to avoid flicker
    if (dragIndexRef.current === targetIndex) {
      row.classList.remove(
        'smtcmp-row-drag-over-before',
        'smtcmp-row-drag-over-after',
      )
      if (dragOverRowRef.current && dragOverRowRef.current !== row) {
        dragOverRowRef.current.classList.remove(
          'smtcmp-row-drag-over-before',
          'smtcmp-row-drag-over-after',
        )
      }
      dragOverRowRef.current = row
      lastDropPosRef.current = null
      lastInsertIndexRef.current = null
      return
    }

    // Hysteresis around the midline to prevent rapid toggling
    const HYSTERESIS = 0.05 // 5% of row height
    let dropAfter: boolean
    if (lastDropPosRef.current) {
      if (rel > 0.5 + HYSTERESIS) dropAfter = true
      else if (rel < 0.5 - HYSTERESIS) dropAfter = false
      else dropAfter = lastDropPosRef.current === 'after'
    } else {
      dropAfter = rel > 0.5
    }

    // Calculate actual insert position to avoid duplicate indicators
    const sourceIndex = dragIndexRef.current!
    let insertIndex = targetIndex
    if (dropAfter) insertIndex += 1
    if (sourceIndex < targetIndex) insertIndex -= 1

    // If same insert position as before, don't change anything
    if (lastInsertIndexRef.current === insertIndex) {
      return
    }

    // clear previous indicator
    if (dragOverRowRef.current) {
      dragOverRowRef.current.classList.remove(
        'smtcmp-row-drag-over-before',
        'smtcmp-row-drag-over-after',
      )
    }

    const desiredClass = dropAfter
      ? 'smtcmp-row-drag-over-after'
      : 'smtcmp-row-drag-over-before'
    row.classList.remove(
      'smtcmp-row-drag-over-before',
      'smtcmp-row-drag-over-after',
    )
    row.classList.add(desiredClass)
    dragOverRowRef.current = row
    lastDropPosRef.current = dropAfter ? 'after' : 'before'
    lastInsertIndexRef.current = insertIndex
  }

  const handleDragEnd = () => {
    dragIndexRef.current = null
    if (dragOverRowRef.current) {
      dragOverRowRef.current.classList.remove(
        'smtcmp-row-drag-over-before',
        'smtcmp-row-drag-over-after',
      )
      dragOverRowRef.current = null
    }
    lastDropPosRef.current = null
    lastInsertIndexRef.current = null
    // remove dragging visuals from any row still marked
    const dragging = document.querySelector('tr.smtcmp-row-dragging')
    if (dragging) dragging.classList.remove('smtcmp-row-dragging')
    const activeHandle = document.querySelector(
      '.smtcmp-drag-handle.smtcmp-drag-handle--active',
    )
    if (activeHandle)
      activeHandle.classList.remove('smtcmp-drag-handle--active')
  }

  const handleDrop = (
    event: DragEvent<HTMLTableRowElement>,
    targetIndex: number,
  ) => {
    event.preventDefault()
    // capture row early to avoid React SyntheticEvent pooling issues
    const rowEl = event.currentTarget as HTMLTableRowElement
    const sourceIndex = dragIndexRef.current
    dragIndexRef.current = null
    if (sourceIndex === null) {
      return
    }

    const rect = event.currentTarget.getBoundingClientRect()
    const dropAfter = event.clientY - rect.top > rect.height / 2

    void (async () => {
      try {
        const updatedChatModels = [...settings.chatModels]
        const [moved] = updatedChatModels.splice(sourceIndex, 1)
        if (!moved) {
          return
        }

        let insertIndex = targetIndex + (dropAfter ? 1 : 0)
        if (sourceIndex < insertIndex) {
          insertIndex -= 1
        }
        if (insertIndex < 0) {
          insertIndex = 0
        }
        if (insertIndex > updatedChatModels.length) {
          insertIndex = updatedChatModels.length
        }
        updatedChatModels.splice(insertIndex, 0, moved)

        await setSettings({
          ...settings,
          chatModels: updatedChatModels,
        })

        triggerDropSuccess(moved.id)
      } catch (error: unknown) {
        console.error('Failed to reorder chat models', error)
        new Notice('Failed to reorder chat models.')
      } finally {
        rowEl?.classList.remove(
          'smtcmp-row-drag-over-before',
          'smtcmp-row-drag-over-after',
        )
        const dragging = document.querySelector('tr.smtcmp-row-dragging')
        if (dragging) dragging.classList.remove('smtcmp-row-dragging')
        const activeHandle = document.querySelector(
          '.smtcmp-drag-handle.smtcmp-drag-handle--active',
        )
        if (activeHandle)
          activeHandle.classList.remove('smtcmp-drag-handle--active')

        dragOverRowRef.current = null
        lastDropPosRef.current = null
        lastInsertIndexRef.current = null
      }
    })()
  }

  return (
    <div>
      <div className="smtcmp-settings-sub-header">Chat models</div>
      <div className="smtcmp-settings-desc">Models used for chat and apply</div>

      <div className="smtcmp-settings-table-container">
        <table className="smtcmp-settings-table">
          <colgroup>
            <col width={16} />
            <col />
            <col />
            <col />
            <col width={60} />
            <col width={60} />
          </colgroup>
          <thead>
            <tr>
              <th></th>
              <th>ID</th>
              <th>Provider ID</th>
              <th>Model (calling ID)</th>
              <th>Enable</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {settings.chatModels.map((chatModel, index) => (
              <tr
                key={chatModel.id}
                data-model-id={chatModel.id}
                draggable
                onDragStart={(event) => handleDragStart(event, index)}
                onDragOver={(event) => handleDragOver(event, index)}
                onDrop={(event) => handleDrop(event, index)}
                onDragEnd={handleDragEnd}
              >
                <td>
                  <span
                    className="smtcmp-drag-handle"
                    aria-label="Drag to reorder"
                  >
                    <GripVertical />
                  </span>
                </td>
                <td>{chatModel.id}</td>
                <td>{chatModel.providerId}</td>
                <td>{chatModel.model || chatModel.name || chatModel.id}</td>
                <td>
                  <ObsidianToggle
                    value={isEnabled(chatModel.enable)}
                    onChange={(value) =>
                      handleToggleEnableChatModel(chatModel.id, value)
                    }
                  />
                </td>
                <td>
                  <div className="smtcmp-settings-actions">
                    {!DEFAULT_CHAT_MODELS.some(
                      (v) => v.id === chatModel.id,
                    ) && (
                      <button
                        onClick={() => handleDeleteChatModel(chatModel.id)}
                        className="clickable-icon"
                      >
                        <Trash2 />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={6}>
                <button
                  onClick={() => {
                    new AddChatModelModal(app, plugin).open()
                  }}
                >
                  Add custom model
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
