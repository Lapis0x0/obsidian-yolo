import { WebRouter } from '../WebRouter'
import { registerBootstrapRoutes } from './bootstrapRoutes'

describe('bootstrapRoutes', () => {
  let router: WebRouter
  let jsonMock: jest.Mock

  beforeEach(() => {
    ;(globalThis as any).document = {
      body: {
        classList: ['theme-dark'],
      },
      documentElement: {
        classList: ['theme-dark', 'mod-windows'],
      },
    }
    ;(globalThis as any).getComputedStyle = jest.fn((element: {
      tagName?: string
    }) => ({
      getPropertyValue: (name: string) => {
        if (element === (globalThis as any).document.documentElement) {
          switch (name) {
            case '--background-primary':
              return '#111111'
            case '--background-secondary':
              return '#181818'
            case '--background-modifier-border':
              return '#2a2a2a'
            case '--text-normal':
              return '#eeeeee'
            case '--text-muted':
              return '#bbbbbb'
            case '--font-ui-smallest':
              return '10px'
            case '--font-ui-smaller':
              return '11px'
            case '--font-ui-small':
              return '12px'
            case '--font-ui-medium':
              return '13px'
            default:
              return ''
          }
        }
        return ''
      },
    }))

    router = new WebRouter()
    jsonMock = jest.fn()
    const ctx = {
      plugin: {
        manifest: {
          id: 'test-plugin',
          name: 'Test Plugin',
          version: '1.0.0',
          dir: '.obsidian/plugins/test',
        },
        settings: { version: 50, chatModelId: 'gpt-4' },
        app: {
          workspace: {
            getActiveFile: () => null,
          },
          vault: {
            getName: () => 'Test Vault',
          },
        },
      },
      server: { router, json: jsonMock },
    } as any

    registerBootstrapRoutes(ctx)
  })

  afterEach(() => {
    delete (globalThis as any).document
    delete (globalThis as any).getComputedStyle
  })

  it('returns plugin info, settings, and theme snapshot', () => {
    const handler = router.resolve('GET', '/api/bootstrap')

    expect(handler).not.toBeNull()
    handler!.handler({} as any, {} as any, handler!.params)

    expect(jsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      pluginInfo: {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        dir: '.obsidian/plugins/test',
      },
      settings: { version: 50, chatModelId: 'gpt-4' },
      vaultName: 'Test Vault',
      activeFile: null,
      theme: {
        bodyClasses: ['theme-dark'],
        htmlClasses: ['theme-dark', 'mod-windows'],
        cssVariables: {
          '--background-primary': '#111111',
          '--background-secondary': '#181818',
          '--background-modifier-border': '#2a2a2a',
          '--text-normal': '#eeeeee',
          '--text-muted': '#bbbbbb',
          '--font-ui-smallest': '10px',
          '--font-ui-smaller': '11px',
          '--font-ui-small': '12px',
          '--font-ui-medium': '13px',
        },
      },
    })
  })

  it('returns the current theme snapshot from /api/theme', () => {
    const handler = router.resolve('GET', '/api/theme')

    expect(handler).not.toBeNull()
    handler!.handler({} as any, {} as any, handler!.params)

    expect(jsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      bodyClasses: ['theme-dark'],
      htmlClasses: ['theme-dark', 'mod-windows'],
      cssVariables: {
        '--background-primary': '#111111',
        '--background-secondary': '#181818',
        '--background-modifier-border': '#2a2a2a',
        '--text-normal': '#eeeeee',
        '--text-muted': '#bbbbbb',
        '--font-ui-smallest': '10px',
        '--font-ui-smaller': '11px',
        '--font-ui-small': '12px',
        '--font-ui-medium': '13px',
      },
    })
  })
})
