import type {
  RuntimeComponentApiMap,
  RuntimeComponentDefinition,
  RuntimeComponentId,
  RuntimeComponentLease,
} from './contracts'

type RuntimeSlot<I extends RuntimeComponentId = RuntimeComponentId> = {
  instance: RuntimeComponentApiMap[I] | null
  activation: Promise<RuntimeComponentApiMap[I]> | null
  leases: number
  quiescing: boolean
  drainWaiters: Set<() => void>
}

export class RuntimeComponentRuntime {
  private readonly slots = new Map<RuntimeComponentId, RuntimeSlot>()
  private disposed = false

  async acquire<I extends RuntimeComponentId>(
    id: I,
    load: () => Promise<RuntimeComponentDefinition<I>>,
  ): Promise<RuntimeComponentLease<I>> {
    if (this.disposed) throw new Error('Runtime component service is disposed')
    const slot = this.slot(id)
    if (slot.quiescing)
      throw new Error(`Runtime component "${id}" is quiescing`)
    if (!slot.activation && !slot.instance) {
      slot.activation = load()
        .then((definition) => definition.create())
        .then((instance) => {
          slot.instance = instance
          return instance
        })
        .finally(() => {
          slot.activation = null
        })
    }
    const api = slot.instance ?? (await slot.activation!)
    if (slot.quiescing || this.disposed) {
      throw new Error(`Runtime component "${id}" is quiescing`)
    }
    slot.leases += 1
    let released = false
    return Object.freeze({
      api,
      release: () => {
        if (released) return
        released = true
        slot.leases -= 1
        if (slot.leases === 0) {
          for (const resolve of slot.drainWaiters) resolve()
          slot.drainWaiters.clear()
        }
      },
    })
  }

  beginQuiesce(id: RuntimeComponentId): void {
    this.slot(id).quiescing = true
  }

  async drainAndDispose(id: RuntimeComponentId): Promise<void> {
    const slot = this.slot(id)
    await slot.activation?.catch(() => undefined)
    if (slot.leases > 0) {
      await new Promise<void>((resolve) => slot.drainWaiters.add(resolve))
    }
    const instance = slot.instance as {
      dispose?: () => void | Promise<void>
    } | null
    slot.instance = null
    await instance?.dispose?.()
  }

  endQuiesce(id: RuntimeComponentId): void {
    this.slot(id).quiescing = false
  }

  isActive(id: RuntimeComponentId): boolean {
    return Boolean(this.slot(id).instance)
  }

  isQuiescing(id: RuntimeComponentId): boolean {
    return this.slot(id).quiescing
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const id of this.slots.keys()) this.beginQuiesce(id)
    await Promise.all(
      [...this.slots.keys()].map((id) => this.drainAndDispose(id)),
    )
  }

  private slot<I extends RuntimeComponentId>(id: I): RuntimeSlot<I> {
    let slot = this.slots.get(id)
    if (!slot) {
      slot = {
        instance: null,
        activation: null,
        leases: 0,
        quiescing: false,
        drainWaiters: new Set(),
      }
      this.slots.set(id, slot)
    }
    return slot as RuntimeSlot<I>
  }
}
