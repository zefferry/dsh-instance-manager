/**
 * Cross-process workspace sync.
 *
 * DSH keeps the workspace domain in `<DSH_HOME>/storages/workspace.json` and
 * caches it in memory per process. The desktop host and every running instance
 * are separate processes sharing that file, so a workspace created in one place
 * stays invisible everywhere else until its file is re-read.
 *
 * This module mirrors the file into the live `workspaceRegistry` memory and
 * replays the storage domain events so the WorkspaceFeed (and therefore every
 * client) publishes the change.
 *
 * It is intentionally read-only: the plugin never writes the DSH storage file,
 * it only mirrors what is already on disk.
 *
 * The mirror is *lazy*: nothing is polled. The host calls `sync()` when the
 * window regains focus (or when the user presses refresh), so an idle app does
 * no disk work at all.
 */
import fs from 'node:fs'
import path from 'node:path'

function readUnit(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object') return null
    if (!value.unit || value.unit.name !== 'workspace') return null
    if (!value.global || typeof value.global !== 'object') return null
    if (!value.tables || typeof value.tables !== 'object') return null
    return value
  } catch {
    return null
  }
}

function recordsOf(unit) {
  const table = unit.tables && unit.tables.workspaces
  return table && typeof table === 'object' ? table : {}
}

function sameValue(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

export function installWorkspaceSync(ctx, { home, log = console }) {
  const storageFile = path.join(home, 'storages', 'workspace.json')
  let inflight = null
  let warned = false

  const warnOnce = (error) => {
    if (warned) return
    warned = true
    log.warn('[instance-manager] 工作区同步失败：', error && error.message ? error.message : error)
  }

  const sync = (options = {}) => {
    if (inflight) return inflight
    const promise = (async () => {
      try {
      let registry
      try {
        registry = ctx.get('workspaceRegistry')
      } catch (error) {
        return
      }
      if (!registry) return
      if (!registry.state || typeof registry.state !== 'object') return
      const unit = readUnit(storageFile)
      if (!unit) return
      const global = unit.global
      // Only an in-flight mutation blocks the merge. A falsy value (false/null)
      // used to dead-lock sync forever.
      if (global.pendingMutation) return
      const replay = Boolean(options && options.replay)
      const incoming = recordsOf(unit)
      const table = registry.table
      const current = table && table.records instanceof Map ? table.records : null
      if (!current) return

      // Merge, never clobber: another process may have written a snapshot that
      // predates a session this process just created. Keeping the union of
      // session ids prevents a just-created Session from falling into the
      // client-side "Ungrouped" bucket right after a focus-triggered sync.
      const mergeRecord = (prev, record) => {
        if (!prev) return record
        const before = Array.isArray(prev.sessionIds) ? prev.sessionIds : []
        const next = Array.isArray(record && record.sessionIds) ? record.sessionIds : []
        const extras = before.filter((id) => !next.includes(id))
        return extras.length ? { ...record, sessionIds: [...next, ...extras] } : record
      }
      const changed = []
      for (const [id, record] of Object.entries(incoming)) {
        const merged = mergeRecord(current.get(id), record)
        if (!sameValue(current.get(id), merged)) changed.push([id, merged])
      }

      // A record that only exists in memory is kept: another process may have
      // written a snapshot that predates a Workspace this process just created,
      // and dropping it would make the Workspace (and its Sessions) disappear.
      // Deletions therefore propagate on the next host start, not mid-session.
      const removed = []
      const mergedGlobal = { ...global }
      const storedIds = Array.isArray(global.workspaceIds) ? [...global.workspaceIds] : []
      const extras = []
      for (const id of current.keys()) {
        if (storedIds.includes(id) || removed.includes(id)) continue
        extras.push(id)
      }
      if (extras.length) mergedGlobal.workspaceIds = [...storedIds, ...extras]
      const stateChanged = !sameValue(registry.state, mergedGlobal)

      // Apply the merged snapshot first, then index any Session id this process
      // has not seen yet (the sidebar resolves rows through that index).
      registry.state = mergedGlobal
      for (const [id, record] of changed) current.set(id, record)
      for (const id of removed) current.delete(id)
      if (typeof registry.rebuildEntities === 'function') registry.rebuildEntities()
      const known = registry.sessionPaths instanceof Map ? registry.sessionPaths : new Map()
      const missing = registry.missingSessionPaths instanceof Set ? registry.missingSessionPaths : new Set()
      const unknownSessions = []
      for (const record of current.values()) {
        const ids = Array.isArray(record && record.sessionIds) ? record.sessionIds : []
        for (const sessionId of ids) {
          if (!known.has(sessionId) && !missing.has(sessionId) && !unknownSessions.includes(sessionId)) unknownSessions.push(sessionId)
        }
      }

      if (unknownSessions.length && typeof registry.indexHeaders === 'function') {
        try {
          const persistence = ctx.get('sessionPersistence')
          if (persistence && typeof persistence.list === 'function') {
            const headers = (await persistence.list())
              .map((entry) => (entry && entry.header ? entry.header : null))
              .filter((header) => header && unknownSessions.includes(header.id))
            if (headers.length) await registry.indexHeaders(headers)
          }
        } catch (error) {
          warnOnce(error)
        }
      }

      const emit = (payload) => {
        try {
          ctx.emit('domain/changed', payload)
        } catch (error) {
          warnOnce(error)
        }
      }
      if (!replay && !stateChanged && changed.length === 0 && removed.length === 0) return
      // A replay pass is used by the focus-triggered `/sync`: a client can miss
      // an increment (for example while its tab was hidden), and emitting only
      // real diffs would leave its Workspace views stale, dropping its Sessions
      // into "Ungrouped" until the next full reload. Replaying is cheap: a
      // handful of Workspace records per focus sync.
      if (replay || stateChanged) {
        emit({ domain: 'workspace', table: '', key: '', operation: 'put', value: mergedGlobal })
      }
      for (const [id, record] of replay ? current : changed) {
        emit({ domain: 'workspace', table: 'workspaces', key: id, operation: 'put', value: record })
      }
      for (const id of removed) {
        emit({ domain: 'workspace', table: 'workspaces', key: id, operation: 'deleted', value: null })
      }
    } catch (error) {
      warnOnce(error)
    }
    })()
    inflight = promise
    promise.then(
      () => { if (inflight === promise) inflight = null },
      () => { if (inflight === promise) inflight = null },
    )
    return promise
  }

  // One pass at startup so a process that booted after another instance's last
  // workspace write converges immediately. After that there is no timer: the
  // host drives refreshed passes through `sync()`.
  void sync()

  return {
    sync,
    dispose() {
      /* no timer / watcher to release */
    },
  }
}
