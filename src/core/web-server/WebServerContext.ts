import type SmartComposerPlugin from '../../main'
import { WebHttpServer } from './WebHttpServer'

export type WebServerContext = {
  plugin: SmartComposerPlugin
  server: WebHttpServer
}
