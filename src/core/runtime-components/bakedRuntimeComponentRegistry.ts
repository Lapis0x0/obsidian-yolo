import registryJson from '../../../runtime-components/registry.json'

import {
  assertCompleteRuntimeComponentRegistry,
  parseRuntimeComponentRegistry,
} from './runtimeComponentManifest'

const parsed = parseRuntimeComponentRegistry(registryJson)
assertCompleteRuntimeComponentRegistry(parsed)

export const BAKED_RUNTIME_COMPONENT_REGISTRY = parsed
