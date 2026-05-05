// 剥除 ANSI 转义序列（颜色、样式、光标控制等）
// 正则覆盖 ESC[ + 参数 + 字母 以及 ESC + 单字母控制码两种形式
// eslint-disable-next-line no-control-regex -- 必须匹配 ESC（0x1B）控制字符才能剥除 ANSI 序列
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-9;]*[ -/]*[@-~])/g

export function stripAnsi(str: string): string {
  return str.replace(ANSI_PATTERN, '')
}
