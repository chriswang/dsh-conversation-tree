import type { store as zh } from '../zh/store.js'

/** `store` domain: synchronization notices (English). */
export const store: Record<keyof typeof zh, string> = {
  'store.syncRetry': 'Sync interrupted; retrying ({detail})',
  'store.localAdopted': 'The local tree differed from the Host; a backup was kept and the Host version adopted',
  'store.droppedChanges': '{count} change(s) were dropped because topics had changed',
  'store.refreshedConflict': 'Another writer changed the tree; refreshed to the latest revision',
}
