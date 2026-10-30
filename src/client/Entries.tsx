/**
 * The three controls that expand or collapse the band.
 *
 * 对话树栏 is a column: it is **collapsed**, not closed. Every control is
 * **one-way** — each expresses exactly one direction, so no control has to carry
 * a "current state" that the other one could contradict:
 *
 *   sidebar panel row        collapsed → reveal the Conversation and expand
 *                            expanded → nothing (it never collapses the band)
 *   Conversation header seat collapsed → expand
 *   band top bar             expanded → collapse
 *
 * The sidebar row used to flip "is the band on screen"; that made the navigation
 * row the only bidirectional control, and reading it as a page left the band on
 * the wrong state. Exiting is the band's own control. The row asks for "make sure
 * the band is on screen" and is delivered by two channels, neither of which is
 * the row's `main` panel:
 *
 * - `sidebar.panellist` (the sidebar's global panel rows, above the Workspace
 *   navigation — the same region the sibling workbench plugin uses) is the
 *   **persistent** entry, present in both sidebar widths and under every main
 *   panel. The shell owns that row's button: its click is `selectPanel(id)`, and
 *   the row's id must name a registered `main` panel, so a same-keyed `main`
 *   **entry bridge** has to exist. But the gesture is not driven by that bridge
 *   mounting: {@link watchRowActivation} observes the activation on the shell's
 *   own button, which is the only channel that survives a sibling plugin
 *   navigating the centre back in the same notification (see its doc).
 * - `conversation.header.leading` is the contextual control, rendered only while
 *   the band is collapsed. While the band is on screen the band's own top bar
 *   draws 「收起」 at the same anchor, so the two never coexist. It is unmounted
 *   with its panel, so it does not exist while a global panel is in front.
 *
 * **The header seat belongs to the free slot.** Two band plugins take turns on
 * the frame's left edge (`band-owner.ts`); while any of them owns it, the seam
 * already expresses that band, so the map's contextual seat retreats and the
 * reader switches bands from the sidebar rows instead (the panel row is always
 * there). The seat therefore renders only while the band is collapsed **and**
 * the slot is free; it reads the protocol's own attribute rather than asking a
 * peer, so neither bundle has to know the other's identity.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'

import { FRESH_MS, type ObservedSessionStatus, type StatusCategory, type StatusCounts, type StatusRollup } from '../shared/status-rollup.js'
import type { BandCollapseStore, FirstRunHintStore } from '../shared/mode-memory.js'
import { LocaleProvider, useLocaleT, type LocaleService } from './locale.js'
import type { MapStore } from './map-store.js'
import type { CatalogState, ObservableSnapshot, RootPanelProps, SessionStatusLike } from './services.js'
import type { StatusLedger } from './status-ledger.js'
import { nextCoveredCompletions } from './completion-watch.js'
import { MapGlyph } from './Glyph.js'
import { StatusRollupBadge } from './StatusRollup.js'
import { ViewToggle } from './ViewToggle.js'

/** How long the one-time hint stays on screen before it retires itself. */
const HINT_MS = 20000

/** Stable empty status source for render tests / profiles without the face. */
const NO_STATUSES: ReadonlyMap<string, SessionStatusLike> = new Map()
/** Stable empty catalog for render tests / profiles without the face. */
const NO_CATALOG: CatalogState = { ids: [], byId: {} }
/** Stable empty observation for render tests / profiles without the ledger. */
const NO_OBSERVED: ReadonlyMap<string, ObservedSessionStatus> = new Map()

/**
 * Whether a session is running, folding in a running subagent the way the
 * panel's categories map does: a parent whose child is still working is live
 * context, not a finished turn.
 * @param sessionId - the session to read.
 * @param statuses - the application's unified status map.
 * @param catalog - the catalog carrying each session's subagent projection.
 * @returns true while the session (or one of its subagents) is running.
 */
function sessionRunning(
  sessionId: string,
  statuses: ReadonlyMap<string, SessionStatusLike>,
  catalog: CatalogState,
): boolean {
  if (statuses.get(sessionId)?.running === true) return true
  const children = catalog.projectionsBySession?.[sessionId]?.values?.subagentCatalog ?? []
  return children.some(child =>
    statuses.get(child.id)?.running === true || catalog.byId[child.id]?.running === true)
}

