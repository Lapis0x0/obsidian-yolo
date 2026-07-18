export type CardMarkdownRenderer = {
  render(
    markdown: string,
    container: HTMLElement,
    sourcePath: string,
  ): Promise<void>
  unload(): void
}

export type CardMarkdownService = {
  createRenderer(): CardMarkdownRenderer
}

export function mountCardMarkdown(
  service: CardMarkdownService,
  container: HTMLElement,
  markdown: string,
  sourcePath: string,
): () => void {
  const renderer = service.createRenderer()
  container.replaceChildren()
  void renderer.render(markdown, container, sourcePath)
  return () => {
    renderer.unload()
    container.replaceChildren()
  }
}
