import type {
  RequestTransportMode,
  ResponseStreamingMode,
} from '../../types/provider.types'

export type ResponseDeliveryMode = 'incremental' | 'buffered'

export type ResponseExecutionMode =
  | 'incremental-streaming'
  | 'buffered-streaming'
  | 'non-streaming'

export const resolveResponseExecutionMode = ({
  deliveryMode,
  transportMode,
  streamingMode = 'auto',
}: {
  deliveryMode: ResponseDeliveryMode
  transportMode?: RequestTransportMode
  streamingMode?: ResponseStreamingMode
}): ResponseExecutionMode => {
  if (streamingMode === 'non-streaming') {
    return 'non-streaming'
  }

  if (streamingMode === 'streaming') {
    if (deliveryMode === 'buffered') {
      return transportMode === 'obsidian'
        ? 'buffered-streaming'
        : 'non-streaming'
    }

    return transportMode === 'obsidian'
      ? 'buffered-streaming'
      : 'incremental-streaming'
  }

  if (transportMode === 'obsidian') {
    return 'buffered-streaming'
  }

  return deliveryMode === 'incremental'
    ? 'incremental-streaming'
    : 'non-streaming'
}
