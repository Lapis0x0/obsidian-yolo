import {
  ConversationSurface,
  type ConversationSurfaceContract,
} from './ConversationSurface'

export type YoloChatSurfaceProps = ConversationSurfaceContract

export function YoloChatSurface(props: YoloChatSurfaceProps) {
  return <ConversationSurface {...props} />
}
