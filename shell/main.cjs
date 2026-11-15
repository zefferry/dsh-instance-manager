/*
 * Minimal desktop shell for a DSH instance.
 *
 * Spawned by the instance-manager host with:
 *   SHELL_URL    instance url (includes the one-time token)
 *   SHELL_TITLE  instance name (window/taskbar title)
 *   SHELL_ICON   optional absolute path to a png/ico icon
 *   SHELL_APP_ID optional AppUserModelID for taskbar grouping
 *   SHELL_DESKTOP_EXE optional path to the main DeepSeek Harness executable; the
 *                back button hides this window and launches/focuses it.
 *   SHELL_PROBE  optional path: write a JSON report and quit (UI tests only)
 *
 * The window is frameless so the page itself owns the whole surface. A slim
 * 34px transparent bar is injected on top of the page; it blends with the page
 * background, hosts a sidebar toggle on the left and the window controls on the
 * right. The taskbar/window icon follows the instance favicon once the page's
 * client plugin has applied it (the page starts with the native whale icon, so
 * the icon is re-applied as soon as the instance icon link appears).
 */
const { app, BrowserWindow, ipcMain, nativeImage, screen, session, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const targetUrl = process.env.SHELL_URL || ''
const initialTitle = process.env.SHELL_TITLE || 'DSH'
const iconHint = process.env.SHELL_ICON || ''
const appId = process.env.SHELL_APP_ID || ''
const probeFile = process.env.SHELL_PROBE || ''
const desktopExe = process.env.SHELL_DESKTOP_EXE || ''

const BAR_HEIGHT = 34

function signal (line) {
  try { process.stdout.write(line + '\n') } catch {}
}

let window = null
let ready = false
let iconTimer = null
let lastIconData = ''

const iconScript = `(async () => {
  const links = Array.from(document.querySelectorAll('link[rel~="icon"]'))
  const link = links.find((candidate) => {
    const href = candidate && candidate.href ? candidate.href : ''
    return href.includes('/plugins/instance-manager/icon') || href.startsWith('data:image/')
  })
  if (!link || !link.href) return ''
  try {
    const img = new Image()
    img.src = link.href
    await img.decode()
    const size = 256
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''
    ctx.clearRect(0, 0, size, size)
    ctx.drawImage(img, 0, 0, size, size)
    return canvas.toDataURL('image/png')
  } catch {
    return ''
  }
})()`

const barScript = `(() => {
  if (document.getElementById('dsh-shell-bar')) return true
  const style = document.createElement('style')
  style.id = 'dsh-shell-bar-style'
  style.textContent = [
    'html,body{height:100%!important;margin:0!important;overflow:hidden!important}',
    '#root{position:fixed!important;left:0!important;right:0!important;top:${BAR_HEIGHT}px!important;bottom:0!important;height:auto!important;margin:0!important}',
    '#dsh-shell-bar{position:fixed;left:0;right:0;top:0;height:${BAR_HEIGHT}px;z-index:2147483000;display:flex;align-items:center;gap:4px;padding:0 6px;background:transparent;-webkit-app-region:drag}',
    '#dsh-shell-bar .sh-b{width:30px;height:26px;display:flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:rgba(255,255,255,.68);-webkit-app-region:no-drag;cursor:default;padding:0}',
    '#dsh-shell-bar .sh-b:hover{background:rgba(255,255,255,.09);color:#fff}',
    '#dsh-shell-bar .sh-b.sh-close:hover{background:#e81123;color:#fff}',
    '#dsh-shell-bar svg{width:14px;height:14px;display:block}',
    '#dsh-shell-bar .sh-spacer{flex:1;height:100%;-webkit-app-region:drag}'
  ].join('')
  document.head.appendChild(style)
  // Newer DSH builds reserve the title-bar area themselves (data-windows-titlebar
  // + --dsh-frame-top-clearance). Only offset #root when the page does not.
  if (document.documentElement.hasAttribute('data-windows-titlebar')) {
    try {
      const rules = Array.from(style.sheet.cssRules)
      for (let index = rules.length - 1; index >= 0; index -= 1) {
        if (rules[index].selectorText === '#root') style.sheet.deleteRule(index)
      }
    } catch {}
  }
  const bar = document.createElement('div')
  bar.id = 'dsh-shell-bar'
  const api = window.__dshShell || {}
  const english = (() => {
    const lang = String(document.documentElement.getAttribute('lang') || navigator.language || '').toLowerCase()
    return lang.indexOf('en') === 0
  })()
  const L = english
    ? { back: 'Back to DeepSeek Harness', toggle: 'Toggle sidebar', minimize: 'Minimize', maximize: 'Maximize', restore: 'Restore', close: 'Close' }
    : { back: '返回 DeepSeek Harness', toggle: '收起/展开侧边栏', minimize: '最小化', maximize: '最大化', restore: '向下还原', close: '关闭' }
  const makeButton = (cls, title, svg, onClick) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'sh-b ' + cls
    button.title = title
    button.setAttribute('aria-label', title)
    button.innerHTML = svg
    button.addEventListener('click', onClick)
    return button
  }
  const left = document.createElement('div')
  left.style.cssText = 'display:flex;align-items:center;gap:2px;-webkit-app-region:no-drag'
  const collapse = makeButton('', L.toggle,
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M6 3v10"/></svg>',
    () => {
      const pick = () => {
        const labels = ['收起侧边栏', '打开侧边栏', 'Collapse sidebar', 'Open sidebar']
        const nodes = Array.from(document.querySelectorAll('[aria-label]'))
        const visible = (el) => {
          const rect = el.getBoundingClientRect()
          const style = window.getComputedStyle(el)
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
        }
        for (const el of nodes) {
          const label = el.getAttribute('aria-label') || ''
          if (labels.indexOf(label) !== -1 && visible(el)) return el
        }
        for (const el of nodes) {
          const label = el.getAttribute('aria-label') || ''
          if ((label.indexOf('侧边栏') !== -1 || /sidebar/i.test(label)) && visible(el)) return el
        }
        return null
      }
      const target = pick()
      if (target) target.click()
    })
  const back = makeButton('', L.back,
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M9.5 3.5L5 8l4.5 4.5"/><path d="M5 8h7"/></svg>',
    () => { if (api.back) api.back() })
  left.appendChild(back)
  left.appendChild(collapse)
  bar.appendChild(left)
  const spacer = document.createElement('div')
  spacer.className = 'sh-spacer'
  bar.appendChild(spacer)
  bar.appendChild(makeButton('', L.minimize,
    '<svg viewBox="0 0 10 10"><path d="M2 5h6" stroke="currentColor" stroke-width="1"/></svg>',
    () => { if (api.minimize) api.minimize() }))
  const MAX_SVG = '<svg viewBox="0 0 10 10"><rect x="2.2" y="2.2" width="5.6" height="5.6" fill="none" stroke="currentColor" stroke-width="1"/></svg>'
  const RESTORE_SVG = '<svg viewBox="0 0 10 10"><rect x="1.6" y="3.2" width="5.2" height="5.2" fill="none" stroke="currentColor" stroke-width="1"/><path d="M3.4 3.2V1.6h5v5h-1.6" fill="none" stroke="currentColor" stroke-width="1"/></svg>'
  const maxButton = makeButton('', L.maximize, MAX_SVG,
    () => { if (api.toggleMaximize) api.toggleMaximize() })
  const applyMaximized = (maximized) => {
    maxButton.innerHTML = maximized ? RESTORE_SVG : MAX_SVG
    maxButton.title = maximized ? L.restore : L.maximize
    maxButton.setAttribute('aria-label', maxButton.title)
  }
  if (api.isMaximized) {
    try { applyMaximized(Boolean(api.isMaximized())) } catch {}
  }
  if (api.onMaximizeChange) api.onMaximizeChange(applyMaximized)
  bar.appendChild(maxButton)
  bar.appendChild(makeButton('sh-close', L.close,
    '<svg viewBox="0 0 10 10"><path d="M2.2 2.2l5.6 5.6M7.8 2.2L2.2 7.8" stroke="currentColor" stroke-width="1"/></svg>',
    () => { if (api.close) api.close() }))
  bar.addEventListener('dblclick', (event) => {
    if (event.target === bar || event.target === spacer) {
      if (api.toggleMaximize) api.toggleMaximize()
    }
  })
  document.body.appendChild(bar)
  return true
})()`

function installBar (contents) {
  contents.executeJavaScript(barScript, true).catch(() => {})
}

function applyPageIcon (win) {
  return Promise.resolve(win.webContents.executeJavaScript(iconScript, true)).then((dataUrl) => {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) return false
    if (dataUrl === lastIconData) return false
    lastIconData = dataUrl
    try {
      const image = nativeImage.createFromDataURL(dataUrl)
      if (image.isEmpty()) return false
      win.setIcon(image)
      signal('shell-icon ' + image.getSize().width + 'x' + image.getSize().height)
      return true
    } catch {
      return false
    }
  }).catch(() => false)
}

