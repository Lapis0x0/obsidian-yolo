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

  it('enables one retry when auto retry is on', () => {
    expect(
      resolveModelRequestPolicy({
        continuationOptions: {
          modelRequestAutoRetryEnabled: true,
          modelRequestTimeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
        },
      } as never),
    ).toEqual({
      maxRetries: 1,
      timeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
    })
  })

  it('clamps timeout to supported bounds', () => {
    expect(
      resolveModelRequestPolicy({
        continuationOptions: {
          modelRequestAutoRetryEnabled: false,
          modelRequestTimeoutMs: 500,
        },
      } as never),
    ).toEqual({
      maxRetries: 0,
      timeoutMs: 1000,
    })

    expect(
      resolveModelRequestPolicy({
        continuationOptions: {
          modelRequestAutoRetryEnabled: false,
          modelRequestTimeoutMs: 999999,
        },
      } as never),
    ).toEqual({
      maxRetries: 0,
      timeoutMs: 600000,
    })
  })

  it('keeps sdk retries disabled in auto transport mode', () => {
    expect(
      resolveSdkMaxRetries({
        requestPolicy: {
          maxRetries: 1,
          timeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
        },
        requestTransportMode: 'auto',
      }),
    ).toBe(0)

    expect(
      resolveSdkMaxRetries({
        requestPolicy: {
          maxRetries: 1,
          timeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
        },
        requestTransportMode: 'obsidian',
      }),
    ).toBe(1)
  })

  it('retries once after timeout', async () => {
    const run = jest
      .fn<Promise<string>, [AbortSignal]>()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new ModelRequestTimeoutError(5)), 20)
          }),
      )
      .mockResolvedValueOnce('ok')

    await expect(
      runWithModelRequestPolicy({
        requestPolicy: {
          maxRetries: 1,
          timeoutMs: 5,
        },
        run,
      }),
    ).resolves.toBe('ok')

    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not retry user aborts', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = jest.fn<Promise<string>, [AbortSignal]>()

    await expect(
      runWithModelRequestPolicy({
        requestPolicy: {
          maxRetries: 1,
          timeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
        },
        signal: controller.signal,
        run,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(run).not.toHaveBeenCalled()
  })
})
