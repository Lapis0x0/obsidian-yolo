import TurndownService from 'turndown'

export function htmlToMarkdown(html: string): string {
  return new TurndownService().turndown(html)
}
