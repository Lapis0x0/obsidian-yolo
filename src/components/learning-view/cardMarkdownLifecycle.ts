import { Component, MarkdownRenderer } from 'obsidian'
import type { App } from 'obsidian'

export function mountCardMarkdown(
  app: App,
  container: HTMLElement,
  markdown: string,
  sourcePath: string,
): () => void {
  const component = new Component()
  component.load()
  container.empty()
  void MarkdownRenderer.render(app, markdown, container, sourcePath, component)
  return () => {
    component.unload()
    container.empty()
  }
}
