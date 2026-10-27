/**
 * 进入对话树模式时收起产品自己的左侧导航栏。
 *
 * 对话树的第一列就是宿主的 Workspace 列表，所以对话树开着的时候，壳层的左栏是同一份
 * 导航的第二份拷贝：把它收起来，宽度让给对话树，导航就只有一个入口。
 *
 * 壳层（ui-layout）只公开了一个 toggle，没有可读/可写的栏状态，这决定了整个控制器
 * 的形状：
 *
 * - 收起必须幂等：判断来自壳层自己写下的 `data-sidebar-collapsed`，而不是「我们点过
 *   一次」；
 * - 窄窗（<1024px）的收起是自动折叠 + 一个独立的展开覆盖位，那里盲目 toggle 会把它
 *   *展开*；读标记同样保护这种情况；
 * - 启动时（或恢复模式后的刷新）壳层帧可能还没挂载：读取返回 `null`，控制器按动画帧
 *   重试，直到壳层给出答案或重试预算耗尽；
 * - 只撤销本控制器造成的收起。读者在对话树期间手动展开左栏，退出对话树时不会把他的选择
 *   抢回去；
 * - 进入（展开对话树）一律收起左栏：对话树的第一列就是同一份 Workspace 导航，两者同屏
 *   等于同一份导航出现两次。这里不做偏好记忆：每次从入口展开都重新
 *   收起；读者在带开着时手动开合左栏仍然完全自由，只是下一次展开会再次收起。
 * - 入场后的下一帧再核对一次（{@link SidebarCollapse.enter} 里的 settle）：同一个点击里，
 *   兄弟带插件退出自己的全宽页时可能把左栏还原，而那次还原的 DOM 标记要到
 *   React 提交后才看得到。立即读可能仍读到旧的"已收起"从而跳过收起；下一帧补读只会
 *   在"带仍展开且左栏确实被还原"时再收一次，不会抢读者之后的手动展开。
 *
 * 壳层的 toggle 还会忘掉拖拽过的栏宽（它的 store 把宽度本身当偏好），所以还原后的
 * 左栏会回到契约默认宽度。这是壳层的既有行为，不是插件的决定。
 */
/** 一次壳层读取：`true` 已收起，`false` 展开，`null` = 壳层帧还没挂载。 */
export type ShellCollapseReader = () => boolean | null

/** 这个行为需要的那一个布局动作。 */
export interface SidebarLayoutLike {
  /** 收起 ⇄ 展开壳层左栏。 */
  toggleSidebar(): void
}

/** {@link createSidebarCollapse} 的注入面。 */
export interface SidebarCollapseOptions {
  /** 壳层的布局服务，收窄到 toggle。 */
  layout: SidebarLayoutLike
  /** 读取壳层当前的收起状态。 */
  read: ShellCollapseReader
  /** 排一次重试；默认下一帧（没有 rAF 时退回 16ms 定时器）。 */
  schedule?: (run: () => void) => void
  /** 壳层帧挂载前最多重试多少帧；默认 120（约 2 秒）。 */
  retries?: number
}

/** 模式开关驱动的生命周期。 */
export interface SidebarCollapse {
  /** 进入模式：左栏展开时收一次（已收起／窄窗自动收起时不动）。 */
  enter: () => void
  /** 退出模式：只撤销本控制器造成的那次收起。 */
  exit: () => void
  /** 当前这次收起是否由本控制器造成（供左侧带让位交接判断）。 */
  owned: () => boolean
  /**
   * 让位交接：交出发起方（返回值 = 是否由本控制器收起左栏），
   * 但不恢复左栏——接手方会继承这次收起。
   */
  releaseOwnership: () => boolean
  /** 收到让位后继承对方对左栏收起的归属。 */
  adoptOwnership: (owned: boolean) => void
  /** 插件卸载：撤销本控制器造成的收起，并丢弃挂起的重试。 */
  dispose: () => void
}

/** 只读取一个选择器的最小 document 面（测试可注入）。 */
export interface QuerySource {
  querySelector(selector: string): Element | null
}

/**
 * 壳层帧的挂载标记：右栏列与悬浮层由 AppFrame 每次渲染都输出，任一存在即说明帧已挂载。
 *
 * 不能拿 `[data-sidebar-collapsed]` 的有无当「展开」：收起时壳层才写这个属性，属性
 * 缺席既可能是展开，也可能是帧还没挂载——两者必须分开。
 */
const FRAME_MARKERS = '[data-rightbar-col], [data-shell-overlay]'

