import { shouldDismissHistoricalUserMessage } from './useHistoricalUserMessageDismiss'

const targetWithClosest = (
  matches: Partial<Record<string, unknown>>,
): Element =>
  ({
    closest: (selector: string) => matches[selector] ?? null,
  }) as unknown as Element

describe('shouldDismissHistoricalUserMessage', () => {
  it('keeps editing for the active message and its control popovers', () => {
    expect(
      shouldDismissHistoricalUserMessage(
        targetWithClosest({
          '[data-user-message-id]': {
            dataset: { userMessageId: 'user-1' },
          },
        }),
        'user-1',
      ),
    ).toBe(false)
    expect(
      shouldDismissHistoricalUserMessage(
        targetWithClosest({ '.yolo-popover-surface': {} }),
        'user-1',
      ),
    ).toBe(false)
  })

  it('dismisses when the pointer moves to another message or outside', () => {
    expect(
      shouldDismissHistoricalUserMessage(
        targetWithClosest({
          '[data-user-message-id]': {
            dataset: { userMessageId: 'user-2' },
          },
        }),
        'user-1',
      ),
    ).toBe(true)
    expect(
      shouldDismissHistoricalUserMessage(targetWithClosest({}), 'user-1'),
    ).toBe(true)
  })
})
