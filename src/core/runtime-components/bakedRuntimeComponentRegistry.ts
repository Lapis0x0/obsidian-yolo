import registryJson from '../../../runtime-components/registry.json'

import { parseRuntimeComponentRegistry } from './runtimeComponentManifest'

export const BAKED_RUNTIME_COMPONENT_REGISTRY =
  parseRuntimeComponentRegistry(registryJson)