/** 壳层帧在左栏收起时写下的标记。 */
const COLLAPSED_MARKER = '[data-sidebar-collapsed]'

/**
 * 从 DOM 读取壳层左栏的收起状态。
 * @param source - 可注入的 document 面；缺省为浏览器全局 document。
 * @returns 收起/展开，或壳层帧尚未挂载（以及非浏览器环境）时的 `null`。
 */
export function readShellSidebarCollapse(source?: QuerySource): boolean | null {
  const query: QuerySource | null = source ?? (typeof document === 'undefined' ? null : document)
  if (query === null) return null
  if (query.querySelector(FRAME_MARKERS) === null) return null
  return query.querySelector(COLLAPSED_MARKER) !== null
}

/** 默认重试节拍：下一动画帧，没有 rAF 时退回一个宏任务。 */
function nextFrame(run: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => { run() })
    return
  }
  setTimeout(run, 16)
}

/**
 * 创建一个「进入对话树 ⇒ 收起左栏」控制器。
 * @param options - 布局 toggle、状态读取、重试调度与预算。
 * @returns 模式开关驱动的一个 enter/exit/dispose。
 */
export function createSidebarCollapse(options: SidebarCollapseOptions): SidebarCollapse {
  const { layout, read } = options
  const schedule = options.schedule ?? nextFrame
  const retries = options.retries ?? 120

  /** 左栏当前这次收起是不是本控制器做的：决定退出时是否还原。 */
  let owned = false
  /** 每次模式切换递增；挂起的重试带着旧令牌到期即作废。 */
  let token = 0
  let disposed = false

  /** 调一次壳层 toggle；布局服务缺席/拒绝对话时只告警，不拖垮模式。 */
  const toggle = (): void => {
    try {
      layout.toggleSidebar()
    } catch (error) {
      console.warn('conversation-map: collapsing the app sidebar failed', error)
    }
  }

  /** 拿到壳层答案后落账：已收起就不认领，展开才切一次并认领。 */
  const adopt = (collapsed: boolean): void => {
    if (collapsed) {
      owned = false
      return
    }
    toggle()
    owned = true
  }

  /** 等壳层帧挂载，然后再落账。 */
  const waitForShell = (): void => {
    const mine = token
    let attempts = 0
    const attempt = (): void => {
      if (disposed || mine !== token) return
      const collapsed = read()
      if (collapsed === null) {
        attempts += 1
        if (attempts < retries) schedule(attempt)
        return
      }
      adopt(collapsed)
    }
    schedule(attempt)
  }

  /**
   * 入场后的下一次布局再核对一次左栏。
   *
   * 同一个点击里，兄弟插件退出全宽页时可能把左栏还原；那次还原的标记要等 React 提交
   * 之后才在 DOM 上可见，所以立即读可能读到"已收起"而跳过收起。这里只补收一次：
   * `enter` 刚收起时读到 true 直接返回（保留 owned）；读到展开才 toggle 并认领。
   * 令牌保证 exit / dispose / 下一次 enter 之后到期的补读作废——它只服务于这一次入场，
   * 不会持续抢读者在带开着期间的手动展开。
   */
  const settle = (): void => {
    const mine = token
    schedule(() => {
      if (disposed || mine !== token) return
      const collapsed = read()
      // 壳层还没挂载，或已经收起（含本控制器刚收起）：不再动作。
      if (collapsed === null || collapsed) return
      toggle()
      owned = true
    })
  }

  return {
    enter(): void {
      if (disposed) return
      // 上次挂起的等待（启动重试）作废，这一次重新读。
      token += 1
      const collapsed = read()
      if (collapsed === null) {
        waitForShell()
        return
      }
      adopt(collapsed)
      settle()
    },
    exit(): void {
      // 退出时先作废挂起的重试：模式关掉后不该再发生一次收起。
      token += 1
      if (disposed || !owned) return
      owned = false
      // 读者中途自己把左栏拉开了：那是他的选择，不再动它。
      if (read() === true) toggle()
    },
    owned(): boolean {
      return owned
    },
    releaseOwnership(): boolean {
      const held = owned
      owned = false
      return held
    },
    adoptOwnership(next: boolean): void {
      if (disposed) return
      owned = next
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      token += 1
      if (!owned) return
      owned = false
      // 插件被卸载/热替换时把左栏还回去，避免侧栏停在收起状态却没人能解释。
      if (read() === true) toggle()
    },
  }
}