/**
 * Watch the activation of the shell's own panel row that hosts this glyph.
 *
 * `sidebar.panellist` hands the occupant only a glyph: the shell draws the row
 * button and owns its click (`selectPanel(id)`), so a plugin that needs to react
 * to its row has no callback to register. The glyph is rendered **inside** that
 * button, which is the one stable fact to build on: a capture-phase click (mouse
 * or keyboard activation; it fires before the shell's own bubble handler at the
 * React root) says "this row was activated" without intercepting anything — no
 * `preventDefault`/`stopPropagation`, the shell's navigation still runs.
 *
 * This channel exists because the bridge panel behind the row cannot be relied
 * on: a sibling band plugin may navigate back to the Conversation in the same
 * notification that selected this row (for example when it exits its own
 * full-width page), so React never mounts the bridge and a gesture delivered
 * only through it is lost.
 *
 * @param glyph - the element the slot rendered for this row, or null before mount.
 * @param activate - the row's one action; called once per activation.
 * @returns the unsubscribe, or a no-op when the row is not a button (a future
 *   shell may change that; the bridge panel is then the remaining channel).
 */
export function watchRowActivation(glyph: Element | null, activate: () => void): () => void {
  const row = glyph?.closest('button') ?? null
  if (row === null) return () => {}
  const onClick = (): void => { activate() }
  row.addEventListener('click', onClick, true)
  return () => { row.removeEventListener('click', onClick, true) }
}

/** The collapse and hint state both entries read from the client half. */
export interface EntryInjected {
  /** Shared band-collapse store: true while the band is collapsed. */
  readonly collapsed?: BandCollapseStore | undefined
  /** One-time discovery hint for the icon-only header seat. */
  readonly hint?: FirstRunHintStore | undefined
  /**
   * The frame's left band slot owner, or null while the slot is free.
   *
   * Two band plugins take turns on that edge, so the Conversation header's seat
   * only exists while nobody owns it: a band already on screen expresses its own
   * state at the seam, and the map's entry there would read as that band's
   * control. The sidebar panel row stays as the map's own persistent entry.
   */
  readonly bandSlot?: ObservableSnapshot<string | null> | undefined
}

/**
 * Subscribe the header seat to the frame's band-slot owner.
 * @param source - the slot source, when the client half injected it.
 * @returns the owner id, or null while the slot is free (and without a source).
 */
function useBandOwner(source: ObservableSnapshot<string | null> | undefined): string | null {
  const subscribe = source === undefined
    ? () => () => {}
    : (listener: () => void) => source.subscribe(listener)
  const read = source === undefined ? () => null : () => source.getSnapshot()
  return useSyncExternalStore(subscribe, read, read)
}

/**
 * Subscribe one entry to the shared collapse store.
 * @param store - the store, when the client half injected it.
 * @returns whether the band is collapsed (false without a store).
 */
function useCollapsed(store: BandCollapseStore | undefined): boolean {
  const subscribe = store === undefined
    ? () => () => {}
    : (listener: () => void) => store.subscribe(listener)
  const read = store === undefined ? () => false : () => store.getSnapshot()
  return useSyncExternalStore(subscribe, read, read)
}

/**
 * Subscribe one entry to the one-time hint.
 * @param store - the hint store, when the client half injected it.
 * @returns whether the hint is still pending (false without a store).
 */
function useHintPending(store: FirstRunHintStore | undefined): boolean {
  const subscribe = store === undefined
    ? () => () => {}
    : (listener: () => void) => store.subscribe(listener)
  const read = store === undefined ? () => false : () => store.getSnapshot()
  return useSyncExternalStore(subscribe, read, read)
}

/** A stable stand-in for a missing panel-info source. */
const NO_PANEL_INFO = { activePanelId: null }

/**
 * Subscribe one entry to the frame's selected main panel.
 * @param source - the panel-info observable, when the client half injected it.
 * @returns the active panel id, or null while the Conversation is in front.
 */
