import {
  cancelDangerousBashApproval,
  getPendingDangerousBashApproval,
  requestDangerousBashApproval,
  resolveDangerousBashApproval,
  subscribeDangerousBashApproval,
} from './dangerousOperationGate'

describe('dangerousOperationGate', () => {
  it('resolves true when approved and clears the pending entry', async () => {
    const promise = requestDangerousBashApproval('call-1', 'rm', ['a.md'])
    const pending = getPendingDangerousBashApproval('call-1')
    expect(pending).not.toBeNull()
    expect(pending?.kind).toBe('rm')
    expect(pending?.targets).toEqual(['a.md'])

    resolveDangerousBashApproval('call-1', pending!.requestId, true)

    await expect(promise).resolves.toBe(true)
    expect(getPendingDangerousBashApproval('call-1')).toBeNull()
  })

  it('resolves false when rejected', async () => {
    const promise = requestDangerousBashApproval('call-2', 'mv', ['a -> b'])
    const pending = getPendingDangerousBashApproval('call-2')

    resolveDangerousBashApproval('call-2', pending!.requestId, false)

    await expect(promise).resolves.toBe(false)
  })

  it('ignores a resolve call with a stale requestId', async () => {
    const promise = requestDangerousBashApproval('call-3', 'rm', ['a.md'])
    resolveDangerousBashApproval('call-3', 'not-the-real-id', true)

    // Still pending — the stale resolve must not have consumed it.
    expect(getPendingDangerousBashApproval('call-3')).not.toBeNull()

    const pending = getPendingDangerousBashApproval('call-3')!
    resolveDangerousBashApproval('call-3', pending.requestId, true)
    await expect(promise).resolves.toBe(true)
  })

  it('cancels a pending request (e.g. on abort) by resolving false', async () => {
    const promise = requestDangerousBashApproval('call-4', 'rm', ['a.md'])
    cancelDangerousBashApproval('call-4')

    await expect(promise).resolves.toBe(false)
    expect(getPendingDangerousBashApproval('call-4')).toBeNull()
  })

  it('notifies subscribers on request, resolve, and cancel', async () => {
    const listener = jest.fn()
    const unsubscribe = subscribeDangerousBashApproval(listener)

    const promise = requestDangerousBashApproval('call-5', 'rm', ['a.md'])
    expect(listener).toHaveBeenCalledTimes(1)

    const pending = getPendingDangerousBashApproval('call-5')!
    resolveDangerousBashApproval('call-5', pending.requestId, true)
    expect(listener).toHaveBeenCalledTimes(2)

    await promise
    unsubscribe()
  })

  it('supports independent pending requests per tool call', async () => {
    const promiseA = requestDangerousBashApproval('call-a', 'rm', ['a.md'])
    const promiseB = requestDangerousBashApproval('call-b', 'mv', ['b -> c'])

    const pendingA = getPendingDangerousBashApproval('call-a')!
    const pendingB = getPendingDangerousBashApproval('call-b')!
    expect(pendingA.requestId).not.toBe(pendingB.requestId)

    resolveDangerousBashApproval('call-a', pendingA.requestId, true)
    resolveDangerousBashApproval('call-b', pendingB.requestId, false)

    await expect(promiseA).resolves.toBe(true)
    await expect(promiseB).resolves.toBe(false)
  })
})
