import type { LearningUiBridge } from './LearningUiHost'

export function mountCardMarkdown(
  bridge: LearningUiBridge,
  container: HTMLElement,
  markdown: string,
  sourcePath: string,
): () => void {
  const renderer = bridge.createMarkdownRenderer()
  container.replaceChildren()
  void renderer.render(markdown, container, sourcePath)
  return () => {
    renderer.unload()
    container.replaceChildren()
  }
}