function useActivePanelId(
  source: ObservableSnapshot<{ readonly activePanelId: string | null }> | undefined,
): string | null {
  const subscribe = source === undefined
    ? () => () => {}
    : (listener: () => void) => source.subscribe(listener)
  const read = source === undefined
    ? () => NO_PANEL_INFO.activePanelId
    : () => source.getSnapshot().activePanelId
  return useSyncExternalStore(subscribe, read, read)
}

/** Props the Conversation-header seat composes. */
export interface MapLauncherProps extends EntryInjected {
  /** Standard header-leading owner share is empty; kept optional for tests. */
  readonly children?: never
  /** The DSH locale service, when this profile provides one. */
  readonly locale?: LocaleService | undefined
}

/**
 * The Conversation header's presentation of the expand control.
 *
 * It renders only while the band is collapsed **and** the frame's left band slot
 * is free. While this band is on screen its own top bar draws the same control at
 * the same anchor; while another band plugin owns the slot, that band's surface is
 * what the seam expresses and the map's entry lives in the sidebar rows instead.
 * @param props - injected collapse store, hint, and band-slot source.
 * @returns the icon-only 「展开对话树」 button (plus its one-time hint), or nothing
 *   while the band is on screen or another band owns the slot.
 */
export function MapLauncher({ collapsed, hint, bandSlot, locale }: MapLauncherProps): ReactNode {
  const t = useLocaleT(locale)
  const hidden = useCollapsed(collapsed)
  const owner = useBandOwner(bandSlot)
  const pending = useHintPending(hint)
  const [visible, setVisible] = useState(pending)

  useEffect(() => {
    if (!hidden || owner !== null || !pending) {
      setVisible(false)
      return undefined
    }
    setVisible(true)
    const timer = setTimeout(() => {
      setVisible(false)
      hint?.dismiss()
    }, HINT_MS)
    return () => { clearTimeout(timer) }
  }, [hidden, owner, pending, hint])

  // The seat belongs to the free slot: another band's surface owns this edge now.
  if (!hidden || owner !== null) return null
  const retire = (): void => {
    setVisible(false)
    hint?.dismiss()
  }
  return (
    <LocaleProvider translator={t}>
      <span className="cm-view-toggle-seat">
        <ViewToggle
          target="expand"
          compact
          onSelect={() => {
            retire()
            collapsed?.set(false)
          }}
        />
        {pending && visible && <span className="cm-hint" aria-hidden="true">{t('view.expand')}</span>}
      </span>
    </LocaleProvider>
  )
}

/** Props the sidebar panel row's glyph composes. */
export interface MapPanelIconProps extends EntryInjected {
  /** Edge length the shell asks for, in CSS px. */
  readonly size: number
  /** The shell's own selection state; in band mode no main panel is selected. */
  readonly active?: boolean
  /** The layout's main-panel selection: a band behind a global panel is not on screen. */
  readonly panelInfo?: ObservableSnapshot<{ readonly activePanelId: string | null }> | undefined
  /** The application's status source, for the row's status cluster. */
  readonly useSessionStatus?: RootPanelProps['useSessionStatus'] | undefined
  /** The application's catalog: the main-view marker and each parent's subagents. */
  readonly useSessions?: RootPanelProps['useSessions'] | undefined
  /** The map document, for the conversations the cluster counts. */
  readonly store?: MapStore | undefined
  /** The shared status observation. */
  readonly statusLedger?: StatusLedger | undefined
  /** The DSH locale service, when this profile provides one. */
  readonly locale?: LocaleService | undefined
  /**
   * The row's one action: make sure the band is on screen.
   *
   * Called by the glyph's own watcher on the shell's row button
   * ({@link watchRowActivation}), never by a click handler of ours — the shell
   * owns the button and its `selectPanel` call still runs.
   */
  readonly activate?: (() => void) | undefined
}

