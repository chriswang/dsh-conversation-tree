/**
 * Client half of the conversation-map plugin.
 *
 * 对话树模式 is a *split of the shipped Conversation column*, not a replacement of
 * the conversation shell. The plugin leaves `main.conversation` alone, so the
 * product's Conversation column — header, view tabs, utilities, composer and
 * right Sidebar — keeps rendering exactly as in normal conversation mode, and
 * only reserves a band on the centre column's left edge for the map:
 *
 * - the map itself is registered into the frame-wide `shell.overlay` list while
 *   the band is expanded, and positions itself over that reserved band;
 * - a single `[data-slot="main.conversation"]` CSS rule adds a `padding-left`
 *   equal to the band width, shifting the shipped Conversation column right
 *   without touching its tree;
 * - the entries are one-way, one direction each. The persistent one is a
 *   `sidebar.panellist` row (「对话树」) in the sidebar's global panel list above
 *   the Workspace navigation — the same region the sibling workbench plugin
 *   uses. The shell owns that row's button, so the action is observed on that
 *   button (`watchRowActivation`) and the row is backed by a same-keyed `main`
 *   **entry bridge** only because the shell requires a panel for every list id:
 *   collapsed → reveal the Conversation and expand; expanded → leave it alone
 *   (exiting is the band's own 「⇤」). The contextual one is the Conversation
 *   header's leading seat (「展开对话树」) while the band is collapsed; while it is
 *   expanded the band's own top bar draws 「收起」 at the same anchor, so the two
 *   never coexist.
 *
 * 打开会话仍走应用自己的导航（`ctx.uiWorkspace.openSession()`）：产品当前
 * Session、右栏、未读标记和对话树行高亮始终指向同一条对话。
 *
 * 进入对话树则把当前 Session 切回对话树记住的那条对话（`session-restore.ts`）：
 * 会话跟界面走——展开对话树、带着已展开的带回到会话列、或启动恢复展开，都
 * 恢复对话树自己的会话上下文；离开时不关闭任何东西，只是把会话列让出去，由下
 * 一个界面（例如另一个带插件在拉起对话时打开它缓存的会话）恢复它自己的。
 *
 * Expanding the band always collapses the product's left column: the map's first
 * column is that same Workspace navigation, so leaving both on screen would show
 * one navigation twice. Collapsing restores only a collapse this plugin
 * performed (see `sidebar-collapse.ts`).
 */
import { openBandCollapseMemory, openFirstRunHint, type BandCollapseStore } from '../shared/mode-memory.js'
import { loadView } from '../shared/view-state.js'
import { MapEntryBridge, MapLauncher, MapPanelIcon } from './Entries.js'
import { MapPanel } from './MapPanel.js'
import type {
  ClientContext, CurrentSessionLike, MapServices, PickDirectory, UiSessionLike,
  UiWorkspaceLike, WorkspacesService,
} from './services.js'
import { createMapStore } from './map-store.js'
import { createSidebarCollapse, readShellSidebarCollapse } from './sidebar-collapse.js'
import { sessionToRestore } from './session-restore.js'
import { createStatusLedger } from './status-ledger.js'
import { browserStorage } from './storage.js'
import { createBandProtocol } from './band-owner.js'
import { openBandSlot } from './band-slot.js'
import { ensureStyles } from './styles.js'

/** Services this plugin needs before it activates. */
export const inject = ['slots', 'sessions', 'workspaces', 'layout']

/** `ctx.remote` subset used for the already-forwarded Session events. */
interface ClientRemoteLike {
  $on?(event: string, listener: (...args: unknown[]) => void): (() => void) | void
}

/**
 * The id the sidebar panel row and its `main` entry bridge share.
 *
 * The shell's row click is `selectPanel(id)` and throws for an id with no
 * registered main panel, so the two registrations are a pair. A fresh id is
 * additive: it neither shadows the Conversation nor any shipped panel.
 */
export const PANEL_ID = 'conversation-map'

/** The Workspace navigation service this plugin optionally borrows a chooser from. */
interface DirectoryPickingLike {
  pickDirectory(): Promise<string | null>
}

