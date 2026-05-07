import type { WebServerContext } from '../WebServerContext'
import type { WebThemeSnapshot } from '../../../runtime/web/webTheme'

const THEME_VARIABLE_NAMES = [
  '--font-default',
  '--font-monospace',
  '--font-interface',
  '--font-text',
  '--font-ui',
  '--font-ui-smallest',
  '--font-ui-smaller',
  '--font-ui-small',
  '--font-ui-medium',
  '--font-ui-large',
  '--font-smallest',
  '--font-smaller',
  '--font-small',
  '--font-medium',
  '--font-large',
  '--font-xl',
  '--font-text-size',
  '--button-radius',
  '--font-normal',
  '--font-semibold',
  '--font-bold',
  '--line-height-normal',
  '--line-height-tight',
  '--h1-size',
  '--h1-weight',
  '--h1-color',
  '--h3-size',
  '--h3-weight',
  '--h4-size',
  '--h4-weight',
  '--text-normal',
  '--text-muted',
  '--text-faint',
  '--text-accent',
  '--text-on-accent',
  '--text-error',
  '--text-success',
  '--text-warning',
  '--background-primary',
  '--background-secondary',
  '--background-tertiary',
  '--background-primary-alt',
  '--background-secondary-alt',
  '--background-modifier-form-field',
  '--background-modifier-border',
  '--background-modifier-border-hover',
  '--background-modifier-border-focus',
  '--background-modifier-box-shadow',
  '--background-modifier-hover',
  '--background-modifier-active',
  '--background-modifier-active-hover',
  '--background-modifier-success',
  '--background-modifier-error',
  '--background-modifier-message',
  '--interactive-normal',
  '--interactive-hover',
  '--interactive-accent',
  '--interactive-accent-hover',
  '--interactive-success',
  '--interactive-accent-rgb',
  '--tab-container-background',
  '--tab-text-color',
  '--tab-text-color-active',
  '--tab-text-color-focused',
  '--tab-divider-color',
  '--radius-1',
  '--radius-xs',
  '--radius-s',
  '--radius-m',
  '--radius-l',
  '--radius-xl',
  '--border-width',
  '--input-border-width',
  '--input-height',
  '--header-height',
  '--file-header-border',
  '--icon-xs',
  '--icon-m',
  '--icon-l',
  '--icon-stroke',
  '--size-2-1',
  '--size-2-2',
  '--size-4-1',
  '--size-4-2',
  '--size-4-3',
  '--size-4-4',
  '--size-4-6',
  '--size-4-8',
] as const

export function registerBootstrapRoutes(ctx: WebServerContext): void {
  ctx.server.router.get('/api/bootstrap', (_req, res) => {
    const activeFile = ctx.plugin.app.workspace.getActiveFile()
    ctx.server.json(res, 200, {
      pluginInfo: {
        id: ctx.plugin.manifest.id,
        name: ctx.plugin.manifest.name,
        version: ctx.plugin.manifest.version,
        dir: ctx.plugin.manifest.dir,
      },
      settings: ctx.plugin.settings,
      vaultName: ctx.plugin.app.vault.getName(),
      activeFile: activeFile
        ? {
            path: activeFile.path,
            name: activeFile.name,
            basename: activeFile.basename,
            extension: activeFile.extension,
            stat: {
              ctime: activeFile.stat.ctime,
              mtime: activeFile.stat.mtime,
              size: activeFile.stat.size,
            },
          }
        : null,
      theme: readThemeSnapshot(),
    })
  })

  ctx.server.router.get('/api/theme', (_req, res) => {
    ctx.server.json(res, 200, readThemeSnapshot())
  })
}

function readThemeSnapshot(): WebThemeSnapshot {
  if (typeof document === 'undefined') {
    return {
      bodyClasses: [],
      htmlClasses: [],
      cssVariables: {},
    }
  }

  return {
    bodyClasses: Array.from(document.body?.classList ?? []),
    htmlClasses: Array.from(document.documentElement?.classList ?? []),
    cssVariables: readCssVariables(),
  }
}

function readCssVariables(): Record<string, string> {
  const cssVariables: Record<string, string> = {}
  const sources = [document.documentElement, document.body].filter(
    (element): element is HTMLElement => Boolean(element),
  )

  for (const propertyName of THEME_VARIABLE_NAMES) {
    for (const element of sources) {
      const value = getComputedStyle(element).getPropertyValue(propertyName).trim()
      if (value) {
        cssVariables[propertyName] = value
        break
      }
    }
  }

  return cssVariables
}