/**
 * The sidebar panel row's glyph (`sidebar.panellist`, 「对话树」).
 *
 * The shell draws the row, owns its click (`selectPanel`) and its native selected
 * state; the plugin only supplies the mark. Band mode never selects a main panel,
 * so the shell's `active` is always false and the "in use" reading has to come
 * from the band itself: the glyph fills and takes the brand ink while the band is
 * **on screen** (expanded *and* the Conversation in front). That one change of
 * shape and ink is the whole marker — the row already carries the status cluster
 * next to it, and a second corner dot next to the numbers read as part of the
 * counts rather than as the band's state, so it was dropped.
 *
 * The row carries the map's status cluster whenever it is mounted — collapsed,
 * expanded, or covered by a global panel. The cluster's scope is **every indexed
 * conversation in every space**, while the tree in front shows only the active
 * space's nodes, so the row is the one place a reader can keep the whole map's
 * counts in view (and switching spaces cannot hide the other spaces' news). A
 * conversation's status still disappears only when that conversation is opened
 * or answered, never because the band changed state. The rail gets the dots-only
 * density: there is no room for counts beside an 18px icon.
 *
 * The same glyph is also the plugin's only handle on its own row: it watches the
 * shell button's activation so the one-way "make sure the band is on screen"
 * gesture still arrives when a sibling plugin navigates the centre back in the
 * same notification, which is exactly the case where the `main` bridge never
 * mounts.
 * @param props - shell-provided edge length, the injected collapse store, the
 *   layout's main-panel selection, and the row's one action.
 * @returns the glyph plus its state marker.
 */