/**
 * The desktop shell's own chooser, published on the page by its app preload.
 *
 * Read off `globalThis` rather than imported: it is the same recipe the shipped
 * `@deepseek-ai/dsh-client-ui-directory-picker-native` surface uses, and the
 * only reachable path to the dialog the shell owns itself.
 */
interface DesktopDirectoryPickerLike {
  pick(): Promise<string | null>
}

/** True on a macOS client; the desktop shell's own bridge never reaches this test. */
function isMacClient(): boolean {
  return /Mac/i.test(navigator.userAgent)
}

/**
 * Resolve a directory chooser through whichever surface serves it.
 *
 * The desktop shell answers first: its dialog belongs to the application window
 * (macOS attaches it to that window), while the Host's chooser runs in a helper
 * the background Host spawns. On macOS 14+ such a helper can no longer take the
 * foreground, so its panel renders without ever receiving a click — the same
 * reason the shipped native client surface prefers this bridge. Without the
 * bridge on a macOS client the Host chooser is refused outright rather than
 * handing the reader a panel that cannot be answered.
 *
 * The shipped Workspace navigation service is the fallback, and it is read
 * lazily, at click time: activation order between client plugins is not
 * guaranteed, so a lookup performed during `apply` could miss a service that is
 * live a moment later.
 * @param ctx - client root context.
 * @returns a picker that rejects with an actionable message when no usable surface serves it.
 */
function resolvePicker(ctx: ClientContext): PickDirectory {
  return async () => {
    const desktop = (globalThis as typeof globalThis & {
      __DSH_DIRECTORY_PICKER__?: DesktopDirectoryPickerLike
    }).__DSH_DIRECTORY_PICKER__
    if (desktop !== undefined && typeof desktop.pick === 'function') return desktop.pick()
    if (isMacClient()) {
      throw new Error('macOS 上由后台进程拉起的系统目录面板无法接受点击。')
    }
    const navigation = ctx.get('uiWorkspace') as DirectoryPickingLike | undefined
    if (navigation === undefined || typeof navigation.pickDirectory !== 'function') {
      throw new Error('当前客户端没有提供目录选择器。')
    }
    return navigation.pickDirectory()
  }
}

/**
 * Resolve the application's Session navigation, read lazily for activation order.
 * @param ctx - client root context.
 * @returns the native open action.
 */
function resolveOpenSession(ctx: ClientContext): (target: unknown) => void {
  return (target: unknown): void => {
    const navigation = ctx.get('uiWorkspace') as UiWorkspaceLike | undefined
    if (navigation === undefined || typeof navigation.openSession !== 'function') {
      throw new Error('当前客户端没有提供会话导航（uiWorkspace.openSession）。')
    }
    navigation.openSession(target)
  }
}

/**
 * Resolve the application's current-Session binding, read lazily.
 *
 * `uiSession.adapter.current` is the binding the shell itself drives. Client
 * plugins activate in an unspecified order, so the service is looked up on every
 * read instead of once during `apply`; a profile without it yields `undefined`
 * and the page falls back to the catalog's `mainView` marker.
 * @param ctx - client root context.
 * @returns the current-Session id source, or undefined when the profile lacks it.
 */
function resolveExternalCurrent(ctx: ClientContext): MapServices['externalCurrent'] {
  const binding = (): CurrentSessionLike | undefined => {
    const service = ctx.get('uiSession') as UiSessionLike | undefined
    return service?.adapter?.current
  }
  return {
    getSnapshot: (): string | null => {
      const current = binding()
      if (current === undefined) return null
      try {
        return (current.getSnapshot()?.key as string | undefined) ?? null
      } catch (_unmounted) {
        // A disposed binding is not a navigation; the catalog fallback still works.
        return null
      }
    },
    subscribe: (listener: () => void): (() => void) => {
      const current = binding()
      if (current === undefined) return () => {}
      try {
        return current.subscribe(listener)
      } catch (_unmounted) {
        return () => {}
      }
    },
  }
}

