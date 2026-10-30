jest.mock('../../contexts/settings-context', () => ({
  useSettings: () => ({
    settings: { chatOptions: { mentionDisplayMode: 'inline' } },
  }),
}))

jest.mock('./ReadOnlyUserMessageContent', () => ({
  __esModule: true,
  default: ({ fallbackText }: { fallbackText: string }) => fallbackText,
}))

import type { App } from 'obsidian'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AppProvider } from '../../contexts/app-context'
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

describe('UserMessageCard attachments in inline mode', () => {
  it('shows an attached image as itself, and leaves the rest to the text', () => {
    const html = renderToStaticMarkup(
      <AppProvider app={{} as App}>
        <UserMessageCard
          snapshot={{
            ...snapshot,
            mentionables: [
              {
                type: 'image',
                name: 'screenshot.png',
                mimeType: 'image/png',
                data: 'data:image/png;base64,AAAA',
              },
              { type: 'url', url: 'https://example.com/page' },
            ],
          }}
          onClick={jest.fn()}
        />
      </AppProvider>,
    )

    expect(html).toContain('src="data:image/png;base64,AAAA"')
    expect(html).toContain('aria-label="screenshot.png"')
    expect(html).not.toContain('example.com')
  })
})