export function MapPanelIcon({
  collapsed, panelInfo, size, useSessionStatus, useSessions, store, statusLedger, activate, locale,
}: MapPanelIconProps): ReactNode {
  const t = useLocaleT(locale)
  const hidden = useCollapsed(collapsed)
  const activePanelId = useActivePanelId(panelInfo)
  const glyph = useRef<HTMLSpanElement | null>(null)
  // The injected action has a stable identity, but the watcher is registered
  // once: keep the latest callback behind a ref instead of re-binding the row's
  // listener on every render (a status poll re-renders this glyph regularly).
  const activation = useRef(activate)
  activation.current = activate
  useEffect(() => watchRowActivation(glyph.current, () => { activation.current?.() }), [])
  // Without the collapse store there is no band to report as on screen: the
  // outline reading is the only honest one.
  const onScreen = collapsed !== undefined && !hidden && activePanelId === null

  const statuses = (useSessionStatus?.((snapshot) => snapshot) ?? NO_STATUSES) as ReadonlyMap<string, SessionStatusLike>
  const catalog = (useSessions?.((state) => state) ?? NO_CATALOG) as CatalogState
  const ledgerSnapshot = useSyncExternalStore(
    useCallback(notify => statusLedger?.subscribe(notify) ?? (() => {}), [statusLedger]),
    useCallback(() => statusLedger?.getSnapshot() ?? NO_OBSERVED, [statusLedger]),
    useCallback(() => statusLedger?.getSnapshot() ?? NO_OBSERVED, [statusLedger]),
  )
  const mapSnapshot = useSyncExternalStore(
    useCallback(notify => store?.subscribe(notify) ?? (() => {}), [store]),
    useCallback(() => store?.getSnapshot() ?? null, [store]),
    useCallback(() => store?.getSnapshot() ?? null, [store]),
  )

  // This sidebar row is the always-mounted observer: it is the only plugin seat
  // that stays mounted while the band is collapsed. The panel observes too when
  // it is visible; applying the same snapshot twice is harmless.
  const liveIds = useMemo(() => catalog.ids.filter(id => {
    const row = catalog.byId[id]
    return row?.origin !== 'subagent' && row?.blank !== true
  }), [catalog])
  useEffect(() => {
    // An empty catalog means "not loaded" or "no Sessions", never "prune
    // everything": without ids the observation must not delete known entries.
    statusLedger?.observe(statuses, liveIds.length > 0 ? liveIds : undefined)
  }, [statusLedger, statuses, liveIds])

  // The "fresh" halo on the cluster needs a clock: the counts only change when a
  // status does, so a minute tick lets a halo retire on its own (the panel runs
  // the same tick while it is mounted).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 60000)
    return () => { clearInterval(timer) }
  }, [])

  // The product never marks its main view unread (`ui-session`'s status
  // controller assumes that conversation is in front of the reader), so a turn
  // that finishes while a global panel covers the Conversation would be silent.
  // This row is the always-mounted observer: it watches the transition and keeps
  // the completion in the shared ledger, so the sidebar cluster **and** the map's
  // node rows show the same mark until the conversation is opened
  // (see completion-watch.ts).
  const mainId = catalog.ids.find(id => (catalog.byId[id]?.retainedBy?.mainView ?? 0) > 0) ?? null
  const covered = activePanelId !== null
  const runningBefore = useRef<ReadonlyMap<string, boolean> | null>(null)
  useEffect(() => {
    if (statusLedger === undefined) return
    const running = new Map<string, boolean>()
    const unread = new Set<string>()
    for (const [sessionId, status] of statuses) {
      running.set(sessionId, sessionRunning(sessionId, statuses, catalog))
      if (status.completionUnread === true) unread.add(sessionId)
    }
    // Capture the previous observation before the updater runs: React may invoke
    // it later, and a ref read inside it would then see a newer snapshot.
    const previous = runningBefore.current
    runningBefore.current = running
    statusLedger.setCompletions(nextCoveredCompletions({
      held: statusLedger.getCompletions(),
      previous,
      running,
      unread,
      mainSessionId: mainId,
      covered,
      now: Date.now(),
    }))
  }, [statuses, catalog, covered, mainId, statusLedger])

  /**
   * This row's global status cluster.
   *
   * The sidebar row is the map's only always-mounted seat, and its scope is the
   * whole map, not the space in front: the same four categories, in the same
   * order, as a node row's rollup — the mark the reader already reads in the
   * columns, not a second count language of its own. The tree shows one space at
   * a time, so this cluster is the place that answers "is anything moving in the
   * spaces I am not looking at?"; it is shown whether the band is collapsed,
   * expanded, or covered by a global panel (the conversation status itself still
   * clears only when that conversation is opened or answered). The conversation
   * the product considers current keeps its attention categories out — they are
   * already in front of the reader — but keeps its running ring: a conversation
   * that is still working is live context, the same reading a node row gives the
   * open conversation. The one
   * attention exception is a stop the product cannot mark — the main session
   * finishing behind a covering panel — which the shared ledger holds (see
   * completion-watch.ts).
   *
   * Classification mirrors `MapPanel`'s categories map, including a parent that
   * is running because one of its subagents is: pending beats running, running
   * beats a forwarded error, an error beats an unread completion.
   */
  const rollup = useMemo<StatusRollup | undefined>(() => {
    if (store === undefined || statusLedger === undefined) return undefined
    const doc = mapSnapshot?.doc
    if (doc === undefined) return undefined
    const errors = statusLedger.getErrors()
    const counts: StatusCounts = { pending: 0, error: 0, done: 0, running: 0 }
    const counted = new Set<string>()
    const threadIds = new Set<string>()
    let fresh: StatusCategory | undefined
    let freshAt = 0
    for (const thread of doc.threads) {
      const sessionId = thread.sessionId
      threadIds.add(sessionId)
      const status = statuses.get(sessionId)
      const running = sessionRunning(sessionId, statuses, catalog)
      let category: StatusCategory | undefined
      // The current conversation keeps only its running context: its attention
      // categories are already on screen, but the shipped status still reports a
      // conversation that is in front as running, and a lone running session is
      // exactly the case this row exists to surface while the band is off screen.
      if (sessionId === mainId) {
        if (running) category = 'running'
      } else if (status?.pendingInteraction !== undefined) category = 'pending'
      else if (running) category = 'running'
      else if (errors.get(sessionId) !== undefined) category = 'error'
      else if (status?.completionUnread === true) category = 'done'
      if (category === undefined) continue
      counts[category] += 1
      counted.add(sessionId)
      if (category === 'running') continue
      // The halo follows the ledger's own transition stamp: a first sighting has
      // none (0), so a count that was already there when the row mounted is not
      // announced as new.
      const observed = ledgerSnapshot.get(sessionId)
      const changedAt = observed?.category === category ? observed.changedAt : 0
      if (changedAt > 0 && now - changedAt < FRESH_MS && changedAt > freshAt) {
        fresh = category
        freshAt = changedAt
      }
    }
    // The product never marks its main view unread, so a stop behind a covering
    // panel is held in the ledger instead (completion-watch.ts) and counted here
    // until the conversation is opened. The guards keep a held entry from
    // double-counting the moment the product or a new turn takes it over, and the
    // conversation in front of the reader is never shown as unread.
    for (const [sessionId, completedAt] of statusLedger.getCompletions()) {
      if (!threadIds.has(sessionId) || counted.has(sessionId)) continue
      if (sessionId === mainId && !covered) continue
      const status = statuses.get(sessionId)
      if (status?.running === true || status?.completionUnread === true) continue
      counts.done += 1
      if (now - completedAt < FRESH_MS && completedAt > freshAt) {
        fresh = 'done'
        freshAt = completedAt
      }
    }
    const total = counts.pending + counts.error + counts.done + counts.running
    if (total === 0) return undefined
    return {
      counts,
      direct: { ...counts },
      total,
      attention: counts.pending + counts.error + counts.done,
      ...(fresh === undefined ? {} : { fresh }),
    }
  }, [store, statusLedger, mapSnapshot, statuses, catalog, ledgerSnapshot, now, mainId, covered])

  // Shown whether the band is on screen or not: the tree in front covers one
  // space only, so this row is where the map-wide counts stay in view (a global
  // panel covering an expanded band is just another state where the row is the
  // only home for them). The 56px rail gets the dots density: an 18px icon-only
  // row has no room for the counts, so the rail keeps the colour reading and the
  // full numbers live in the title.
  const rail = size > 16
  const statusTitle = rollup === undefined
    ? undefined
    : rollup.attention > 0
      ? t('entries.pendingCount', { n: rollup.attention })
      : t('entries.runningCount', { n: rollup.counts.running })
  const title = onScreen
    ? statusTitle === undefined
      ? t('entries.titleOnScreen')
      : t('entries.titleOnScreenWithStatus', { status: statusTitle })
    : statusTitle === undefined
      ? t('common.panelTitle')
      : t('entries.titleWithStatus', { status: statusTitle })
  return (
    <LocaleProvider translator={t}>
      <span
        ref={glyph}
        className="cm-panel-glyph"
        data-seat={rail ? 'rail' : 'wide'}
        data-in-use={onScreen ? 'true' : 'false'}
        title={title}
        {...(rollup === undefined ? {} : { 'aria-label': title })}
      >
        <MapGlyph size={size} filled={onScreen} />
        {rollup !== undefined && (
          <StatusRollupBadge
            rollup={rollup}
            density={rail ? 'dots' : 'cluster'}
            scope={t('entries.scopeAllIndexed')}
          />
        )}
      </span>
    </LocaleProvider>
  )
}

