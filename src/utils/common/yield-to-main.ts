/**
 * 让步给主线程，防止长时间运行的任务阻塞 UI
 * 使用 setTimeout(0) 将控制权交还给事件循环
 */
export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

/**
 * 带条件的让步：每 N 次调用让步一次
 * 用于在循环中减少让步频率，平衡性能和响应性
 */
export function createYieldController(yieldEvery = 10) {
  let counter = 0
  return async function maybeYield(): Promise<void> {
    counter++
    if (counter >= yieldEvery) {
      counter = 0
      await yieldToMain()
    }
  }
}
