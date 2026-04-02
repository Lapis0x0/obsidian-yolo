import { DEFAULT_MODEL_REQUEST_TIMEOUT_MS } from '../../settings/schema/setting.types'

import {
  DEFAULT_MODEL_REQUEST_POLICY,
  ModelRequestTimeoutError,
  resolveModelRequestPolicy,
  resolveSdkMaxRetries,
  runWithModelRequestPolicy,
} from './requestPolicy'

describe('requestPolicy', () => {
  it('uses default timeout and no retries', () => {
    expect(
      resolveModelRequestPolicy({
        continuationOptions: undefined,
      } as never),
    ).toEqual(DEFAULT_MODEL_REQUEST_POLICY)
  })

  it('reads the configured primary request timeout', () => {
    expect(
      resolveModelRequestPolicy({
        continuationOptions: {
          primaryRequestTimeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
        },
      } as never),
    ).toEqual({
      timeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
    })
  })

  it('clamps timeout to supported bounds', () => {
    expect(
      resolveModelRequestPolicy({
        continuationOptions: {
          primaryRequestTimeoutMs: 500,
        },
      } as never),
    ).toEqual({
      timeoutMs: 1000,
    })

    expect(
      resolveModelRequestPolicy({
        continuationOptions: {
          primaryRequestTimeoutMs: 999999,
        },
      } as never),
    ).toEqual({
      timeoutMs: 600000,
    })
  })

  it('keeps sdk retries disabled for every transport mode', () => {
    expect(resolveSdkMaxRetries()).toBe(0)
    expect(
      resolveSdkMaxRetries({
        requestPolicy: {
          timeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
        },
        requestTransportMode: 'auto',
      }),
    ).toBe(0)
    expect(
      resolveSdkMaxRetries({
        requestPolicy: {
          timeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
        },
        requestTransportMode: 'obsidian',
      }),
    ).toBe(0)
  })

  it('enforces timeout without retrying', async () => {
    const run = jest.fn<Promise<string>, [AbortSignal]>().mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new ModelRequestTimeoutError(5)), 20)
        }),
    )

    await expect(
      runWithModelRequestPolicy({
        requestPolicy: {
          timeoutMs: 5,
        },
        run,
      }),
    ).rejects.toBeInstanceOf(ModelRequestTimeoutError)

    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not retry user aborts', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = jest.fn<Promise<string>, [AbortSignal]>()

    await expect(
      runWithModelRequestPolicy({
        requestPolicy: {
          timeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
        },
        signal: controller.signal,
        run,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(run).not.toHaveBeenCalled()
  })
})
