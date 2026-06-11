import type { ChatUserMessage } from '../../types/chat'
import type { ContentPart } from '../../types/llm/request'

/**
 * 时间感知注入:在「新用户回合进入对话」那一刻把当前时间固定到消息的
 * `timeContext` 字段,请求组装时再以纯函数形式拼到发给 LLM 的内容最前面。
 *
 * 与「system prompt 时间变量」不同,这里固定后永不改写,因此天然不破坏前缀缓存。
 */

const pad2 = (value: number): string => value.toString().padStart(2, '0')

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

/**
 * 把某个时刻格式化成 `2026-05-30 14:53 (Friday)`——日期 + 时间 + 星期,本地时间,不带时区。
 */
export const formatTimeContext = (now: Date): string => {
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
  const weekday = WEEKDAY_NAMES[now.getDay()] ?? WEEKDAY_NAMES[0]
  return `${date} ${time} (${weekday})`
}

/**
 * 按设置把当前时间固定写入 `message.timeContext`,返回新对象(不原地修改入参);
 * 时间感知关闭时原样返回。
 *
 * 只能在「新用户回合进入对话」时调用(普通发送提交、Quick Ask 创建消息、入队那一刻、
 * 历史编辑后重新提交)。retry / continue / tool recovery / 历史补编 等路径绝不调用,
 * 沿用消息上已有的 `timeContext`,以保证前缀缓存稳定。
 */
export const stampUserMessageTimeContext = (
  message: ChatUserMessage,
  timeContextEnabled: boolean,
): ChatUserMessage => {
  if (!timeContextEnabled) {
    return message
  }
  return {
    ...message,
    timeContext: formatTimeContext(new Date()),
  }
}

/**
 * 纯函数:把 `<current_time>…</current_time>` 前缀拼到发给 LLM 的内容最前面。
 * 绝不原地修改入参——
 *   - string:    返回拼好的新串。
 *   - ContentPart[]: 返回新数组,在首位新增一个 text part(原有 part 一律不改),
 *     避免重复前缀、污染 snapshotEntries 与内存消息。
 */
export const prefixTimeContext = (
  content: string | ContentPart[],
  timeContext: string,
): string | ContentPart[] => {
  const prefix = `<current_time>${timeContext}</current_time>`
  if (typeof content === 'string') {
    return `${prefix}\n\n${content}`
  }
  return [
    {
      type: 'text',
      text: `${prefix}\n\n`,
    },
    ...content,
  ]
}
