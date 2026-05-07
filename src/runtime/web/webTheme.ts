export type WebThemeSnapshot = {
  bodyClasses: string[]
  htmlClasses: string[]
  cssVariables: Record<string, string>
}

const THEME_CLASS_PREFIXES = ['theme-', 'mod-']

function syncClassList(
  element: HTMLElement,
  nextClasses: string[],
  appliedClasses: Set<string>,
): Set<string> {
  for (const className of appliedClasses) {
    if (!nextClasses.includes(className)) {
      element.classList.remove(className)
    }
  }

  for (const className of nextClasses) {
    element.classList.add(className)
  }

  return new Set(nextClasses)
}

function clearThemeClasses(element: HTMLElement): void {
  for (const className of Array.from(element.classList)) {
    if (THEME_CLASS_PREFIXES.some((prefix) => className.startsWith(prefix))) {
      element.classList.remove(className)
    }
  }
}

let appliedBodyClasses = new Set<string>()
let appliedHtmlClasses = new Set<string>()
let appliedCssVariables = new Set<string>()

export function applyWebThemeSnapshot(snapshot: WebThemeSnapshot): void {
  const html = document.documentElement
  const body = document.body
  if (!html || !body) {
    return
  }

  clearThemeClasses(html)
  clearThemeClasses(body)

  appliedHtmlClasses = syncClassList(html, snapshot.htmlClasses, appliedHtmlClasses)
  appliedBodyClasses = syncClassList(body, snapshot.bodyClasses, appliedBodyClasses)

  for (const name of appliedCssVariables) {
    if (!(name in snapshot.cssVariables)) {
      html.style.removeProperty(name)
    }
  }

  for (const [name, value] of Object.entries(snapshot.cssVariables)) {
    html.style.setProperty(name, value)
  }

  appliedCssVariables = new Set(Object.keys(snapshot.cssVariables))
}
