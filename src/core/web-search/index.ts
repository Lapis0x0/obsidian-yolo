export * from './types'
export { getWebSearchProvider } from './registry'
export {
  activeProviderSupportsScrape,
  isWebSearchToolReady,
  resolveActiveWebSearchProvider,
  runWebScrape,
  runWebSearch,
} from './runner'

export const WEB_SEARCH_TOOL_NAME = 'web_search'
export const WEB_SCRAPE_TOOL_NAME = 'web_scrape'
