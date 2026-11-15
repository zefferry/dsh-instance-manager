// Instance Manager — client half (DSH web UI plugin bundle).
// Registered through the shell module loader; requires only seeded shell modules.
window.__ModuleLoader__.load({
  id: '@local/dsh-instance-manager',
  factory: (require) => {
    const React = require('react')
    const ui = require('@deepseek-ai/dsh-client-ui-primitives')
    let ReactDOMClient = null
    try {
      ReactDOMClient = require('react-dom/client')
    } catch {
      try {
        ReactDOMClient = require('react-dom')
      } catch {
        ReactDOMClient = null
      }
    }

    const h = React.createElement
    const NS = 'instance-manager'
    const ROOT = '/plugins/instance-manager'
    let LANG = 'zh'
    let ctxRef = null

    const t = (zh, en) => (LANG === 'zh' ? zh : en)
    const icon = (name, fallbackGlyph) => ui[name] || (() => h('span', null, fallbackGlyph || ''))

    // ------------------------------------------------------------------
    // store + API
    // ------------------------------------------------------------------
    const store = { state: null, error: '', actionError: '', listeners: new Set(), inflight: false }
    const emit = () => {
      for (const listener of [...store.listeners]) listener()
    }
    const subscribe = (listener) => {
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    }
    const snapshot = () => store.state

    async function api(path, init) {
      const response = await fetch(ROOT + path, {
        credentials: 'same-origin',
        ...(init || {}),
        headers: { 'content-type': 'application/json', ...(init && init.headers ? init.headers : {}) },
      })
      const text = await response.text()
      let body = {}
      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        body = {}
      }
      if (!response.ok || body.ok !== true) {
        throw Error((body && body.error && body.error.message) || `HTTP ${response.status}`)
      }
      return body.value
    }

    // The desktop and every instance share one DSH_HOME: sessions and workspaces
    // written by another process only show up in this window after the native
    // stores refresh. The host exposes a cheap revision digest; when it changes we
    // ask the native session store to re-list (it reads persisted sessions from
    // disk, so cross-process sessions are included).
    let lastRevision = null
    function syncNativeStores(state) {
      const revision = state && state.revision ? String(state.revision) : ''
      if (!revision) return
      if (lastRevision === null) {
        lastRevision = revision
        return
      }
      if (revision === lastRevision) return
      lastRevision = revision
      refreshNativeStores()
      try {
        const ctx = ctxRef
        const workspaces = ctx && typeof ctx.get === 'function' ? ctx.get('workspaces') : null
        if (workspaces && typeof workspaces.refresh === 'function') workspaces.refresh()
      } catch {
        /* ignored */
      }
    }

    async function refresh() {
      if (store.inflight) {
        // A retry may be clicked while a request is still in flight (for example
        // one started before the host came back). Run once more when it settles.
        store.queued = true
        return false
      }
      store.inflight = true
      try {
        const next = await api('/state')
        store.state = next
        store.error = ''
        store.failures = 0
        syncNativeStores(next)
        return true
      } catch (error) {
        store.error = error && error.message ? error.message : String(error)
        store.failures = (store.failures || 0) + 1
        return false
      } finally {
        store.inflight = false
        if (!store.state && store.error) scheduleBootRetry()
        else clearBootRetry()
        ensureFastPoll(store.state)
        emit()
        if (store.queued) {
          store.queued = false
          void refresh()
        }
      }
    }

    // Ask the shell's own stores to re-list. Session data and workspace data are
    // shared on disk, so a refresh is what makes another process's writes visible.
    function refreshNativeStores() {
      const ctx = ctxRef
      if (!ctx || typeof ctx.get !== 'function') return
      try {
        const sessions = ctx.get('sessions')
        if (sessions && typeof sessions.refresh === 'function') sessions.refresh()
      } catch {
        /* native session store not ready */
      }
      try {
        const workspaces = ctx.get('workspaces')
        if (workspaces && typeof workspaces.refresh === 'function') workspaces.refresh()
      } catch {
        /* native workspace store not ready */
      }
    }

    // Nothing polls while the app is idle: the desktop session/workspace data is
    // shared on disk, so we refresh it when the window regains focus (or when the
    // user presses the refresh button). A 1s poll is added only while a state
    // machine is actively moving (provisioning, starting, stopping, icon job).
    let busyTimer = 0
    let focusTimer = 0
    let syncing = false
    let focusBound = false
    let focusHandlers = null
    let bootRetryTimer = 0

    // A failed first load means no panels are registered yet (the mode is unknown),
    // so keep retrying in the background until the host answers again. This is a
    // bounded bootstrap retry, not a general poll.
    function scheduleBootRetry() {
      if (bootRetryTimer) return
      const failures = Math.max(1, store.failures || 1)
      const delay = Math.min(30000, 5000 * Math.pow(2, Math.min(failures - 1, 3)))
      bootRetryTimer = setTimeout(() => {
        bootRetryTimer = 0
        if (!store.state) void refresh()
      }, delay)
    }
    function clearBootRetry() {
      if (!bootRetryTimer) return
      clearTimeout(bootRetryTimer)
      bootRetryTimer = 0
    }

    function needsFastPoll(state) {
      if (!state) return false
      const instances = Array.isArray(state.instances) ? state.instances : []
      for (const instance of instances) {
        if (!instance) continue
        if (instance.status === 'starting' || instance.status === 'stopping') return true
        if (instance.provision && instance.provision.done === false) return true
        if (instance.iconGenerating) return true
      }
      return false
    }

    function busyDelay() {
      const failures = store.failures || 0
      if (!failures) return 1000
      return Math.min(8000, 1000 * Math.pow(2, Math.min(failures, 3)))
    }

    function scheduleBusyPoll() {
      if (busyTimer) return
      busyTimer = setTimeout(async () => {
        busyTimer = 0
        if (!needsFastPoll(store.state)) return
        if (!isHidden()) await refresh()
        if (needsFastPoll(store.state)) scheduleBusyPoll()
      }, busyDelay())
    }

    function ensureFastPoll(state) {
      if (needsFastPoll(state)) {
        scheduleBusyPoll()
        return
      }
      if (busyTimer) {
        clearTimeout(busyTimer)
        busyTimer = 0
      }
    }

    // Another process may still be flushing its workspace/session writes while
    // this window regains focus, so a single pass can arrive a moment too early.
    // Follow up twice with single-shot passes (never a recurring poll) and give
    // the native session store a second chance to list them.
    let followTimers = []
    function isHidden() {
      return typeof document !== 'undefined' && document.visibilityState === 'hidden'
    }
    function clearFollowTimers() {
      for (const timer of followTimers) clearTimeout(timer)
      followTimers = []
    }
    async function syncNow(options) {
      if (syncing) return
      syncing = true
      const follow = Boolean(options && options.follow)
      if (!follow) clearFollowTimers()
      try {
        const next = await api('/sync', { method: 'POST', body: '{}' })
        store.state = next
        store.error = ''
        refreshNativeStores()
        if (follow) {
          followTimers.push(setTimeout(() => { if (!isHidden()) refreshNativeStores() }, 900))
        } else {
          followTimers = [
            setTimeout(() => { void syncNow({ follow: true }) }, 1500),
            setTimeout(() => { void syncNow({ follow: true }) }, 5000),
          ]
        }
      } catch (error) {
        store.error = error && error.message ? error.message : String(error)
      } finally {
        syncing = false
        ensureFastPoll(store.state)
        emit()
      }
    }

    function scheduleSync() {
      if (focusTimer) return
      focusTimer = setTimeout(() => {
        focusTimer = 0
        void syncNow()
      }, 200)
    }

    function bindFocusSync() {
      if (focusBound || typeof window === 'undefined') return
      focusBound = true
      const onFocus = () => scheduleSync()
      const onVisibility = () => {
        if (document.visibilityState === 'visible') scheduleSync()
      }
      focusHandlers = { onFocus, onVisibility }
      window.addEventListener('focus', onFocus)
      window.addEventListener('pageshow', onFocus)
      document.addEventListener('visibilitychange', onVisibility)
    }

    function unbindFocusSync() {
      if (!focusBound || !focusHandlers) return
      focusBound = false
      window.removeEventListener('focus', focusHandlers.onFocus)
      window.removeEventListener('pageshow', focusHandlers.onFocus)
      document.removeEventListener('visibilitychange', focusHandlers.onVisibility)
      focusHandlers = null
    }

    // Visible but unfocused windows (for example a web-mode instance in a
    // background tab) get no focus event, so their view of shared workspace
    // data would go stale. This tiny probe only asks for the revision number;
    // a full /sync only runs when the data actually changed.
    let revisionTimer = 0
    let revisionChecking = false
    function checkRevision() {
      if (revisionChecking || syncing || isHidden()) return
      if (!store.state || !store.state.revision) return
      revisionChecking = true
      api('/revision')
        .then((value) => {
          if (!value || !value.revision) return
          const current = store.state && store.state.revision
          if (current && value.revision !== current) void syncNow()
        })
        .catch(() => {})
        .finally(() => { revisionChecking = false })
    }

    function startPolling() {
      bindFocusSync()
      if (!revisionTimer) revisionTimer = setInterval(checkRevision, 3000)
      void refresh()
    }
    function stopPolling() {
      unbindFocusSync()
      if (revisionTimer) clearInterval(revisionTimer)
      revisionTimer = 0
      if (busyTimer) clearTimeout(busyTimer)
      busyTimer = 0
      if (focusTimer) clearTimeout(focusTimer)
      focusTimer = 0
      clearBootRetry()
      clearFollowTimers()
    }

    const useStore = () => React.useSyncExternalStore(subscribe, snapshot, snapshot)
    const useStoreError = () => React.useSyncExternalStore(subscribe, () => store.error, () => store.error)
    const useActionError = () => React.useSyncExternalStore(subscribe, () => store.actionError, () => store.actionError)
    const useOrigins = () => {
      const state = useStore()
      return (state && state.sessionOrigins) || {}
    }
    const useHello = () => {
      const state = useStore()
      return (state && state.hello) || {}
    }

    // ------------------------------------------------------------------
    // formatting helpers
    // ------------------------------------------------------------------
    const STATUS_COLORS = {
      running: 'var(--dsw-alias-state-success-primary)',
      starting: 'var(--dsw-alias-state-warn-primary)',
      stopped: 'var(--dsw-alias-label-dimmed)',
      error: 'var(--dsw-alias-state-error-primary)',
    }
    const SESSION_STATE_COLORS = {
      ongoing: 'var(--dsw-alias-brand-primary)',
      warning: 'var(--dsw-alias-state-warn-primary)',
      done: 'var(--dsw-alias-state-success-primary)',
      idle: 'var(--dsw-alias-label-dimmed)',
    }
    const statusLabel = (status) => {
      if (status === 'running') return t('运行中', 'Running')
      if (status === 'starting') return t('启动中', 'Starting')
      if (status === 'error') return t('错误', 'Error')
      return t('已停止', 'Stopped')
    }

    function relativeTime(iso) {
      if (!iso) return ''
      const time = Date.parse(iso)
      if (!Number.isFinite(time)) return ''
      const diff = Date.now() - time
      if (diff < 60_000) return t('刚刚', 'just now')
      if (diff < 3_600_000) return t('{n} 分钟前', '{n} min ago').replace('{n}', Math.floor(diff / 60_000))
      if (diff < 86_400_000) return t('{n} 小时前', '{n} h ago').replace('{n}', Math.floor(diff / 3_600_000))
      return new Date(time).toLocaleDateString(LANG === 'zh' ? 'zh-CN' : 'en-US')
    }

    async function copyText(value) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value)
          return true
        }
      } catch {
        /* fall through to the legacy path */
      }
      const area = document.createElement('textarea')
      area.value = value
      document.body.appendChild(area)
      area.select()
      try {
        document.execCommand('copy')
      } catch {
        /* ignored */
      }
      area.remove()
      return true
    }

    // Native folder dialog, exactly like the desktop app's "add workspace" flow.
    async function pickFolder() {
      const current = ctxRef
      const uiWorkspace = current && typeof current.get === 'function' ? current.get('uiWorkspace') : null
      if (!uiWorkspace || typeof uiWorkspace.pickDirectory !== 'function') {
        throw Error(t('当前环境不支持系统目录选择，请直接输入路径。', 'Native folder picking is unavailable here; type the path instead.'))
      }
      const picked = await uiWorkspace.pickDirectory()
      return typeof picked === 'string' && picked ? picked : null
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(reader.error || Error('读取图片失败'))
        reader.readAsDataURL(file)
      })
    }

    // Center-crop to a square icon and encode as PNG (keeps uploads small).
    function cropIcon(file) {
      return new Promise((resolve, reject) => {
        readFileAsDataUrl(file)
          .then((dataUrl) => {
            const image = new Image()
            image.onload = () => {
              const side = Math.min(image.naturalWidth, image.naturalHeight)
              const sx = Math.round((image.naturalWidth - side) / 2)
              const sy = Math.round((image.naturalHeight - side) / 2)
              const width = 256
              const height = 256
              const canvas = document.createElement('canvas')
              canvas.width = width
              canvas.height = height
              const context = canvas.getContext('2d')
              context.imageSmoothingQuality = 'high'
              context.drawImage(image, sx, sy, side, side, 0, 0, width, height)
              resolve(canvas.toDataURL('image/png'))
            }
            image.onerror = () => reject(Error('无法解析图片'))
            image.src = dataUrl
          })
          .catch(reject)
      })
    }

    const initialOf = (name) => (String(name || '?').trim().charAt(0) || '?').toUpperCase()

    function iconUrl(record) {
      if (!record) return ''
      const version = record.iconVersion || record.kernelVersion || ''
      return `${ROOT}/icon?id=${encodeURIComponent(record.id || '')}&v=${encodeURIComponent(version)}`
    }

    function setActionError(message) {
      store.actionError = message || ''
      emit()
    }

    function openInstance(record) {
      if (!record) return
      if (record.accessMode === 'desktop-app') {
        api('/open-shell', { method: 'POST', body: JSON.stringify({ id: record.id }) })
          .catch((reason) => {
            const message = reason && reason.message ? reason.message : String(reason)
            console.warn('[instance-manager] 桌面窗口打开失败：', message)
            if (record.url) {
              window.open(record.url, '_blank', 'noopener')
            } else {
              setActionError(t('桌面窗口没有响应，请先启动分身再试一次。', 'The desktop window did not respond. Start the instance and try again.'))
            }
          })
        return
      }
      if (record.url) window.open(record.url, '_blank', 'noopener')
    }

    // ------------------------------------------------------------------
    // shared bits
    // ------------------------------------------------------------------
    function StatusBar({ status, title, onClick }) {
      return h(onClick ? 'button' : 'span', {
        className: 'im-statusbar',
        type: onClick ? 'button' : undefined,
        style: { background: STATUS_COLORS[status] || STATUS_COLORS.stopped },
        title: title || statusLabel(status),
        'aria-label': onClick ? title || statusLabel(status) : undefined,
        onClick: onClick || undefined,
      })
    }

    function InstanceIcon({ record, size = 52, className = '' }) {
      const style = { width: size, height: size, borderRadius: Math.round(size / 4) }
      if (record && record.hasIcon) {
        return h('img', {
          className: `im-instance-icon ${className}`.trim(),
          style,
          src: iconUrl(record),
          alt: record.name || '',
        })
      }
      return h('span', { className: `im-instance-icon im-instance-icon-fallback ${className}`.trim(), style }, initialOf(record && record.name))
    }

    function ProgressBar({ provision }) {
      if (!provision) return null
      const percent = Math.max(0, Math.min(100, Number(provision.percent) || 0))
      return h('div', { className: 'im-progress' },
        h('div', { className: 'im-progress-track' }, h('div', { className: 'im-progress-fill', style: { width: `${percent}%` } })),
        h('div', { className: 'im-progress-text' },
          h('span', null, provision.message || t('正在处理…', 'Working…')),
          h('span', { className: 'im-progress-percent' }, `${percent}%`)))
    }

    function Notice({ children, tone }) {
      if (!children) return null
      return h('div', { className: 'im-notice', 'data-tone': tone || 'info', role: tone === 'error' ? 'alert' : undefined }, children)
    }

    // ------------------------------------------------------------------
    // sidebar entry
    // ------------------------------------------------------------------
    function InstanceGlyph({ size = 16, className = 'im-nav-svg' }) {
      return h('svg', {
        className,
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': 'true',
      },
        h('rect', { x: 3.6, y: 3.4, width: 16.8, height: 5.2, rx: 1.7, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('rect', { x: 3.6, y: 9.4, width: 16.8, height: 5.2, rx: 1.7, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('rect', { x: 3.6, y: 15.4, width: 16.8, height: 5.2, rx: 1.7, stroke: 'currentColor', strokeWidth: 1.5 }))
    }

    function InstancesNavIcon(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 16
      const state = useStore()
      const instances = state && Array.isArray(state.instances) ? state.instances : []
      const active = instances.filter((item) => item && (item.status === 'running' || item.status === 'starting')).length
      return h('span', { className: 'im-nav-wrap' },
        h(InstanceGlyph, { size }),
        active > 0
          ? h('span', { className: 'im-nav-badge', 'aria-label': t(active + ' 个运行中', active + ' running') }, String(active))
          : null)
    }

    // ------------------------------------------------------------------
    // list page
    // ------------------------------------------------------------------
    function StatusFilter({ value, onChange, counts }) {
      const options = [
        { id: 'all', label: t('全部', 'All') },
        { id: 'running', label: t('运行中', 'Running') },
        { id: 'stopped', label: t('已停止', 'Stopped') },
        { id: 'error', label: t('错误', 'Error') },
      ]
      return h('div', { className: 'im-status-seg', role: 'tablist' },
        options.map((option) => h('button', {
          key: option.id,
          type: 'button',
          role: 'tab',
          'aria-selected': value === option.id ? 'true' : 'false',
          'data-active': value === option.id ? 'true' : 'false',
          className: 'im-seg',
          onClick: () => onChange(option.id),
        },
          h('span', { className: 'im-seg-label' }, option.label),
          h('span', { className: 'im-seg-count' }, String(counts && Number.isFinite(counts[option.id]) ? counts[option.id] : 0)))))
    }

    function IconButton({ label, glyph, size = 16, disabled, tone, onClick }) {
      return h('button', {
        type: 'button',
        className: 'im-icon-btn',
        title: label,
        'aria-label': label,
        'data-tone': tone || 'neutral',
        disabled,
        onClick: (event) => {
          event.preventDefault()
          event.stopPropagation()
          onClick()
        },
        onDoubleClick: (event) => {
          event.preventDefault()
          event.stopPropagation()
        },
      }, h(glyph, { size }))
    }

    function InstanceCard({ record, onOpen, onStart, onStop, onRestart, busy, canDrag, dragActive, dragging, onDragStart, onDragEnd, onDrop }) {
      const running = record.status === 'running'
      const starting = record.status === 'starting'
      const provisioning = record.provision && !record.provision.done
      const stoppedLike = record.status === 'stopped' || record.status === 'error'
      const handleDoubleClick = () => {
        if (provisioning || starting) return
        if (stoppedLike) {
          onOpen(record.id)
          return
        }
        if (running) openInstance(record)
      }
      return h('div', {
        className: 'im-card',
        role: 'button',
        tabIndex: 0,
        'aria-label': record.name,
        'data-dragging': dragging ? 'true' : undefined,
        draggable: canDrag && !starting,
        onDragStart: (event) => {
          if (!canDrag) return
          try {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', record.id)
          } catch {
            /* ignored */
          }
          onDragStart(record.id)
        },
        onDragEnd: () => onDragEnd(),
        onDragOver: (event) => {
          if (!dragActive) return
          event.preventDefault()
          try {
            event.dataTransfer.dropEffect = 'move'
          } catch {
            /* ignored */
          }
        },
        onDrop: (event) => {
          event.preventDefault()
          onDrop(record.id)
        },
        onDoubleClick: handleDoubleClick,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            handleDoubleClick()
          }
        },
        title: stoppedLike ? t('双击打开设置', 'Double-click for settings') : running ? t('双击打开分身', 'Double-click to open') : '',
      },
        h('div', { className: 'im-card-icon' }, h(InstanceIcon, { record, size: 52 })),
        h('div', { className: 'im-card-main' },
          h('div', { className: 'im-card-title-row' },
            h('span', { className: 'im-card-name' }, record.name),
            record.lanEnabled ? h('span', { className: 'im-tag' }, t('局域网', 'LAN')) : null,
            h('span', {
              className: 'im-tag im-tag-mode',
              title: record.accessMode === 'desktop-app'
                ? t('启动后在桌面应用窗口中打开', 'Opens in a desktop app window after start')
                : t('启动后在浏览器标签页中打开', 'Opens in a browser tab after start'),
            }, record.accessMode === 'desktop-app' ? t('桌面', 'Desktop') : t('网页', 'Web')),
            provisioning ? h('span', { className: 'im-tag im-tag-warn' }, t('创建中', 'Creating')) : null),
          h('div', { className: 'im-card-desc' }, record.description || t('未填写描述', 'No description')),
          record.status === 'error' && record.error
            ? h('div', { className: 'im-card-error' }, record.error)
            : null,
          provisioning ? h(ProgressBar, { provision: record.provision }) : null),
        h('div', { className: 'im-card-actions' },
          canDrag
            ? h('span', { className: 'im-card-grip', 'aria-hidden': 'true', title: t('拖动排序', 'Drag to reorder') },
                h(icon('IconChevronsUpDownOutlineRegular', '≡'), { size: 14 }))
            : null,
          running
            ? h(IconButton, {
                label: t('重启分身', 'Restart instance'),
                glyph: icon('IconRefreshOutlineRegular', '↻'),
                disabled: busy,
                onClick: () => onRestart(record.id),
              })
            : null,
          h(IconButton, {
            label: running ? t('停止分身', 'Stop instance') : starting ? t('启动中…', 'Starting…') : t('启动分身', 'Start instance'),
            glyph: running ? icon('IconStopFillRegular', '■') : icon('IconTriangleRightFillRegular', '▶'),
            size: running ? 16 : 18,
            disabled: busy || provisioning || starting,
            onClick: () => {
              if (running) onStop(record.id)
              else if (!starting) onStart(record.id)
            },
          })),
        h('div', { className: 'im-card-side' },
          h(StatusBar, {
            status: record.status,
            title: record.status === 'error' ? t('查看错误详情', 'Show error details') : statusLabel(record.status),
            onClick: record.status === 'error' ? () => onOpen(record.id) : undefined,
          })))
    }

    function EmptyState({ onCreate }) {
      return h('div', { className: 'im-empty' },
        h('div', { className: 'im-empty-icon' }, h(icon('IconCordisPluginOutlineRegular', '◧'), { size: 34 })),
        h('h2', { className: 'im-empty-title' }, t('还没有分身', 'No instances yet')),
        h('p', { className: 'im-empty-text' },
          t('分身拥有独立的内核副本、独立插件和固定端口，用来隔离并行项目。', 'An instance owns its own kernel copy, plugins and fixed port, so parallel projects stay isolated.')),
        h(ui.Button, { variant: 'primary', onClick: onCreate }, t('新建分身', 'New instance')))
    }

    function CreateDialog({ onClose, onOpenSettings }) {
      const state = useStore()
      const [form, setForm] = React.useState({
        name: '',
        description: '',
        storageDir: (state && state.hello && state.hello.defaultStorageDir) || '',
        port: '',
        lanEnabled: false,
        autoOpen: true,
      })
      const [busy, setBusy] = React.useState(false)
      const [picking, setPicking] = React.useState(false)
      const [error, setError] = React.useState('')
      const [createdId, setCreatedId] = React.useState('')
      const record = createdId && state && state.instances ? state.instances.find((item) => item.id === createdId) : null
      const provision = record && record.provision ? record.provision : null
      const done = Boolean(provision && provision.done)
      const failed = Boolean(done && provision && provision.error)
      const cancelled = Boolean(done && provision && provision.cancelled)

      React.useEffect(() => {
        const fallback = (state && state.hello && state.hello.defaultStorageDir) || ''
        if (fallback) setForm((current) => (current.storageDir ? current : { ...current, storageDir: fallback }))
      }, [state && state.hello ? state.hello.defaultStorageDir : ''])

      const setField = (key, value) => setForm((current) => ({ ...current, [key]: value }))

      async function chooseStorage() {
        if (picking) return
        setPicking(true)
        try {
          const picked = await pickFolder()
          if (typeof picked === 'string' && picked) setField('storageDir', picked)
        } catch (reason) {
          setError(reason && reason.message ? reason.message : String(reason))
        } finally {
          setPicking(false)
        }
      }

      async function submit() {
        if (busy) return
        const storageDir = form.storageDir.trim() || (state && state.hello && state.hello.defaultStorageDir) || ''
        if (!form.name.trim()) {
          setError(t('请填写分身名称', 'Name is required'))
          return
        }
        if (!storageDir) {
          setError(t('请选择存储位置', 'Choose a storage location'))
          return
        }
        setBusy(true)
        setError('')
        try {
          const value = await api('/create', {
            method: 'POST',
            body: JSON.stringify({
              name: form.name.trim(),
              description: form.description,
              storageDir,
              port: form.port ? Number(form.port) : undefined,
              lanEnabled: form.lanEnabled,
              autoOpen: form.autoOpen,
            }),
          })
          setCreatedId(value.id)
          // The dialog renders provisioning progress from the shared store; the
          // first refresh also starts the 1s busy poll (idle windows never poll).
          void refresh()
        } catch (reason) {
          setError(reason && reason.message ? reason.message : String(reason))
        } finally {
          setBusy(false)
        }
      }

      async function cancelCreate() {
        if (createdId && !done) {
          try {
            await api('/create-cancel', { method: 'POST', body: JSON.stringify({ id: createdId }) })
          } catch {
            /* ignored */
          }
        }
        onClose()
      }

      const footer = []
      if (!createdId) {
        footer.push(h(ui.Button, { key: 'cancel', variant: 'outline', disabled: busy, onClick: onClose }, t('取消', 'Cancel')))
        footer.push(h(ui.Button, { key: 'create', variant: 'primary', disabled: busy, onClick: submit }, busy ? t('创建中…', 'Creating…') : t('创建', 'Create')))
      } else if (!done) {
        footer.push(h(ui.Button, { key: 'cancel', variant: 'outline', onClick: cancelCreate }, t('取消创建', 'Cancel creation')))
      } else if (failed) {
        footer.push(h(ui.Button, { key: 'close', variant: 'outline', onClick: onClose }, t('关闭', 'Close')))
      } else {
        footer.push(h(ui.Button, { key: 'close', variant: 'outline', onClick: onClose }, t('完成', 'Done')))
        footer.push(h(ui.Button, { key: 'settings', variant: 'primary', onClick: () => { onClose(); onOpenSettings(createdId) } }, t('打开设置', 'Open settings')))
      }

      return h(ui.Modal, {
        open: true,
        onClose: createdId && !done ? () => {} : onClose,
        closeLabel: t('关闭', 'Close'),
        title: t('新建分身', 'New instance'),
        description: t('分身不绑定工作区，拥有独立内核副本、独立插件与固定端口。', 'An instance is not bound to a workspace; it owns a kernel copy, its plugins and a fixed port.'),
        footer: h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } }, footer),
      },
        createdId
          ? h('div', { className: 'im-create-progress' },
              h('div', { className: 'im-create-name' }, record ? record.name : createdId),
              h(ProgressBar, { provision: provision || { percent: 0, message: t('准备中…', 'Preparing…') } }),
              failed ? h(Notice, { tone: 'error' }, provision.error) : null,
              cancelled ? h(Notice, null, t('创建已取消。', 'Creation cancelled.')) : null,
              done && !failed && !cancelled ? h(Notice, { tone: 'success' }, t('分身已创建，可以启动。之后在桌面端的分身设置里添加插件。', 'Instance created. Add plugins later from this instance’s settings on the desktop.')) : null)
          : h('div', { className: 'im-form' },
              h('label', { className: 'im-field' },
                h('span', { className: 'im-label' }, t('名称', 'Name'), h('span', { className: 'im-required' }, '*')),
                h('input', {
                  className: 'im-input',
                  value: form.name,
                  maxLength: 40,
                  autoFocus: true,
                  placeholder: t('给分身起一个名字', 'Name this instance'),
                  onChange: (event) => setField('name', event.target.value),
                })),
              h('label', { className: 'im-field' },
                h('span', { className: 'im-label' }, t('描述', 'Description')),
                h('input', {
                  className: 'im-input',
                  value: form.description,
                  maxLength: 300,
                  placeholder: t('可选，说明这个分身用来做什么', 'Optional notes about this instance'),
                  onChange: (event) => setField('description', event.target.value),
                })),
              h('label', { className: 'im-field' },
                h('span', { className: 'im-label' }, t('内核', 'Kernel')),
                h('div', { className: 'im-readonly' },
                  t('跟随桌面：', 'Follows desktop: '),
                  (state && state.hello && state.hello.desktopVersion) || t('当前版本', 'current version'))),
              h('label', { className: 'im-field' },
                h('span', { className: 'im-label' }, t('存储位置', 'Storage location'), h('span', { className: 'im-required' }, '*')),
                h('div', { className: 'im-path-row' },
                  h('input', {
                    className: 'im-input im-path-input',
                    value: form.storageDir,
                    placeholder: t('选择分身文件的保存目录', 'Pick the folder that holds this instance'),
                    onChange: (event) => setField('storageDir', event.target.value),
                  }),
                  h(ui.Button, { variant: 'outline', size: 'sm', className: 'im-toggle', disabled: picking, onClick: chooseStorage }, picking ? t('选择中…', 'Choosing…') : t('选择目录', 'Choose folder'))),
                h('div', { className: 'im-hint' }, t('内核副本、插件副本、配置与日志都会保存在该目录下的分身文件夹中。', 'The kernel copy, plugin snapshots, config and logs live in an instance folder inside this directory.')),
                form.storageDir && /(^|[\\/])(Program Files|Windows|ProgramData)([\\/]|$)/i.test(form.storageDir)
                  ? h('div', { className: 'im-hint im-hint-warn' }, t('系统目录可能被升级、杀毒软件或权限变化影响，建议选择用户目录。', 'System folders can be affected by upgrades, antivirus or permission changes; a user folder is safer.'))
                  : null),
              h('label', { className: 'im-field' },
                h('span', { className: 'im-label' }, t('端口', 'Port')),
                h('input', {
                  className: 'im-input',
                  value: form.port,
                  inputMode: 'numeric',
                  placeholder: t('留空自动分配（52000-52999）', 'Auto (52000-52999)'),
                  onChange: (event) => setField('port', event.target.value.replace(/[^0-9]/g, '')),
                })),
              h('div', { className: 'im-switch-row' },
                h('div', null,
                  h('div', { className: 'im-label' }, t('局域网访问', 'LAN access')),
                  h('div', { className: 'im-hint' }, t('默认关闭。开启后同一局域网设备可访问，请自行确认网络环境安全。', 'Off by default. Turning it on exposes the instance to your LAN; make sure the network is trusted.'))),
                h(ui.Button, { variant: form.lanEnabled ? 'primary' : 'outline', size: 'sm', className: 'im-toggle', onClick: () => setField('lanEnabled', !form.lanEnabled) }, form.lanEnabled ? t('已开启', 'On') : t('关闭', 'Off'))),
              h('div', { className: 'im-switch-row' },
                h('div', null,
                  h('div', { className: 'im-label' }, t('启动后自动打开', 'Open automatically after start')),
                  h('div', { className: 'im-hint' }, t('按访问方式自动打开浏览器标签页或桌面窗口。', 'Opens a browser tab or a desktop window according to the access mode.'))),
                h(ui.Button, { variant: form.autoOpen ? 'primary' : 'outline', size: 'sm', className: 'im-toggle', onClick: () => setField('autoOpen', !form.autoOpen) }, form.autoOpen ? t('已开启', 'On') : t('关闭', 'Off')))),
        error ? h(Notice, { tone: 'error' }, error) : null)
    }

    function LogDialog({ record, onClose }) {
      const [text, setText] = React.useState('')
      const [error, setError] = React.useState('')
      const load = () => {
        api(`/log?id=${encodeURIComponent(record.id)}&lines=200`)
          .then((value) => setText(value.text || ''))
          .catch((reason) => setError(reason && reason.message ? reason.message : String(reason)))
      }
      React.useEffect(load, [record.id])
      return h(ui.Modal, {
        open: true,
        onClose,
        closeLabel: t('关闭', 'Close'),
        title: t('分身日志', 'Instance log'),
        description: record.error || record.name,
        footer: h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          h(ui.Button, { variant: 'outline', onClick: load }, t('刷新', 'Refresh')),
          h(ui.Button, { variant: 'outline', onClick: onClose }, t('关闭', 'Close'))),
      }, h('pre', { className: 'im-log' }, error || text || t('暂无日志', 'No log yet')))
    }

    // ------------------------------------------------------------------
    // instance settings (desktop only, opened for stopped instances)
    // ------------------------------------------------------------------
    function InstanceSettings({ id, onBack, onDeleted }) {
      const state = useStore()
      const record = state && state.instances ? state.instances.find((item) => item.id === id) : undefined
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [showLog, setShowLog] = React.useState(false)
      const [deleteOpen, setDeleteOpen] = React.useState(false)
      const [confirmName, setConfirmName] = React.useState('')
      const [migrateOpen, setMigrateOpen] = React.useState(false)
      const [migratePath, setMigratePath] = React.useState('')
      const [plugins, setPlugins] = React.useState(null)
      const [pluginPage, setPluginPage] = React.useState(null)
      const [pluginsError, setPluginsError] = React.useState('')
      const [pluginBusy, setPluginBusy] = React.useState('')
      const [addOpen, setAddOpen] = React.useState(false)
      const [library, setLibrary] = React.useState([])
      const [removeTarget, setRemoveTarget] = React.useState(null)
      const [promptOpen, setPromptOpen] = React.useState(false)
      const [promptGroups, setPromptGroups] = React.useState(null)
      const [promptSelected, setPromptSelected] = React.useState([])
      const [promptBusy, setPromptBusy] = React.useState(false)
      const [promptError, setPromptError] = React.useState('')
      const [autoState, setAutoState] = React.useState('')
      const [preparingShell, setPreparingShell] = React.useState(false)
      const shellRuntime = (state && state.hello && state.hello.shellRuntime) || null
      const fileInputRef = React.useRef(null)
      const initializedFor = React.useRef('')

      const provisioning = Boolean(record && record.provision && !record.provision.done)
      const running = Boolean(record && record.status === 'running')

      React.useEffect(() => {
        // Entering settings is a focus-like moment for cross-process data too.
        scheduleSync()
      }, [])

      React.useEffect(() => {
        if (!record) return
        if (initializedFor.current === record.id) return
        initializedFor.current = record.id
        setDraft({
          name: record.name,
          description: record.description,
          port: String(record.port),
          lanEnabled: Boolean(record.lanEnabled),
          autoOpen: record.autoOpen !== false,
          accessMode: record.accessMode === 'desktop-app' ? 'desktop-app' : 'browser',
        })
      }, [record])

      const loadPlugins = React.useCallback(() => {
        if (!id) return
        api(`/instance-plugins?id=${encodeURIComponent(id)}`)
          .then((value) => {
            setPlugins(value)
            setPluginsError('')
          })
          .catch((reason) => setPluginsError(reason && reason.message ? reason.message : String(reason)))
      }, [id])

      React.useEffect(() => {
        if (!record || provisioning) return
        loadPlugins()
      }, [record && record.id, record && record.status, provisioning, loadPlugins])

      // Icon generation is asynchronous on the host: watch the polled record and
      // surface completion/failure without keeping any dialog open.
      const iconWatch = React.useRef({ version: '', known: false, generating: false, errorKey: '' })
      React.useEffect(() => {
        if (!record) return
        const watch = iconWatch.current
        const version = record.iconVersion || ''
        const iconError = record.iconError || ''
        if (!watch.known) {
          watch.known = true
          watch.version = version
        }
        if (record.iconGenerating) {
          watch.generating = true
          return
        }
        if (iconError) {
          if (watch.errorKey !== iconError) {
            watch.errorKey = iconError
            watch.generating = false
            setError(t('图标生成失败：', 'Icon generation failed: ') + iconError)
          }
          return
        }
        if (watch.generating && version && version !== watch.version) {
          watch.generating = false
          setNotice(t('图标已生成并应用。', 'Icon generated and applied.'))
        }
        if (version) watch.version = version
      }, [record && record.iconVersion, record && record.iconGenerating, record && record.iconError])

      const portText = draft ? String(draft.port).trim() : ''
      const portNumber = Number(portText)
      const portValid = portText !== '' && Number.isInteger(portNumber) && portNumber >= 52000 && portNumber <= 52999
      const dirty = Boolean(record && draft) && (draft.name !== record.name || draft.description !== record.description || String(record.port) !== draft.port || Boolean(record.lanEnabled) !== draft.lanEnabled || (record.autoOpen !== false) !== draft.autoOpen || (record.accessMode === 'desktop-app' ? 'desktop-app' : 'browser') !== draft.accessMode)

      // Settings save themselves: the instance record is the source of truth and
      // every edit lands ~0.7s later, so leaving the page never loses changes.
      // This effect must stay above the early return so hook order never changes.
      React.useEffect(() => {
        if (!record || !draft || !dirty || provisioning || busy) return undefined
        if (!draft.name.trim()) return undefined
        // Never send port 0: clearing the field used to make the host reject the
        // whole patch, silently discarding the other edits.
        if (String(draft.port).trim() !== '' && !portValid) return undefined
        const handle = setTimeout(() => {
          setAutoState('saving')
          api('/update', { method: 'POST', body: JSON.stringify({ id, patch: draftPatch() }) })
            .then(() => {
              setAutoState('saved')
              refresh()
            })
            .catch(() => setAutoState('error'))
        }, 700)
        return () => clearTimeout(handle)
      }, [record && record.id, draft && draft.name, draft && draft.description, draft && draft.port, draft && draft.lanEnabled, draft && draft.autoOpen, draft && draft.accessMode, dirty, provisioning, busy])

      const flushRef = React.useRef(null)
      flushRef.current = flushDraft
      React.useEffect(() => () => {
        try {
          if (flushRef.current) flushRef.current()
        } catch {
          /* ignored */
        }
      }, [])

      if (!record || !draft) {
        return h('div', { className: 'im-page' },
          h('div', { className: 'im-detail-head' },
            h('button', { type: 'button', className: 'im-back', onClick: onBack }, h(icon('IconChevronLeftOutlineRegular', '‹'), { size: 16 }), t('返回', 'Back'))),
          h('div', { className: 'im-empty' }, h('p', { className: 'im-empty-text' }, t('分身不存在或已删除。', 'This instance no longer exists.'))))
      }

      async function run(kind, task) {
        setBusy(kind)
        setError('')
        setNotice('')
        try {
          await task()
        } catch (reason) {
          setError(reason && reason.message ? reason.message : String(reason))
        } finally {
          setBusy('')
        }
      }

      function draftPatch() {
        const patch = {
          name: draft.name.trim(),
          description: draft.description,
          lanEnabled: draft.lanEnabled,
          autoOpen: draft.autoOpen,
          accessMode: draft.accessMode,
        }
        if (portValid) patch.port = portNumber
        return patch
      }

      function flushDraft() {
        if (!dirty) return
        if (!draft.name.trim()) return
        if (String(draft.port).trim() !== '' && !portValid) return
        api('/update', { method: 'POST', body: JSON.stringify({ id, patch: draftPatch() }) })
          .then(() => refresh())
          .catch(() => {})
      }

      function prepareShellRuntime() {
        if (preparingShell) return
        setPreparingShell(true)
        setError('')
        setNotice('')
        api('/prepare-shell-runtime', { method: 'POST', body: JSON.stringify({}) })
          .then(() => {
            setNotice(t('桌面运行库已就绪，下次打开分身会使用桌面窗口。', 'Desktop runtime is ready; the next launch opens a desktop window.'))
            refresh()
          })
          .catch((reason) => setError(reason && reason.message ? reason.message : String(reason)))
          .finally(() => setPreparingShell(false))
      }

      function uploadIcon(file) {
        if (!file) return
        run('icon', async () => {
          const dataUrl = await cropIcon(file)
          await api('/update', { method: 'POST', body: JSON.stringify({ id, patch: { iconDataUrl: dataUrl } }) })
          setNotice(t('图标已更新。', 'Icon updated.'))
        })
      }

      function openIconLocalPicker() {
        if (fileInputRef.current) fileInputRef.current.click()
      }

      async function openPromptDialog() {
        setPromptOpen(true)
        setPromptError('')
        if (promptGroups) return
        try {
          const value = await api('/icon-keywords')
          setPromptGroups(Array.isArray(value.groups) ? value.groups : [])
        } catch (reason) {
          setPromptError(reason && reason.message ? reason.message : String(reason))
        }
      }

      function toggleKeyword(keyword) {
        setPromptSelected((previous) => previous.includes(keyword)
          ? previous.filter((item) => item !== keyword)
          : [...previous, keyword])
      }

      async function copyIconPrompt() {
        if (promptBusy) return
        setPromptBusy(true)
        setPromptError('')
        try {
          const value = await api('/build-icon-prompt', {
            method: 'POST',
            body: JSON.stringify({ id, keywords: promptSelected }),
          })
          await copyText(value.text)
          setPromptOpen(false)
          setNotice(t('提示词已复制到剪贴板。', 'Prompt copied to the clipboard.'))
        } catch (reason) {
          setPromptError(reason && reason.message ? reason.message : String(reason))
        } finally {
          setPromptBusy(false)
        }
      }

      async function chooseMigrateDir() {
        try {
          const picked = await pickFolder()
          if (typeof picked === 'string' && picked) setMigratePath(picked)
        } catch (reason) {
          setError(reason && reason.message ? reason.message : String(reason))
        }
      }

      function migrate() {
        const target = migratePath.trim()
        if (!target) {
          setError(t('请选择新的存储目录', 'Pick the new storage folder'))
          return
        }
        run('migrate', async () => {
          await api('/migrate', { method: 'POST', body: JSON.stringify({ id, storageDir: target }) })
          setMigrateOpen(false)
          setNotice(t('存储位置已迁移，端口与局域网设置保持不变，下次启动生效。', 'Storage moved. Port and LAN settings are unchanged and apply on the next start.'))
        })
      }

      const pluginsEnabled = Boolean(plugins && Array.isArray(plugins.entries))
      const installedNames = new Set(pluginsEnabled ? plugins.entries.map((entry) => entry.name) : [])
      const addable = (plugins && Array.isArray(plugins.library) ? plugins.library : []).filter((entry) => !installedNames.has(entry.name))

      async function togglePlugin(entry) {
        if (running || pluginBusy) return
        setPluginBusy(entry.name)
        setPluginsError('')
        try {
          await api('/set-plugin-enabled', { method: 'POST', body: JSON.stringify({ id, name: entry.name, enabled: !entry.enabled }) })
          loadPlugins()
        } catch (reason) {
          setPluginsError(reason && reason.message ? reason.message : String(reason))
        } finally {
          setPluginBusy('')
        }
      }

      async function addPlugin(entry) {
        if (running || pluginBusy) return
        setPluginBusy(entry.name)
        setPluginsError('')
        try {
          await api('/add-plugin', { method: 'POST', body: JSON.stringify({ id, name: entry.name }) })
          setAddOpen(false)
          loadPlugins()
          setNotice(t(`已添加「${entry.title || entry.name}」，重启分身后生效。`, `Added “${entry.title || entry.name}”. Restart the instance to apply.`))
        } catch (reason) {
          setPluginsError(reason && reason.message ? reason.message : String(reason))
        } finally {
          setPluginBusy('')
        }
      }

      async function removePlugin(entry) {
        if (running || pluginBusy) return
        setPluginBusy(entry.name)
        setPluginsError('')
        try {
          await api('/remove-plugin', { method: 'POST', body: JSON.stringify({ id, name: entry.name }) })
          setRemoveTarget(null)
          loadPlugins()
          setNotice(t(`已移除「${entry.name}」，重启分身后生效。`, `Removed “${entry.name}”. Restart the instance to apply.`))
        } catch (reason) {
          setPluginsError(reason && reason.message ? reason.message : String(reason))
        } finally {
          setPluginBusy('')
        }
      }

      const accessOptions = [
        { value: 'browser', label: t('网页', 'Web'), disabled: false },
        { value: 'desktop-app', label: t('桌面', 'Desktop'), disabled: false },
      ]

      const addGroups = []
      const experimentalAddable = (plugins && Array.isArray(plugins.experimental) ? plugins.experimental : [])
        .filter((entry) => !installedNames.has(entry.name))
      if (experimentalAddable.length > 0) {
        addGroups.push({
          key: 'experimental',
          label: t('实验性', 'Experimental'),
          items: experimentalAddable.map((entry) => ({
            name: entry.name,
            title: LANG === 'zh' ? entry.title : (entry.titleEn || entry.title || entry.name),
            description: LANG === 'zh' ? entry.description : (entry.descriptionEn || entry.description || ''),
            version: entry.version || '',
            icon: entry.icon || null,
          })),
        })
      }
      if (addable.length > 0) {
        addGroups.push({
          key: 'installed',
          label: t('已安装', 'Installed'),
          items: addable.map((entry) => ({
            name: entry.name,
            title: entry.title || entry.name,
            description: entry.description || '',
            version: entry.version || '',
            icon: entry.icon || null,
          })),
        })
      }

      const installedEntries = plugins && Array.isArray(plugins.entries) ? plugins.entries : []
      const pendingExperimental = (plugins && Array.isArray(plugins.experimental) ? plugins.experimental : [])
        .filter((entry) => !installedNames.has(entry.name))
      const addCount = pendingExperimental.length + addable.length
      const addedCount = installedEntries.length

      const autoSaveState = autoState
      const autoSaveLabel = autoSaveState === 'saving'
        ? t('保存中…', 'Saving…')
        : autoSaveState === 'saved'
          ? t('已自动保存', 'Saved')
          : autoSaveState === 'error'
            ? t('保存失败', 'Save failed')
            : t('修改后自动保存', 'Changes save automatically')

      // The confirm dialog is shared by both the settings page and the plugin
      // subpages: rendering it inside only one return made "remove" a no-op on
      // the subpage until the user navigated back.
      const removeDialog = removeTarget
        ? h(ui.Modal, {
          open: true,
          onClose: () => setRemoveTarget(null),
          closeLabel: t('取消', 'Cancel'),
          title: t('移除插件？', 'Remove plugin?'),
          description: removeTarget.name,
          footer: h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            h(ui.Button, { variant: 'outline', disabled: pluginBusy !== '', onClick: () => setRemoveTarget(null) }, t('取消', 'Cancel')),
            h(ui.Button, { variant: 'outline', disabled: pluginBusy !== '', onClick: () => removePlugin(removeTarget) }, t('移除', 'Remove'))),
        })
        : null

      // Plugin management lives in two native-styled subpages: "add" lists the
      // plugins this instance can still take, "manage" lists the ones it owns.
      if (pluginPage) {
        const isAdd = pluginPage === 'add'
        const pageTitle = isAdd
          ? t(`将插件添加到「${record.name}」`, `Add plugins to “${record.name}”`)
          : t(`「${record.name}」的插件`, `Plugins of “${record.name}”`)
        const pluginTile = (entry) => h('div', { className: 'im-plugin-icon', 'data-plugin-icon': '' },
          entry.icon
            ? h('img', { src: entry.icon, alt: '', className: 'im-plugin-iconimg' })
            : h(icon('IconCordisPluginOutlineRegular', '◈'), { size: 18 }))
        const manageRow = (entry) => h('li', {
          key: entry.name,
          className: 'im-plugin-row',
          title: [entry.name, entry.version, entry.official ? t('实验性', 'Experimental') : ''].filter(Boolean).join(' · '),
          'data-plugin-package': entry.name,
          'data-plugin-kind': 'package',
          'data-plugin-status': entry.enabled ? 'running' : 'disabled',
        },
          pluginTile(entry),
          h('div', { className: 'im-plugin-main' },
            h('div', { className: 'im-plugin-name', 'data-plugin-title': '' }, entry.title || entry.name),
            entry.description ? h('div', { className: 'im-plugin-desc', 'data-plugin-desc': '' }, entry.description) : null),
          h('div', { className: 'im-plugin-actions', 'data-plugin-actions': '' },
            h(ui.Button, {
              variant: entry.enabled ? 'primary' : 'outline',
              size: 'sm',
              className: 'im-toggle',
              disabled: running || pluginBusy !== '',
              onClick: () => togglePlugin(entry),
            }, entry.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')),
            h('button', {
              type: 'button',
              className: 'im-icon-btn',
              title: t('移除插件', 'Remove plugin'),
              disabled: running || pluginBusy !== '',
              onClick: () => setRemoveTarget(entry),
            }, h(icon('IconTrashOutlineRegular', '⌫'), { size: 14 }))))
        const addRow = (entry) => h('li', {
          key: entry.name,
          className: 'im-plugin-row',
          title: [entry.name, entry.version].filter(Boolean).join(' · '),
          'data-plugin-package': entry.name,
          'data-plugin-kind': 'package',
          'data-plugin-status': 'disabled',
        },
          pluginTile(entry),
          h('div', { className: 'im-plugin-main' },
            h('div', { className: 'im-plugin-name', 'data-plugin-title': '' }, entry.title || entry.name),
            entry.description ? h('div', { className: 'im-plugin-desc', 'data-plugin-desc': '' }, entry.description) : null),
          h('div', { className: 'im-plugin-actions', 'data-plugin-actions': '' },
            h('button', {
              type: 'button',
              className: 'im-add-btn',
              title: t('添加插件', 'Add plugin'),
              'aria-label': t('添加插件', 'Add plugin'),
              disabled: running || pluginBusy !== '',
              onClick: () => addPlugin(entry),
            }, pluginBusy === entry.name ? '…' : h(icon('IconPlusOutlineRegular', '+'), { size: 14 }))))
        const listEmpty = (text) => h('p', { className: 'im-muted im-subpage-empty' }, text)
        const addList = addCount === 0
          ? listEmpty(t('桌面端插件与实验性插件都已经在本分身中了。', 'Every desktop and experimental plugin is already in this instance.'))
          : h('div', { className: 'im-add-groups' }, addGroups.map((group) => h('div', { key: group.key, className: 'im-add-group' },
              h('div', { className: 'im-add-group-title' }, group.label),
              h('ul', { className: 'im-plugin-list', 'data-plugin-list': '' }, group.items.map(addRow)))))
        const manageList = installedEntries.length === 0
          ? listEmpty(t('还没有添加插件。', 'No plugins have been added yet.'))
          : h('ul', { className: 'im-plugin-list', 'data-plugin-list': '' }, installedEntries.map(manageRow))
        // Surface contract v1: attributes only, layout/behavior unchanged.
        const pluginSurface = h('div', {
          className: 'im-plugin-surface',
          'data-plugin-surface': 'instance',
          'data-plugin-surface-version': '1',
          'data-plugin-caps': 'rename desc tags icon search clone',
          'data-plugin-scope': `instance:${record.id}`,
        }, isAdd ? addList : manageList)
        return h('div', { className: 'im-page' },
          h('div', { className: 'im-detail-head' },
            h('button', { type: 'button', className: 'im-back', onClick: () => setPluginPage(null) },
              h(icon('IconChevronLeftOutlineRegular', '‹'), { size: 16 }), t('分身设置', 'Instance settings'))),
          h('div', { className: 'im-subpage-head' },
            h('h1', { className: 'im-subpage-title' }, pageTitle),
            h('div', { className: 'im-hint' }, isAdd
              ? t('实验性插件来自分身内核，只写配置、不复制文件；社区插件会复制独立副本。添加后重启分身生效。', 'Experimental plugins ship with the instance kernel and only get a config entry; community plugins are copied. Restart the instance to apply.')
              : t('插件启停与移除只修改分身自己的 profile，重启分身后生效。', 'Enabling, disabling or removing plugins only changes this instance’s profile; restart the instance to apply.'))),
          notice ? h(Notice, { tone: 'success' }, notice) : null,
          error ? h(Notice, { tone: 'error' }, error) : null,
          pluginsError ? h(Notice, { tone: 'error' }, pluginsError) : null,
          running ? h('div', { className: 'im-hint' }, t('分身运行中，停止后才能管理插件。', 'Stop the instance to manage its plugins.')) : null,
          plugins === null
            ? h('p', { className: 'im-muted im-subpage-empty' }, t('正在加载插件…', 'Loading plugins…'))
            : isAdd
              ? pluginSurface
              : null,
          !isAdd
            ? h('section', { className: 'im-group' },
                h('h2', { className: 'im-group-title' }, t('内置插件配置', 'Built-in plugin settings')),
                h('p', { className: 'im-hint', style: { margin: 0 } },
                  t('内置插件配置保存在分身自己的 profile 中，与桌面端互不影响；启动分身后可在分身的「插件」页中修改。',
                    'Built-in plugin settings live in the instance’s own profile and never touch the desktop; start the instance and edit them in its Plugins page.')),
                record && record.status === 'running' && record.url
                  ? h(ui.Button, {
                      variant: 'outline',
                      size: 'sm',
                      style: { alignSelf: 'flex-start' },
                      onClick: () => openInstance(record),
                    }, t('打开分身插件页', 'Open instance plugins'))
                  : null)
            : null,
          !isAdd ? pluginSurface : null,
          removeDialog)
      }

      return h('div', { className: 'im-page' },
        h('div', { className: 'im-detail-head' },
          h('button', { type: 'button', className: 'im-back', onClick: () => { flushDraft(); onBack() } }, h(icon('IconChevronLeftOutlineRegular', '‹'), { size: 16 }), t('分身', 'Instances'))),
        h('div', { className: 'im-detail-title-row' },
          h('div', { className: 'im-detail-icon' }, h(InstanceIcon, { record, size: 52 })),
          h('div', { style: { minWidth: 0, flex: 1 } },
            h('h1', { className: 'im-detail-name' }, record.name),
            h('div', { className: 'im-detail-sub' },
              h(StatusBar, { status: record.status, title: statusLabel(record.status) }),
              h('span', null, statusLabel(record.status)),
              record.lastStartedAt ? h('span', { className: 'im-dot-sep' }, '·') : null,
              record.lastStartedAt ? h('span', null, t('上次启动 ', 'Last started ') + relativeTime(record.lastStartedAt)) : null))),
        h('div', { className: 'im-autosave-hint', 'data-state': autoState }, autoSaveLabel),
        error ? h(Notice, { tone: 'error' }, error) : null,
        notice ? h(Notice, { tone: 'success' }, notice) : null,
        record.error ? h('div', { className: 'im-error-panel' },
          h('div', null, record.error),
          h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => setShowLog(true) }, t('查看日志', 'View log'))) : null,
        provisioning ? h('div', { className: 'im-group' }, h('div', { className: 'im-group-title' }, t('创建进度', 'Provisioning')), h(ProgressBar, { provision: record.provision })) : null,

        h('section', { className: 'im-group' },
          h('h2', { className: 'im-group-title' }, t('基础信息', 'Basics')),
          h('div', { className: 'im-form' },
            h('div', { className: 'im-icon-row' },
              h('button', {
                type: 'button',
                className: 'im-icon-edit',
                title: t('更换图标', 'Change icon'),
                disabled: busy === 'icon',
                onClick: openIconLocalPicker,
              },
                h(InstanceIcon, { record, size: 72 }),
                h('span', { className: 'im-icon-edit-hint' }, t('更换', 'Change'))),
              h('input', {
                ref: fileInputRef,
                type: 'file',
                accept: 'image/png,image/jpeg',
                style: { display: 'none' },
                onChange: (event) => {
                  const file = event.target.files && event.target.files[0]
                  uploadIcon(file)
                  event.target.value = ''
                },
              }),
              h('div', { className: 'im-icon-row-text' },
                h('div', { className: 'im-label' }, t('图标', 'Icon')),
                record.iconGenerating
                  ? h('div', { className: 'im-hint im-generating' }, t('正在后台生成图标，完成后自动应用，可以关闭本页。', 'Generating an icon in the background; it applies automatically and you can leave this page.'))
                  : h('div', { className: 'im-hint' }, t('点击图标可更换：选择本地正方形图片（PNG/JPG，自动裁剪为 1:1，不超过 512KB）。', 'Click the icon to change it: pick a local square image (PNG/JPG, cropped to 1:1, up to 512KB).'))),
              h('button', {
                type: 'button',
                className: 'im-icon-prompt',
                onClick: openPromptDialog,
              }, t('获取提示词', 'Get prompt'))),
            h('label', { className: 'im-field' },
              h('span', { className: 'im-label' }, t('名称', 'Name')),
              h('input', { className: 'im-input', value: draft.name, maxLength: 40, onChange: (event) => setDraft({ ...draft, name: event.target.value }) })),
            h('label', { className: 'im-field' },
              h('span', { className: 'im-label' }, t('描述', 'Description')),
              h('input', { className: 'im-input', value: draft.description, maxLength: 300, onChange: (event) => setDraft({ ...draft, description: event.target.value }) })))),

        h('section', { className: 'im-group' },
          h('h2', { className: 'im-group-title' }, t('访问', 'Access')),
          h('div', { className: 'im-access-group', role: 'group', 'aria-label': t('访问方式', 'Access mode') },
            accessOptions.map((option) => h('button', {
              key: option.value,
              type: 'button',
              className: 'im-access-btn',
              disabled: option.disabled,
              'data-active': draft.accessMode === option.value ? 'true' : 'false',
              'aria-pressed': draft.accessMode === option.value ? 'true' : 'false',
              title: option.disabled ? t('即将支持', 'Coming soon') : '',
              onClick: () => {
                if (option.disabled) return
                setDraft({ ...draft, accessMode: option.value })
              },
            }, option.label))),
          h('div', { className: 'im-hint' }, t('网页：在浏览器标签页中打开。桌面：在独立的桌面应用窗口中打开，窗口图标与分身图标一致。', 'Web: open in a browser tab. Desktop: open in a standalone app window using the instance icon.')),
          h('div', { className: 'im-shell-runtime' },
            h('span', { className: 'im-kv-key' }, t('桌面运行库', 'Desktop runtime')),
            h('span', { className: 'im-tag' },
              !shellRuntime
                ? t('未知', 'Unknown')
                : shellRuntime.installed
                  ? t('已就绪', 'Ready')
                  : shellRuntime.downloading
                    ? t('下载中', 'Downloading')
                    : t('未安装', 'Not installed')),
            shellRuntime && !shellRuntime.installed
              ? h(ui.Button, {
                  variant: 'outline',
                  size: 'sm',
                  disabled: preparingShell || Boolean(shellRuntime && shellRuntime.downloading),
                  onClick: prepareShellRuntime,
                }, preparingShell || (shellRuntime && shellRuntime.downloading) ? t('准备中…', 'Preparing…') : t('下载运行库', 'Download runtime'))
              : null,
            shellRuntime && shellRuntime.error
              ? h('span', { className: 'im-muted' }, shellRuntime.error)
              : h('span', { className: 'im-muted' }, t('首次打开桌面窗口时自动下载（约 158 MB，所有分身共用）。', 'Downloaded once on first use (~158 MB, shared by all instances).'))),
          record && record.shellError
            ? h('div', { className: 'im-hint im-hint-error' }, t('桌面窗口错误：', 'Desktop window error: ') + record.shellError)
            : null,
          h('div', { className: 'im-kv' },
            h('div', { className: 'im-kv-row' },
              h('span', { className: 'im-kv-key' }, t('地址', 'URL')),
              h('div', { className: 'im-kv-value' },
                record.url
                  ? h('code', { className: 'im-url' }, record.url)
                  : h('span', { className: 'im-muted' }, t('分身停止后不可访问', 'Unavailable while stopped')),
                record.url
                  ? h(ui.Button, {
                      variant: 'outline',
                      size: 'sm',
                      onClick: () => {
                        copyText(record.url).then((ok) => {
                          if (ok) setNotice(t('地址已复制。', 'URL copied.'))
                          else setError(t('复制失败，请手动选择地址。', 'Copy failed; please select the URL manually.'))
                        })
                      },
                    }, h(icon('IconCopyOutlineRegular', '⧉'), { size: 14 }), t('复制地址', 'Copy URL'))
                  : null)),
            h('div', { className: 'im-kv-row' },
              h('span', { className: 'im-kv-key' }, t('端口', 'Port')),
              h('div', { className: 'im-kv-value' },
                h('input', {
                  className: 'im-input im-input-compact',
                  value: draft.port,
                  inputMode: 'numeric',
                  onChange: (event) => setDraft({ ...draft, port: event.target.value.replace(/[^0-9]/g, '').slice(0, 5) }),
                }),
                record.portChanged && record.status === 'running'
                  ? h('span', { className: 'im-warn-text' }, t('端口冲突，已自动改为 ', 'Port was busy; using ') + record.port)
                  : null)),
            h('div', { className: 'im-kv-row' },
              h('span', { className: 'im-kv-key' }, t('局域网访问', 'LAN access')),
              h('div', { className: 'im-kv-value' },
                h(ui.Button, {
                  variant: draft.lanEnabled ? 'primary' : 'outline',
                  size: 'sm',
                  className: 'im-toggle',
                  onClick: () => setDraft({ ...draft, lanEnabled: !draft.lanEnabled }),
                }, draft.lanEnabled ? t('已开启', 'On') : t('关闭', 'Off')),
                h('span', { className: 'im-hint' }, t('开启后同一局域网可访问，启动时生效。', 'Applies on next start. Exposes the instance on your LAN.')))),
            h('div', { className: 'im-kv-row' },
              h('span', { className: 'im-kv-key' }, t('自动打开', 'Auto open')),
              h('div', { className: 'im-kv-value' },
                h(ui.Button, {
                  variant: draft.autoOpen ? 'primary' : 'outline',
                  size: 'sm',
                  className: 'im-toggle',
                  onClick: () => setDraft({ ...draft, autoOpen: !draft.autoOpen }),
                }, draft.autoOpen ? t('已开启', 'On') : t('关闭', 'Off')),
                h('span', { className: 'im-hint' }, t('按访问方式自动打开浏览器标签页或桌面窗口。', 'Opens a browser tab or a desktop window according to the access mode.')))))),

        h('section', { className: 'im-group' },
          h('h2', { className: 'im-group-title' }, t('插件', 'Plugins')),
          pluginsError ? h(Notice, { tone: 'error' }, pluginsError) : null,
          running ? h('div', { className: 'im-hint' }, t('分身运行中，停止后才能管理插件。', 'Stop the instance to manage its plugins.')) : null,
          plugins === null
            ? h('p', { className: 'im-muted' }, t('正在加载插件…', 'Loading plugins…'))
            : h('div', { className: 'im-plugin-entries' },
                h('div', { className: 'im-plugin-entry' },
                  h('div', { className: 'im-plugin-entry-text' },
                    h('div', { className: 'im-plugin-entry-title' }, t(`可添加 ${addCount} 个`, `${addCount} available`)),
                    h('div', { className: 'im-plugin-entry-desc' }, t('来自桌面端已安装的插件与分身内核中的实验性插件。', 'From the desktop app and the instance kernel’s experimental plugins.'))),
                  h(ui.Button, {
                    variant: 'outline',
                    size: 'sm',
                    disabled: running || provisioning || pluginBusy !== '',
                    onClick: () => { setNotice(''); setError(''); setPluginPage('add'); loadPlugins() },
                  }, t('添加插件', 'Add plugins'))),
                h('div', { className: 'im-plugin-entry' },
                  h('div', { className: 'im-plugin-entry-text' },
                    h('div', { className: 'im-plugin-entry-title' }, t(`已添加 ${addedCount} 个`, `${addedCount} added`)),
                    h('div', { className: 'im-plugin-entry-desc' }, t('启停或移除本分身的插件，修改后重启分身生效。', 'Enable, disable or remove this instance’s plugins; restart to apply.'))),
                  h(ui.Button, {
                    variant: 'outline',
                    size: 'sm',
                    onClick: () => { setNotice(''); setError(''); setPluginPage('manage'); loadPlugins() },
                  }, t('管理插件', 'Manage plugins')))),
          h('div', { className: 'im-hint' }, t('插件只影响本分身，与桌面端和其他分身互不影响。', 'Plugins only affect this instance, not the desktop or other instances.'))),

        h('section', { className: 'im-group' },
          h('h2', { className: 'im-group-title' }, t('数据', 'Data')),
          h('div', { className: 'im-actions' },
            h('div', { className: 'im-action-row' },
              h('div', { className: 'im-action-text' },
                h('div', { className: 'im-action-title' }, t('内核版本', 'Kernel')),
                h('div', { className: 'im-action-value' }, record.kernelVersion === 'pending' ? t('创建中…', 'Provisioning…') : record.kernelVersion),
                state && state.hello && state.hello.desktopVersion && state.hello.desktopVersion !== record.kernelVersion
                  ? h('div', { className: 'im-warn-text' }, t('桌面内核为 ', 'Desktop kernel is ') + state.hello.desktopVersion + t('，可重建', ', rebuild available'))
                  : null),
              h(ui.Button, {
                variant: 'outline',
                size: 'sm',
                disabled: busy !== '' || running || provisioning,
                onClick: () => run('rebuild', async () => {
                  await api('/rebuild', { method: 'POST', body: JSON.stringify({ id }) })
                  setNotice(t('已开始重建内核，请等待完成。', 'Kernel rebuild started.'))
                }),
              }, t('重建内核', 'Rebuild kernel'))),
            h('div', { className: 'im-action-row' },
              h('div', { className: 'im-action-text' },
                h('div', { className: 'im-action-title' }, t('存储目录', 'Storage')),
                h('code', { className: 'im-url' }, record.storageDir || ''),
                h('div', { className: 'im-hint' }, t('分身文件位于 ', 'Instance files live in ') + (record.instanceRoot || '')),
                h('div', { className: 'im-hint' }, running
                  ? t('分身运行中，停止后可迁移。', 'Stop the instance before moving its storage.')
                  : t('内核副本、插件副本、配置与日志都保存在该目录中；迁移后原目录会清空。', 'The kernel copy, plugin snapshots, config and logs live here; moving empties the old folder.'))),
              h(ui.Button, {
                variant: 'outline',
                size: 'sm',
                disabled: busy !== '' || running || provisioning,
                onClick: () => { setMigratePath(record.storageDir || ''); setMigrateOpen(true) },
              }, t('迁移存储位置', 'Move storage'))))),

        h('section', { className: 'im-group' },
          h('h2', { className: 'im-group-title' }, t('删除', 'Delete')),
          h('div', { className: 'im-actions' },
            h('div', { className: 'im-action-row' },
              h('div', { className: 'im-action-text' },
                h('div', { className: 'im-action-title' }, t('删除分身', 'Delete instance')),
                h('div', { className: 'im-hint' }, t('删除内核副本、插件副本与分身记录，保留工作区与会话。', 'Removes the kernel copy, plugin copies and the instance record. Workspaces and sessions are kept.'))),
              h(ui.Button, {
                variant: 'outline',
                size: 'sm',
                className: 'im-delete-btn',
                onClick: () => { setConfirmName(''); setDeleteOpen(true) },
              }, h(icon('IconTrashOutlineRegular', '⌫'), { size: 14 }), t('删除分身', 'Delete'))))),

        showLog ? h(LogDialog, { record, onClose: () => setShowLog(false) }) : null,
        h(ui.Modal, {
          open: deleteOpen,
          onClose: () => setDeleteOpen(false),
          closeLabel: t('取消', 'Cancel'),
          title: t('删除分身？', 'Delete instance?'),
          description: t('工作区与会话会保留，但本分身中创建的工作区将不再显示归属标记。', 'Workspaces and sessions are kept, but attribution markers for this instance are cleared.'),
          footer: h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            h(ui.Button, { variant: 'outline', disabled: busy !== '', onClick: () => setDeleteOpen(false) }, t('取消', 'Cancel')),
            h(ui.Button, {
              variant: 'outline',
              style: { color: 'var(--dsw-alias-state-error-primary)' },
              disabled: busy !== '' || confirmName !== record.name,
              onClick: () => run('delete', async () => {
                await api('/delete', { method: 'POST', body: JSON.stringify({ id, confirmName }) })
                setDeleteOpen(false)
                onDeleted()
              }),
            }, t('确认删除', 'Delete'))),
        },
          h('div', { className: 'im-form' },
            h('label', { className: 'im-field' },
              h('span', { className: 'im-label' }, t('输入分身名称以确认：', 'Type the instance name to confirm:'), h('strong', null, record.name)),
              h('input', {
                className: 'im-input',
                value: confirmName,
                onChange: (event) => setConfirmName(event.target.value),
                placeholder: record.name,
                autoFocus: true,
              })))),
        h(ui.Modal, {
          open: migrateOpen,
          onClose: () => setMigrateOpen(false),
          closeLabel: t('取消', 'Cancel'),
          title: t('迁移存储位置', 'Move storage'),
          description: t('停用分身后，把所有分身文件移动到新目录。工作区与会话不受影响。', 'Move every instance file to a new folder. Workspaces and sessions are unaffected.'),
          footer: h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            h(ui.Button, { variant: 'outline', disabled: busy !== '', onClick: () => setMigrateOpen(false) }, t('取消', 'Cancel')),
            h(ui.Button, {
              variant: 'primary',
              disabled: busy !== '' || !migratePath.trim() || migratePath.trim() === (record.storageDir || ''),
              onClick: migrate,
            }, busy === 'migrate' ? t('迁移中…', 'Moving…') : t('开始迁移', 'Move'))),
        },
          h('div', { className: 'im-form' },
            h('div', { className: 'im-field' },
              h('span', { className: 'im-label' }, t('新的存储目录', 'New storage folder'), h('span', { className: 'im-required' }, '*')),
              h('div', { className: 'im-path-row' },
                h('input', {
                  className: 'im-input im-path-input',
                  value: migratePath,
                  placeholder: t('选择新的存储目录', 'Pick the new folder'),
                  onChange: (event) => setMigratePath(event.target.value),
                }),
                h(ui.Button, { variant: 'outline', size: 'sm', className: 'im-toggle', disabled: busy !== '', onClick: chooseMigrateDir }, t('选择目录', 'Choose folder')))),
            h('div', { className: 'im-hint' }, t('迁移后，分身文件会放在新目录下的同名分身文件夹中。', 'After moving, the instance keeps its folder name inside the new directory.')))),
        h(ui.Modal, {
          open: addOpen,
          onClose: () => setAddOpen(false),
          closeLabel: t('取消', 'Cancel'),
          title: t('添加插件', 'Add plugin'),
          description: t('实验性插件来自分身内核，只写配置、不复制文件；社区插件会复制独立副本。重启分身后生效。', 'Experimental plugins ship with the instance kernel and only get a config entry; community plugins are copied. Restart the instance to apply.'),
          footer: h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            h(ui.Button, { variant: 'outline', onClick: () => setAddOpen(false) }, t('取消', 'Cancel'))),
          contentClassName: 'im-add-modal-content',
          className: 'im-add-modal',
        },
          addGroups.length === 0
            ? h('p', { className: 'im-muted' }, t('桌面端插件与实验性插件都已经在本分身中了。', 'Every desktop and experimental plugin is already in this instance.'))
            : h('div', { className: 'im-add-groups' },
                addGroups.map((group) => h('div', { key: group.key, className: 'im-add-group' },
                  h('div', { className: 'im-add-group-title' }, group.label),
                  h('ul', { className: 'im-add-list' },
                    group.items.map((entry) => h('li', { key: entry.name, className: 'im-add-row' },
                      h('div', { className: 'im-plugin-main' },
                        h('div', { className: 'im-plugin-name' }, entry.title || entry.name, h('span', { className: 'im-add-name' }, entry.name)),
                        entry.description ? h('div', { className: 'im-plugin-meta' }, entry.description) : null,
                        entry.version ? h('div', { className: 'im-plugin-meta' }, entry.version) : null),
                      h(ui.Button, { variant: 'outline', size: 'sm', disabled: pluginBusy !== '', onClick: () => addPlugin(entry) }, pluginBusy === entry.name ? t('添加中…', 'Adding…') : t('添加', 'Add'))))))))),
        h(ui.Modal, {
          open: promptOpen,
          onClose: () => setPromptOpen(false),
          closeLabel: t('取消', 'Cancel'),
          title: t('获取提示词', 'Get prompt'),
          description: t('选择关键词（可不选、可多选），确认后复制完整提示词。', 'Pick keywords (optional, multi-select) and copy the full prompt.'),
          className: 'im-prompt-modal',
          contentClassName: 'im-prompt-modal-content',
          footer: h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            h(ui.Button, { variant: 'outline', onClick: () => setPromptOpen(false) }, t('取消', 'Cancel')),
            h(ui.Button, { variant: 'primary', disabled: promptBusy || !promptGroups, onClick: copyIconPrompt }, promptBusy ? t('准备中…', 'Preparing…') : t('复制提示词', 'Copy prompt'))),
        },
          promptError ? h(Notice, { tone: 'error' }, promptError) : null,
          !promptGroups
            ? h('p', { className: 'im-muted' }, t('正在加载关键词…', 'Loading keywords…'))
            : h('div', { className: 'im-kw-groups' }, promptGroups.map((group) => h('div', { key: group.id, className: 'im-kw-group' },
                h('div', { className: 'im-kw-title' }, group.label),
                h('div', { className: 'im-kw-list' }, group.keywords.map((keyword) => h('button', {
                  key: keyword.id,
                  type: 'button',
                  className: 'im-kw-chip',
                  'data-active': promptSelected.includes(keyword.id) ? 'true' : 'false',
                  'aria-pressed': promptSelected.includes(keyword.id) ? 'true' : 'false',
                  onClick: () => toggleKeyword(keyword.id),
                }, keyword.label)))))),
        ),
        removeDialog)
    }

    // ------------------------------------------------------------------
    // instance list page
    // ------------------------------------------------------------------
    function InstancesPage() {
      const state = useStore()
      const storeError = useStoreError()
      const actionError = useActionError()
      const [view, setView] = React.useState({ kind: 'list' })
      const [query, setQuery] = React.useState('')
      const [filter, setFilter] = React.useState('all')
      const [createOpen, setCreateOpen] = React.useState(false)
      const [busyId, setBusyId] = React.useState('')
      const [dragId, setDragId] = React.useState('')
      const [error, setError] = React.useState('')

      React.useEffect(() => {
        startPolling()
        // Opening the panel is also a "regain focus" moment: pull the state that
        // another process may have written while this window was in the chat view.
        scheduleSync()
      }, [])

      const instances = state && state.instances ? state.instances : []
      const running = instances.filter((item) => item.status === 'running').length
      const canDrag = filter === 'all' && !query.trim()
      const filtered = instances
        .filter((item) => {
          if (filter === 'running') return item.status === 'running' || item.status === 'starting'
          if (filter === 'stopped') return item.status === 'stopped'
          if (filter === 'error') return item.status === 'error'
          return true
        })
        .filter((item) => {
          const needle = query.trim().toLowerCase()
          if (!needle) return true
          return `${item.name} ${item.description}`.toLowerCase().includes(needle)
        })

      const counts = {
        all: instances.length,
        running: instances.filter((item) => item.status === 'running' || item.status === 'starting').length,
        stopped: instances.filter((item) => item.status === 'stopped').length,
        error: instances.filter((item) => item.status === 'error').length,
      }

      const act = async (kind, id) => {
        setBusyId(id)
        setError('')
        try {
          await api(kind, { method: 'POST', body: JSON.stringify({ id }) })
        } catch (reason) {
          setError(reason && reason.message ? reason.message : String(reason))
        } finally {
          setBusyId('')
          refresh()
        }
      }

      const dropOn = async (targetId) => {
        if (!dragId || dragId === targetId) {
          setDragId('')
          return
        }
        const ids = instances.map((item) => item.id)
        const from = ids.indexOf(dragId)
        const to = ids.indexOf(targetId)
        setDragId('')
        if (from < 0 || to < 0 || from === to) return
        ids.splice(to, 0, ids.splice(from, 1)[0])
        setError('')
        try {
          await api('/reorder', { method: 'POST', body: JSON.stringify({ ids }) })
        } catch (reason) {
          setError(reason && reason.message ? reason.message : String(reason))
        } finally {
          refresh()
        }
      }

      if (view.kind === 'detail') {
        return h(InstanceSettings, {
          id: view.id,
          onBack: () => setView({ kind: 'list' }),
          onDeleted: () => setView({ kind: 'list' }),
        })
      }

      return h('div', { className: 'im-page' },
        h('div', { className: 'im-page-head' },
          h('div', { className: 'im-hero-top' },
            h('div', { className: 'im-hero-titles' },
              h('h1', { className: 'im-page-title' }, t('分身', 'Instances')),
              h('div', { className: 'im-page-sub-row' },
                h('span', { className: 'im-page-sub' }, t('管理相互隔离的 DSH 分身：独立内核、独立插件与固定端口', 'Run isolated DSH instances: separate kernel, plugins and a fixed port.')),
                h('span', {
                  className: 'im-page-info',
                  role: 'img',
                  tabIndex: 0,
                  'aria-label': t('分身说明', 'About instances'),
                  'data-tip': t(
                    '分身拥有独立的内核副本、独立插件和固定端口；分身由主桌面端管理。双击分身可打开设置或访问地址。',
                    'An instance has its own kernel copy, plugins and a fixed port, and is managed by the desktop. Double-click a card for settings or its URL.',
                  ),
                }, h(icon('IconInfoOutlineRegular', 'i'), { size: 14 })))),
            h('div', { className: 'im-hero-actions' },
              h(IconButton, { label: t('刷新列表', 'Refresh'), glyph: icon('IconRefreshOutlineRegular', '↻'), onClick: () => { void refresh() } }),
              h(ui.Button, { variant: 'primary', onClick: () => setCreateOpen(true) }, h(icon('IconPlusOutlineRegular', '+'), { size: 14 }), t('新建分身', 'New instance')))),
          instances.length > 0 ? h(StatusFilter, { value: filter, onChange: setFilter, counts }) : null),
        error ? h(Notice, { tone: 'error' }, error) : null,
        storeError ? h(Notice, { tone: 'error' }, storeError) : null,
        actionError
          ? h('div', { className: 'im-action-notice' },
              h(Notice, { tone: 'error' }, actionError),
              h('button', {
                type: 'button',
                className: 'im-notice-dismiss',
                'aria-label': t('关闭提示', 'Dismiss'),
                onClick: () => setActionError(''),
              }, '×'))
          : null,
        instances.length > 0
          ? h('div', { className: 'im-toolbar' },
              h('div', { className: 'im-search' },
                h(icon('IconSearchOutlineRegular', '⌕'), { size: 14 }),
                h('input', {
                  className: 'im-search-input',
                  value: query,
                  placeholder: t('搜索名称或描述', 'Search name or description'),
                  onChange: (event) => setQuery(event.target.value),
                })))
          : null,
        filtered.length > 0
          ? h('div', { className: 'im-list' },
              filtered.map((record) => h(InstanceCard, {
                key: record.id,
                record,
                busy: busyId === record.id,
                canDrag,
                dragActive: Boolean(dragId),
                dragging: dragId === record.id,
                onDragStart: (dragRecordId) => setDragId(dragRecordId),
                onDragEnd: () => setDragId(''),
                onDrop: dropOn,
                onOpen: (id) => setView({ kind: 'detail', id }),
                onStart: (id) => act('/start', id),
                onStop: (id) => act('/stop', id),
                onRestart: (id) => act('/restart', id),
              })))
          : instances.length === 0
            ? h(EmptyState, { onCreate: () => setCreateOpen(true) })
            : h('div', { className: 'im-empty' },
                h('p', { className: 'im-empty-text' }, t('没有匹配的分身', 'No matching instances'))),
        createOpen
          ? h(CreateDialog, {
              onClose: () => setCreateOpen(false),
              onOpenSettings: (id) => {
                setCreateOpen(false)
                setView({ kind: 'detail', id })
              },
            })
          : null)
    }

    // ------------------------------------------------------------------
    // attribution: session badge + banner (session-scoped, v2)
    // ------------------------------------------------------------------
    function BadgeArt({ origin, size }) {
      const style = { width: size, height: size, borderRadius: Math.max(4, Math.round(size / 4)) }
      if (origin && origin.hasIcon) {
        return h('img', {
          className: 'im-badge-img',
          style,
          src: `${ROOT}/icon?id=${encodeURIComponent(origin.instanceId)}&v=${encodeURIComponent(origin.iconVersion || '')}`,
          alt: '',
        })
      }
      return h('span', { className: 'im-badge-letter', style }, initialOf(origin && origin.instanceName))
    }

    function SessionOriginBadge({ sessionId }) {
      const origins = useOrigins()
      const origin = origins[sessionId]
      if (!origin) return null
      const color = STATUS_COLORS[origin.status] || STATUS_COLORS.stopped
      return h('span', {
        className: 'im-badge im-session-badge-react',
        title: t(`最近执行：${origin.instanceName}`, `Last executed in “${origin.instanceName}”`),
        'aria-label': t(`最近执行：${origin.instanceName}`, `Last executed in “${origin.instanceName}”`),
        style: { borderColor: color, color },
        onClick: (event) => event.stopPropagation(),
        onDoubleClick: (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (origin.status === 'running' && origin.url) window.open(origin.url, '_blank', 'noopener')
          else if (origin.status !== 'starting') api('/start', { method: 'POST', body: JSON.stringify({ id: origin.instanceId }) }).then(refresh).catch(() => {})
        },
      }, h(BadgeArt, { origin, size: 14 }))
    }

    // ------------------------------------------------------------------
    // assistant footer identity (executed most recently by …)
    // ------------------------------------------------------------------

    function executorIdentity(sessionId, origins, hello) {
      const origin = sessionId && origins ? origins[sessionId] : null
      if (origin && origin.instanceName) return { name: origin.instanceName, status: origin.status || '' }
      if (hello && hello.mode === 'instance') return { name: hello.instanceName || '', status: 'running' }
      return { name: t('主端', 'Desktop'), status: 'desktop' }
    }

    function paintExecutor(host, name, status) {
      if (!host) return
      const doc = host.ownerDocument
      host.textContent = ''
      host.setAttribute('data-status', status || '')
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('width', '15')
      svg.setAttribute('height', '15')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('aria-hidden', 'true')
      for (const y of [3.4, 9.4, 15.4]) {
        const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect')
        rect.setAttribute('x', '3.6')
        rect.setAttribute('y', String(y))
        rect.setAttribute('width', '16.8')
        rect.setAttribute('height', '5.2')
        rect.setAttribute('rx', '1.7')
        rect.setAttribute('stroke', 'currentColor')
        rect.setAttribute('stroke-width', '1.5')
        svg.appendChild(rect)
      }
      const label = doc.createElement('span')
      label.className = 'im-executor-name'
      label.textContent = name
      host.appendChild(svg)
      host.appendChild(label)
      const title = t(`最近执行：${name}`, `Last executed in ${name}`)
      host.title = title
      host.setAttribute('aria-label', title)
    }

    function AssistantExecutor({ sessionId }) {
      const origins = useOrigins()
      const hello = useHello()
      const identity = executorIdentity(sessionId, origins, hello)
      const anchorRef = React.useRef(null)
      React.useEffect(() => {
        const anchor = anchorRef.current
        if (!anchor || typeof document === 'undefined') return undefined
        const tail = anchor.closest('[data-turn-tail]')
        if (!tail) return undefined
        const endInfo = tail.querySelector('[class*="endInfo"]')
        if (!endInfo) return undefined
        let host = tail.querySelector('[data-im-executor]')
        if (!host) {
          host = document.createElement('span')
          host.className = 'im-executor'
          host.setAttribute('data-im-executor', '')
          // Place it between the usage pill and the time stamp.
          endInfo.insertBefore(host, endInfo.lastElementChild)
        }
        paintExecutor(host, identity.name, identity.status)
        return () => {
          if (host && host.parentNode) host.parentNode.removeChild(host)
        }
      }, [sessionId, identity.name, identity.status])
      return h('span', { ref: anchorRef, className: 'im-executor-anchor', 'aria-hidden': 'true' })
    }

    function AttributionBanner({ sessionRef }) {
      const origins = useOrigins()
      const hello = useHello()
      const origin = origins[sessionRef]
      const storageKey = sessionRef ? `im.banner.${sessionRef}` : ''
      const [dismissed, setDismissed] = React.useState(() => {
        try {
          return storageKey ? localStorage.getItem(storageKey) === '1' : false
        } catch {
          return false
        }
      })
      React.useEffect(() => {
        try {
          setDismissed(storageKey ? localStorage.getItem(storageKey) === '1' : false)
        } catch {
          setDismissed(false)
        }
      }, [storageKey])
      if (!origin || dismissed) return null
      if (hello.mode === 'instance' && origin.instanceId === hello.instanceId) return null
      const dismiss = () => {
        setDismissed(true)
        try {
          if (storageKey) localStorage.setItem(storageKey, '1')
        } catch {
          /* ignored */
        }
      }
      const title = t(`本会话最近由分身「${origin.instanceName}」执行`, `This session was last executed by “${origin.instanceName}”`)
      const detail = origin.workspacePath
        ? t(`工作区：${origin.workspacePath}`, `Workspace: ${origin.workspacePath}`)
        : ''
      return h('div', { className: 'im-banner', role: 'status' },
        h('div', { className: 'im-banner-icon' }, h(icon('IconInfoOutlineRegular', 'i'), { size: 14 })),
        h('div', { className: 'im-banner-body' },
          h('div', { className: 'im-banner-title' }, title),
          detail ? h('div', { className: 'im-banner-text' }, detail) : null),
        origin.running && origin.url
          ? h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => window.open(origin.url, '_blank', 'noopener') }, t('打开分身', 'Open instance'))
          : null,
        h('button', { type: 'button', className: 'im-banner-close', title: t('关闭', 'Dismiss'), onClick: dismiss }, h(icon('IconCloseOutlineRegular', '×'), { size: 12 })))
    }

    // ------------------------------------------------------------------
    // DOM-level badge injection for busy session rows
    //
    // The native sidebar only renders `sidebar.session.row.leading` while the
    // session is idle; busy rows show state dots instead. To give every owned
    // session a status-coloured instance icon we overlay the dots with a badge.
    // ------------------------------------------------------------------
    let stopWatchers = null

    function restoreNativeDots(row) {
      const dots = row.querySelectorAll('[data-state]')
      dots.forEach((dot) => {
        dot.style.display = ''
      })
    }

    function updateInjectedBadge(badge, origin, sessionState) {
      const color = SESSION_STATE_COLORS[sessionState] || STATUS_COLORS[origin.status] || STATUS_COLORS.stopped
      badge.style.borderColor = color
      badge.style.color = color
      badge.title = t(`在「${origin.instanceName}」中创建`, `Created in “${origin.instanceName}”`)
      const key = `${origin.instanceId}|${origin.iconVersion || ''}|${origin.hasIcon ? 1 : 0}|${origin.instanceName}`
      if (badge.dataset.key !== key) {
        badge.dataset.key = key
        badge.textContent = ''
        if (origin.hasIcon) {
          const img = document.createElement('img')
          img.className = 'im-badge-img'
          img.alt = ''
          img.src = `${ROOT}/icon?id=${encodeURIComponent(origin.instanceId)}&v=${encodeURIComponent(origin.iconVersion || '')}`
          badge.appendChild(img)
        } else {
          badge.textContent = initialOf(origin.instanceName)
        }
      }
    }

    function scanSessionRows(origins) {
      if (typeof document === 'undefined') return
      const rows = document.querySelectorAll('[data-row-key^="session:"]')
      for (const row of rows) {
        const rawKey = row.getAttribute('data-row-key') || ''
        const sessionId = rawKey.slice('session:'.length)
        const origin = origins[sessionId]
        const reactBadge = row.querySelector('.im-session-badge-react')
        let injected = row.querySelector('.im-session-badge-dom')
        if (reactBadge) {
          if (injected) injected.remove()
          restoreNativeDots(row)
          continue
        }
        if (!origin) {
          if (injected) injected.remove()
          restoreNativeDots(row)
          continue
        }
        const dot = row.querySelector('[data-state]')
        if (!dot || !dot.parentElement) {
          if (injected) injected.remove()
          continue
        }
        if (!injected || injected.parentElement !== dot.parentElement) {
          if (injected) injected.remove()
          injected = document.createElement('span')
          injected.className = 'im-badge im-session-badge-dom'
          injected.addEventListener('dblclick', (event) => {
            event.preventDefault()
            event.stopPropagation()
            const current = origins[sessionId]
            if (!current) return
            if (current.status === 'running' && current.url) window.open(current.url, '_blank', 'noopener')
          })
          dot.parentElement.insertBefore(injected, dot)
        }
        updateInjectedBadge(injected, origin, dot.getAttribute('data-state'))
        dot.style.display = 'none'
      }
    }

    function letterFavicon(letter) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#4f7cff"/><text x="16" y="21.5" font-family="system-ui,sans-serif" font-size="15" font-weight="600" text-anchor="middle" fill="#ffffff">${letter}</text></svg>`
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    }

    // The shell ships its own <link rel="icon"> (the DSH whale). Browsers keep
    // whichever icon link they consider authoritative, so pointing our own link
    // is not enough: every icon link in <head> has to point at the instance icon.
    const FAVICON_SELECTOR = 'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'

    function setFavicon(record, fallbackName) {
      if (typeof document === 'undefined') return
      const hasIcon = Boolean(record && record.hasIcon)
      const type = hasIcon ? (record.iconContentType || 'image/png') : 'image/svg+xml'
      const href = hasIcon
        ? `${ROOT}/icon?id=${encodeURIComponent(record.id)}&v=${encodeURIComponent(record.iconVersion || '')}`
        : letterFavicon(initialOf(fallbackName))
      const apply = (link) => {
        if (link.getAttribute('href') !== href) link.setAttribute('href', href)
        if (link.getAttribute('type') !== type) link.setAttribute('type', type)
      }
      const links = Array.from(document.querySelectorAll(FAVICON_SELECTOR))
      let ours = links.find((link) => link.hasAttribute('data-im-favicon'))
      for (const link of links) {
        if (link === ours) continue
        apply(link)
        link.setAttribute('data-im-favicon-native', '1')
      }
      if (!ours) {
        ours = document.createElement('link')
        ours.rel = 'icon'
        ours.setAttribute('data-im-favicon', '1')
        ours.setAttribute('sizes', 'any')
        document.head.appendChild(ours)
      }
      apply(ours)
    }

    function applyInstanceBrand(hello, record) {
      if (typeof document === 'undefined') return
      const name = hello.instanceName || hello.instanceId || ''
      const identity = document.querySelector('[class*="_brandIdentity"]')
      if (!identity) return
      let wrap = identity.querySelector('[data-im-brand]')
      if (!wrap) {
        for (const child of Array.from(identity.children)) {
          if (!child.hasAttribute('data-im-brand')) child.style.display = 'none'
        }
        wrap = document.createElement('span')
        wrap.setAttribute('data-im-brand', '1')
        wrap.className = 'im-brand'
        identity.appendChild(wrap)
      }
      const iconKey = record ? `${record.id}:${record.iconVersion || ''}:${record.iconContentType || ''}` : ''
      if (wrap.getAttribute('data-icon-key') !== iconKey) {
        wrap.setAttribute('data-icon-key', iconKey)
        wrap.textContent = ''
        const image = document.createElement('img')
        image.className = 'im-brand-icon'
        image.alt = ''
        image.src = record && record.hasIcon
          ? `${ROOT}/icon?id=${encodeURIComponent(record.id)}&v=${encodeURIComponent(record.iconVersion || '')}`
          : letterFavicon(initialOf(name))
        wrap.appendChild(image)
        wrap.appendChild(document.createElement('span')).className = 'im-brand-name'
      }
      const label = wrap.querySelector('.im-brand-name')
      if (label && label.textContent !== name) label.textContent = name
    }

    function applyBranding(state) {
      if (typeof document === 'undefined') return
      const hello = state && state.hello
      if (!hello || hello.mode !== 'instance') return
      const name = hello.instanceName || hello.instanceId || ''
      if (!name) return
      if (document.title !== name) document.title = name
      const record = (state.instances || []).find((item) => item.id === hello.instanceId) || null
      setFavicon(record, name)
      applyInstanceBrand(hello, record)
    }

    function startWatchers() {
      if (stopWatchers) return
      let raf = 0
      let alive = true
      const tick = () => {
        if (!alive || !store.state) return
        scanSessionRows(store.state.sessionOrigins || {})
        applyBranding(store.state)
      }
      const schedule = () => {
        if (raf || !alive) return
        raf = requestAnimationFrame(() => {
          raf = 0
          tick()
        })
      }
      const observer = typeof document !== 'undefined' ? new MutationObserver(schedule) : null
      if (observer) observer.observe(document.body, { childList: true, subtree: true })
      const timer = setInterval(tick, 1500)
      const unsubscribe = subscribe(schedule)
      tick()
      stopWatchers = () => {
        alive = false
        if (observer) observer.disconnect()
        clearInterval(timer)
        unsubscribe()
        if (raf) cancelAnimationFrame(raf)
        try {
          if (typeof document !== 'undefined') {
            document.querySelectorAll('.im-session-badge-dom').forEach((node) => node.remove())
            document.querySelectorAll('[data-row-key^="session:"] [data-state]').forEach((dot) => { dot.style.display = '' })
          }
        } catch {
          /* ignored */
        }
      }
    }

    // ------------------------------------------------------------------
    // manual cross-process refresh button in the native workspaces header
    //
    // The native sidebar has no refresh affordance and this plugin is the only
    // place that knows the desktop and every instance share one DSH_HOME. The
    // button is DOM-injected next to the native workspace icons (search / view
    // options / add workspace) and re-created whenever the sidebar re-renders.
    // ------------------------------------------------------------------
    const REFRESH_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M13.1 6.3A5.4 5.4 0 0 0 3.5 4.7L2.3 6.1M2.9 9.7a5.4 5.4 0 0 0 9.6 1.6l1.2-1.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'

    function installWorkspaceRefreshButton(ctx) {
      if (typeof document === 'undefined') return () => {}
      let button = null
      let spinTimer = 0
      const onRefresh = () => {
        // Ask the host to replay workspace.json once (it is the only place that
        // can mirror the file into the live registry), then refresh the native
        // session/workspace stores and our own state.
        void syncNow()
        if (button) {
          button.setAttribute('data-busy', '1')
          if (spinTimer) clearTimeout(spinTimer)
          spinTimer = setTimeout(() => {
            spinTimer = 0
            if (button) button.removeAttribute('data-busy')
          }, 700)
        }
      }
      const ensure = () => {
        if (!document.body) return
        const anchor = ['添加工作区', 'Add workspace', '新增工作区', 'New workspace']
          .map((label) => document.querySelector(`button[aria-label="${label}"]`))
          .find(Boolean)
        if (!anchor || !anchor.parentElement) return
        const group = anchor.parentElement
        if (button && group.contains(button)) return
        if (!button) {
          button = document.createElement('button')
          button.type = 'button'
          button.className = 'im-ws-refresh'
          button.setAttribute('aria-label', t('刷新会话', 'Refresh sessions'))
          button.title = t('刷新会话与工作区', 'Refresh sessions and workspaces')
          button.innerHTML = REFRESH_SVG
          button.addEventListener('click', onRefresh)
        }
        group.appendChild(button)
      }
      ensure()
      const observer = new MutationObserver(() => ensure())
      observer.observe(document.body, { childList: true, subtree: true })
      return () => {
        observer.disconnect()
        if (spinTimer) clearTimeout(spinTimer)
        if (button) {
          button.remove()
          button = null
        }
      }
    }

    // ------------------------------------------------------------------
    // instance plugin page: block the native add button, open a native notice
    // ------------------------------------------------------------------
    function showAddPluginNoticeDom() {
      if (typeof document === 'undefined') return
      if (document.querySelector('.im-notice-backdrop')) return
      const backdrop = document.createElement('div')
      backdrop.className = 'im-notice-backdrop'
      const dialog = document.createElement('div')
      dialog.className = 'im-notice-dialog'
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')
      const title = document.createElement('div')
      title.className = 'im-notice-title'
      title.textContent = t('添加插件', 'Add plugin')
      const body = document.createElement('div')
      body.className = 'im-notice-body'
      body.textContent = t('请到 DeepSeek Harness 主端口（桌面应用）的分身设置页中，为这个分身添加插件。', 'Add plugins for this instance from the DeepSeek Harness desktop app, in its instance settings page.')
      const actions = document.createElement('div')
      actions.className = 'im-notice-actions'
      const ok = document.createElement('button')
      ok.type = 'button'
      ok.className = 'im-notice-ok'
      ok.textContent = t('知道了', 'Got it')
      const onKey = (event) => {
        if (event.key === 'Escape') close()
      }
      const close = () => {
        document.removeEventListener('keydown', onKey)
        backdrop.remove()
      }
      ok.addEventListener('click', close)
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) close()
      })
      actions.appendChild(ok)
      dialog.appendChild(title)
      dialog.appendChild(body)
      dialog.appendChild(actions)
      backdrop.appendChild(dialog)
      document.body.appendChild(backdrop)
      document.addEventListener('keydown', onKey)
      ok.focus()
    }

    function showAddPluginNotice() {
      if (typeof document === 'undefined') return
      if (document.querySelector('.im-notice-backdrop, .im-notice-host')) return
      if (!ReactDOMClient) {
        showAddPluginNoticeDom()
        return
      }
      const host = document.createElement('div')
      host.className = 'im-notice-host'
      document.body.appendChild(host)
      const close = () => {
        try {
          root.unmount()
        } catch {
          /* ignored */
        }
        host.remove()
      }
      let root
      try {
        root = ReactDOMClient.createRoot ? ReactDOMClient.createRoot(host) : null
      } catch {
        root = null
      }
      if (!root) {
        host.remove()
        showAddPluginNoticeDom()
        return
      }
      root.render(h(ui.Modal, {
        open: true,
        onClose: close,
        closeLabel: t('关闭', 'Close'),
        title: t('添加插件', 'Add plugin'),
        footer: h(ui.Button, { variant: 'primary', onClick: close }, t('知道了', 'Got it')),
      }, h('p', { className: 'im-hint', style: { margin: 0 } },
        t('请到 DeepSeek Harness 主端口（桌面应用）的分身设置页中，为这个分身添加插件。', 'Add plugins for this instance from the DeepSeek Harness desktop app, in its instance settings page.'))))
    }

    function installInstanceAddBlocker(ctx) {
      if (typeof document === 'undefined') return () => {}
      const onClick = (event) => {
        const target = event.target instanceof Element ? event.target.closest('[class*="_addPrimary"],[class*="_addButton"]') : null
        if (!target) return
        if (target.closest('.im-page, .im-notice-host, .im-notice-backdrop')) return
        event.preventDefault()
        event.stopPropagation()
        showAddPluginNotice()
      }
      document.addEventListener('click', onClick, true)
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', `${NS}/client.instance-hide.css`)
      style.textContent = '[class*="_addMore"]{display:none!important}[class*="_addGroup"]>[class*="_addPrimary"]{border-top-right-radius:var(--dsw-radius-md)!important;border-bottom-right-radius:var(--dsw-radius-md)!important}'
      document.head.appendChild(style)
      return () => {
        document.removeEventListener('click', onClick, true)
        style.remove()
      }
    }

    // ------------------------------------------------------------------
    // instance-mode branding (tab icon + title)
    // ------------------------------------------------------------------
    // handled by startWatchers() via applyBranding()

    // ------------------------------------------------------------------
    // CSS
    // ------------------------------------------------------------------
    const CSS = `
.im-page{display:flex;flex-direction:column;gap:14px;padding:22px 0 48px;width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;height:100%;min-height:0;overflow-y:auto}
.im-page,.im-page *{box-sizing:border-box}
.im-page>*{width:100%;max-width:960px;margin-left:auto;margin-right:auto;flex:0 0 auto}
.im-page-head{display:flex;flex-direction:column;align-items:stretch;gap:10px;padding:14px 16px 12px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;min-height:0;box-shadow:none}
.im-hero-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;min-width:0}
.im-hero-titles{display:flex;flex-direction:column;gap:2px;min-width:0}
.im-hero-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding-top:2px}
.im-page-head .im-page-title{font-size:20px;line-height:26px}
.im-status-seg{display:flex;align-items:stretch;gap:2px;padding:3px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);border-radius:9px;box-shadow:inset 0 1px 2px rgba(0,0,0,.07),inset 0 0 0 .5px color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)}
.im-seg{position:relative;flex:1 1 0;min-width:0;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:20px;padding:7px 8px;border-radius:7px;cursor:pointer;white-space:nowrap;transition:color .14s ease}
.im-seg:hover{color:var(--dsw-alias-label-primary);background:color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)}
.im-seg[data-active=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px rgba(0,0,0,.10),0 0 0 .5px color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)}
.im-seg-label,.im-seg-count{position:relative;z-index:1}
.im-seg-count{font-size:11.5px;line-height:16px;min-width:18px;padding:0 5px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);color:var(--dsw-alias-label-secondary);font-weight:600;text-align:center}
.im-seg[data-active=true] .im-seg-count{background:color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent);color:var(--dsw-alias-label-primary)}
.im-page-heading{display:flex;flex-direction:row;align-items:center;gap:6px;min-width:0}
.im-page-title-row{display:flex;align-items:baseline;gap:10px;min-width:0}
.im-page-title{margin:0;font-size:20px;font-weight:600;line-height:28px;color:var(--dsw-alias-label-primary)}
.im-page-sub-row{display:flex;align-items:center;gap:6px;min-height:18px}
.im-page-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.im-page-info{display:inline-flex;align-items:center;justify-content:center;position:relative;color:var(--dsw-alias-label-tertiary);cursor:help;outline:none;flex:0 0 auto}
.im-page-info:hover,.im-page-info:focus-visible{color:var(--dsw-alias-label-secondary)}
.im-page-info[data-tip]:after{content:attr(data-tip);position:absolute;left:50%;top:calc(100% + 8px);transform:translateX(-50%);width:max-content;max-width:380px;padding:8px 10px;border-radius:8px;background:#1f2329;color:#fff;font-size:12px;line-height:18px;font-weight:400;white-space:normal;text-align:left;box-shadow:0 8px 24px rgba(0,0,0,.18);opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease;z-index:40}
.im-page-info:hover:after,.im-page-info:focus-visible:after{opacity:1;visibility:visible}
.im-page-desc{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.im-toolbar{display:flex;flex-direction:column;align-items:stretch;gap:10px}
.im-search{display:flex;align-items:center;gap:6px;height:34px;padding:0 12px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);width:100%;flex:0 0 auto}
.im-search-input{border:0;background:transparent;outline:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;width:100%;min-width:0}
.im-list{display:flex;flex-direction:column;gap:2px}
.im-card{position:relative;display:flex;align-items:center;gap:14px;padding:14px 12px;border:0;border-radius:var(--dsw-radius-lg);background:transparent;cursor:default;transition:background .12s ease;user-select:none}
.im-card+.im-card:before{content:"";position:absolute;left:12px;right:12px;top:0;border-top:.5px solid var(--dsw-alias-border-l2)}
.im-card:hover{background:var(--dsw-alias-interactive-bg-hover)}
.im-card[data-dragging=true]{opacity:.45}
.im-card-grip{display:inline-flex;align-items:center;justify-content:center;width:18px;flex:0 0 18px;color:var(--dsw-alias-label-dimmed);cursor:grab;opacity:0;transition:opacity .12s ease}
.im-card:hover .im-card-grip{opacity:.8}
.im-card-icon{flex:0 0 auto;display:flex;align-items:center;justify-content:center;border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-3)}
.im-instance-icon{display:flex;align-items:center;justify-content:center;object-fit:cover}
.im-instance-icon-fallback{background:linear-gradient(135deg,var(--dsw-alias-brand-primary,#4f7cff),var(--dsw-alias-state-success-primary,#4f7cff));color:var(--dsw-alias-label-inverted,#fff);font-size:20px;font-weight:600}
.im-card-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px}
.im-card-title-row{display:flex;align-items:center;gap:8px;min-width:0}
.im-card-name{font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.im-card-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.im-card-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.im-tag{flex:0 0 auto;font-size:11px;line-height:16px;padding:0 6px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.im-tag-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-border-l2))}
.im-card-actions{flex:0 0 auto;display:flex;align-items:center;gap:6px}
.im-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.im-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.im-icon-btn:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.im-icon-btn[data-tone=danger]:hover:not(:disabled){color:var(--dsw-alias-state-error-primary)}
.im-hero-actions .im-icon-btn{width:34px;height:34px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.im-hero-actions .im-icon-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.im-add-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;transition:border-color .15s ease,color .15s ease,background .15s ease}
.im-add-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.im-add-btn:disabled{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-dimmed);cursor:default;opacity:.6}
.im-card-side{flex:0 0 auto;display:flex;align-items:center}
.im-statusbar{display:inline-block;width:4px;height:40px;border-radius:2px;background:var(--dsw-alias-label-dimmed)}
.im-detail-head{display:flex;align-items:center;gap:8px}
.im-back{display:inline-flex;align-items:center;gap:2px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;cursor:pointer;padding:4px 6px;border-radius:6px}
.im-back:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.im-detail-title-row{display:flex;align-items:center;gap:14px}
.im-detail-icon{flex:0 0 auto}
.im-detail-name{margin:0;font-size:20px;font-weight:600;line-height:28px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.im-detail-sub{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.im-dot-sep{color:var(--dsw-alias-border-l2)}
.im-group{display:flex;flex-direction:column;gap:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);padding:16px 18px;background:var(--dsw-alias-bg-layer-1)}
.im-group-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.im-group-title{margin:0;font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}
.im-form{display:flex;flex-direction:column;gap:12px}
.im-field{display:flex;flex-direction:column;gap:6px}
.im-label{display:flex;align-items:center;gap:6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.im-required{color:var(--dsw-alias-state-error-primary)}
.im-input{height:34px;padding:0 10px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none;min-width:0}
.im-input:focus{border-color:var(--dsw-alias-brand-primary)}
.im-input-compact{width:120px}
.im-readonly{height:34px;display:flex;align-items:center;padding:0 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:13px}
.im-switch-row{display:flex;align-items:center;justify-content:space-between;gap:14px}
.im-toggle{white-space:nowrap;min-width:56px;flex:0 0 auto}
.im-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.im-generating{color:var(--dsw-alias-brand-primary,#4f7cff);animation:im-pulse 1.4s ease-in-out infinite}
@keyframes im-pulse{0%,100%{opacity:1}50%{opacity:.55}}
.im-muted{color:var(--dsw-alias-label-tertiary);font-size:13px;margin:0}
.im-subpage-empty{margin-left:auto;margin-right:auto;text-align:center;padding:20px 0}
.im-warn-text{font-size:12px;color:var(--dsw-alias-state-warn-primary)}
.im-kv{display:flex;flex-direction:column;gap:12px}
.im-kv-row{display:flex;align-items:flex-start;gap:14px}
.im-kv-key{flex:0 0 96px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);padding-top:6px}
.im-kv-value{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;flex:1}
.im-url{font-family:var(--dsw-font-family-mono,monospace);font-size:12px;padding:4px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.im-path-row{display:flex;align-items:center;gap:8px;min-width:0}
.im-path-input{flex:1 1 auto}
.im-path-value{flex-direction:column;align-items:flex-start;gap:6px}
.im-path-value .im-url{white-space:normal;word-break:break-all;max-width:100%}
.im-icon-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.im-icon-row-text{display:flex;flex-direction:column;gap:4px;min-width:0}
.im-icon-prompt{margin-left:auto;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1;cursor:pointer;white-space:nowrap}
.im-icon-prompt:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.im-prompt-modal{display:flex!important;flex-direction:column;width:min(720px,94vw)!important;max-width:720px!important;max-height:min(80vh,720px);overflow:hidden}
.im-prompt-modal-content{flex:1 1 auto;min-height:0;max-height:none;overflow-y:auto}
.im-kw-groups{display:flex;flex-direction:column;gap:14px}
.im-kw-group{display:flex;flex-direction:column;gap:8px}
.im-kw-title{font-size:12px;color:var(--dsw-alias-label-secondary)}
.im-kw-list{display:flex;flex-wrap:wrap;gap:6px}
.im-kw-chip{height:26px;padding:0 10px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}
.im-kw-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.im-kw-chip[data-active="true"]{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}
.im-kw-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f7cff);outline-offset:2px}

.im-action-notice{display:flex;align-items:flex-start;gap:8px}
.im-action-notice .im-notice{flex:1 1 auto}
.im-notice-dismiss{flex:0 0 auto;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:24px;cursor:pointer;padding:0 4px}
.im-icon-edit{position:relative;display:inline-flex;align-items:center;justify-content:center;width:72px;height:72px;padding:0;margin:0;line-height:0;border:0;background:transparent;border-radius:16px;cursor:pointer;overflow:hidden;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2)}
.im-icon-edit:hover .im-icon-edit-hint{opacity:1}
.im-icon-edit-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42);color:#fff;font-size:12px;opacity:0;transition:opacity .12s ease}
.im-access-group{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);align-self:flex-start}
.im-shell-runtime{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.im-hint-error{color:var(--dsw-alias-label-error,#d64545)}
.im-access-btn{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:20px;padding:4px 12px;border-radius:6px;cursor:pointer}
.im-access-btn[data-active=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 0 0 .5px var(--dsw-alias-border-l2)}
.im-access-btn:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.im-plugin-tabs{display:flex;align-items:stretch;gap:2px;border-bottom:.5px solid var(--dsw-alias-border-l2);margin-bottom:2px}
.im-plugin-tab{flex:1 1 0;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:20px;padding:6px 10px 8px;cursor:pointer;position:relative;border-radius:4px 4px 0 0}
.im-plugin-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.im-plugin-tab[data-active=true]{color:var(--dsw-alias-label-primary);font-weight:500}
.im-plugin-tab[data-active=true]:after{content:"";position:absolute;left:12px;right:12px;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-label-primary)}
.im-plugin-tab-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:9px;font-size:11px;line-height:18px;font-weight:400;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-3)}
.im-plugin-list{list-style:none;margin:0 auto;padding:0;width:100%;max-width:960px;display:flex;flex-direction:column;gap:2px}
.im-plugin-row{display:flex;align-items:center;justify-content:flex-start;gap:12px;padding:8px 10px;border-radius:10px;transition:background .12s ease}
.im-plugin-row:hover{background:var(--dsw-alias-bg-layer-2)}
.im-plugin-tile{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;flex:0 0 36px;border-radius:10px;color:#fff;background:linear-gradient(135deg,#7b8dff,#5b6cf0)}
.im-plugin-tile[data-tone="1"]{background:linear-gradient(135deg,#59c9a5,#2fa37f)}
.im-plugin-tile[data-tone="2"]{background:linear-gradient(135deg,#f0a35e,#d9822b)}
.im-plugin-tile[data-tone="3"]{background:linear-gradient(135deg,#c98bf0,#9a5fd0)}
.im-plugin-tile[data-tone="4"]{background:linear-gradient(135deg,#67b7e8,#3f8ec9)}
.im-plugin-main{min-width:0;display:flex;flex-direction:column;gap:2px}
.im-plugin-name{font-size:14px;font-weight:500;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.im-plugin-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto;margin-left:auto}
.im-plugin-entries{display:flex;flex-direction:column;gap:10px}
.im-plugin-entry{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.im-plugin-entry-text{min-width:0;display:flex;flex-direction:column;gap:2px}
.im-plugin-entry-title{font-size:13px;font-weight:600;line-height:20px}
.im-plugin-entry-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.im-subpage-head{display:flex;flex-direction:column;gap:4px}
.im-subpage-title{margin:0;font-size:20px;font-weight:600;line-height:28px;color:var(--dsw-alias-label-primary)}
.im-add-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.im-add-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 2px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.im-add-row:last-child{border-bottom:0}
.im-add-groups{display:flex;flex-direction:column;gap:18px}
.im-add-group{display:flex;flex-direction:column;gap:4px}
.im-add-group-title{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em;padding:2px 2px 4px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.im-add-name{margin-left:8px;font-weight:400;font-size:12px;color:var(--dsw-alias-label-dimmed)}
.im-add-modal{width:min(760px,94vw)!important;max-width:760px!important}
.im-add-modal-content{max-height:min(62vh,560px);overflow-y:auto;padding-right:4px}
.im-brand{display:inline-flex;align-items:center;gap:8px;min-width:0;max-width:100%}
.im-brand-icon{width:24px;height:24px;border-radius:7px;object-fit:cover;flex:0 0 auto}
.im-brand-name{font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.im-icon-choices{display:flex;flex-direction:column;gap:10px}
.im-icon-choice{display:flex;align-items:center;gap:14px;padding:14px;border-radius:var(--dsw-radius-lg);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.im-icon-choice:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.im-icon-choice:disabled{opacity:.6;cursor:default}
.im-icon-choice-glyph{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);font-size:20px;line-height:1}
.im-icon-choice-text{min-width:0;display:flex;flex-direction:column;gap:2px}
.im-icon-choice-title{font-size:14px;font-weight:600;line-height:20px}
.im-textarea{height:auto;min-height:150px;padding:10px 12px;line-height:20px;resize:vertical;font-family:inherit}
.im-delete-btn{color:var(--dsw-alias-label-primary)}
.im-danger-row{display:flex;align-items:center;justify-content:space-between;gap:14px}
.im-danger .im-group-title{color:var(--dsw-alias-state-error-primary)}
.im-error-panel{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-error-primary);font-size:13px}
.im-notice{padding:8px 12px;border-radius:var(--dsw-radius-md);font-size:13px;line-height:20px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.im-notice[data-tone=error]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.im-notice[data-tone=success]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.im-progress{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.im-progress-track{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}
.im-progress-fill{height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}
.im-progress-text{display:flex;justify-content:space-between;gap:10px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.im-create-progress{display:flex;flex-direction:column;gap:10px}
.im-create-name{font-size:14px;font-weight:600}
.im-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:56px 20px;text-align:center}
.im-empty-icon{display:flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:16px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}
.im-empty-title{margin:6px 0 0;font-size:16px;font-weight:600;line-height:24px}
.im-empty-text{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);max-width:420px}
.im-log{margin:0;max-height:340px;overflow:auto;font-family:var(--dsw-font-family-mono,monospace);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-md);padding:10px}
.im-plugin-icon{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;flex:0 0 40px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);overflow:hidden;color:var(--dsw-alias-label-tertiary)}
.im-plugin-iconimg{width:28px;height:28px;object-fit:contain}
.im-plugin-desc{font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.im-autosave-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0 auto;width:100%;max-width:960px}
.im-actions{display:flex;flex-direction:column;gap:12px}
.im-action-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.im-action-text{display:flex;flex-direction:column;gap:4px;min-width:0}
.im-action-title{font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.im-action-value{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}
.im-detail-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-top:4px}
.im-nav-svg{display:block;flex:0 0 auto}
.im-nav-wrap{position:relative;display:inline-flex;align-items:center;justify-content:center}
.im-hint-warn{color:var(--dsw-alias-label-warning,#b7791f)}
.im-nav-badge{position:absolute;top:-4px;right:-6px;display:flex;align-items:center;justify-content:center;width:14px;height:14px;padding:0;border-radius:50%;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);font:600 9px/1 var(--dsw-font-ui,system-ui);text-align:center;box-shadow:0 0 0 1.5px var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#fff));pointer-events:none}
.im-ws-refresh{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:4px;flex:0 0 auto}
.im-ws-refresh:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.im-ws-refresh[data-busy="1"] svg{animation:im-spin .7s linear}
@keyframes im-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.im-badge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:5px;border:1.5px solid var(--dsw-alias-label-dimmed);overflow:hidden;font-size:9px;font-weight:600;line-height:1;cursor:default;user-select:none;flex:0 0 auto;background:var(--dsw-alias-bg-layer-2);box-sizing:border-box}
.im-executor-anchor{display:none}
.im-executor{display:inline-flex;align-items:center;gap:4px;min-width:0;height:calc(28px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(24px + var(--dsh-content-font-delta,0px));white-space:nowrap}
.im-executor svg{display:block;flex:0 0 auto;width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}
.im-executor-name{min-width:0;overflow:hidden;text-overflow:ellipsis}
.im-badge-img{display:block;object-fit:cover;width:100%;height:100%}
.im-badge-letter{display:flex;align-items:center;justify-content:center;width:100%;height:100%}
.im-banner{display:flex;align-items:center;gap:10px;padding:8px 12px;margin:0 0 8px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.im-banner-icon{display:flex;align-items:center;color:var(--dsw-alias-brand-primary)}
.im-banner-body{min-width:0;flex:1}
.im-banner-title{color:var(--dsw-alias-label-primary);font-weight:500}
.im-banner-text{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.im-banner-close{display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:4px;border-radius:4px}
.im-banner-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.im-notice-host{position:relative;z-index:2147483000}
.im-notice-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42);padding:24px}
.im-notice-dialog{width:min(440px,100%);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-xl);border:.5px solid var(--dsw-alias-border-l2);box-shadow:0 18px 48px rgba(0,0,0,.28);padding:18px 20px;display:flex;flex-direction:column;gap:10px;font-size:14px;line-height:22px}
.im-notice-title{font-size:15px;font-weight:600}
.im-notice-body{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.im-notice-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:4px}
.im-notice-ok{height:32px;padding:0 14px;border-radius:8px;border:0;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-inverted,#fff);font:inherit;font-size:13px;cursor:pointer}
.im-host-error{position:fixed;left:16px;bottom:16px;z-index:2147482000;max-width:min(460px,calc(100vw - 32px));display:flex;align-items:flex-start;gap:12px;padding:12px 14px;border-radius:12px;border:.5px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);box-shadow:0 10px 30px rgba(0,0,0,.24);pointer-events:auto}
.im-host-error-main{min-width:0;display:flex;flex-direction:column;gap:4px}
.im-host-error-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.im-host-error-text{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.im-host-error-retry{flex:0 0 auto;height:28px;padding:0 12px;border-radius:8px;border:0;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-inverted,#fff);font:inherit;font-size:12px;cursor:pointer}
`

    // Shown when even the first /state request failed: at that point no sidebar
    // entry or panel exists yet, so this overlay slot is the only way to tell the
    // user what is wrong and let them retry.
    function HostErrorToast() {
      const error = useStoreError()
      const state = useStore()
      if (!error || state) return null
      return h('div', { className: 'im-host-error', role: 'alert' },
        h('div', { className: 'im-host-error-main' },
          h('div', { className: 'im-host-error-title' }, t('分身管理无法连接宿主接口', 'Instance Manager cannot reach the host API')),
          h('div', { className: 'im-host-error-text' }, error)),
        h('button', {
          type: 'button',
          className: 'im-host-error-retry',
          // A full reload is the most reliable recovery: it re-runs the shell boot
          // sequence (and the token exchange) instead of patching a half-initialized
          // client state.
          onClick: () => {
            try {
              window.location.reload()
            } catch {
              void refresh()
            }
          },
        }, t('重试', 'Retry')))
    }

    // ------------------------------------------------------------------
    // registration
    // ------------------------------------------------------------------
    const disposers = []
    let registeredDesktop = false
    let registeredInstance = false

    function registerDesktopPanels() {
      if (registeredDesktop) return
      registeredDesktop = true
      const ctx = ctxRef
      try {
        disposers.push(installWorkspaceRefreshButton(ctx))
      } catch {
        /* ignored */
      }
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'instances',
          order: -10,
          locale: NS,
          label: () => t('分身', 'Instances'),
        }, InstancesNavIcon))
      ctx.slots.inject('main', () =>
        ctx.slots.register({
          name: 'main',
          key: 'instances',
          locale: NS,
        }, InstancesPage))
    }

    function registerInstancePanels() {
      if (registeredInstance) return
      registeredInstance = true
      const ctx = ctxRef
      try {
        disposers.push(installInstanceAddBlocker(ctx))
      } catch {
        /* ignored */
      }
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'workspaces'],
      apply(ctx) {
        ctxRef = ctx
        try {
          LANG = ctx.locale.getSnapshot().active === 'en' ? 'en' : 'zh'
        } catch {
          LANG = 'zh'
        }
        disposers.push(ctx.effect(() => {
          const tagId = `${NS}/client.css`
          if (typeof document !== 'undefined' && !document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`)) {
            const tag = document.createElement('style')
            tag.dataset.plugin = NS
            tag.dataset.pluginCss = tagId
            tag.textContent = CSS
            document.head.appendChild(tag)
          }
          return () => {}
        }, 'instance-manager: styles'))

        try {
          const unsubscribeLocale = ctx.locale.subscribe(() => {
            const snapshot = ctx.locale.getSnapshot()
            const next = snapshot.active === 'en' ? 'en' : 'zh'
            if (next !== LANG) {
              LANG = next
              emit()
            }
          })
          if (typeof unsubscribeLocale === 'function') disposers.push(unsubscribeLocale)
        } catch {
          /* ignored */
        }

        startPolling()
        startWatchers()
        disposers.push(() => stopPolling())
        disposers.push(() => {
          if (stopWatchers) {
            stopWatchers()
            stopWatchers = null
          }
        })

        const unsubscribe = subscribe(() => {
          const mode = store.state && store.state.hello ? store.state.hello.mode : ''
          if (mode === 'desktop') registerDesktopPanels()
          else if (mode === 'instance') registerInstancePanels()
        })
        disposers.push(unsubscribe)

        // Session attribution markers exist in both environments.
        ctx.slots.inject('sidebar.session.row.leading', () =>
          ctx.slots.register({
            name: 'sidebar.session.row.leading',
            id: 'instance-manager.attribution',
            order: 20,
            locale: NS,
          }, SessionOriginBadge))
        // Put the last executor beside the per-message usage/time strip.
        ctx.slots.inject('conversation.chat.assistant-actions', () =>
          ctx.slots.register({
            name: 'conversation.chat.assistant-actions',
            id: 'instance-manager.executor',
            order: 40,
            locale: NS,
          }, AssistantExecutor))
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register({
            name: 'conversation.input.dock',
            id: 'instance-manager.attribution-banner',
            order: 5,
            locale: NS,
            inject: (sessionId) => ({ sessionRef: sessionId }),
          }, AttributionBanner))
        // Bootstrap failure has no panel to attach to; use the shell overlay.
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({
            name: 'shell.overlay',
            id: 'instance-manager.host-error',
            order: 10,
            locale: NS,
          }, HostErrorToast))

        disposers.push(() => {
          for (const dispose of disposers.splice(0)) {
            try {
              if (typeof dispose === 'function') dispose()
            } catch {
              /* ignored */
            }
          }
        })
        ctx.effect(() => () => {
          for (const dispose of disposers.splice(0)) {
            try {
              if (typeof dispose === 'function') dispose()
            } catch {
              /* ignored */
            }
          }
        }, 'instance-manager: teardown')
      },
    }
  },
})
