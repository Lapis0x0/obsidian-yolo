import * as Tooltip from '@radix-ui/react-tooltip'
import {
  ArrowBigUp,
  ChevronUp,
  Command,
  CornerDownLeftIcon,
} from 'lucide-react'
import { Platform } from 'obsidian'
import { useCallback, useState } from 'react'

export function VaultChatButton({ onClick }: { onClick: () => void }) {
  const [portalContainer, setPortalContainer] = useState<HTMLElement>()
  const triggerRef = useCallback((node: HTMLDivElement | null) => {
    setPortalContainer(node?.ownerDocument.body)
  }, [])

  return (
    <>
      <Tooltip.Provider delayDuration={0}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <div
              ref={triggerRef}
              className="yolo-chat-user-input-submit-button"
              onClick={onClick}
            >
              <div className="yolo-chat-user-input-submit-button-icons">
                {Platform.isMacOS ? (
                  <Command size={10} />
                ) : (
                  <ChevronUp size={12} />
                )}
                {/* TODO: Replace with a custom icon */}
                <ArrowBigUp size={12} />
                <CornerDownLeftIcon size={12} />
              </div>
              <div>Vault Chat</div>
            </div>
          </Tooltip.Trigger>
          <Tooltip.Portal container={portalContainer}>
            <Tooltip.Content className="yolo-tooltip-content" sideOffset={5}>
              Chat with your entire vault
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    </>
  )
}
