/**
 * JS 侧动效常量，与 tokens/motion.css 同源；三层语汇（L1 回执 / L2 显隐 /
 * L3 跟随）与硬规则见该文件头注释。改动任一侧时必须同步另一侧。
 *
 * framer-motion / WAAPI 动画不受 CSS 的 reduced-motion 全局兜底覆盖，
 * 使用这些常量的组件需自行通过 useReducedMotion / matchMedia 降级。
 */

/** 微反馈：hover / focus 级的颜色、透明度变化。 */
export const MOTION_DURATION_FEEDBACK_S = 0.12
/** L2 退场：快速收场。 */
export const MOTION_DURATION_EXIT_S = 0.16
/** L2 入场：比退场从容。 */
export const MOTION_DURATION_ENTER_S = 0.22

/** 入场 / 落位默认曲线（easeOutQuint）。 */
export const MOTION_EASE_OUT = [0.22, 1, 0.36, 1] as const
/** 同一曲线的 CSS 字符串形式，供 WAAPI / 内联样式使用。 */
export const MOTION_EASE_OUT_CSS = 'cubic-bezier(0.22, 1, 0.36, 1)'
/** 退场曲线：加速离开。 */
export const MOTION_EASE_IN = [0.4, 0, 1, 1] as const

/** L3 跟随：补位 / 布局位移用 spring，插值加速度而非数值，不错峰。 */
export const MOTION_LAYOUT_SPRING = {
  type: 'spring',
  stiffness: 350,
  damping: 35,
  mass: 0.8,
} as const
