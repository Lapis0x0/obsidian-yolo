import type {
  RequestTransportMode,
  ResponseStreamingMode,
} from '../../types/provider.types'

import type {
  ResponseDeliveryMode,
  ResponseExecutionMode,
} from './responseDeliveryMode'
import { resolveResponseExecutionMode } from './responseDeliveryMode'

describe('resolveResponseExecutionMode', () => {
  it.each([
    ['auto', 'incremental', 'browser', 'incremental-streaming'],
    ['auto', 'incremental', 'node', 'incremental-streaming'],
    ['auto', 'incremental', 'obsidian', 'buffered-streaming'],
    ['auto', 'buffered', 'browser', 'non-streaming'],
    ['auto', 'buffered', 'node', 'non-streaming'],
    ['auto', 'buffered', 'obsidian', 'buffered-streaming'],
    ['streaming', 'incremental', 'browser', 'incremental-streaming'],
    ['streaming', 'incremental', 'node', 'incremental-streaming'],
    ['streaming', 'incremental', 'obsidian', 'buffered-streaming'],
    ['streaming', 'buffered', 'browser', 'non-streaming'],
    ['streaming', 'buffered', 'node', 'non-streaming'],
    ['streaming', 'buffered', 'obsidian', 'buffered-streaming'],
    ['non-streaming', 'incremental', 'browser', 'non-streaming'],
    ['non-streaming', 'incremental', 'node', 'non-streaming'],
    ['non-streaming', 'incremental', 'obsidian', 'non-streaming'],
    ['non-streaming', 'buffered', 'browser', 'non-streaming'],
    ['non-streaming', 'buffered', 'node', 'non-streaming'],
    ['non-streaming', 'buffered', 'obsidian', 'non-streaming'],
  ] as const)(
    'maps %s streaming over %s delivery and %s transport to %s',
    (streamingMode, deliveryMode, transportMode, expected) => {
      expect(
        resolveResponseExecutionMode({
          deliveryMode,
          transportMode,
          streamingMode,
        }),
      ).toBe(expected)
    },
  )

  it.each([
    ['incremental', 'browser', 'incremental-streaming'],
    ['incremental', 'node', 'incremental-streaming'],
    ['buffered', 'browser', 'non-streaming'],
    ['buffered', 'node', 'non-streaming'],
    ['incremental', 'obsidian', 'buffered-streaming'],
    ['buffered', 'obsidian', 'buffered-streaming'],
  ] as const)(
    'preserves auto behavior when streaming mode is omitted for %s delivery over %s transport',
    (deliveryMode, transportMode, expected) => {
      expect(
        resolveResponseExecutionMode({ deliveryMode, transportMode }),
      ).toBe(expected)
    },
  )

  it('treats invalid streaming mode values as auto at the typed boundary', () => {
    expect(
      resolveResponseExecutionMode({
        deliveryMode: 'incremental' as ResponseDeliveryMode,
        transportMode: 'obsidian' as RequestTransportMode,
        streamingMode: 'invalid' as ResponseStreamingMode,
      }),
    ).toBe('buffered-streaming' as ResponseExecutionMode)
  })
})