/**
 * Collapse ⇄ expand the product's left navigation column through the layout
 * service, degrading to a warning when the shell cannot take it.
 *
 * A profile without a mounted frame has nothing to toggle; the collapse store
 * still drives the page, so this never throws into apply/render paths.
 * @param ctx - client root context carrying the layout face.
 */
function toggleLeftSidebar(ctx: ClientContext): void {
  try {
    ctx.layout.toggleSidebar()
  } catch (error) {
    console.warn('conversation-map: left sidebar toggle failed', error)
  }
}

/**
 * Register the expand seat, the collapse store, and the map band overlay that
 * exists exactly while the band is expanded.
 * @param ctx - client root context carrying the services this plugin uses.
 */
export function apply(ctx: ClientContext): void {
  ensureStyles()

  const workspaces = ctx.get('workspaces') as WorkspacesService | undefined
  if (workspaces === undefined) throw new Error('conversation-map: the Workspace service is unavailable')
  const storage = browserStorage()
  // Raw persisted collapse state. The entries receive a gated view below so an
  // expand request first asks the other band plugin to yield the single slot.
  const raw: BandCollapseStore = openBandCollapseMemory(storage)
  // One-time discovery hint for the icon-only expand seat; never shown twice.
  const hint = openFirstRunHint(storage)
  // The authoritative document lives on the Host; the store owns loading,
  // migration, optimistic commits, polling, and the localStorage-only fallback.
  const store = createMapStore({ ctx, storage })
  ctx.effect(() => () => { store.dispose() }, 'conversation-map: Host map store')
  // In-memory observation of the application's Session status: the only extra
  // facts are transition times (for the two-minute halo) and forwarded error
  // events (the product has no failed state). Nothing is persisted, so a reload
  // follows the product exactly like its own unread marks.
  const statusLedger = createStatusLedger()
  ctx.effect(() => {
    const remote = ctx.get('remote') as ClientRemoteLike | undefined
    if (remote === undefined || remote === null || typeof remote.$on !== 'function') {
      return () => { statusLedger.dispose() }
    }
    const offs: (() => void)[] = []
    try {
      const offError = remote.$on('api-session/error', (...args: unknown[]) => {
        const raw = args[0]
        const sessionId = typeof raw === 'string'
          ? raw
          : (raw as { sessionId?: unknown } | null | undefined)?.sessionId
        if (typeof sessionId === 'string') statusLedger.observeError(sessionId)
      })
      if (typeof offError === 'function') offs.push(offError)
      const offStatus = remote.$on('api-session/status', (...args: unknown[]) => {
        const [sessionId, running] = args
        if (typeof sessionId === 'string' && running === true) statusLedger.observeRunning(sessionId)
      })
      if (typeof offStatus === 'function') offs.push(offStatus)
    } catch (error) {
      console.warn('conversation-map: could not subscribe to Session status events', error)
    }
    return () => {
      for (const off of offs) off()
      statusLedger.dispose()
    }
  }, 'conversation-map: status ledger events')

  /** Reveal the Conversation panel (the band is a presentation of it). */
  const revealConversation = (): void => {
    try {
      // `null` is the layout's own id for the Conversation panel.
      ctx.layout.selectPanel(null)
    } catch (error) {
      console.warn('conversation-map: selecting the Conversation panel failed', error)
    }
  }

  /** Transient status line for cross-plugin conflicts (no toast surface ships here). */
  const showBandNotice = (message: string): void => {
    if (typeof document === 'undefined') return
    try {
      const element = document.createElement('div')
      element.textContent = message
      element.setAttribute('data-dsh-toast', 'band-busy')
      element.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:1000;'
        + 'background:rgba(30,30,36,.94);color:#fff;padding:8px 14px;border-radius:8px;font-size:12px;'
        + 'line-height:1.5;pointer-events:none;opacity:0;transition:opacity .15s'
      document.body.appendChild(element)
      requestAnimationFrame(() => { element.style.opacity = '1' })
      setTimeout(() => {
        element.style.opacity = '0'
        setTimeout(() => { element.remove() }, 220)
      }, 1800)
    } catch { /* a page without a body is not worth failing the click */ }
  }

  const sidebarCollapse = createSidebarCollapse({
    layout: { toggleSidebar: () => { toggleLeftSidebar(ctx) } },
    read: readShellSidebarCollapse,
  })

  /**
   * Read the layout's selected main panel, tolerating a disposed source.
   *
   * Selecting the entry row sets `activePanelId` to this plugin's `main` key for
   * the click itself; every reader of the panel source (the bridge, the sidebar
   * glyph) needs to tell that apart from a real navigation.
   */
  const readActivePanel = (): string | null => {
    try {
      return ctx.layout.panelInfo.getSnapshot().activePanelId
    } catch (_unmounted) {
      return null
    }
  }

  /** True while this band is closing so the other owner can take the slot. */
  let handingOff = false
  /** True while an acquire handshake is in flight. */
  let claiming = false

  /** Wait until the band's reservation attribute is gone (same paint as unmount). */
  const waitForSplitGone = async (timeoutMs = 600): Promise<void> => {
    if (typeof document === 'undefined') return
    const startedAt = Date.now()
    await new Promise<void>(resolve => {
      const check = (): void => {
        const split = document.documentElement.hasAttribute('data-conversation-map-split')
        if (!split || Date.now() - startedAt > timeoutMs) { resolve(); return }
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(check)
        else setTimeout(check, 16)
      }
      check()
    })
  }

  const protocol = createBandProtocol({
    owner: 'conversation-map',
    closeForHandoff: async () => {
      handingOff = true
      try {
        raw.set(true)
        await waitForSplitGone()
        // Hand the left-column ownership over without restoring it: the incoming
        // band keeps it collapsed and restores it when the reader leaves.
        return sidebarCollapse.releaseOwnership()
      } finally {
        handingOff = false
      }
    },
  })
  ctx.effect(() => () => { protocol.dispose() }, 'conversation-map: band protocol')

  // Who owns the frame's left band slot, as the seats read it. The header seat is
  // only for the *free* slot: while another band plugin draws the edge, its
  // surface is what the seam expresses, so the map's contextual entry retreats and
  // the sidebar panel row stays as the map's own entry.
  const bandSlot = openBandSlot()
  ctx.effect(() => () => { bandSlot.dispose() }, 'conversation-map: band slot')

  /** Ask for the band slot, then reveal the Conversation and expand. */
  const expandWithClaim = async (): Promise<void> => {
    if (claiming) return
    claiming = true
    try {
      const result = await protocol.acquire()
      if (!result.acquired) {
        showBandNotice('另一个左侧面板正在使用，请先收起它')
        return
      }
      // The band's session context comes back with the band: switch the column
      // to the remembered conversation before the panel mounts, so its first
      // render already agrees with the native current session.
      restoreRememberedSession()
      revealConversation()
      raw.set(false)
      // A handoff never restores the product's left column: if the outgoing band
      // was the party that collapsed it, this band adopts that collapse so it can
      // restore it when the reader leaves the band.
      if (result.collapseOwned) sidebarCollapse.adoptOwnership(true)
    } finally {
      claiming = false
    }
  }

  // The entries see this gated store: expanding claims the shared slot first;
  // collapsing needs no handshake.
  const collapsed: BandCollapseStore = {
    getSnapshot: () => raw.getSnapshot(),
    subscribe: listener => raw.subscribe(listener),
    set: next => {
      if (next) { raw.set(true); return }
      if (!raw.getSnapshot()) return
      void expandWithClaim()
    },
    toggle: () => {
      if (raw.getSnapshot()) void expandWithClaim()
      else raw.set(true)
    },
  }

  const services: MapServices = {
    sessions: ctx.sessions,
    workspaces,
    store,
    statusLedger,
    panelInfo: ctx.layout.panelInfo,
    pickDirectory: resolvePicker(ctx),
    openSession: resolveOpenSession(ctx),
    externalCurrent: resolveExternalCurrent(ctx),
    collapse: () => { collapsed.set(true) },
  }

  /** The shell's current Session id, or null when the binding is unreadable. */
  const readCurrentSession = (): string | null => {
    try {
      return services.externalCurrent?.getSnapshot() ?? null
    } catch (_unmounted) {
      return null
    }
  }

  /** Session ids the Workspace catalog currently knows. */
  const liveSessionIds = (): ReadonlySet<string> => {
    const live = new Set<string>()
    try {
      for (const item of workspaces.list.getSnapshot().items) {
        for (const id of item.sessionIds) live.add(id)
      }
    } catch (_unmounted) {
      // An unreadable catalog restores nothing; the expand itself still works.
    }
    return live
  }

  /**
   * Switch the Conversation column back to the conversation the map remembers.
   *
   * Entering the map — expanding the band, returning to the Conversation from
   * another main panel while the band is on screen, or the startup restore — is
   * the moment the map's session context comes back: the remembered id
   * (`ViewState.openSessionId`, kept fresh while the band is expanded) replaces
   * whatever another surface left in the column. Nothing is closed on the way
   * out; without a remembered or still-live id the current conversation stays.
   */
  const restoreRememberedSession = (): void => {
    const target = sessionToRestore({
      remembered: loadView(storage).openSessionId,
      current: readCurrentSession(),
      live: liveSessionIds(),
    })
    if (target === null) return
    try {
      services.openSession?.(target)
    } catch (error) {
      console.warn('conversation-map: restoring the remembered conversation failed', error)
    }
  }

  // The "make sure the band is on screen" action of the sidebar row. It is
  // one-way: a collapsed band expands; an already expanded band is left alone
  // (revealing the Conversation is the shell's own `selectPanel` return trip, or
  // the bridge's fallback). Collapsing is the band's own top-bar control.
  const activateEntry = (): void => {
    if (!raw.getSnapshot()) return
    void expandWithClaim()
  }

  /** The bridge fallback's expand branch (claims the shared slot, then expands). */
  const openBand = (): void => { void expandWithClaim() }

  // Second delivery channel for the row activation: the panel selection itself.
  //
  // The primary channel is the glyph's watcher on the shell's row button (see
  // `watchRowActivation`), which does not depend on client-plugin activation
  // order or on a sibling's behaviour. This subscription is the free duplicate:
  // when this plugin's listener happens to run *before* a sibling's (a sibling
  // band plugin may navigate back to the Conversation from the same notification), the
  // panel is flipped back here, before React renders — the bridge then never
  // commits, so the row costs no blank frame at all.
  ctx.effect(() => {
    let stop: (() => void) | undefined
    try {
      stop = ctx.layout.panelInfo.subscribe(() => {
        if (readActivePanel() !== PANEL_ID) return
        revealConversation()
        activateEntry()
      })
    } catch (_unmounted) {
      // A disposed source leaves the row watcher as the only entry channel.
    }
    return () => { stop?.() }
  }, 'conversation-map: row activation')

  ctx.effect(() => {
    let hidden = raw.getSnapshot()
    if (!hidden) {
      // Startup restore: only the first band to claim the slot may expand.
      if (protocol.claimIfFree()) {
        revealConversation()
        sidebarCollapse.enter()
      } else {
        raw.set(true)
      }
    }
    const stop = raw.subscribe(() => {
      const next = raw.getSnapshot()
      if (next === hidden) return
      hidden = next
      if (!next) {
        revealConversation()
        sidebarCollapse.enter()
        return
      }
      if (handingOff) return
      sidebarCollapse.exit()
      protocol.release()
    })
    return () => { stop(); sidebarCollapse.dispose() }
  }, 'conversation-map: band collapse transitions')

  // Startup restore: the band can come back expanded while the shell is still
  // restoring its own saved conversation, so the switch waits for the Workspace
  // catalog and runs once. A band that starts collapsed never switches
  // anything — its expand goes through the claim path above.
  let startupRestoreDone = false
  const restoreStartup = (): void => {
    if (startupRestoreDone) return
    if (raw.getSnapshot()) {
      startupRestoreDone = true
      return
    }
    if (workspaces.list.getSnapshot().phase === 'pending') return
    startupRestoreDone = true
    restoreRememberedSession()
  }
  ctx.effect(() => {
    let stop: (() => void) | undefined
    try {
      stop = workspaces.list.subscribe(restoreStartup)
    } catch (_unmounted) {
      // A disposed catalog leaves the interactive expand paths.
    }
    restoreStartup()
    return () => { stop?.() }
  }, 'conversation-map: startup session restore')

  // Re-entry restore: returning to the Conversation from another main panel
  // (the sibling workbench switches sessions from its own pages) re-reveals
  // this band, and that re-entry is as much "entering the map" as expanding.
  ctx.effect(() => {
    let stop: (() => void) | undefined
    try {
      stop = ctx.layout.panelInfo.subscribe(() => {
        if (readActivePanel() !== null) return
        if (raw.getSnapshot()) return
        restoreRememberedSession()
      })
    } catch (_unmounted) {
      // A disposed panel source leaves the interactive expand paths.
    }
    return () => { stop?.() }
  }, 'conversation-map: re-entry session restore')

  // The expand seat: the leading edge of the content header, drawn only while the
  // band is collapsed **and** no band owns the frame's left edge. While it is
  // expanded the band's own top bar draws the single control at the same anchor;
  // while a peer band owns the edge, that band's surface is the only thing the
  // seam should express (the sidebar panel row stays as the map's entry).
  ctx.effect(() => ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({
    name: 'conversation.header.leading',
    inject: () => ({ collapsed, hint, bandSlot }),
  }, MapLauncher)), 'conversation-map: conversation-header entry')

  // The entry bridge: the `main` panel the sidebar's panel row dispatches to.
  // The shell owns the row and its click is `selectPanel(id)`, which throws for
  // an id with no registered panel — so the row and this panel are a pair. The
  // bridge paints nothing and returns to the Conversation in its first layout
  // effect; selecting it is the click, never a page the reader stays on. It is
  // also the fallback channel for the row action when the glyph's watcher cannot
  // run (a future shell may stop rendering the glyph inside a button).
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    inject: () => ({
      collapsed,
      reveal: revealConversation,
      open: openBand,
    }),
  }, MapEntryBridge)), 'conversation-map: entry bridge')

  // The persistent entry: a sidebar panel row above the Workspace navigation,
  // beside the other global-panel entries. The shell draws the button, its label and its
  // native selected state; the plugin supplies the glyph and, because band mode
  // never selects a main panel, the glyph carries the on-screen reading itself.
  // The row's action is one-way — collapsed → expand; expanded → leave it — and
  // is delivered by the glyph watching its own shell button, so it survives a
  // sibling plugin navigating the centre back in the same notification.
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    label: '对话树',
    inject: () => ({ collapsed, panelInfo: ctx.layout.panelInfo, store, statusLedger, activate: activateEntry }),
  }, MapPanelIcon)), 'conversation-map: sidebar panel row')

  // The map band exists only while the band is expanded. It is a frame-wide
  // overlay entry (the additive root-scoped seat), so mounting and disposing it
  // never touches the shipped Conversation's own registration: the Conversation
  // column simply keeps rendering underneath and is shifted right by the band's
  // CSS reservation. The current Session stays the application's throughout;
  // entering the map only switches it back to the remembered conversation
  // (see restoreRememberedSession above), never replaces the column.
  ctx.effect(() => {
    let dispose: (() => void) | undefined
    const sync = (): void => {
      dispose?.()
      dispose = undefined
      if (collapsed.getSnapshot()) return
      dispose = ctx.slots.inject('shell.overlay', () => {
        try {
          return ctx.slots.register({
            name: 'shell.overlay',
            id: 'conversation-map',
            order: 40,
            inject: () => ({ services }),
          }, MapPanel)
        } catch (error) {
          // A future DSH may change the overlay contract: keep the shipped
          // Conversation fully usable and leave the collapse switch available so
          // the reader can collapse the band.
          console.error('conversation-map: could not mount the map band; staying on the shipped Conversation', error)
          protocol.release()
          raw.set(true)
          return () => {}
        }
      })
    }
    const stop = collapsed.subscribe(sync)
    sync()
    return () => { stop(); dispose?.() }
  }, 'conversation-map: map band overlay')
}
