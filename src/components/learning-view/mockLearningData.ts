/**
 * Mock learning data for the design-migration UI shell.
 *
 * ⚠️ This is a throwaway fixture ported verbatim from the design mock. It is a
 * FLAT presentation model and is intentionally separate from the vault-derived
 * domain model in `src/core/learning/types.ts`. The UI views consume this mock
 * for now; a later phase will wire the real vault data through an adapter.
 * Do not import both models into the same file.
 */

export type Mastery = 'mastered' | 'learning' | 'new'

export type Card = {
  id: string
  pointId: string
  front: string
  back: string
  mastery: Mastery
  due?: boolean
}

export type Exercise = {
  id: string
  pointId: string
  question: string
  /** Optional code snippet shown below the question prose */
  codeSnippet?: string
  answer: string
  practiced: boolean
}

export type KnowledgePoint = {
  id: string
  index: string
  title: string
  mastery: Mastery
  masteryPct: number
  cardCount: number
  exerciseCount: number
}

export type Chapter = {
  id: string
  index: number
  title: string
  summary: string
  points: KnowledgePoint[]
}

export type Project = {
  id: string
  name: string
  topic: string
  progress: number
  cardProgress: number
  exerciseProgress: number
  totalCards: number
  totalExercises: number
  completedCards: number
  completedExercises: number
  dueCards: number
  dueExercises: number
  lastStudied: string
}

export const projects: Project[] = [
  {
    id: 'rust',
    name: 'Rust 所有权与生命周期',
    topic: '系统编程',
    progress: 65,
    cardProgress: 65,
    exerciseProgress: 70,
    totalCards: 100,
    totalExercises: 50,
    completedCards: 65,
    completedExercises: 35,
    dueCards: 8,
    dueExercises: 9,
    lastStudied: '2 小时前',
  },
  {
    id: 'dp',
    name: '算法导论 · 动态规划',
    topic: '算法',
    progress: 30,
    cardProgress: 28,
    exerciseProgress: 34,
    totalCards: 200,
    totalExercises: 80,
    completedCards: 56,
    completedExercises: 27,
    dueCards: 5,
    dueExercises: 0,
    lastStudied: '昨天',
  },
  {
    id: 'fp',
    name: '函数式编程入门',
    topic: '编程范式',
    progress: 12,
    cardProgress: 12,
    exerciseProgress: 10,
    totalCards: 150,
    totalExercises: 60,
    completedCards: 18,
    completedExercises: 6,
    dueCards: 0,
    dueExercises: 0,
    lastStudied: '3 天前',
  },
]

export const chapters: Chapter[] = [
  {
    id: 'ch1',
    index: 1,
    title: '所有权基础',
    summary: '理解 Rust 内存模型的核心——所有权系统，以及值如何在变量间转移。',
    points: [
      {
        id: 'p1-1',
        index: '1.1',
        title: '所有权三原则',
        mastery: 'mastered',
        masteryPct: 100,
        cardCount: 3,
        exerciseCount: 1,
      },
      {
        id: 'p1-2',
        index: '1.2',
        title: '移动语义（Move）',
        mastery: 'mastered',
        masteryPct: 92,
        cardCount: 4,
        exerciseCount: 2,
      },
      {
        id: 'p1-3',
        index: '1.3',
        title: 'Clone 与 Copy 的差异',
        mastery: 'learning',
        masteryPct: 60,
        cardCount: 3,
        exerciseCount: 1,
      },
    ],
  },
  {
    id: 'ch2',
    index: 2,
    title: '引用与借用',
    summary: '在不转移所有权的前提下访问数据，并理解借用检查器如何保证安全。',
    points: [
      {
        id: 'p2-1',
        index: '2.1',
        title: '不可变引用',
        mastery: 'mastered',
        masteryPct: 95,
        cardCount: 3,
        exerciseCount: 1,
      },
      {
        id: 'p2-2',
        index: '2.2',
        title: '可变引用',
        mastery: 'learning',
        masteryPct: 85,
        cardCount: 4,
        exerciseCount: 2,
      },
      {
        id: 'p2-3',
        index: '2.3',
        title: '借用检查器规则',
        mastery: 'learning',
        masteryPct: 55,
        cardCount: 4,
        exerciseCount: 2,
      },
      {
        id: 'p2-4',
        index: '2.4',
        title: '悬垂引用与编译器保护',
        mastery: 'new',
        masteryPct: 0,
        cardCount: 3,
        exerciseCount: 1,
      },
    ],
  },
  {
    id: 'ch3',
    index: 3,
    title: '生命周期',
    summary: '用生命周期注解向编译器描述引用的有效范围，消除悬垂引用。',
    points: [
      {
        id: 'p3-1',
        index: '3.1',
        title: '生命周期注解语法',
        mastery: 'new',
        masteryPct: 0,
        cardCount: 3,
        exerciseCount: 1,
      },
      {
        id: 'p3-2',
        index: '3.2',
        title: '函数签名中的生命周期',
        mastery: 'new',
        masteryPct: 0,
        cardCount: 4,
        exerciseCount: 2,
      },
      {
        id: 'p3-3',
        index: '3.3',
        title: "'static 生命周期",
        mastery: 'new',
        masteryPct: 0,
        cardCount: 2,
        exerciseCount: 1,
      },
    ],
  },
]

