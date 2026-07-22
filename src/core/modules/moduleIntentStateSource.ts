import type { ModuleIntentStore } from './moduleIntentStore'
import type { ModuleIntentState, ModuleIntentStateSource } from './types'

/** Projects synchronized intent for the module IDs known to the local read model. */
export class SynchronizedModuleIntentStateSource
  implements ModuleIntentStateSource
{
  constructor(
    private readonly options: Readonly<{
      store: Pick<ModuleIntentStore, 'get'>
    }>,
  ) {}

  async load(
    moduleIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<ModuleIntentState>> {
    const ids = [...new Set(moduleIds)].sort()
    const intents = await Promise.all(
      ids.map(async (id) => ({ id, state: await this.options.store.get(id) })),
    )
    return Object.freeze(
      intents.flatMap(({ id, state }) =>
        state ? [Object.freeze({ id, state })] : [],
      ),
    )
  }
}
