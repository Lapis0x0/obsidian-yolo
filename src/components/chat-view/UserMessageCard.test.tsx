jest.mock('../../contexts/settings-context', () => ({
  useSettings: () => ({
    settings: { chatOptions: { mentionDisplayMode: 'inline' } },
  }),
}))

jest.mock('./ReadOnlyUserMessageContent', () => ({
  __esModule: true,
  default: ({ fallbackText }: { fallbackText: string }) => fallbackText,
}))

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { UserMessageDisplaySnapshot } from '../../types/chat-timeline'

import UserMessageCard from './UserMessageCard'

const snapshot: UserMessageDisplaySnapshot = {
  content: null,
  text: 'Read-only history',
  mentionables: [],
  selectedSkills: [],
}

describe('UserMessageCard interaction semantics', () => {
  it('preserves interactive semantics by default', () => {
    const html = renderToStaticMarkup(
      <UserMessageCard snapshot={snapshot} onClick={jest.fn()} />,
    )

    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
  })

  it('removes button and keyboard semantics when rendered read-only', () => {
    const html = renderToStaticMarkup(
      <UserMessageCard
        snapshot={snapshot}
        interactive={false}
        onClick={jest.fn()}
      />,
    )

    expect(html).not.toContain('role="button"')
    expect(html).not.toContain('tabindex=')
  })
})
