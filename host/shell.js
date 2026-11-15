/*
 * Desktop shell runtime for instances.
 *
 * The shell is a tiny Electron app (../shell) that loads the instance url in a
 * normal desktop window. Electron itself is not shipped with the plugin: it is
 * downloaded once per machine into <home>/instances/_runtime/electron/<version>
 * and shared by every instance.
 *
 * Tests can point DSH_INSTANCE_SHELL_DIR at an existing unpacked Electron
 * directory (the one that contains electron.exe) to skip the download.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const SHELL_RUNTIME_VERSION = '44.7.0'
const ZIP_NAME = `electron-v${SHELL_RUNTIME_VERSION}-win32-x64.zip`
const DOWNLOAD_URLS = [
  `https://npmmirror.com/mirrors/electron/${SHELL_RUNTIME_VERSION}/${ZIP_NAME}`,
  `https://github.com/electron/electron/releases/download/v${SHELL_RUNTIME_VERSION}/${ZIP_NAME}`,
]
const MIN_ZIP_BYTES = 60 * 1024 * 1024

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shellAppDir = path.join(pluginRoot, 'shell')
const inflight = new Map()
const state = { downloading: false, error: '', progress: 0 }

export function shellRuntimeDir (home) {
  const override = process.env.DSH_INSTANCE_SHELL_DIR
  if (override) return path.resolve(override)
  return path.join(home, 'instances', '_runtime', 'electron', SHELL_RUNTIME_VERSION)
}

export function shellExecutable (home) {
  return path.join(shellRuntimeDir(home), 'electron.exe')
}

export function isShellRuntimeInstalled (home) {
  try {
    return fs.statSync(shellExecutable(home)).isFile()
  } catch {
    return false
  }
}

export function shellRuntimeInfo (home) {
  return {
    version: SHELL_RUNTIME_VERSION,
    dir: shellRuntimeDir(home),
    installed: isShellRuntimeInstalled(home),
    override: Boolean(process.env.DSH_INSTANCE_SHELL_DIR),
    downloading: state.downloading,
    progress: state.progress,
    error: state.error,
  }
}

function downloadTo (url, file, log) {
  return new Promise((resolve, reject) => {
    let parsed
    try { parsed = new URL(url) } catch (error) { reject(error); return }
    const lib = parsed.protocol === 'http:' ? http : https
    log(`[shell] 下载 ${parsed.origin}${parsed.pathname}`)
    const request = lib.get(parsed, {
      headers: { 'user-agent': 'dsh-instance-manager', accept: 'application/octet-stream' },
      timeout: 90 * 1000,
    }, (response) => {
      const status = response.statusCode || 0
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume()
        resolve(downloadTo(new URL(response.headers.location, parsed).toString(), file, log))
        return
      }
      if (status !== 200) {
        response.resume()
        reject(new Error(`HTTP ${status}`))
        return
      }
      const total = Number(response.headers['content-length']) || 0
      const out = fs.createWriteStream(file)
      let received = 0
      let reported = 0
      response.on('data', (chunk) => {
        received += chunk.length
        if (total > 0) state.progress = Math.min(1, received / total)
        if (received - reported >= 10 * 1024 * 1024) {
          reported = received
          log(`[shell] 已下载 ${(received / 1024 / 1024).toFixed(1)} MB`)
        }
      })
      response.on('error', reject)
      out.on('error', reject)
      out.on('finish', () => out.close(() => resolve(received)))
      response.pipe(out)
    })
    request.on('timeout', () => request.destroy(new Error('下载超时')))
    request.on('error', reject)
  })
}

function extractZip (zipFile, destination) {
  fs.mkdirSync(destination, { recursive: true })
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const candidates = ['tar', path.join(systemRoot, 'System32', 'tar.exe')]
  for (const command of candidates) {
    try {
      const result = spawnSync(command, ['-xf', zipFile, '-C', destination], { windowsHide: true, stdio: 'ignore' })
      if (result.status === 0) return true
    } catch {}
  }
  try {
    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`
    const script = `Expand-Archive -LiteralPath ${quote(zipFile)} -DestinationPath ${quote(destination)} -Force`
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' })
    if (result.status === 0) return true
  } catch {}
  return false
}

export function ensureShellRuntime (home, log = () => {}) {
  if (isShellRuntimeInstalled(home)) return Promise.resolve(shellRuntimeInfo(home))
  const key = shellRuntimeDir(home)
  if (process.env.DSH_INSTANCE_SHELL_DIR) {
    return Promise.reject(new Error(`桌面运行库不存在：${key}`))
  }
  const running = inflight.get(key)
  if (running) return running
  state.downloading = true
  state.error = ''
  state.progress = 0
  const task = (async () => {
    const parent = path.dirname(key)
    const zipFile = path.join(parent, ZIP_NAME)
    const partial = `${key}.partial`
    try {
      fs.mkdirSync(parent, { recursive: true })
      fs.rmSync(partial, { recursive: true, force: true })
      log('[shell] 准备下载桌面运行库 Electron ' + SHELL_RUNTIME_VERSION)
      let lastError = null
      let downloaded = 0
      for (const url of DOWNLOAD_URLS) {
        try {
          fs.rmSync(zipFile, { force: true })
          downloaded = await downloadTo(url, zipFile, log)
          if (downloaded >= MIN_ZIP_BYTES) { lastError = null; break }
          lastError = new Error(`下载不完整（${downloaded} 字节）`)
        } catch (error) {
          lastError = error
          log(`[shell] 下载源失败：${error && error.message ? error.message : error}`)
        }
      }
      if (lastError) throw lastError
      log('[shell] 解压桌面运行库…')
      if (!extractZip(zipFile, partial)) throw new Error('解压失败（tar 与 PowerShell 均不可用）')
      if (!fs.existsSync(path.join(partial, 'electron.exe'))) throw new Error('运行库缺少 electron.exe')
      fs.rmSync(key, { recursive: true, force: true })
      fs.renameSync(partial, key)
      fs.writeFileSync(path.join(key, '.ready.json'), JSON.stringify({
        version: SHELL_RUNTIME_VERSION,
        installedAt: new Date().toISOString(),
        size: downloaded,
      }, null, 2))
      log('[shell] 桌面运行库已就绪：' + key)
      state.error = ''
      state.progress = 1
      return shellRuntimeInfo(home)
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      state.error = message
      try { fs.rmSync(partial, { recursive: true, force: true }) } catch {}
      try { fs.rmSync(zipFile, { force: true }) } catch {}
      throw new Error('桌面运行库准备失败：' + message)
    } finally {
      try { fs.rmSync(zipFile, { force: true }) } catch {}
      state.downloading = false
    }
  })()
  inflight.set(key, task)
  void task.finally(() => { inflight.delete(key) }).catch(() => {})
  return task
}

export function killShellProcess (pid) {
  if (!pid) return
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    return
  } catch {}
  try { process.kill(pid) } catch {}
}

export function spawnInstanceShell (home, record) {
  if (!isShellRuntimeInstalled(home)) throw new Error('桌面运行库尚未安装')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  const iconPath = typeof record.iconPath === 'string' && /\.(png|ico)$/i.test(record.iconPath) ? record.iconPath : ''
  Object.assign(env, {
    SHELL_URL: record.url || '',
    SHELL_TITLE: record.name || 'DSH',
    SHELL_ICON: iconPath,
    SHELL_APP_ID: 'dsh.instance.' + record.id,
    SHELL_DESKTOP_EXE: process.versions.electron ? process.execPath : '',
  })
  const child = spawn(shellExecutable(home), [shellAppDir], {
    cwd: pluginRoot,
    env,
    windowsHide: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return child
}