/** Props the `main` entry bridge composes. */
export interface MapEntryBridgeProps {
  /** Shared band-collapse store: true while the band is collapsed. */
  readonly collapsed?: BandCollapseStore | undefined
  /** Reveal the Conversation (a global panel owns the centre during the click). */
  readonly reveal?: (() => void) | undefined
  /** Expand the band (claims the frame's band slot first). */
  readonly open?: (() => void) | undefined
}

/**
 * The `main` panel behind the sidebar's 「对话树」 row.
 *
 * The shell's row only knows `selectPanel(id)`, and its id must name a registered
 * main panel, so this panel has to exist — but the row's action is **not** driven
 * from here. The primary channel is the glyph's watcher on the shell button
 * ({@link watchRowActivation}): it survives a sibling plugin navigating the
 * centre back to the Conversation in the same notification, where this panel is
 * never rendered at all. The bridge is the fallback for that channel: selecting
 * it is what took the Conversation off screen, so it hands the centre back, and
 * if the row action has not run yet (no watcher, e.g. a future shell that stops
 * rendering the glyph inside a button) it also asks to expand.
 *
 * It paints nothing: the Conversation is one render away, and a placeholder
 * would flash over the view it returns to.
 * @param props - the injected collapse store and the reveal/open actions.
 * @returns nothing; the panel exists only for its mounting gesture.
 */
export function MapEntryBridge({ collapsed, reveal, open }: MapEntryBridgeProps): ReactNode {
  const requested = useRef(false)
  useLayoutEffect(() => {
    if (requested.current) return
    requested.current = true
    // Reveal first: selecting this panel is what took the Conversation off
    // screen, and the expand request must land on a mounted Conversation column.
    reveal?.()
    if (collapsed?.getSnapshot() === true) open?.()
  }, [collapsed, reveal, open])
  return null
}