function startIconWatch (win) {
  if (iconTimer) clearInterval(iconTimer)
  const startedAt = Date.now()
  let applied = false
  const attempt = () => {
    if (!win || win.isDestroyed()) return
    void applyPageIcon(win).then((ok) => {
      if (ok) applied = true
      if (applied && iconTimer) {
        clearInterval(iconTimer)
        iconTimer = null
      }
    })
  }
  iconTimer = setInterval(() => {
    if (!win || win.isDestroyed()) { clearInterval(iconTimer); iconTimer = null; return }
    if (Date.now() - startedAt > 30000) { clearInterval(iconTimer); iconTimer = null; return }
    attempt()
  }, 300)
  attempt()
  win.webContents.on('page-favicon-updated', attempt)
}

function errorPage (message) {
  const escaped = String(message || (String(app.getLocale() || '').toLowerCase().startsWith('en') ? 'Unknown error' : '未知错误')).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const english = String(app.getLocale() || '').toLowerCase().startsWith('en')
  const title = english ? 'Cannot open this instance' : '无法打开分身'
  const hint = english
    ? 'Close this window and start the instance again from the DeepSeek Harness desktop app.'
    : '可以关闭本窗口，回到 DeepSeek Harness 桌面端重新启动分身。'
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8">
  <body style="font-family:system-ui;background:#0f1115;color:#e6e8ee;padding:40px">
  <h2 style="margin:0 0 12px">${title}</h2>
  <p style="opacity:.8;line-height:1.7">${escaped}</p>
  <p style="opacity:.6;margin-top:24px">${hint}</p></body>`)
}

async function writeProbe (win) {
  if (!probeFile || !win || win.isDestroyed()) return
  try {
    const info = await win.webContents.executeJavaScript(`(() => {
      const bar = document.getElementById('dsh-shell-bar')
      const root = document.getElementById('root')
      const buttons = bar ? Array.from(bar.querySelectorAll('button')).map((button) => button.getAttribute('aria-label')) : []
      return {
        hasBar: Boolean(bar),
        buttons,
        title: document.title,
        rootTop: root ? Math.round(root.getBoundingClientRect().top) : -1,
        viewport: { w: window.innerWidth, h: window.innerHeight }
      }
    })()`, true)
    let sidebarToggle = null
    try {
      const readToggle = "(function(){var el=document.querySelector('[aria-label=\"收起侧边栏\"],[aria-label=\"打开侧边栏\"],[aria-label=\"Collapse sidebar\"],[aria-label=\"Open sidebar\"]');return el?el.getAttribute('aria-label'):null})()"
      const clickBar = "(function(){var bs=Array.from(document.querySelectorAll('#dsh-shell-bar button'));var b=bs.find(function(x){var l=x.getAttribute('aria-label')||'';return l==='收起/展开侧边栏'||l==='Toggle sidebar'});if(!b)return false;b.click();return true})()"
      const seen = await win.webContents.executeJavaScript(readToggle, true)
      if (seen) {
        const before = seen
        await win.webContents.executeJavaScript(clickBar, true)
        await new Promise((resolve) => setTimeout(resolve, 700))
        const afterCollapse = await win.webContents.executeJavaScript(readToggle, true)
        await win.webContents.executeJavaScript(clickBar, true)
        await new Promise((resolve) => setTimeout(resolve, 700))
        const afterExpand = await win.webContents.executeJavaScript(readToggle, true)
        sidebarToggle = { before, afterCollapse, afterExpand }
      }
    } catch {}
    let backMinimized = null
    try {
      const clicked = await win.webContents.executeJavaScript("(function(){var bs=Array.from(document.querySelectorAll('#dsh-shell-bar button'));var b=bs.find(function(x){var l=x.getAttribute('aria-label')||'';return l.indexOf('返回')===0||l==='Back to DeepSeek Harness'});if(!b)return false;b.click();return true})()", true)
      if (clicked) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        backMinimized = win.isMinimized()
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    } catch {}
    const image = await win.capturePage()
    const png = path.join(path.dirname(probeFile), 'shell-probe.png')
 
    fs.writeFileSync(png, image.toPNG())
    fs.writeFileSync(probeFile, JSON.stringify({ ...info, sidebarToggle, backMinimized, icon: lastIconData ? 'applied' : '', screenshot: png }, null, 2))
  } catch (error) {
    try { fs.writeFileSync(probeFile, JSON.stringify({ error: String(error && error.message ? error.message : error) }, null, 2)) } catch {}
  } finally {
    setTimeout(() => { if (window) window.close() }, 120)
  }
}

function windowStateFile () {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState () {
  try {
    const value = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'))
    if (!value || typeof value !== 'object') return null
    const width = Number(value.width)
    const height = Number(value.height)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 900 || height < 600) return null
    const state = { width: Math.round(width), height: Math.round(height) }
    if (Number.isFinite(value.x) && Number.isFinite(value.y)) {
      state.x = Math.round(value.x)
      state.y = Math.round(value.y)
      // Drop off-screen positions (monitor unplugged, resolution changed).
      const visible = screen.getAllDisplays().some((display) => {
        const area = display.workArea
        return state.x < area.x + area.width && state.x + state.width > area.x && state.y < area.y + area.height && state.y + state.height > area.y
      })
      if (!visible) {
        delete state.x
        delete state.y
      }
    }
    if (value.maximized) state.maximized = true
    return state
  } catch {
    return null
  }
}

function saveWindowState (win) {
  if (!win || win.isDestroyed() || probeFile) return
  try {
    const bounds = win.getBounds()
    fs.mkdirSync(path.dirname(windowStateFile()), { recursive: true })
    fs.writeFileSync(windowStateFile(), JSON.stringify({ ...bounds, maximized: win.isMaximized() }))
  } catch {
    /* ignored */
  }
}

async function createWindow () {
  const saved = loadWindowState()
  const options = {
    width: saved ? saved.width : 1280,
    height: saved ? saved.height : 820,
    minWidth: 900,
    minHeight: 600,
    title: initialTitle,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    options.x = saved.x
    options.y = saved.y
  }
  if (appId) app.setAppUserModelId(appId)
  if (iconHint && /\.(png|ico)$/i.test(iconHint)) {
    try {
      const image = nativeImage.createFromPath(iconHint)
      if (!image.isEmpty()) options.icon = image
    } catch {}
  }
  window = new BrowserWindow(options)
  if (saved && saved.maximized) {
    try { window.maximize() } catch {}
  }
  let saveTimer = 0
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveTimer = 0; if (window) saveWindowState(window) }, 500)
  }
  window.on('resize', scheduleSave)
  window.on('move', scheduleSave)
  window.once('ready-to-show', () => { if (window) window.show() })
  // The host keeps this process alive while the window is hidden (the back
  // button); writing "show\n" to our stdin brings the same window back.
  try {
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      if (!window || window.isDestroyed()) return
      if (String(chunk).indexOf('show') === -1) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    })
  } catch {}

  window.on('closed', () => {
    if (saveTimer) clearTimeout(saveTimer)
    if (iconTimer) { clearInterval(iconTimer); iconTimer = null }
    window = null
    signal('shell-closed')
  })
  window.on('maximize', () => { if (window) window.webContents.send('shell:maximized', true) })
  window.on('unmaximize', () => { if (window) window.webContents.send('shell:maximized', false) })
  const allowedOrigin = (() => {
    try { return new URL(targetUrl).origin } catch { return '' }
  })()
  window.webContents.on('will-navigate', (event, url) => {
    try {
      const next = new URL(url)
      if (allowedOrigin && next.origin === allowedOrigin) return
      event.preventDefault()
      if (!allowedOrigin && url.startsWith('data:text/html')) return
      if (next.protocol === 'http:' || next.protocol === 'https:') void shell.openExternal(url)
    } catch {
      event.preventDefault()
    }
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    try { void shell.openExternal(url) } catch {}
    return { action: 'deny' }
  })
  window.webContents.on('dom-ready', () => {
    if (window) installBar(window.webContents)
  })
  window.webContents.on('did-finish-load', () => {
    if (!window) return
    installBar(window.webContents)
    startIconWatch(window)
    if (!ready) { ready = true; signal('shell-ready') }
    if (probeFile) setTimeout(() => { void writeProbe(window) }, 2200)
  })
  window.webContents.on('did-fail-load', (_event, code, description, _validatedURL, isMainFrame) => {
    if (!window || code === -3) return
    // Sub-frames (previews, embedded docs) must not replace the whole shell.
    if (isMainFrame === false) return
    void window.loadURL(errorPage(`${description || '加载失败'}（${code}）`))
  })
  try {
    await window.loadURL(targetUrl || errorPage('缺少分身地址'))
  } catch (error) {
    void window.loadURL(errorPage(error && error.message ? error.message : error))
  }
}
function ownWindow (event) {
  const win = BrowserWindow.fromWebContents(event.sender)
  return win && win === window ? win : null
}
ipcMain.on('shell:window', (event, action) => {
  const win = ownWindow(event)
  if (!win) return
  if (action === 'minimize') win.minimize()
  else if (action === 'toggle-maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize() }
  else if (action === 'close') win.close()
})
ipcMain.on('shell:back', (event) => {
  const win = ownWindow(event)
  if (desktopExe) {
    try {
      spawn(desktopExe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
    } catch {}
  }
  // Minimize instead of hide: the window stays in the taskbar, so the user can
  // still restore it (and the host can write "show" to our stdin).
  if (win) win.minimize()
})
ipcMain.on('shell:window:state', (event) => {
  const win = ownWindow(event)
  event.returnValue = Boolean(win && win.isMaximized())
})

app.on('window-all-closed', () => { app.quit() })

app.whenReady().then(() => {
  try {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
  } catch {}
  return createWindow()
}).catch((error) => {
  signal('shell-error ' + (error && error.message ? error.message : String(error)))
  app.quit()
})