export const cards: Card[] = [
  {
    id: 'c1',
    pointId: 'p1-1',
    front: 'Rust 的所有权三原则是什么？',
    back: '① 每个值有且仅有一个所有者；② 同一时间只能存在一个所有者；③ 所有者离开作用域时，值被丢弃。',
    mastery: 'mastered',
  },
  {
    id: 'c2',
    pointId: 'p1-2',
    front:
      '以下代码会编译成功吗？`let s1 = String::from("hi"); let s2 = s1; println!("{}", s1);`',
    back: '编译失败。s1 的所有权在 let s2 = s1 时已经移动给 s2，s1 不再有效，因此 println! 中使用 s1 会触发 borrow of moved value 错误。',
    mastery: 'learning',
    due: true,
  },
  {
    id: 'c3',
    pointId: 'p2-2',
    front: '为什么同一作用域内不能同时存在两个可变引用？',
    back: '为了在编译期杜绝数据竞争。借用检查器保证：要么有任意多个不可变引用，要么只有一个可变引用。',
    mastery: 'learning',
    due: true,
  },
  {
    id: 'c4',
    pointId: 'p2-1',
    front: '&T 与 &mut T 的区别是什么？',
    back: '&T 是共享（不可变）引用，可同时存在多个；&mut T 是独占（可变）引用，同一时间只能有一个，且与不可变引用互斥。',
    mastery: 'mastered',
  },
  {
    id: 'c5',
    pointId: 'p2-3',
    front: '借用检查器（borrow checker）的核心规则是什么？',
    back: '在任意给定时间，对一块数据要么有一个可变引用，要么有任意数量的不可变引用，二者不可兼得，且所有引用必须始终有效。',
    mastery: 'learning',
    due: true,
  },
  {
    id: 'c6',
    pointId: 'p1-3',
    front: 'Copy 与 Clone 有何不同？',
    back: 'Copy 是按位浅拷贝、隐式发生（如整数）；Clone 是显式调用 .clone()，可执行深拷贝。实现了 Copy 的类型赋值时不会发生 move。',
    mastery: 'learning',
    due: true,
  },
]

