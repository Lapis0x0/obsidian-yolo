import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'

import {
  getYoloModuleRuntimeBridge,
  installYoloModuleRuntimeBridge,
} from './runtimeBridge'

describe('module shared runtime bridge', () => {
  it('publishes Core React and JSX runtime identities and cleans up once', () => {
    const remove = installYoloModuleRuntimeBridge()
    const runtime = getYoloModuleRuntimeBridge()
    expect(runtime.react).toBe(React)
    expect(runtime.jsxRuntime).toBe(jsxRuntime)

    remove()
    remove()
    expect(() => getYoloModuleRuntimeBridge()).toThrow('unavailable')
  })
})