export const exercises: Exercise[] = [
  // ── 第 1 章 · 所有权基础 ──
  {
    id: 'e1-1',
    pointId: 'p1-1',
    question:
      '用自己的话阐述 Rust 所有权三原则，并说明它们如何协同防止内存安全问题。',
    answer:
      '① 每个值有唯一所有者；② 同一时刻只有一个所有者；③ 所有者离开作用域时值被丢弃。三者确保内存只被释放一次、且无悬垂指针。',
    practiced: true,
  },
  {
    id: 'e1-2a',
    pointId: 'p1-2',
    question:
      '描述 String 在函数传参时发生 move 的过程，以及如何避免所有权被夺走。',
    answer:
      '把 String 直接作为参数传入函数会移动所有权，函数返回后原变量失效。可改为传引用 &String/&str 借用，或在函数末尾把所有权返还（return）。',
    practiced: false,
  },
  {
    id: 'e1-2b',
    pointId: 'p1-2',
    question: '以下代码的输出是什么？请解释所有权如何变化。',
    codeSnippet:
      'let s1 = String::from("hello");\nlet s2 = s1;\n// println!("{}", s1);\nprintln!("{}", s2);',
    answer:
      '输出 hello。s1 的所有权移给 s2 后 s1 失效；若取消注释 println s1 会编译失败。',
    practiced: true,
  },
  {
    id: 'e1-3',
    pointId: 'p1-3',
    question: 'Copy 与 Clone 有何本质区别？分别适用于什么类型的数据？',
    answer:
      'Copy 是隐式按位浅拷贝，适用于栈上简单类型；Clone 是显式深拷贝，适用于堆上数据如 String、Vec。',
    practiced: false,
  },

  // ── 第 2 章 · 引用与借用 ──
  {
    id: 'e2-1',
    pointId: 'p2-1',
    question:
      '&T 和 &mut T 在权限上有何不同？为什么不可变引用可以同时存在多个？',
    answer:
      '&T 只读，可多个并存；&mut T 独占写权限，同一时刻只能有一个，且与任何 &T 互斥。只读共享不会导致数据竞争。',
    practiced: true,
  },
  {
    id: 'e2-2a',
    pointId: 'p2-2',
    question:
      '解释为什么 Rust 不允许同一作用域内同时存在多个可变引用？请举一个能体现问题的代码场景。',
    answer:
      '避免数据竞争。若允许多个 &mut 同时修改同一数据，可能产生未定义行为，例如 Vec 扩容导致其他 &mut 悬垂。',
    practiced: true,
  },
  {
    id: 'e2-2b',
    pointId: 'p2-2',
    question: '以下代码能否通过编译？若不能，说明原因。',
    codeSnippet:
      'let mut s = String::from("a");\nlet r1 = &mut s;\nlet r2 = &mut s;\nr1.push(\'b\');',
    answer:
      '不能。同一作用域内不能同时存在两个可变引用，第二个 &mut s 会与 r1 冲突。',
    practiced: false,
  },
  {
    id: 'e2-3a',
    pointId: 'p2-3',
    question: '下列代码为何无法编译？应如何修改？',
    codeSnippet:
      'let mut v = vec![1, 2, 3];\nlet first = &v[0];\nv.push(4);\nprintln!("{first}");',
    answer:
      'first 是不可变借用，v.push 需要可变借用，二者冲突。可先取值再 push，或缩小 first 的作用域。',
    practiced: false,
  },
  {
    id: 'e2-3b',
    pointId: 'p2-3',
    question:
      '什么是 NLL（非词法生命周期）？它如何影响下面这段代码的编译结果？',
    codeSnippet:
      'let mut s = String::from("hi");\nlet r = &s;\nprintln!("{r}");\nlet r2 = &mut s;\nr2.push_str("!");',
    answer:
      'NLL 让引用的生命周期延续到最后一次使用而非作用域末尾。r 在 println 后结束，因此 r2 可以合法创建。',
    practiced: false,
  },
  {
    id: 'e2-4',
    pointId: 'p2-4',
    question: '什么是悬垂引用？Rust 如何在编译期防止它？',
    answer:
      '悬垂引用指向已释放的内存。借用检查器通过生命周期分析，拒绝返回局部变量引用的代码。',
    practiced: false,
  },

  // ── 第 3 章 · 生命周期 ──
  {
    id: 'e3-1',
    pointId: 'p3-1',
    question: "生命周期注解 'a 的含义是什么？它是否改变了引用的实际存活时间？",
    answer:
      "'a 是泛型生命周期参数，描述引用之间的包含关系，不改变运行时行为，仅用于编译期校验。",
    practiced: false,
  },
  {
    id: 'e3-2a',
    pointId: 'p3-2',
    question: '为下面的函数补充正确的生命周期注解，使代码能够编译。',
    codeSnippet:
      'fn longest(x: &str, y: &str) -> &str {\n    if x.len() > y.len() { x } else { y }\n}',
    answer:
      "fn longest<'a>(x: &'a str, y: &'a str) -> &'a str { ... }，返回值生命周期不能长于两个入参中较短的那个。",
    practiced: false,
  },
  {
    id: 'e3-2b',
    pointId: 'p3-2',
    question:
      '结构体中包含引用时，为什么必须标注生命周期？请写出一个包含 &str 字段的结构体定义。',
    answer:
      "编译器需要知道结构体实例的存活时间不会超过其引用。例：struct Excerpt<'a> { text: &'a str }",
    practiced: false,
  },
  {
    id: 'e3-3',
    pointId: 'p3-3',
    question: "'static 生命周期表示什么？String 字面量为什么是 'static 的？",
    answer:
      "'static 表示引用在整个程序运行期间有效。字符串字面量嵌入二进制，程序存续期间一直有效。",
    practiced: false,
  },
]

export const tabs = ['大纲', '知识地图', '卡片', '习题'] as const
export type TabKey = (typeof tabs)[number]
