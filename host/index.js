/**
 * Instance Manager — host half.
 *
 * Desktop mode (Electron desktop host): owns the instance registry, kernel copies,
 * per-instance profiles, process lifecycle, ports, logs and attribution.
 * Instance mode (child process spawned by the desktop half): records workspace
 * attribution and serves the plugin-library endpoints for its own profile.
 *
 * The plugin never modifies DSH source. It is a normal Cordis bundle.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { installWorkspaceSync } from './workspace-sync.js'
import { ensureShellRuntime, shellRuntimeInfo, spawnInstanceShell, killShellProcess } from './shell.js'

export const name = 'dsh-instance-manager'
export const inject = ['webServer', 'workspaceRegistry', 'sessionPersistence', 'connection']

const PLUGIN_PACKAGE = '@local/dsh-instance-manager'
const ROUTE = '/plugins/instance-manager'
const PORT_MIN = 52000
const PORT_MAX = 52999
const KERNEL_COPY_SCRIPT = 'instance-manager-copy-kernel.cjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')

// ---------------------------------------------------------------------------
// environment / mode
// ---------------------------------------------------------------------------

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim() ? path.resolve(fromEnv) : path.join(os.homedir(), '.dsh')
}

const HOME = dshHome()
const INSTANCES_ROOT = path.join(HOME, 'instances')
const PROFILES_ROOT = path.join(HOME, 'profiles')
const REGISTRY_PATH = path.join(INSTANCES_ROOT, 'registry.json')
const ATTRIBUTION_PATH = path.join(INSTANCES_ROOT, 'attribution.json')
const ATTRIBUTION_DIR = path.join(INSTANCES_ROOT, 'attribution')
const ATTRIBUTION_SCHEMA = 4
const ATTRIBUTION_SESSION_LIMIT = 400
// Sessions older than this many milliseconds before the instance process boot
// cannot have been created by it: `session/created` also fires when an existing
// session is attached (opened, resumed or listed), and those must never be
// recorded as instance-created.
const ATTRIBUTION_BOOT_SLACK_MS = 5000

// Bundles that every profile silently carries; they are never offered as
// removable plugins because the desktop plugin page shows them in its built-in
// sections rather than the installed list.
const BUILTIN_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-sdk-minimal',
  PLUGIN_PACKAGE,
])

// The optional official bundles the desktop plugin page exposes in its
// "experimental" section. They ship inside the kernel, so an instance enables
// one by listing its name in dsh.profile.bundles; nothing is copied.
const EXPERIMENTAL_BUNDLES = [
  {
    name: '@deepseek-ai/dsh-agent-team',
    zh: '智能体团队',
    en: 'Agent Team',
    zhDescription: '启用团队协作、团队工具、成员列表和共享任务看板。',
    enDescription: 'Enable multi-agent team collaboration, team tools, member lists and a shared task board.',
  },
  {
    name: '@deepseek-ai/dsh-voice-input',
    zh: '语音输入',
    en: 'Voice Input',
    zhDescription: '在本机使用 SenseVoice 转写录音，首次使用需安装依赖。',
    enDescription: 'Transcribe recordings locally with SenseVoice; dependencies are installed on first use.',
  },
  {
    name: '@deepseek-ai/dsh-auto-review',
    zh: '自动授权审查',
    en: 'Auto Review',
    zhDescription: '提供自动审查权限模式，由模型在每次工具调用前判断是否授权。',
    enDescription: 'Adds an auto-review permission mode judged by the model before each tool call.',
  },
  {
    name: '@deepseek-ai/dsh-inspector',
    zh: '开发者工具',
    en: 'Developer Tools',
    zhDescription: '查看调试会话原始数据、聊天消息分组数据，以及调试 NodeJS 后端。',
    enDescription: 'Inspect raw session data, grouped chat messages and debug the Node backend.',
  },
  {
    name: '@deepseek-ai/dsh-cot-translation',
    zh: '思考过程机器翻译',
    en: 'Reasoning Translation',
    zhDescription: '机器翻译展开的思考内容，原文不会发送给所选服务。',
    enDescription: 'Translate expanded reasoning text; the original text never leaves the local host.',
  },
  {
    name: '@deepseek-ai/dsh-session-titles',
    zh: '会话标题',
    en: 'Session Titles',
    zhDescription: '用模型为会话自动生成简短标题。',
    enDescription: 'Generate short session titles with a model.',
  },
  {
    name: '@deepseek-ai/dsh-terminal',
    zh: '终端',
    en: 'Terminal',
    zhDescription: '限制每条命令最多能跑多久、最多输出多少内容。',
    enDescription: 'Bound how long each command runs and how much output it may produce.',
  },
  {
    name: '@deepseek-ai/dsh-session-search',
    zh: '会话搜索',
    en: 'Session Search',
    zhDescription: '在所有历史会话中搜索消息内容。',
    enDescription: 'Search message content across every stored session.',
  },
  {
    name: '@deepseek-ai/dsh-badge-skill',
    zh: '技能徽标',
    en: 'Skill Badges',
    zhDescription: '在对话中显示技能调用徽标。',
    enDescription: 'Show skill invocation badges inside conversations.',
  },
  {
    name: '@deepseek-ai/dsh-ralph',
    zh: 'Ralph 循环',
    en: 'Ralph Loop',
    zhDescription: '按固定节奏重复执行任务的自循环模式。',
    enDescription: 'A self-loop mode that repeats a task on a fixed cadence.',
  },
  {
    name: '@deepseek-ai/dsh-plugin-market',
    zh: '插件市场',
    en: 'Plugin Market',
    zhDescription: '在客户端浏览并安装社区插件。',
    enDescription: 'Browse and install community plugins from the client.',
  },
  {
    name: '@deepseek-ai/dsh-tool-worktree',
    zh: '工作树工具',
    en: 'Worktree Tools',
    zhDescription: '为 Git 工作树提供工具支持。',
    enDescription: 'Provide Git worktree tooling.',
  },
]

const ICON_PROMPT_FILE = path.join(PACKAGE_ROOT, 'icon-prompt.md')
const ICON_SYSTEM_PROMPT = [
  '你是应用图标设计师。你的回答必须是一段可直接保存为 .svg 文件的源码：',
  '第一个字符必须是 "<"，最后一个字符必须是 ">"，整段内容从 <svg 开始、到 </svg> 结束。',
  '禁止使用 Markdown 代码块（不要写 ```）、禁止任何解释、标题、前言或后记，禁止附加其它 XML 声明。',
  '根元素必须同时包含 xmlns="http://www.w3.org/2000/svg"、viewBox="0 0 256 256"、width="256"、height="256"。',
  '图形要求：正方形构图，简洁、边缘清晰，适合作为 1:1 应用图标；使用纯色或渐变填充；',
  '不要包含文字（<text>）、外链、脚本、foreignObject 或位图。',
].join('\n')

// Only the labels are shown in the UI; ids stay stable so the prompt builder can
// accept a list of selected keyword ids from the client.
const ICON_KEYWORD_GROUPS = [
  { id: 'style', label: '风格', keywords: ['极简', '几何', '扁平', '线性', '面性', '双色', '单色', '渐变', '玻璃拟态', '新拟态', '拟物', '像素', '手绘', '涂鸦', '复古', '未来感', '科技', '有机流体', '负空间', '字母组合', '具象', '卡通', '暗黑', '商务', '游戏', '圆角', '锐角', '对称', '动态', '赛博朋克', '国潮', '版画'] },
  { id: 'shape', label: '构图与形状', keywords: ['居中对称', '满幅底板', '圆形母题', '方形母题', '三角形', '六边形', '环形', '层叠', '对角线', '网格', '节点路径', '箭头', '容器', '折角', '波纹', '星形', '盾形', '叶片', '水滴', '钥匙孔'] },
  { id: 'palette', label: '色彩', keywords: ['蓝色系', '青色系', '蓝绿色系', '绿色系', '墨绿色系', '紫色系', '品红系', '红色系', '橙色系', '琥珀色系', '黄色系', '粉色系', '棕色系', '灰色系', '黑白', '双色配色', '三色配色', '冷色', '暖色', '高饱和', '低饱和', '莫兰迪', '霓虹', '金属色', '深色底板', '浅色底板', '天蓝', '靛蓝', '薄荷', '珊瑚', '酒红', '奶油', '雾霾蓝'] },
  { id: 'texture', label: '质感与光影', keywords: ['无阴影', '柔和阴影', '内阴影', '高光', '磨砂', '玻璃', '金属', '哑光', '发光', '描边', '粗描边', '无描边', '轻微渐变', '纯平色', '浮雕', '镂空', '半透明', '颗粒'] },
  { id: 'semantic', label: '语义与用途', keywords: ['开发', '终端', '代码', '数据', '图表', '人工智能', '聊天', '文档', '文件夹', '搜索', '安全', '网络', '云', '容器', '齿轮', '火箭', '实验室', '音乐', '视频', '财务', '医疗', '教育', '写作', '翻译', '机器人', '芯片', '地球', '信封', '日历'] },
  { id: 'app', label: '应用类型', keywords: ['开发工具', '效率工具', '设计工具', '媒体应用', '社交应用', '办公应用', '学习应用', '娱乐应用', '系统工具', '智能助手', '安全工具', '网络工具', '多媒体'] },
]

function detectEnvironment() {
  const instanceId = (process.env.DSH_INSTANCE_ID || '').trim()
  const argv = process.argv
  const looksDesktop = Boolean(process.versions.electron) && argv.some((arg) => typeof arg === 'string' && arg.includes('dsh-desktop-host'))
  if (instanceId) {
    return {
      kind: 'instance',
      instanceId,
      instanceName: (process.env.DSH_INSTANCE_NAME || '').trim(),
      profileName: argv.includes('--profile') ? argv[argv.indexOf('--profile') + 1] : '',
    }
  }
  if (looksDesktop) {
    return {
      kind: 'desktop',
      kernelSource: argv[2] || '',
      profileDir: argv[3] || path.join(HOME, 'profiles', 'desktop'),
      runtimeDir: argv[4] || '',
      pnpmScript: argv[5] || '',
      runtimeBin: argv[6] || '',
    }
  }
  return { kind: 'standalone' }
}

const ENV = detectEnvironment()

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function readJson(file, fallback = undefined) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function folderSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name))
      else if (entry.isFile()) {
        try {
          total += fs.statSync(path.join(current, entry.name)).size
        } catch {
          /* ignored */
        }
      }
    }
  }
  return total
}

function copyTreeDeref(source, target, options = {}) {
  const skipNestedNodeModules = options.skipNestedNodeModules === true
  let copied = 0
  let bytes = 0
  const walk = (src, dest) => {
    const stat = fs.statSync(src)
    if (stat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true })
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (skipNestedNodeModules && entry.name === 'node_modules') continue
        if (entry.name === '.git') continue
        walk(path.join(src, entry.name), path.join(dest, entry.name))
      }
      return
    }
    if (!stat.isFile()) return
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    copied += 1
    bytes += stat.size
  }
  walk(source, target)
  return { copied, bytes }
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

function backupBrokenFile(file) {
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bad-' + String(Date.now()))
  } catch {
    /* ignored */
  }
}

function readRegistry() {
  const value = readJson(REGISTRY_PATH, null)
  const valid =
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.instances &&
    typeof value.instances === 'object' &&
    !Array.isArray(value.instances)
  if (!valid) {
    backupBrokenFile(REGISTRY_PATH)
    return { schemaVersion: 1, instances: {} }
  }
  return value
}

function saveRegistry(registry) {
  writeJson(REGISTRY_PATH, registry)
  try {
    signalChanged('registry.changed')
  } catch {
    /* ignored */
  }
}

function updateInstance(id, patch) {
  const registry = readRegistry()
  const current = registry.instances[id]
  if (!current) return null
  const next = { ...current, ...patch }
  registry.instances[id] = next
  saveRegistry(registry)
  return next
}

const RUNNING = new Map() // id -> { child, stopping, startingAt, logStream, poll, url }
const SHELLS = new Map() // id -> { child, phase, error, openedAt }
const SHELL_ERRORS = new Map() // id -> last shell error (kept until next open/close)
const PROVISION = new Map() // id -> { phase, percent, message, done, error, cancelled, cancel }
// Set while the plugin is applied so the HTTP layer can trigger an on-demand
// workspace mirror pass (no polling: focus / visibility / manual refresh only).
let workspaceSyncHandle = null

// Other plugins can listen to this event to mirror instance and plugin state
// without polling our HTTP routes. The actual emitter is installed in apply().
let signalChanged = () => {}

function storageRoot(record) {
  const base = record && record.storageDir ? path.resolve(record.storageDir) : INSTANCES_ROOT
  return path.join(base, record ? record.id : '')
}

function instanceDir(idOrRecord) {
  if (idOrRecord && typeof idOrRecord === 'object') return storageRoot(idOrRecord)
  return storageRoot(readRegistry().instances[idOrRecord] || { id: idOrRecord })
}

function profileEntryDir(record) {
  return path.join(PROFILES_ROOT, record.profileName || record.id)
}

// The profile is addressed by name by the dsh CLI; in the default layout it is
// a real directory, in the custom-storage layout it is a junction pointing into
// the instance storage root so that "everything lives in the chosen folder".
function profileDir(record) {
  return profileEntryDir(record)
}

function profilePhysicalDir(record) {
  return record && record.storageDir ? path.join(storageRoot(record), 'profile') : profileEntryDir(record)
}

function logFile(id) {
  return path.join(instanceDir(id), 'logs', 'instance.log')
}

const LOG_BUFFERS = new Map()

function redactSecrets(text) {
  return String(text || '')
    .replace(/([?&]token=)[^&\s]*/gi, '$1***')
    .replace(/([?&]access_token=)[^&\s]*/gi, '$1***')
}

function writeLogText(id, text) {
  try {
    const file = logFile(id)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, redactSecrets(text))
  } catch {
    /* ignored */
  }
}

// stdout arrives in arbitrary chunks. Buffer until a newline so a token that
// straddles two chunks is still redacted as one string.
function appendLog(id, text) {
  const pending = String(LOG_BUFFERS.get(id) || '') + String(text || '')
  const cut = pending.lastIndexOf('\n')
  if (cut === -1) {
    LOG_BUFFERS.set(id, pending)
    return
  }
  LOG_BUFFERS.set(id, pending.slice(cut + 1))
  writeLogText(id, pending.slice(0, cut + 1))
}

function flushLog(id) {
  const pending = LOG_BUFFERS.get(id)
  if (!pending) return
  LOG_BUFFERS.delete(id)
  writeLogText(id, pending + '\n')
}

function scrubLogFile(id) {
  try {
    const file = logFile(id)
    if (!fs.existsSync(file)) return
    const text = fs.readFileSync(file, 'utf8')
    const redacted = redactSecrets(text)
    if (redacted !== text) fs.writeFileSync(file, redacted)
  } catch {
    /* ignored */
  }
}

// ---------------------------------------------------------------------------
// kernel copy (Electron-as-node helper reads the asar and writes real files)
// ---------------------------------------------------------------------------

const COPY_SCRIPT_SOURCE = String.raw`'use strict'
const fs = require('fs')
const path = require('path')
const src = process.argv[2]
const dst = process.argv[3]
if (!src || !dst) { console.log(JSON.stringify({ type: 'error', message: 'missing src/dst' })); process.exit(2) }
const started = Date.now()
let files = 0, dirs = 0, bytes = 0, last = 0
function emit (payload) { process.stdout.write(JSON.stringify(payload) + '\n') }
function walk (source, target) {
  const stat = fs.lstatSync(source) // asar-aware: never throws on packed entries
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true })
    dirs += 1
    for (const entry of fs.readdirSync(source)) walk(path.join(source, entry), path.join(target, entry))
    return
  }
  if (!stat.isFile()) return
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
  files += 1
  bytes += stat.size
  const now = Date.now()
  if (now - last > 1500) { last = now; emit({ type: 'progress', files, dirs, bytes, ms: now - started }) }
}
try {
  fs.mkdirSync(dst, { recursive: true })
  walk(src, dst)
  let version = ''
  try { version = JSON.parse(fs.readFileSync(path.join(dst, 'desktop-runtime.json'), 'utf8')).release?.version || '' } catch {}
  emit({ type: 'done', files, dirs, bytes, ms: Date.now() - started, version })
} catch (error) {
  emit({ type: 'error', message: error && error.message ? error.message : String(error) })
  process.exit(1)
}
`

function ensureCopyScript() {
  fs.mkdirSync(INSTANCES_ROOT, { recursive: true })
  const file = path.join(INSTANCES_ROOT, KERNEL_COPY_SCRIPT)
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== COPY_SCRIPT_SOURCE) {
    fs.writeFileSync(file, COPY_SCRIPT_SOURCE, 'utf8')
  }
  return file
}

function copyKernel(source, dest, provision, onMeta, job) {
  return new Promise((resolve, reject) => {
    if (!source || !fs.existsSync(source)) {
      reject(Error(`桌面内核目录不可用：${source || '(未知)'}`))
      return
    }
    const script = ensureCopyScript()
    // `process.execPath` inside the desktop host is the Electron binary; with
    // ELECTRON_RUN_AS_NODE it runs plain Node with asar support.
    const electronSpawning = process.versions.electron ? process.execPath : null
    const command = electronSpawning || process.execPath
    const child = spawn(command, [script, source, dest], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (job) {
      job.child = child
      job.kill = () => {
        if (child.pid) killTree(child.pid)
      }
    }
    let stdout = ''
    let stderr = ''
    const totalBytes = 430 * 1024 * 1024
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      for (const line of chunk.split('\n')) {
        const text = line.trim()
        if (!text.startsWith('{')) continue
        try {
          const payload = JSON.parse(text)
          if (payload.type === 'progress') {
            const percent = Math.min(78, Math.round((payload.bytes / totalBytes) * 78))
            provision({ phase: 'copy-kernel', percent, message: `正在复制内核（${Math.round(payload.bytes / 1048576)} MB）` })
          } else if (payload.type === 'done') {
            if (typeof onMeta === 'function') onMeta(payload)
          } else if (payload.type === 'error') {
            stderr += `\n${payload.message}`
          }
        } catch {
          /* partial line */
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => reject(error))
    child.on('exit', (code) => {
      if (job) job.child = null
      if (code === 0) resolve(stdout)
      else reject(Error(`内核复制失败（退出码 ${code}）${stderr ? `：${stderr.trim().slice(-500)}` : ''}`))
    })
  })
}

// ---------------------------------------------------------------------------
// profile creation / plugin copies / library
// ---------------------------------------------------------------------------

function desktopProfileDir() {
  return ENV.kind === 'desktop' ? ENV.profileDir : readJson(path.join(INSTANCES_ROOT, 'desktop.json'), {})?.profileDir
}

const PATCH_EMPTY = '[]\n'
const WORKSPACE_YAML = 'nodeLinker: hoisted\nautoInstallPeers: false\n'
const MANAGED_PATCH_BEGIN = '# >>> instance-manager: native directory picker (managed, do not edit)'
const MANAGED_PATCH_END = '# <<< instance-manager: native directory picker'

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function managedPatchBlock() {
  return [
    MANAGED_PATCH_BEGIN,
    '- id: directory-picker',
    '  disabled: true',
    '- insert:',
    '    - id: instance-manager-directory-picker-host',
    "      name: '@deepseek-ai/dsh-host-directory-picker-native'",
    '    - id: instance-manager-directory-picker-surface',
    "      name: '@deepseek-ai/dsh-client-ui-directory-picker-native'",
    MANAGED_PATCH_END,
    '',
  ].join('\n')
}

// Instances bind a (possibly non-loopback) address, and DSH then resolves the
// "auto" directory-picker backend to the in-app browser, not the OS dialog.
// Force the native backend so instances behave exactly like the desktop app.
function ensureManagedPatch(profile) {
  const file = path.join(profile, 'cordis.patch.yml')
  let text = PATCH_EMPTY
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    text = PATCH_EMPTY
  }
  const managed = managedPatchBlock()
  const blockPattern = new RegExp(`${escapeRegExp(MANAGED_PATCH_BEGIN)}[\\s\\S]*?${escapeRegExp(MANAGED_PATCH_END)}\\n?`)
  if (blockPattern.test(text)) {
    text = text.replace(blockPattern, managed)
  } else if (text.trim() === '' || text.trim() === '[]') {
    text = managed
  } else {
    text = `${text.replace(/\s*$/, '')}\n${managed}`
  }
  fs.writeFileSync(file, text, 'utf8')
}

function isDirectoryLink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

function ensureProfileJunction(record) {
  if (!record || !record.storageDir) return
  const physical = profilePhysicalDir(record)
  const entry = profileEntryDir(record)
  fs.mkdirSync(physical, { recursive: true })
  try {
    if (fs.existsSync(entry) || isDirectoryLink(entry)) {
      if (isDirectoryLink(entry)) {
        let current = ''
        try {
          current = fs.readlinkSync(entry)
        } catch {
          current = ''
        }
        if (current && path.resolve(current) === path.resolve(physical)) return
        fs.rmSync(entry, { recursive: true, force: true })
      } else {
        // A real directory in the way (legacy layout): leave it untouched.
        return
      }
    }
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.symlinkSync(physical, entry, 'junction')
  } catch (error) {
    console.warn('[instance-manager] 无法创建配置目录链接：', error && error.message ? error.message : error)
  }
}

function removeProfileJunction(record) {
  const entry = profileEntryDir(record)
  if (!isDirectoryLink(entry)) return
  try {
    fs.rmSync(entry, { recursive: true, force: true })
  } catch {
    /* ignored */
  }
}

function readDependencies(profile) {
  const pkg = readJson(path.join(profile, 'package.json'), {})
  return pkg && pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
}

// Native DSH plugin pages call a bundle "installed" when it is a dependency of
// the profile (not when it is merely in dsh.profile.bundles). Keep both in sync
// so plugins installed through the instance library show up in 已安装.
function writeDependency(profile, name, spec) {
  const file = path.join(profile, 'package.json')
  const pkg = readJson(file, {})
  pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  if (spec === null) delete pkg.dependencies[name]
  else pkg.dependencies[name] = spec
  writeJson(file, pkg)
}

function readBundles(profile) {
  const pkg = readJson(path.join(profile, 'package.json'), {})
  const bundles = pkg?.dsh?.profile?.bundles
  return Array.isArray(bundles) ? bundles.filter((item) => typeof item === 'string') : []
}

function writeBundles(profile, bundles) {
  const file = path.join(profile, 'package.json')
  const pkg = readJson(file, {})
  pkg.name = pkg.name || `dsh-profile-${path.basename(profile)}`
  pkg.private = true
  pkg.type = pkg.type || 'module'
  pkg.dependencies = pkg.dependencies || {}
  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  pkg.dsh.profile.bundles = [...new Set(bundles)]
  writeJson(file, pkg)
}

function ensureProfile(record) {
  const physical = profilePhysicalDir(record)
  fs.mkdirSync(physical, { recursive: true })
  ensureProfileJunction(record)
  const pkgFile = path.join(physical, 'package.json')
  if (!fs.existsSync(pkgFile)) {
    const desktop = desktopProfileDir()
    const inheritedPatch = desktop ? path.join(desktop, 'cordis.patch.yml') : ''
    const patchText = inheritedPatch && fs.existsSync(inheritedPatch) ? fs.readFileSync(inheritedPatch, 'utf8') : PATCH_EMPTY
    writeJson(pkgFile, {
      name: `dsh-profile-${record.id}`,
      private: true,
      type: 'module',
      dependencies: {},
      dsh: { profile: { bundles: [`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, PLUGIN_PACKAGE] } },
    })
    fs.writeFileSync(path.join(physical, 'cordis.patch.yml'), patchText, 'utf8')
    fs.writeFileSync(path.join(physical, 'pnpm-workspace.yaml'), WORKSPACE_YAML, 'utf8')
    fs.writeFileSync(path.join(physical, 'cordis.yml'), '[]\n', 'utf8')
  }
  ensureManagedPatch(physical)
  return physical
}

function syncSelfIntoProfile(profile) {
  const target = path.join(profile, 'node_modules', PLUGIN_PACKAGE)
  const wanted = selfPluginVersion()
  let current = ''
  try {
    current = String(readJson(path.join(target, 'package.json'), {})?.version || '')
  } catch {
    current = ''
  }
  if (current === wanted) return target
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch {
    /* ignored */
  }
  copyTreeDeref(PACKAGE_ROOT, target, { skipNestedNodeModules: true })
  try {
    writeDependency(profile, PLUGIN_PACKAGE, wanted)
  } catch {
    /* ignored */
  }
  return target
}

function selfPluginVersion() {
  try {
    return String(readJson(path.join(PACKAGE_ROOT, 'package.json'), {})?.version || '0.1.0')
  } catch {
    return '0.1.0'
  }
}

const PLUGIN_ICON_MIME = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
])

const PLUGIN_ICON_TTL_MS = 60 * 1000
const PLUGIN_ICON_CACHE = new Map()

// Plugins may ship their own artwork at `icon` (relative path), the same field
// the native plugin page reads. Keep it as a data URL so the desktop client can
// render it without another round trip.
function iconDataUrlFromPackage(packageDir) {
  try {
    const manifest = readJson(path.join(packageDir, 'package.json'), null)
    const iconRel = manifest && typeof manifest.icon === 'string' ? manifest.icon.trim() : ''
    if (!iconRel) return null
    const base = path.resolve(packageDir)
    const file = path.resolve(base, iconRel)
    if (file !== base && !file.startsWith(base + path.sep)) return null
    const mime = PLUGIN_ICON_MIME.get(path.extname(file).toLowerCase())
    if (!mime) return null
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size <= 0 || stat.size > 256 * 1024) return null
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
  } catch {
    return null
  }
}

function pluginIcon(packageDir) {
  if (!packageDir) return null
  const now = Date.now()
  const hit = PLUGIN_ICON_CACHE.get(packageDir)
  if (hit && now - hit.at < PLUGIN_ICON_TTL_MS) return hit.value
  const value = iconDataUrlFromPackage(packageDir)
  PLUGIN_ICON_CACHE.set(packageDir, { at: now, value })
  return value
}

function scanDesktopLibrary() {
  const desktop = desktopProfileDir()
  if (!desktop) return []
  // The native plugin page counts every installed dependency, even when the
  // bundle is currently disabled. Instances must offer the same set, otherwise
  // plugins installed-on-desktop-but-disabled can never be added to an instance.
  const bundles = readBundles(desktop)
  const names = [...new Set([...Object.keys(readDependencies(desktop)), ...bundles])]
  const entries = []
  for (const bundleName of names) {
    if (bundleName.startsWith('@deepseek-ai/')) continue
    if (bundleName === PLUGIN_PACKAGE) continue
    const sourceDir = path.join(desktop, 'node_modules', bundleName)
    const manifest = readJson(path.join(sourceDir, 'package.json'), null)
    if (!manifest) continue
    if (!manifest.dsh && !bundles.includes(bundleName)) continue
    entries.push({
      name: bundleName,
      version: String(manifest.version || '0.0.0'),
      title: manifest?.dsh?.title || manifest?.displayName || bundleName,
      description: manifest?.dsh?.description || manifest?.description || '',
      icon: pluginIcon(sourceDir),
      sourceDir,
      kind: manifest?.dsh?.bundle ? 'bundle' : 'plugin',
      enabled: bundles.includes(bundleName),
    })
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

function instanceBundles(record) {
  return readBundles(profileDir(record))
}

function copyPluginClosure(sourceDir, profile, desktop) {
  const targetRoot = path.join(profile, 'node_modules')
  fs.mkdirSync(targetRoot, { recursive: true })
  const seen = new Set()
  const queue = [sourceDir]
  let copied = 0
  while (queue.length) {
    const dir = queue.shift()
    const manifest = readJson(path.join(dir, 'package.json'), null)
    if (!manifest || !manifest.name) continue
    if (seen.has(manifest.name)) continue
    seen.add(manifest.name)
    const target = path.join(targetRoot, manifest.name)
    if (!fs.existsSync(target)) {
      const result = copyTreeDeref(dir, target, { skipNestedNodeModules: true })
      copied += result.copied
    }
    for (const depName of Object.keys(manifest.dependencies || {})) {
      if (depName.startsWith('@deepseek-ai/')) continue
      const resolved = resolveDependency(depName, dir, desktop)
      if (!resolved) throw Error(`依赖 ${depName} 未找到，无法复制插件 ${manifest.name}`)
      queue.push(resolved)
    }
    // 可选依赖（如 sharp 的 @img/sharp-<platform>-<arch> 原生包）在当前平台上
    // 只有实际安装成功的那一个才需要复制；解析不到的跳过，不能因此失败。
    for (const depName of Object.keys(manifest.optionalDependencies || {})) {
      if (depName.startsWith('@deepseek-ai/')) continue
      const resolved = resolveDependency(depName, dir, desktop)
      if (resolved) queue.push(resolved)
    }
  }
  return { packages: seen.size, copied }
}

function resolveDependency(depName, fromDir, desktop) {
  // 按 Node 的查找规则从 fromDir 逐级向上找 node_modules，兼容 npm/pnpm 把
  // 传递依赖提升（hoist）到包根或上层目录的布局——否则像 sharp 这种依赖被
  // 提升到插件根目录的包，会在「依赖 @img/colour 未找到」处误报失败。
  let dir = path.resolve(fromDir)
  for (let depth = 0; depth < 16; depth += 1) {
    const candidate = path.join(dir, 'node_modules', depName)
    try {
      if (fs.existsSync(candidate)) return fs.realpathSync(candidate)
    } catch {
      /* ignored */
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (desktop) {
    try {
      const candidate = path.join(desktop, 'node_modules', depName)
      if (fs.existsSync(candidate)) return fs.realpathSync(candidate)
    } catch {
      /* ignored */
    }
  }
  return null
}

function isSystemBundle(name) {
  return BUILTIN_BUNDLES.has(name) || name === PLUGIN_PACKAGE
}

function experimentalEntry(name) {
  return EXPERIMENTAL_BUNDLES.find((item) => item.name === name) || null
}

function kernelRoot(record) {
  // <instance>/kernel/<version>/node_modules/@deepseek-ai/dsh/lib/bin.js
  let dir = kernelBin(record)
  for (let index = 0; index < 5; index += 1) dir = path.dirname(dir)
  return dir
}

function pluginManifest(record, name) {
  const dir = pluginPackageDir(record, name)
  return dir ? readJson(path.join(dir, 'package.json'), null) : null
}

function pluginPackageDir(record, name) {
  const profile = profileDir(record)
  const candidates = [
    path.join(profile, 'node_modules', name),
    path.join(kernelRoot(record), 'node_modules', name),
  ]
  const desktop = desktopProfileDir()
  if (desktop) candidates.push(path.join(desktop, 'node_modules', name))
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    } catch {
      /* ignored */
    }
  }
  return null
}

// Optional official bundles the instance can turn on: they ship in its kernel,
// so enabling only edits dsh.profile.bundles.
function experimentalLibrary(record) {
  const bundles = readBundles(profileDir(record))
  return EXPERIMENTAL_BUNDLES.filter((item) => !bundles.includes(item.name) && pluginManifest(record, item.name))
    .map((item) => {
      const manifest = pluginManifest(record, item.name)
      const packDir = pluginPackageDir(record, item.name)
      return {
        name: item.name,
        title: String(manifest?.dsh?.title || item.zh),
        titleEn: item.en,
        description: String(manifest?.dsh?.description || item.zhDescription),
        descriptionEn: item.enDescription,
        version: String(manifest?.version || ''),
        icon: pluginIcon(packDir),
      }
    })
}

// Plugin management is a desktop-side task: the instance only loads whatever
// its profile lists. A bundle is enabled when it is in dsh.profile.bundles and
// "installed" for the native page when it is also a profile dependency.
function instancePluginEntries(record) {
  const profile = profileDir(record)
  const bundles = readBundles(profile)
  const deps = readDependencies(profile)
  const names = [...new Set([...bundles, ...Object.keys(deps)])]
    .filter((name) => !isSystemBundle(name))
    .sort((a, b) => a.localeCompare(b))
  return names.map((name) => {
    const manifest = pluginManifest(record, name)
    const experimental = experimentalEntry(name)
    const official = Boolean(experimental)
    return {
      name,
      title: String(manifest?.dsh?.title || (experimental ? experimental.zh : '') || manifest?.displayName || name),
      description: String(manifest?.dsh?.description || (experimental ? experimental.zhDescription : '') || manifest?.description || ''),
      version: String(manifest?.version || deps[name] || ''),
      icon: pluginIcon(pluginPackageDir(record, name)),
      enabled: bundles.includes(name),
      official,
      experimental: official,
    }
  })
}

function requireStoppedInstance(record) {
  if (RUNNING.has(record.id) || record.status === 'running' || record.status === 'starting') {
    throw Error('请先停止分身再管理插件')
  }
}

function addPluginToInstance(record, name) {
  requireStoppedInstance(record)
  if (!name || isSystemBundle(name)) throw Error('该系统插件不可通过此入口管理')
  const profile = profileDir(record)
  const bundles = readBundles(profile)
  // Official experimental bundles live in the copied kernel; enabling one only
  // needs the profile bundle list and a dependency entry.
  const experimental = experimentalEntry(name)
  if (experimental) {
    const manifest = pluginManifest(record, name)
    if (!manifest) throw Error('该实验性插件不在当前分身内核中，请先重建内核')
    if (!bundles.includes(name)) bundles.push(name)
    writeBundles(profile, bundles)
    writeDependency(profile, name, String(manifest.version || '*'))
    try {
      signalChanged('plugins.changed', record.id)
    } catch {
      /* ignored */
    }
    return { name, experimental: true, restartRequired: true }
  }
  const entry = scanDesktopLibrary().find((item) => item.name === name)
  if (!entry) throw Error(`桌面插件库中不存在 ${name}`)
  const result = copyPluginClosure(entry.sourceDir, profile, desktopProfileDir())
  if (!bundles.includes(name)) bundles.push(name)
  writeBundles(profile, bundles)
  writeDependency(profile, name, String(entry.version || '*'))
  try {
    signalChanged('plugins.changed', record.id)
  } catch {
    /* ignored */
  }
  return { name, ...result, restartRequired: true }
}

function setPluginEnabled(record, name, enabled) {
  requireStoppedInstance(record)
  if (!name || isSystemBundle(name)) throw Error('该系统插件不可通过此入口管理')
  const profile = profileDir(record)
  const bundles = readBundles(profile)
  const present = bundles.includes(name)
  if (enabled && !present) bundles.push(name)
  if (!enabled && present) bundles.splice(bundles.indexOf(name), 1)
  writeBundles(profile, bundles)
  try {
    signalChanged('plugins.changed', record.id)
  } catch {
    /* ignored */
  }
  return { name, enabled: Boolean(enabled), restartRequired: true }
}

function removePluginFromInstance(record, name) {
  requireStoppedInstance(record)
  if (!name || isSystemBundle(name)) throw Error('该系统插件不可移除')
  const profile = profileDir(record)
  if (!experimentalEntry(name)) {
    const target = path.join(profile, 'node_modules', name)
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
  }
  writeBundles(profile, readBundles(profile).filter((item) => item !== name))
  writeDependency(profile, name, null)
  try {
    signalChanged('plugins.changed', record.id)
  } catch {
    /* ignored */
  }
  return { name, restartRequired: true }
}

// ---------------------------------------------------------------------------
// attribution
// ---------------------------------------------------------------------------

function attributionFile(instanceId) {
  const safe = String(instanceId || '').replace(/[^A-Za-z0-9._-]/g, '_')
  return path.join(ATTRIBUTION_DIR, `${safe}.json`)
}

function readAttributionFile(instanceId) {
  const value = readJson(attributionFile(instanceId), null)
  const sessionsOk = value && value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)
  // Older schema versions may contain blank drafts that were later reused by the
  // desktop; ignore them silently instead of quarantining the file.
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.schemaVersion === 'number' && value.schemaVersion < ATTRIBUTION_SCHEMA) return null
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== ATTRIBUTION_SCHEMA || !sessionsOk) {
    if (value) backupBrokenFile(attributionFile(instanceId))
    return null
  }
  return value
}

function recordSessionAttribution(info, sessionId, workspacePath, sessionCreatedAt, executedAt) {
  if (!info || !info.instanceId || !sessionId) return
  const now = new Date().toISOString()
  // executedAt marks the LAST execution, not the first sighting: the badge is an
  // "executed most recently by" marker, so every turn refreshes it while the
  // session's own createdAt stays untouched for reference/truncation ordering.
  const stamp = typeof executedAt === 'string' && executedAt ? executedAt : now
  try {
    fs.mkdirSync(ATTRIBUTION_DIR, { recursive: true })
  } catch {
    /* ignored */
  }
  const existing = readAttributionFile(info.instanceId) || {
    schemaVersion: ATTRIBUTION_SCHEMA,
    instanceId: info.instanceId,
    instanceName: info.instanceName || info.instanceId,
    updatedAt: now,
    sessions: {},
  }
  existing.instanceId = info.instanceId
  existing.instanceName = info.instanceName || existing.instanceName || info.instanceId
  existing.updatedAt = now
  const current = existing.sessions[sessionId]
  if (!current) {
    existing.sessions[sessionId] = { workspacePath: workspacePath || '', createdAt: sessionCreatedAt || stamp, executedAt: stamp }
  } else {
    if (!current.workspacePath && workspacePath) current.workspacePath = workspacePath
    if (!current.createdAt) current.createdAt = sessionCreatedAt || stamp
    current.executedAt = stamp
  }
  const ids = Object.keys(existing.sessions)
  if (ids.length > ATTRIBUTION_SESSION_LIMIT) {
    ids.sort((a, b) => String(existing.sessions[a].executedAt || existing.sessions[a].createdAt || '').localeCompare(String(existing.sessions[b].executedAt || existing.sessions[b].createdAt || '')))
    for (const stale of ids.slice(0, ids.length - ATTRIBUTION_SESSION_LIMIT)) delete existing.sessions[stale]
  }
  try {
    writeJson(attributionFile(info.instanceId), existing)
  } catch (error) {
    console.warn('[instance-manager] 写入会话归属失败：', error && error.message ? error.message : error)
  }
}

// Merge every per-instance attribution file. Per-instance files avoid the
// read-modify-write race the old single shared file had between the desktop
// host and the child instances.
function mergedSessionRecords() {
  const merged = {}
  let names = []
  try {
    names = fs.readdirSync(ATTRIBUTION_DIR).filter((name) => name.endsWith('.json'))
  } catch {
    names = []
  }
  for (const name of names) {
    // Use the validating reader so an array/corrupt file is backed up instead of
    // being silently ignored (or merged as an unusable shape).
    const value = readAttributionFile(name.replace(/\.json$/, ''))
    if (!value) continue
    for (const [sessionId, info] of Object.entries(value.sessions)) {
      if (!info || typeof info !== 'object') continue
      if (!info.createdAt && !info.executedAt) continue
      const candidate = {
        instanceId: value.instanceId || info.instanceId || '',
        instanceName: value.instanceName || info.instanceName || '',
        workspacePath: String(info.workspacePath || ''),
        createdAt: String(info.createdAt || ''),
        // Legacy schema-4 rows only carried createdAt; treat it as the last
        // execution so old data still merges sensibly.
        executedAt: String(info.executedAt || info.createdAt || ''),
        updatedAt: String(value.updatedAt || ''),
      }
      const present = merged[sessionId]
      if (!present || candidate.executedAt > present.executedAt || (candidate.executedAt === present.executedAt && candidate.updatedAt >= present.updatedAt)) merged[sessionId] = candidate
    }
  }
  return merged
}

function iconVersion(record) {
  if (!record || !record.iconPath) return ''
  try {
    return String(Math.round(fs.statSync(record.iconPath).mtimeMs))
  } catch {
    return ''
  }
}

function iconContentType(file) {
  return /\.svg$/i.test(String(file || '')) ? 'image/svg+xml' : 'image/png'
}

function sanitizeSvg(text) {
  let svg = stripSvgReply(text)
  svg = svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '')
  if (!/<svg[^>]*xmlns=/i.test(svg)) svg = svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  if (!/<svg[^>]*viewBox=/i.test(svg)) svg = svg.replace(/<svg/i, '<svg viewBox="0 0 256 256"')
  svg = svg.replace(/\swidth="[^"]*"/i, '').replace(/\sheight="[^"]*"/i, '')
  return svg
}

// Models sometimes wrap the document in a fenced block, prefix it with a
// sentence, or forget the closing tag. Extract the first real <svg> element and
// repair the missing tail so a nearly-correct answer still produces an icon.
function stripSvgReply(text) {
  let value = String(text || '')
  value = value.replace(/```(?:svg|xml|html)?/gi, '').replace(/```/g, '')
  const start = value.indexOf('<svg')
  if (start === -1) {
    throw Error('模型没有返回 SVG 图标')
  }
  let svg = value.slice(start).trim()
  const end = svg.lastIndexOf('</svg>')
  if (end !== -1) svg = svg.slice(0, end + 6)
  else if (/\/>\s*$/.test(svg)) svg = svg.trim()
  else svg = `${svg.trimEnd()}</svg>`
  if (!/<svg[\s\S]*?(<\/svg>|\/>)/i.test(svg)) throw Error('模型没有返回 SVG 图标')
  return svg
}

function writeIconFile(record, kind, buffer) {
  const dir = instanceDir(record.id)
  fs.mkdirSync(dir, { recursive: true })
  const png = path.join(dir, 'icon.png')
  const svg = path.join(dir, 'icon.svg')
  if (kind === 'svg') {
    fs.writeFileSync(svg, buffer)
    try {
      fs.rmSync(png, { force: true })
    } catch {
      /* ignored */
    }
    return svg
  }
  fs.writeFileSync(png, buffer)
  try {
    fs.rmSync(svg, { force: true })
  } catch {
    /* ignored */
  }
  return png
}

function saveIconSvg(record, svgText) {
  const svg = sanitizeSvg(svgText)
  if (Buffer.byteLength(svg, 'utf8') > 512 * 1024) throw Error('图标不能超过 512KB')
  return writeIconFile(record, 'svg', Buffer.from(svg, 'utf8'))
}

function saveIconDataUrl(record, iconDataUrl) {
  const value = String(iconDataUrl || '')
  let match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(value)
  if (match) {
    const buffer = Buffer.from(match[1], 'base64')
    if (buffer.length > 512 * 1024) throw Error('图标不能超过 512KB')
    if (!(buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)) throw Error('图标文件不是有效 PNG')
    return writeIconFile(record, 'png', buffer)
  }
  match = /^data:image\/svg\+xml,(.*)$/s.exec(value)
  if (match) return saveIconSvg(record, decodeURIComponent(match[1]))
  match = /^data:image\/svg\+xml;base64,(.*)$/s.exec(value)
  if (match) return saveIconSvg(record, Buffer.from(match[1], 'base64').toString('utf8'))
  throw Error('图标需为 PNG 或 SVG 数据')
}

const FALLBACK_ICON_PROMPT = [
  '一个简洁的现代应用图标，正方形构图，中心是抽象几何图形，边缘利落，配色克制，',
  '深色渐变背景，纯色或渐变图形，无文字、无外链、无位图。',
].join('')

function iconPromptText() {
  try {
    const text = fs.readFileSync(ICON_PROMPT_FILE, 'utf8')
    if (text.trim()) return text
  } catch {
    /* ignored */
  }
  return FALLBACK_ICON_PROMPT
}

function iconKeywordGroups() {
  return ICON_KEYWORD_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    keywords: group.keywords.map((label, index) => ({ id: group.id + '-' + index, label })),
  }))
}

function iconKeywordIndex() {
  const index = new Map()
  for (const group of iconKeywordGroups()) {
    for (const keyword of group.keywords) index.set(keyword.id, keyword.label)
  }
  return index
}

function buildIconPrompt(record, keywordIds) {
  const index = iconKeywordIndex()
  const selected = []
  for (const id of Array.isArray(keywordIds) ? keywordIds : []) {
    const label = index.get(String(id))
    if (label && !selected.includes(label)) selected.push(label)
  }
  const keywordLine = selected.length
    ? '用户偏好的关键词（只作为风格倾向，不要全部堆砌）：' + selected.join('、')
    : '无额外偏好，按应用信息自行取舍，保持克制。'
  return iconPromptText()
    .replaceAll('{{name}}', record.name || '未命名分身')
    .replaceAll('{{description}}', record.description || '（未填写）')
    .replaceAll('{{keywords}}', keywordLine)
}

// Ask the default model for one square SVG icon. The first answer is kept raw;
// if it is not parseable as an SVG document the model gets one repair round with
// its own invalid output quoted back before we give up.
async function generateIconSvg(ctx, prompt) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.prepareCall !== 'function') throw Error('当前环境没有可用的模型服务')
  let route = null
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (selection && selection.provider && selection.model) route = selection
  } catch {
    /* ignored */
  }
  if (!route) {
    const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    const provider = providers[0]?.id || providers[0]?.provider
    if (!provider) throw Error('没有可用的模型，请先在桌面端配置模型')
    const models = await llm.listModels(provider)
    const model = models[0]?.id || models[0]?.model
    if (!model) throw Error('没有可用的模型，请先在桌面端配置模型')
    route = { provider, model }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  const userMessage = (text) => ({
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-instance-manager' },
  })
  const callOnce = async (messages) => {
    const call = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens: 4096 }, controller.signal)
    const options = { ...call.config, messages, system: ICON_SYSTEM_PROMPT, purpose: 'instance-icon', signal: controller.signal }
    let text = ''
    for await (const chunk of call.stream(options)) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    }
    return text.trim()
  }
  try {
    const first = await callOnce([userMessage(prompt)])
    try {
      stripSvgReply(first)
      return first
    } catch (error) {
      const repair = [
        '上一次输出无法解析为 SVG 图标。',
        '只输出完整 <svg ...>...</svg> 源码本身：第一个字符是 <，最后一个字符是 >，不要代码块标记，不要解释。',
        '如果缺失，请补上 xmlns="http://www.w3.org/2000/svg" 与 viewBox="0 0 256 256"。',
      ].join('\n')
      const second = await callOnce([
        userMessage(prompt),
        { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text: String(first || '').slice(0, 4000) }] },
        userMessage(repair),
      ])
      stripSvgReply(second)
      return second
    }
  } finally {
    clearTimeout(timer)
  }
}

// Icon generation runs detached from the HTTP request so the settings dialog can
// close immediately. The client polls /state and sees `iconGenerating` /
// `iconError` / a new `iconVersion` without holding a request open.
const ICON_JOBS = new Map() // instance id -> { startedAt, state: 'running'|'done'|'error', error, finishedAt }
const ICON_JOB_TTL_MS = 10 * 60 * 1000

function iconJob(id) {
  const job = ICON_JOBS.get(id)
  if (!job) return null
  if (job.state !== 'running' && job.finishedAt && Date.now() - job.finishedAt > ICON_JOB_TTL_MS) {
    ICON_JOBS.delete(id)
    return null
  }
  return job
}

function iconJobView(id) {
  const job = iconJob(id)
  if (!job) return null
  return { state: job.state, startedAt: job.startedAt, finishedAt: job.finishedAt || 0, error: job.error || '' }
}

function startIconGeneration(context, id, prompt) {
  const job = { startedAt: Date.now(), finishedAt: 0, state: 'running', error: '' }
  ICON_JOBS.set(id, job)
  generateIconSvg(context, prompt)
    .then((svgText) => {
      const current = readRegistry().instances[id]
      if (!current) throw Error('分身已被删除')
      const file = saveIconSvg(current, svgText)
      updateInstance(id, { iconPath: file })
      job.state = 'done'
      job.finishedAt = Date.now()
    })
    .catch((error) => {
      job.state = 'error'
      job.error = error && error.message ? error.message : String(error)
      job.finishedAt = Date.now()
      console.warn('[instance-manager] 生成图标失败：', job.error)
    })
  return iconJobView(id)
}

// url, icon version and a renamed instance name stay accurate.
function sessionOrigins() {
  const registry = readRegistry()
  const merged = mergedSessionRecords()
  const result = {}
  for (const [sessionId, info] of Object.entries(merged)) {
    const record = registry.instances[info.instanceId]
    if (!record) continue
    result[sessionId] = {
      instanceId: record.id,
      instanceName: record.name,
      workspacePath: info.workspacePath,
      createdAt: info.createdAt,
      executedAt: info.executedAt,
      status: record.status,
      running: record.status === 'running',
      url: ENV.kind === 'desktop' && RUNNING.get(record.id) && RUNNING.get(record.id).url ? RUNNING.get(record.id).url : '',
      port: record.port || null,
      hasIcon: Boolean(record.iconPath && fs.existsSync(record.iconPath)),
      iconContentType: record.iconPath ? iconContentType(record.iconPath) : '',
      iconVersion: iconVersion(record),
    }
  }
  return result
}

function lookupSessionOrigin(sessionId) {
  if (!sessionId) return null
  return sessionOrigins()[sessionId] || null
}

function removeAttributionFile(instanceId) {
  let removed = false
  try {
    const file = attributionFile(instanceId)
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true })
      removed = true
    }
  } catch {
    /* ignored */
  }
  // Drop rows written by earlier versions into the legacy single-file map.
  const legacy = readJson(ATTRIBUTION_PATH, null)
  if (legacy && legacy.workspaces && typeof legacy.workspaces === 'object') {
    let changed = 0
    for (const [key, value] of Object.entries(legacy.workspaces)) {
      if (value && value.instanceId === instanceId) {
        delete legacy.workspaces[key]
        changed += 1
      }
    }
    if (changed) writeJson(ATTRIBUTION_PATH, legacy)
  }
  return removed
}

function installSessionAttribution(ctx, info) {
  let disposed = false
  // The badge means "executed most recently by": record only real executions
  // (turn/start or a user message), never mere session attachment. Opening a
  // session in a host must not steal it from its last executor, while chatting
  // in that host does. Subagent sessions are not shown in the sidebar, so they
  // are ignored entirely.
  const onEvent = (session, event) => {
    try {
      if (disposed || !session || typeof session.id !== 'string' || !event) return
      if (event.type !== 'turn/start' && event.type !== 'user/message') return
      const header = session.header && typeof session.header === 'object' ? session.header : {}
      if (header.parentSession) return
      const createdAt = Number(header.createdAt) || 0
      recordSessionAttribution(
        info,
        session.id,
        typeof header.cwd === 'string' ? header.cwd : '',
        createdAt ? new Date(createdAt).toISOString() : '',
        new Date().toISOString(),
      )
    } catch (error) {
      console.warn('[instance-manager] 记录会话归属失败：', error && error.message ? error.message : error)
    }
  }
  const disposeEvent = ctx.on('session/event', onEvent, { global: true })
  return () => {
    disposed = true
    if (typeof disposeEvent === 'function') {
      try {
        disposeEvent()
      } catch {
        /* ignored */
      }
    }
  }
}

// A compact change digest lets every client ask the native session store to
// refresh when another process (desktop or sibling instance) writes sessions.
let revisionCache = { at: 0, value: '' }

function revisionDigest() {
  const now = Date.now()
  if (revisionCache.value && now - revisionCache.at < 700) return revisionCache.value
  const hash = crypto.createHash('sha1')
  const feedFile = (label, file) => {
    try {
      const stat = fs.statSync(file)
      hash.update(`${label}:${stat.size}:${stat.mtimeMs};`)
    } catch {
      hash.update(`${label}:missing;`)
    }
  }
  feedFile('workspaces', path.join(HOME, 'storages', 'workspace.json'))
  const sessionsRoot = path.join(HOME, 'sessions')
  feedFile('sessions-root', sessionsRoot)
  let workspaceDirs = []
  try {
    workspaceDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    workspaceDirs = []
  }
  for (const name of workspaceDirs) feedFile(`sessions:${name}`, path.join(sessionsRoot, name))
  let attributionFiles = []
  try {
    attributionFiles = fs.readdirSync(ATTRIBUTION_DIR).filter((name) => name.endsWith('.json')).sort()
  } catch {
    attributionFiles = []
  }
  for (const name of attributionFiles) feedFile(`attribution:${name}`, path.join(ATTRIBUTION_DIR, name))
  const value = hash.digest('hex').slice(0, 20)
  revisionCache = { at: now, value }
  return value
}

function invalidateRevision() {
  revisionCache = { at: 0, value: '' }
}

// ---------------------------------------------------------------------------
// ports / logs / url
// ---------------------------------------------------------------------------

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = http.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen({ host: '127.0.0.1', port, exclusive: true })
  })
}

async function allocatePort(preferred) {
  let port = Number.isInteger(preferred) && preferred >= PORT_MIN && preferred <= PORT_MAX ? preferred : PORT_MIN
  for (let attempt = 0; attempt <= PORT_MAX - PORT_MIN; attempt += 1) {
    const candidate = PORT_MIN + ((port - PORT_MIN + attempt) % (PORT_MAX - PORT_MIN + 1))
    // eslint-disable-next-line no-await-in-loop
    if (await portIsFree(candidate)) return { port: candidate, changed: candidate !== preferred }
  }
  throw Error('端口池 52000-52999 已全部占用')
}

function lanAddress() {
  const interfaces = os.networkInterfaces()
  for (const list of Object.values(interfaces)) {
    for (const item of list || []) {
      if (item && item.family === 'IPv4' && !item.internal) return item.address
    }
  }
  return ''
}

function readLogTail(id, lines = 120) {
  try {
    const text = fs.readFileSync(logFile(id), 'utf8').replace(/\u001b\[[0-9;]*m/g, '')
    return text.split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

function httpProbe(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const request = http.get(url, { timeout: timeoutMs }, (response) => {
        response.resume()
        finish(response.statusCode >= 200 && response.statusCode < 500)
      })
      request.on('timeout', () => {
        request.destroy()
        finish(false)
      })
      request.on('error', () => finish(false))
    } catch {
      finish(false)
    }
  })
}

function openInBrowser(url) {
  try {
    const child = spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    /* ignored */
  }
}


// ---------------------------------------------------------------------------
// Desktop shell
// ---------------------------------------------------------------------------

function shellEntry (id) {
  const entry = SHELLS.get(id)
  if (!entry) return null
  if (entry.child && entry.child.exitCode !== null) {
    SHELLS.delete(id)
    return null
  }
  return entry
}

function shellPhase (id) {
  const entry = shellEntry(id)
  return entry ? entry.phase : 'closed'
}

function closeInstanceShell (id) {
  const entry = SHELLS.get(id)
  if (!entry) return false
  SHELLS.delete(id)
  SHELL_ERRORS.delete(id)
  if (entry.child && entry.child.pid) killShellProcess(entry.child.pid)
  appendLog(id, '\n=== desktop shell closed by manager ===\n')
  return true
}

function openInstanceShell (id) {
  const record = readRegistry().instances[id]
  if (!record) throw Error('分身不存在')
  const runningEntry = RUNNING.get(id)
  if (!runningEntry || !runningEntry.url) throw Error('分身尚未运行或宿主已重启，请重新启动分身')
  SHELL_ERRORS.delete(id)
  const existing = shellEntry(id)
  if (existing && existing.phase !== 'error') {
    // The shell hides itself when the user clicks "back"; reuse that window.
    if (existing.child && existing.child.stdin && existing.child.stdin.writable) {
      try { existing.child.stdin.write('show\n') } catch {}
    }
    return { id, shell: existing.phase }
  }
  const entry = { child: null, phase: 'preparing', error: '', openedAt: Date.now() }
  SHELLS.set(id, entry)
  void (async () => {
    try {
      await ensureShellRuntime(HOME, (line) => console.log(line))
      if (SHELLS.get(id) !== entry) return
      const fresh = readRegistry().instances[id]
      const live = RUNNING.get(id)
      const url = live && typeof live.url === 'string' ? live.url : ''
      if (!fresh || !url) throw new Error('分身已停止')
      const child = spawnInstanceShell(HOME, { ...fresh, url })
      entry.child = child
      entry.phase = 'opening'
      child.on('error', (error) => {
        const message = error && error.message ? error.message : String(error)
        entry.phase = 'error'
        entry.error = message
        SHELL_ERRORS.set(id, message)
        appendLog(id, '\n=== desktop shell failed: ' + message + ' ===\n')
      })
      appendLog(id, `\n=== desktop shell pid=${child.pid} ===\n`)
      if (child.stdout) {
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
          for (const line of String(chunk).split(/\r?\n/)) {
            if (!line) continue
            if (line === 'shell-ready') entry.phase = 'ready'
            else if (line === 'shell-closed') appendLog(id, '\n=== desktop shell window closed ===\n')
            else if (line.startsWith('shell-error ')) {
              entry.error = line.slice('shell-error '.length)
              appendLog(id, `\n=== desktop shell error: ${entry.error} ===\n`)
            }
          }
        })
      }
      if (child.stderr) {
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk) => appendLog(id, chunk))
      }
      child.on('exit', (code) => {
        if (SHELLS.get(id) === entry) SHELLS.delete(id)
        appendLog(id, `\n=== desktop shell exited (${code == null ? '?' : code}) ===\n`)
      })
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      entry.phase = 'error'
      entry.error = message
      SHELL_ERRORS.set(id, message)
      appendLog(id, `\n=== desktop shell failed: ${message} ===\n`)
      console.warn('[instance-manager] 桌面窗口打开失败：', message)
      const live = RUNNING.get(id)
      const fresh = readRegistry().instances[id]
      if (fresh && fresh.autoOpen !== false && live && live.url) openInBrowser(live.url)
    }
  })()
  return { id, shell: 'preparing' }
}

function killTree (pid) {
  if (!pid) return
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* ignored */
    }
  }
}

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

// ---------------------------------------------------------------------------
// instance lifecycle
// ---------------------------------------------------------------------------

function nodeExecutable() {
  const runtimeDir = ENV.runtimeDir
  if (runtimeDir) {
    const candidate = path.join(runtimeDir, 'dependencies', 'node', 'bin', 'node.exe')
    if (fs.existsSync(candidate)) return { command: candidate, env: {} }
  }
  if (process.versions.electron) {
    return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { command: process.execPath, env: {} }
}

function kernelBin(record) {
  return path.join(instanceDir(record.id), 'kernel', record.kernelVersion || 'current', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

let GENERATION = 0
function nextGeneration() {
  GENERATION += 1
  return GENERATION
}

async function waitForPidExit(pid, timeoutMs = 8000) {
  if (!pid) return true
  const deadline = Date.now() + timeoutMs
  while (pidAlive(pid)) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return true
}

async function startInstance(ctx, id, options = {}) {
  const registry = readRegistry()
  const record = registry.instances[id]
  if (!record) throw Error('分身不存在')
  const existing = RUNNING.get(id)
  if (existing) {
    if (existing.starting) return { id, status: 'starting', alreadyStarting: true }
    return { id, status: existing.ready ? 'running' : record.status, alreadyRunning: Boolean(existing.ready) }
  }
  if ((record.status === 'running' || record.status === 'starting') && pidAlive(record.pid)) {
    throw Error('分身进程已在运行；如状态异常，请先停止分身。')
  }
  const bin = kernelBin(record)
  if (!fs.existsSync(bin)) {
    const next = updateInstance(id, { status: 'error', error: '分身内核不完整，请在设置中重建内核。' })
    return next
  }
  // Reserve the slot synchronously before the first await: two concurrent
  // /start calls must never spawn two DSH processes for one instance.
  const state = {
    generation: nextGeneration(),
    starting: true,
    child: null,
    startingAt: Date.now(),
    url: '',
    stopping: false,
    stopRequested: false,
    ready: false,
    poll: undefined,
  }
  RUNNING.set(id, state)
  try {
    const profile = profileDir(record)
    const physical = profilePhysicalDir(record)
    // Create the physical profile first: creating the entry path while the
    // junction is missing would produce a real directory and block the link.
    fs.mkdirSync(physical, { recursive: true })
    try {
      ensureProfileJunction(record)
      ensureManagedPatch(physical)
      syncSelfIntoProfile(physical)
    } catch (error) {
      console.warn('[instance-manager] 无法准备分身配置：', error && error.message ? error.message : error)
    }
    const allocation = await allocatePort(record.port)
    if (state.stopRequested || RUNNING.get(id) !== state) {
      if (RUNNING.get(id) === state) RUNNING.delete(id)
      return { id, status: 'stopped', aborted: true }
    }
    const port = allocation.port
    const lanIp = record.lanEnabled ? lanAddress() : ''
    const host = lanIp || '127.0.0.1'
    appendLog(id, `\n=== start ${new Date().toISOString()} port=${port} host=${host} ===\n`)
    const node = nodeExecutable()
    const args = [
      bin,
      '--profile', record.profileName || record.id,
      '--host', host,
      '--port', String(port),
      '--no-open',
    ]
    if (lanIp) {
      args.push('--trusted-host', `${lanIp}:${port}`, '--public-url', `http://${lanIp}:${port}`)
    }
    let child
    try {
      child = spawn(node.command, args, {
        cwd: fs.existsSync(physical) ? physical : profile,
        env: {
          ...process.env,
          ...node.env,
          DSH_INSTANCE_ID: id,
          DSH_INSTANCE_NAME: record.name,
          DSH_INSTANCE_MANAGER: '1',
          DSH_INSTANCES_ROOT: INSTANCES_ROOT,
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      if (RUNNING.get(id) === state) RUNNING.delete(id)
      const message = error && error.message ? error.message : String(error)
      updateInstance(id, { status: 'error', error: `无法启动分身进程：${message}`, pid: null, url: null })
      throw error
    }
    state.child = child
    state.starting = false
    child.on('error', (error) => {
      const message = error && error.message ? error.message : String(error)
      appendLog(id, `\n=== spawn error: ${message} ===\n`)
      if (state.poll) clearInterval(state.poll)
      state.poll = undefined
      if (RUNNING.get(id) === state) RUNNING.delete(id)
      updateInstance(id, { status: 'error', error: `无法启动分身进程：${message}`, pid: null, url: null })
      flushLog(id)
    })
    updateInstance(id, { status: 'starting', pid: child.pid, error: '', port, portChanged: allocation.changed || undefined })

    let buffered = ''
    const onChunk = (chunk) => {
      appendLog(id, chunk)
      buffered += chunk
      const match = /dsh web:\s+(https?:\/\/\S+)/.exec(buffered)
      if (match && !state.url) state.url = match[1].replace(/[),.;]+$/, '')
      if (buffered.length > 20000) buffered = buffered.slice(-10000)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', onChunk)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', onChunk)

    const deadline = Date.now() + 90000
    const poll = setInterval(async () => {
      if (state.stopRequested || state.ready || RUNNING.get(id) !== state) return
      if (state.url) {
        const healthy = await httpProbe(state.url)
        if (state.stopRequested || state.ready || RUNNING.get(id) !== state) return
        if (healthy) {
          state.ready = true
          if (state.poll) clearInterval(state.poll)
          state.poll = undefined
          updateInstance(id, {
            status: 'running',
            pid: child.pid,
            // Never persist the process token: it is a bearer credential.
            url: redactSecrets(state.url),
            lastStartedAt: new Date().toISOString(),
            error: '',
          })
          appendLog(id, `\n=== running ${redactSecrets(state.url)} ===\n`)
          flushLog(id)
          const latest = readRegistry().instances[id]
          if (latest && latest.autoOpen !== false && options.open !== false) {
            if (latest.accessMode === 'desktop-app') {
              try {
                openInstanceShell(id)
              } catch (error) {
                appendLog(id, '\n=== desktop shell unavailable, fallback to browser ===\n')
                openInBrowser(state.url)
              }
            } else {
              openInBrowser(state.url)
            }
          }
        }
      }
      if (Date.now() > deadline && !state.ready) {
        if (state.poll) clearInterval(state.poll)
        state.poll = undefined
        appendLog(id, '\n=== start timeout ===\n')
        updateInstance(id, { status: 'error', pid: null, url: null, error: '启动超时（90 秒内未就绪），请查看日志。' })
        killTree(child.pid)
        flushLog(id)
        if (RUNNING.get(id) === state) RUNNING.delete(id)
      }
    }, 800)
    state.poll = poll

    child.on('exit', (code) => {
      if (state.poll) clearInterval(state.poll)
      state.poll = undefined
      if (RUNNING.get(id) !== state) {
        appendLog(id, `\n=== exit ignored (superseded) code=${code} ===\n`)
        flushLog(id)
        return
      }
      RUNNING.delete(id)
      flushLog(id)
      const latest = readRegistry().instances[id]
      if (!latest) return
      if (state.stopping || state.stopRequested) {
        updateInstance(id, { status: 'stopped', pid: null, url: null })
        appendLog(id, `\n=== stopped ===\n`)
      } else {
        updateInstance(id, { status: 'error', pid: null, url: null, error: `分身进程意外退出（退出码 ${code}）` })
        appendLog(id, `\n=== exited code=${code} ===\n`)
      }
      flushLog(id)
    })
    return { id, port, lan: Boolean(lanIp) }
  } catch (error) {
    if (RUNNING.get(id) === state) RUNNING.delete(id)
    const message = error && error.message ? error.message : String(error)
    appendLog(id, `\n=== start failed: ${message} ===\n`)
    flushLog(id)
    throw error
  }
}

async function stopInstance(id) {
  closeInstanceShell(id)
  const record = readRegistry().instances[id]
  if (!record) throw Error('分身不存在')
  const state = RUNNING.get(id)
  const pid = (state && state.child && state.child.pid) || record.pid
  if (state) {
    state.stopping = true
    state.stopRequested = true
    if (state.poll) clearInterval(state.poll)
    state.poll = undefined
  }
  if (pid) killTree(pid)
  const gone = pid ? await waitForPidExit(pid, 8000) : true
  if (state && RUNNING.get(id) === state) RUNNING.delete(id)
  flushLog(id)
  if (!gone) {
    const message = '无法终止分身进程（可能仍在后台运行），请稍后重试或手动结束该进程。'
    updateInstance(id, { status: 'error', pid, url: null, error: message })
    appendLog(id, `\n=== stop failed: process ${pid} is still alive ===\n`)
    flushLog(id)
    return { id, status: 'error', error: message }
  }
  updateInstance(id, { status: 'stopped', pid: null, url: null, error: '' })
  appendLog(id, `\n=== stop requested ===\n`)
  flushLog(id)
  return { id, status: 'stopped' }
}

function stopAll() {
  for (const id of Array.from(SHELLS.keys())) closeInstanceShell(id)
  for (const id of Array.from(PROVISION.keys())) cancelProvision(id)
  for (const [id, state] of RUNNING) {
    state.stopping = true
    state.stopRequested = true
    if (state.poll) clearInterval(state.poll)
    if (state.child && state.child.pid) killTree(state.child.pid)
    RUNNING.delete(id)
    flushLog(id)
    try {
      updateInstance(id, { status: 'stopped', pid: null, url: null })
    } catch {
      /* ignored */
    }
  }
}

function cleanupStale() {
  const registry = readRegistry()
  let changed = false
  for (const [id, record] of Object.entries(registry.instances)) {
    if (record.provision && record.provision.done !== true) {
      registry.instances[id] = { ...record, status: 'error', error: '创建过程被中断，请删除分身后重新创建。' }
      changed = true
      continue
    }
    if ((record.status === 'running' || record.status === 'starting') && !pidAlive(record.pid)) {
      registry.instances[id] = { ...record, status: 'stopped', pid: null, url: null }
      changed = true
    }
  }
  if (changed) saveRegistry(registry)
}

// ---------------------------------------------------------------------------
// provisioning job
// ---------------------------------------------------------------------------

function cancelProvision(id) {
  const provision = PROVISION.get(id)
  if (!provision) return false
  provision.cancelled = true
  try {
    if (typeof provision.kill === 'function') provision.kill()
  } catch {
    /* ignored */
  }
  return true
}

async function waitForProvisionStop(id, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (PROVISION.has(id) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return !PROVISION.has(id)
}

async function runProvision(id) {
  const provision = PROVISION.get(id)
  const record = readRegistry().instances[id]
  if (!record || !provision) return
  const dir = instanceDir(id)
  const cancelled = () => provision.cancelled === true
  const cleanupCancelled = () => {
    try {
      cleanupInstanceFiles(id, readRegistry().instances[id] || record)
    } catch {
      /* ignored */
    }
    Object.assign(provision, { phase: 'cancelled', percent: 100, message: '已取消', done: true, cancelled: true })
    LOG_BUFFERS.delete(id)
  }
  const update = (patch) => {
    if (cancelled()) return null
    const current = PROVISION.get(id)
    if (current) Object.assign(current, patch)
    try {
      return updateInstance(id, { provision: patch })
    } catch {
      return null
    }
  }
  try {
    update({ phase: 'copy-kernel', percent: 2, message: '正在准备内核…' })
    const kernelDir = path.join(dir, 'kernel', record.kernelVersion || 'pending')
    fs.mkdirSync(kernelDir, { recursive: true })
    let detectedVersion = record.kernelVersion && record.kernelVersion !== 'pending' ? record.kernelVersion : ''
    await copyKernel(ENV.kernelSource, kernelDir, (payload) => {
      if (cancelled()) return
      update({ phase: 'copy-kernel', percent: payload.percent, message: payload.message })
    }, (meta) => {
      if (meta && meta.version) detectedVersion = meta.version
    }, provision)
    if (cancelled()) {
      cleanupCancelled()
      return
    }
    if (!detectedVersion) {
      detectedVersion = readJson(path.join(kernelDir, 'desktop-runtime.json'), {})?.release?.version || 'unknown'
    }
    // The kernel source directory name is a placeholder when the version was
    // unknown at create time; rename to the detected version.
    let finalKernel = kernelDir
    if (path.basename(kernelDir) !== detectedVersion) {
      finalKernel = path.join(dir, 'kernel', detectedVersion)
      if (fs.existsSync(finalKernel)) fs.rmSync(finalKernel, { recursive: true, force: true })
      fs.renameSync(kernelDir, finalKernel)
    }
    const bin = path.join(finalKernel, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (!fs.existsSync(bin)) throw Error('内核复制不完整：缺少 @deepseek-ai/dsh/lib/bin.js')
    if (cancelled()) {
      cleanupCancelled()
      return
    }
    update({ phase: 'profile', percent: 84, message: '正在创建独立配置…' })
    const profile = ensureProfile({ ...record, kernelVersion: detectedVersion })
    syncSelfIntoProfile(profile)
    writeBundles(profile, [`@deepseek-ai/dsh-base`, '@deepseek-ai/dsh-web-app', PLUGIN_PACKAGE])
    writeDependency(profile, PLUGIN_PACKAGE, selfPluginVersion())
    if (cancelled()) {
      cleanupCancelled()
      return
    }
    update({ phase: 'library', percent: 92, message: '正在记录插件库…' })
    const library = { schemaVersion: 1, desktopProfileDir: desktopProfileDir(), createdAt: new Date().toISOString(), entries: scanDesktopLibrary() }
    fs.mkdirSync(dir, { recursive: true })
    writeJson(path.join(dir, 'library.json'), library)
    if (cancelled()) {
      cleanupCancelled()
      return
    }
    update({ phase: 'done', percent: 100, message: '创建完成', done: true })
    const finished = updateInstance(id, {
      kernelVersion: detectedVersion,
      status: 'stopped',
      provision: { phase: 'done', percent: 100, message: '创建完成', done: true },
      error: '',
    })
    if (finished) writeJson(path.join(dir, 'instance.json'), finished)
    flushLog(id)
  } catch (error) {
    flushLog(id)
    if (cancelled()) {
      cleanupCancelled()
      return
    }
    const message = error && error.message ? error.message : String(error)
    appendLog(id, `\n=== provision failed: ${message} ===\n`)
    flushLog(id)
    // Roll the half-built directory back so a failed create does not leave a
    // 400MB+ orphan on disk. The registry row is kept with an error so the user
    // still sees what happened and can delete it.
    try {
      cleanupInstanceFiles(id, readRegistry().instances[id] || record)
    } catch {
      /* ignored */
    }
    LOG_BUFFERS.delete(id)
    updateInstance(id, { status: 'error', error: message, provision: { phase: 'error', percent: 100, message, done: true, error: message } })
    const current = PROVISION.get(id)
    if (current) Object.assign(current, { phase: 'error', message, done: true, error: message })
  }
}

function cleanupInstanceFiles(id, record) {
  // Drop the profile entry link first: it may point into the storage root that
  // is about to be deleted, and Windows cannot remove a non-empty junction tree.
  if (record) removeProfileJunction(record)
  try {
    fs.rmSync(instanceDir(record || id), { recursive: true, force: true })
  } catch {
    /* ignored */
  }
  try {
    const entry = record ? profileEntryDir(record) : path.join(PROFILES_ROOT, id)
    if (fs.existsSync(entry)) fs.rmSync(entry, { recursive: true, force: true })
  } catch {
    /* ignored */
  }
}

function resolveStorageDir(input) {
  const raw = String(input || '').trim()
  if (!raw) throw Error('请选择存储位置')
  if (!path.isAbsolute(raw)) throw Error('存储位置需为绝对路径')
  const resolved = path.resolve(raw)
  for (const item of Object.values(readRegistry().instances)) {
    const root = storageRoot(item)
    const relative = path.relative(root, resolved)
    if (relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw Error('存储位置不能位于其他分身的存储目录内')
    }
  }
  try {
    fs.mkdirSync(resolved, { recursive: true })
    const probe = path.join(resolved, `.instance-manager-write-test-${process.pid}`)
    fs.writeFileSync(probe, 'ok', 'utf8')
    fs.unlinkSync(probe)
  } catch (error) {
    throw Error('存储位置不可写：' + (error && error.message ? error.message : String(error)))
  }
  return resolved
}

function moveDir(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    fs.renameSync(source, target)
    return
  } catch (error) {
    const code = error && error.code
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTEMPTY') throw error
  }
  copyTreeDeref(source, target, {})
  fs.rmSync(source, { recursive: true, force: true })
}

function createInstance(body) {
  const name = String(body?.name || '').trim()
  const nameChars = Array.from(name).length
  if (nameChars < 1 || nameChars > 40) throw Error('分身名称需为 1-40 个字符')
  if (Object.values(readRegistry().instances).some((item) => item.name === name)) {
    throw Error('分身名称已存在，请换一个名称')
  }
  const storageDir = resolveStorageDir(body?.storageDir)
  const ports = Object.values(readRegistry().instances).map((item) => item.port)
  const explicitPort = body?.port !== undefined && body?.port !== null && String(body.port).trim() !== ''
  const requestedPort = Number(body?.port)
  if (explicitPort && (!Number.isInteger(requestedPort) || requestedPort < PORT_MIN || requestedPort > PORT_MAX)) {
    throw Error(`端口需在 ${PORT_MIN}-${PORT_MAX} 之间`)
  }
  let port = explicitPort ? requestedPort : PORT_MIN
  while (ports.includes(port) && port < PORT_MAX) port += 1
  const id = `inst-${crypto.randomUUID()}`
  const order = Object.values(readRegistry().instances).reduce((max, item) => Math.max(max, Number.isFinite(item.order) ? item.order : -1), -1) + 1
  const record = {
    schemaVersion: 1,
    id,
    name,
    description: String(body?.description || '').slice(0, 300),
    iconPath: '',
    kernelVersion: 'pending',
    profileName: id,
    storageDir,
    port,
    lanEnabled: body?.lanEnabled === true,
    autoOpen: body?.autoOpen !== false,
    order,
    accessMode: 'browser',
    status: 'stopped',
    pid: null,
    url: null,
    createdAt: new Date().toISOString(),
    lastStartedAt: '',
    error: '',
    provision: { phase: 'copy-kernel', percent: 0, message: '排队中…', done: false },
  }
  const registry = readRegistry()
  registry.instances[id] = record
  saveRegistry(registry)
  fs.mkdirSync(instanceDir(record), { recursive: true })
  writeJson(path.join(instanceDir(record), 'instance.json'), record)
  const provision = { phase: 'copy-kernel', percent: 0, message: '正在准备…', done: false, cancelled: false }
  PROVISION.set(id, provision)
  setImmediate(() => {
    runProvision(id).finally(() => {
      PROVISION.delete(id)
    })
  })
  return { id, storageDir }
}

async function deleteInstance(id, confirmName) {
  const record = readRegistry().instances[id]
  if (!record) throw Error('分身不存在')
  if (String(confirmName || '') !== record.name) throw Error('分身名称不匹配')
  // A provision job holds a kernel-copy child process: cancel it and wait for
  // the job to unwind before touching the directory, otherwise the copy keeps
  // writing (and re-creating) files after the delete returns.
  if (PROVISION.has(id)) {
    cancelProvision(id)
    const provisionStopped = await waitForProvisionStop(id, 15000)
    if (!provisionStopped) throw Error('创建任务仍在结束中，请稍后重试')
  }
  const result = await stopInstance(id)
  if (result && result.status === 'error') throw Error(result.error || '分身仍在运行，无法删除')
  const fresh = readRegistry().instances[id]
  if (!fresh) return { id, deleted: true }
  removeAttributionFile(id)
  cleanupInstanceFiles(id, fresh)
  LOG_BUFFERS.delete(id)
  const registry = readRegistry()
  delete registry.instances[id]
  saveRegistry(registry)
  console.log(`[instance-manager] deleted ${id}`)
  return { id }
}

async function migrateInstance(id, targetDir) {
  const record = readRegistry().instances[id]
  if (!record) throw Error('分身不存在')
  if (RUNNING.has(id) || record.status === 'running' || record.status === 'starting') {
    throw Error('请先停止分身再迁移存储位置')
  }
  const target = resolveStorageDir(targetDir)
  if (record.storageDir && path.resolve(record.storageDir) === target) return record
  const oldRoot = storageRoot(record)
  if (!fs.existsSync(oldRoot)) throw Error('当前存储目录不存在，无法迁移')
  const newRoot = path.join(target, id)
  if (fs.existsSync(newRoot)) throw Error('目标位置已存在同名分身目录，请换一个目录')
  const hadStorageDir = Boolean(record.storageDir)
  // Break the junction first: it points into the tree that is about to move.
  if (hadStorageDir) removeProfileJunction(record)
  try {
    moveDir(oldRoot, newRoot)
    const next = updateInstance(id, { storageDir: target, error: '' })
    // Legacy layout kept the profile as a real directory outside the storage
    // root; fold it into the moved tree so everything really lives in the new
    // folder, then link the profile entry at it.
    const entry = profileEntryDir(record)
    const physical = path.join(newRoot, 'profile')
    if (!isDirectoryLink(entry) && fs.existsSync(entry) && !fs.existsSync(physical)) {
      moveDir(entry, physical)
    }
    // `next` is a plain object with the new storageDir, so the junction target
    // points at the moved profile.
    ensureProfileJunction(next)
    // Icons are recorded with an absolute path: re-point it into the new root.
    if (next.iconPath) {
      const relative = path.relative(oldRoot, path.resolve(next.iconPath))
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        const movedIcon = path.join(newRoot, relative)
        const updated = updateInstance(id, { iconPath: movedIcon })
        writeJson(path.join(newRoot, 'instance.json'), updated)
      } else {
        writeJson(path.join(newRoot, 'instance.json'), next)
      }
    } else {
      writeJson(path.join(newRoot, 'instance.json'), next)
    }
    return readRegistry().instances[id]
  } catch (error) {
    // Put the junction back so the instance stays usable when the move fails.
    if (hadStorageDir) ensureProfileJunction(record)
    throw error
  }
}

function validateKernelDir(dir, version) {
  const bin = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!fs.existsSync(bin)) throw Error('内核不完整：缺少 @deepseek-ai/dsh/lib/bin.js')
  const manifest = readJson(path.join(dir, 'desktop-runtime.json'), null)
  if (!manifest) throw Error('内核不完整：缺少 desktop-runtime.json')
  const found = String(manifest?.release?.version || '')
  if (!version) throw Error('无法识别内核版本')
  if (found && found !== version) throw Error(`内核版本不一致（期望 ${version}，实际 ${found}）`)
}

async function rebuildKernel(id) {
  const record = readRegistry().instances[id]
  if (!record) throw Error('分身不存在')
  if (RUNNING.has(id) || record.status === 'running' || record.status === 'starting') throw Error('请先停止分身再重建内核')
  if (PROVISION.has(id)) throw Error('分身正在执行其他任务，请稍后再试')
  const source = ENV.kernelSource
  if (!source) throw Error('当前环境无法读取桌面内核')
  const kernelDir = path.join(instanceDir(id), 'kernel')
  const staging = path.join(kernelDir, `.rebuild-${Date.now()}`)
  const provision = { phase: 'copy-kernel', percent: 0, message: '正在重建内核…', done: false, cancelled: false }
  PROVISION.set(id, provision)
  updateInstance(id, { provision: { ...provision }, error: '' })
  setImmediate(async () => {
    let version = ''
    try {
      fs.rmSync(staging, { recursive: true, force: true })
      await copyKernel(source, staging, (payload) => {
        if (provision.cancelled) return
        try {
          updateInstance(id, { provision: { ...payload, done: false } })
        } catch {
          /* ignored */
        }
      }, (meta) => {
        version = meta?.version || ''
      }, provision)
      if (provision.cancelled) throw Error('已取消')
      if (!version) version = readJson(path.join(staging, 'desktop-runtime.json'), {})?.release?.version || ''
      // Validate the complete tree BEFORE touching the current kernel. The old
      // implementation removed the existing kernel first, so one bad copy made
      // the instance permanently unusable.
      validateKernelDir(staging, version)
      const target = path.join(kernelDir, version)
      let backup = ''
      if (fs.existsSync(target)) {
        backup = path.join(kernelDir, `.old-${Date.now()}`)
        fs.renameSync(target, backup)
      }
      try {
        fs.renameSync(staging, target)
        validateKernelDir(target, version)
      } catch (swapError) {
        try {
          fs.rmSync(target, { recursive: true, force: true })
        } catch {
          /* ignored */
        }
        if (backup && fs.existsSync(backup)) fs.renameSync(backup, target)
        throw swapError
      }
      if (backup) {
        try {
          fs.rmSync(backup, { recursive: true, force: true })
        } catch {
          /* ignored */
        }
      }
      updateInstance(id, {
        kernelVersion: version,
        provision: { phase: 'done', percent: 100, message: '内核已重建', done: true },
        error: '',
        status: 'stopped',
      })
      appendLog(id, `\n=== kernel rebuilt ${version} ===\n`)
      flushLog(id)
    } catch (error) {
      const cancelled = provision.cancelled
      const message = cancelled ? '已取消' : error && error.message ? error.message : String(error)
      try {
        fs.rmSync(staging, { recursive: true, force: true })
      } catch {
        /* ignored */
      }
      try {
        updateInstance(id, {
          status: 'stopped',
          provision: { phase: cancelled ? 'cancelled' : 'error', percent: 100, message, done: true, error: cancelled ? undefined : message },
          error: cancelled ? '' : message,
        })
      } catch {
        /* ignored */
      }
      if (!cancelled) appendLog(id, `\n=== kernel rebuild failed: ${message} ===\n`)
      flushLog(id)
    } finally {
      PROVISION.delete(id)
    }
  })
  return { id, started: true }
}

function updateInstanceSettings(id, patch) {
  const record = readRegistry().instances[id]
  if (!record) throw Error('分身不存在')
  const next = {}
  if (typeof patch?.name === 'string') {
    const name = patch.name.trim()
    const nameChars = Array.from(name).length
    if (nameChars < 1 || nameChars > 40) throw Error('分身名称需为 1-40 个字符')
    if (Object.values(readRegistry().instances).some((item) => item.id !== id && item.name === name)) {
      throw Error('分身名称已存在，请换一个名称')
    }
    next.name = name
  }
  if (typeof patch?.description === 'string') next.description = patch.description.slice(0, 300)
  if (patch?.port !== undefined) {
    const port = Number(patch.port)
    if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) throw Error(`端口需在 ${PORT_MIN}-${PORT_MAX} 之间`)
    const conflict = Object.values(readRegistry().instances).some((item) => item.id !== id && item.port === port)
    if (conflict) throw Error('端口已被其他分身占用')
    next.port = port
  }
  if (typeof patch?.lanEnabled === 'boolean') next.lanEnabled = patch.lanEnabled
  if (typeof patch?.autoOpen === 'boolean') next.autoOpen = patch.autoOpen
  if (patch?.accessMode === 'browser' || patch?.accessMode === 'desktop-app') next.accessMode = patch.accessMode
  if (typeof patch?.iconDataUrl === 'string') {
    next.iconPath = saveIconDataUrl(record, patch.iconDataUrl)
  }
  const updated = updateInstance(id, next)
  try {
    writeJson(path.join(instanceDir(id), 'instance.json'), updated)
  } catch {
    /* ignored */
  }
  return updated
}

// ---------------------------------------------------------------------------
// state serialization
// ---------------------------------------------------------------------------

function instanceView(record) {
  const provision = PROVISION.get(record.id) || record.provision || null
  return {
    id: record.id,
    name: record.name,
    description: record.description || '',
    iconPath: record.iconPath || '',
    hasIcon: Boolean(record.iconPath && fs.existsSync(record.iconPath)),
    iconContentType: record.iconPath ? iconContentType(record.iconPath) : '',
    kernelVersion: record.kernelVersion,
    desktopVersion: desktopVersion(),
    port: record.port,
    lanEnabled: Boolean(record.lanEnabled),
    autoOpen: record.autoOpen !== false,
    order: Number.isFinite(record.order) ? record.order : 0,
    accessMode: record.accessMode === 'desktop-app' ? 'desktop-app' : 'browser',
    iconVersion: iconVersion(record),
    iconGenerating: Boolean(iconJob(record.id) && iconJob(record.id).state === 'running'),
    iconError: iconJob(record.id) && iconJob(record.id).state === 'error' ? iconJob(record.id).error : '',
    status: record.status,
    url: ENV.kind === 'desktop' && RUNNING.get(record.id) && RUNNING.get(record.id).url ? RUNNING.get(record.id).url : '',
    pid: record.pid || null,
    shell: shellPhase(record.id),
    shellError: SHELL_ERRORS.get(record.id) || (() => { const entry = shellEntry(record.id); return entry ? entry.error || '' : '' })(),
    error: record.error || '',
    portChanged: record.portChanged === true,
    createdAt: record.createdAt,
    lastStartedAt: record.lastStartedAt || '',
    storageDir: record.storageDir ? path.resolve(record.storageDir) : INSTANCES_ROOT,
    instanceRoot: instanceDir(record),
    provision,
    pluginCount: (() => {
      try {
        return instanceBundles(record).length
      } catch {
        return 0
      }
    })(),
  }
}

let desktopVersionCache = { source: '', at: 0, value: '' }

function desktopVersion() {
  if (!ENV.kernelSource) return ''
  const now = Date.now()
  if (desktopVersionCache.source === ENV.kernelSource && now - desktopVersionCache.at < 60000) {
    return desktopVersionCache.value
  }
  let value = ''
  try {
    const manifest = readJson(path.join(ENV.kernelSource, 'desktop-runtime.json'), null)
    value = String(manifest?.release?.version || '')
  } catch {
    value = ''
  }
  desktopVersionCache = { source: ENV.kernelSource, at: now, value }
  return value
}

function helloPayload() {
  const payload = {
    mode: ENV.kind,
    instanceId: ENV.kind === 'instance' ? ENV.instanceId : '',
    instanceName: ENV.kind === 'instance' ? ENV.instanceName : '',
    desktopVersion: desktopVersion(),
    platform: process.platform,
    autoOpenDefault: true,
    home: HOME,
    defaultStorageDir: INSTANCES_ROOT,
    shellRuntime: shellRuntimeInfo(HOME),
  }
  if (ENV.kind === 'instance') {
    const record = readRegistry().instances[ENV.instanceId]
    payload.instance = {
      id: ENV.instanceId,
      name: record?.name || ENV.instanceName || ENV.instanceId,
      iconUrl: record?.iconPath ? `${ROUTE}/icon?id=${encodeURIComponent(ENV.instanceId)}&v=${iconVersion(record)}` : '',
    }
  }
  return payload
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(Error('请求体过大'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(Error('请求体不是有效 JSON'), { statusCode: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function requireInstanceRecord(id) {
  const registry = readRegistry()
  const record = registry.instances && id ? registry.instances[id] : null
  if (!record) throw Error(`分身不存在：${id}`)
  return record
}

function pluginDescriptor(record, entry) {
  const source = entry.official ? 'experimental' : (BUILTIN_BUNDLES.has(entry.name) ? 'builtin' : 'community')
  return {
    id: `${record.id}:${entry.name}`,
    instanceId: record.id,
    instanceName: record.name,
    name: entry.name,
    title: entry.title || entry.name,
    description: entry.description || '',
    version: entry.version || '',
    source,
    enabled: Boolean(entry.enabled),
    removable: !entry.official && entry.name !== PLUGIN_PACKAGE,
    experimental: Boolean(entry.official),
    icon: entry.icon || null,
    tags: entry.official ? ['experimental'] : [],
  }
}

function pluginCatalog(record) {
  const installed = instancePluginEntries(record)
  const names = new Set(installed.map((entry) => entry.name))
  const rows = []
  for (const entry of experimentalLibrary(record)) {
    if (!names.has(entry.name)) rows.push(pluginDescriptor(record, { ...entry, enabled: false, official: true }))
  }
  for (const entry of scanDesktopLibrary()) {
    if (!names.has(entry.name)) rows.push(pluginDescriptor(record, { ...entry, enabled: false, official: false }))
  }
  return rows
}

// Public service for other plugins: instance discovery plus the plugin catalog
// and plugin mutations. The matching HTTP routes stay available for the client.
function createInstanceManagerService() {
  return {
    listInstances() {
      const registry = readRegistry()
      return Object.values(registry.instances || {}).map((record) => instanceView(record))
    },
    getInstance(id) {
      return instanceView(requireInstanceRecord(id))
    },
    listPlugins(id) {
      const record = requireInstanceRecord(id)
      return instancePluginEntries(record).map((entry) => pluginDescriptor(record, entry))
    },
    listCatalog(id) {
      return pluginCatalog(requireInstanceRecord(id))
    },
    setPluginEnabled(id, name, enabled) {
      const record = requireInstanceRecord(id)
      return setPluginEnabled(record, name, enabled)
    },
    addPlugin(id, name) {
      const record = requireInstanceRecord(id)
      return addPluginToInstance(record, name)
    },
    removePlugin(id, name) {
      const record = requireInstanceRecord(id)
      return removePluginFromInstance(record, name)
    },
  }
}

function statePayload() {
  const registry = readRegistry()
  return {
    hello: helloPayload(),
    instances: Object.values(registry.instances)
      .map(instanceView)
      .sort((a, b) => a.order - b.order || String(a.createdAt).localeCompare(String(b.createdAt))),
    library: ENV.kind === 'desktop' ? scanDesktopLibrary() : undefined,
    revision: revisionDigest(),
    sessionOrigins: sessionOrigins(),
  }
}

function registerRoutes(ctx) {
  const webServer = ctx.get('webServer') || ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    console.warn('[instance-manager] webServer 不可用，无法注册 HTTP 接口')
    return () => {}
  }
  const fence = (req) => {
    try {
      const connection = ctx.get('connection')
      if (connection && typeof connection.requestRejection === 'function') {
        return connection.requestRejection(req) === undefined
      }
    } catch {
      /* ignored */
    }
    // Fail closed: without the connection service we cannot authenticate the
    // caller, and these routes can read process tokens and mutate instances.
    return false
  }
  const jsonRoute = (method, pathName, handler) => ({
    kind: 'exact',
    path: `${ROUTE}${pathName}`,
    handler: async (req, res) => {
      if (req.method !== method) return sendJson(res, 405, { ok: false, error: { message: 'method not allowed' } })
      if (!fence(req)) return sendJson(res, 403, { ok: false, error: { message: 'forbidden' } })
      try {
        const url = new URL(req.url, 'http://localhost')
        const body = method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams)
        const value = await handler({ body, query: url.searchParams, ctx })
        sendJson(res, 200, { ok: true, value })
      } catch (error) {
        const status = error && error.statusCode ? error.statusCode : 400
        sendJson(res, status, { ok: false, error: { message: error && error.message ? error.message : String(error) } })
      }
    },
  })
  const routes = []
  routes.push({
    kind: 'exact',
    path: `${ROUTE}/icon`,
    handler: (req, res) => {
      if (!fence(req)) {
        res.statusCode = 403
        res.end()
        return
      }
      try {
        const url = new URL(req.url, 'http://localhost')
        const id = url.searchParams.get('id') || ''
        const record = readRegistry().instances[id]
        if (!record || !record.iconPath) {
          res.statusCode = 404
          res.end()
          return
        }
        const root = path.resolve(instanceDir(id))
        const file = path.resolve(record.iconPath)
        const relative = path.relative(root, file)
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
          res.statusCode = 403
          res.end()
          return
        }
        let real = ''
        try {
          real = fs.realpathSync(file)
        } catch {
          res.statusCode = 404
          res.end()
          return
        }
        const realRoot = fs.realpathSync(root)
        const realRelative = path.relative(realRoot, real)
        if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
          res.statusCode = 403
          res.end()
          return
        }
        const data = fs.readFileSync(real)
        res.statusCode = 200
        res.setHeader('content-type', iconContentType(real))
        res.setHeader('cache-control', 'max-age=30')
        res.setHeader('x-content-type-options', 'nosniff')
        res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
        res.end(data)
      } catch {
        res.statusCode = 404
        res.end()
      }
    },
  })
  routes.push(jsonRoute('GET', '/state', () => statePayload()))
  // Very small liveness probe for visible-but-unfocused windows: it only
  // reports the revision so the client can lazily decide to call /sync.
  routes.push(jsonRoute('GET', '/revision', () => ({ revision: revisionDigest() })))
  // Lazy cross-process refresh: the client asks for this when the window gains
  // focus (or when the user presses the refresh button), instead of polling.
  routes.push(jsonRoute('POST', '/sync', async () => {
    const handle = workspaceSyncHandle
    if (handle && typeof handle.sync === 'function') {
      try {
        const result = await handle.sync({ replay: true })
      } catch (error) {
        console.warn('[instance-manager] 工作区同步失败：', error && error.message ? error.message : error)
      }
    }
    invalidateRevision()
    return statePayload()
  }))
  routes.push(jsonRoute('GET', '/library', ({ ctx: context }) => {
    const record = ENV.kind === 'instance' ? readRegistry().instances[ENV.instanceId] : null
    const bundles = record ? instanceBundles(record) : []
    return { entries: scanDesktopLibrary(), installed: bundles }
  }))
  routes.push(jsonRoute('GET', '/log', ({ query }) => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可查看分身日志')
    const id = query.get('id') || ''
    const lines = Number(query.get('lines') || 120)
    if (!readRegistry().instances[id]) throw Error('分身不存在')
    const text = readLogTail(id, Number.isFinite(lines) ? Math.min(500, Math.max(20, lines)) : 120)
    return { text: redactSecrets(text) }
  }))
  routes.push(jsonRoute('GET', '/session', ({ query }) => {
    const sessionId = query.get('sessionId') || ''
    const origin = lookupSessionOrigin(sessionId)
    return {
      sessionId,
      workspacePath: origin ? origin.workspacePath : '',
      attribution: origin,
      self: helloPayload(),
    }
  }))
  routes.push(jsonRoute('GET', '/attribution', () => ({
    schemaVersion: ATTRIBUTION_SCHEMA,
    sessions: sessionOrigins(),
    self: helloPayload(),
  })))
  routes.push(jsonRoute('POST', '/create', ({ body }) => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可创建分身')
    return createInstance(body)
  }))
  routes.push(jsonRoute('POST', '/create-cancel', async ({ body }) => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可操作分身')
    const id = String(body?.id || '')
    const provision = PROVISION.get(id)
    if (!provision) {
      const error = Error('创建已完成或不存在，无需取消')
      error.statusCode = 409
      throw error
    }
    provision.cancelled = true
    cancelProvision(id)
    const stopped = await waitForProvisionStop(id, 15000)
    if (!stopped) throw Error('创建任务仍在结束中，请稍后重试')
    const record = readRegistry().instances[id]
    cleanupInstanceFiles(id, record)
    LOG_BUFFERS.delete(id)
    if (record) {
      const registry = readRegistry()
      delete registry.instances[id]
      saveRegistry(registry)
    }
    return { id, cancelled: true }
  }))
  routes.push(jsonRoute('POST', '/start', async ({ body }) => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可启动分身')
    const id = String(body?.id || '')
    return startInstance(ctx, id)
  }))
  routes.push(jsonRoute('POST', '/stop', ({ body }) => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可停止分身')
    return stopInstance(String(body?.id || ''))
  }))
  routes.push(jsonRoute('POST', '/open-shell', ({ body }) => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可打开桌面窗口')
    return openInstanceShell(String(body?.id || ''))
  }))
  routes.push(jsonRoute('POST', '/close-shell', ({ body }) => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可关闭桌面窗口')
    const id = String(body?.id || '')
    return { id, closed: closeInstanceShell(id) }
  }))
  routes.push(jsonRoute('POST', '/prepare-shell-runtime', async () => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可准备桌面运行库')
    return ensureShellRuntime(HOME, (line) => console.log(line))
  }))
  routes.push(jsonRoute('POST', '/delete', ({ body }) => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可删除分身')
    return deleteInstance(String(body?.id || ''), body?.confirmName)
  }))
  routes.push(jsonRoute('POST', '/update', ({ body }) => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可修改分身')
    return updateInstanceSettings(String(body?.id || ''), body?.patch || {})
  }))
  routes.push(jsonRoute('POST', '/rebuild', async ({ body }) => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可重建内核')
    return rebuildKernel(String(body?.id || ''))
  }))
  routes.push(jsonRoute('POST', '/migrate', async ({ body }) => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可迁移分身')
    await migrateInstance(String(body?.id || ''), body?.storageDir)
    const record = readRegistry().instances[String(body?.id || '')]
    return record ? instanceView(record) : null
  }))
  routes.push(jsonRoute('POST', '/reorder', ({ body }) => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可操作分身')
    const ids = Array.isArray(body?.ids) ? body.ids.map((value) => String(value)) : []
    if (new Set(ids).size !== ids.length) throw Error('排序中包含重复分身')
    const registry = readRegistry()
    const valid = ids.filter((id) => registry.instances[id])
    if (valid.length !== ids.length) throw Error('排序中包含未知分身')
    valid.forEach((id, index) => {
      registry.instances[id] = { ...registry.instances[id], order: index }
    })
    saveRegistry(registry)
    return { ids: valid }
  }))
  routes.push(jsonRoute('GET', '/instance-plugins', ({ query }) => {
    const id = query.get('id') || ''
    const record = readRegistry().instances[id]
    if (!record) throw Error('分身不存在')
    return {
      instanceId: id,
      entries: instancePluginEntries(record),
      library: scanDesktopLibrary(),
      experimental: experimentalLibrary(record),
    }
  }))

  routes.push(jsonRoute('GET', '/icon-keywords', () => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可读取图标提示词')
    return { groups: iconKeywordGroups() }
  }))
  routes.push(jsonRoute('POST', '/build-icon-prompt', ({ body }) => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可生成图标提示词')
    const record = readRegistry().instances[String(body?.id || '')]
    if (!record) throw Error('分身不存在')
    const keywords = Array.isArray(body?.keywords) ? body.keywords.map((item) => String(item)) : []
    return { text: buildIconPrompt(record, keywords) }
  }))
  routes.push(jsonRoute('GET', '/icon-prompt', () => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可读取图标提示词')
    return { text: iconPromptText(), file: ICON_PROMPT_FILE }
  }))
  routes.push(jsonRoute('POST', '/generate-icon', async ({ body, ctx: context }) => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可生成图标')
    const id = String(body?.id || '')
    const record = readRegistry().instances[id]
    if (!record) throw Error('分身不存在')
    const running = iconJob(id)
    if (running && running.state === 'running') throw Error('图标生成中，请稍后再试')
    const prompt = String(body?.prompt || '').trim() || iconPromptText()
    const job = startIconGeneration(context, id, prompt)
    return { started: true, job, instance: instanceView(readRegistry().instances[id]) }
  }))
  routes.push(jsonRoute('POST', '/restart', async ({ body }) => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可重启分身')
    const id = String(body?.id || '')
    const record = readRegistry().instances[id]
    if (!record) throw Error('分身不存在')
    if (record.status !== 'running') throw Error('分身未在运行，无法重启')
    await stopInstance(id)
    return startInstance(ctx, id)
  }))
  routes.push(jsonRoute('POST', '/set-plugin-enabled', ({ body }) => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可操作分身')
    const record = readRegistry().instances[String(body?.id || '')]
    if (!record) throw Error('分身不存在')
    return setPluginEnabled(record, String(body?.name || ''), body?.enabled === true)
  }))
  routes.push(jsonRoute('POST', '/add-plugin', ({ body }) => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可添加插件')
    const record = readRegistry().instances[String(body?.id || '')]
    if (!record) throw Error('分身不存在')
    return addPluginToInstance(record, String(body?.name || ''))
  }))
  routes.push(jsonRoute('POST', '/remove-plugin', ({ body }) => {
    if (ENV.kind !== 'desktop') throw Error('仅桌面端可移除插件')
    const record = readRegistry().instances[String(body?.id || '')]
    if (!record) throw Error('分身不存在')
    return removePluginFromInstance(record, String(body?.name || ''))
  }))
  const disposers = routes.map((route) => {
    const dispose = webServer.register(route)
    return typeof dispose === 'function' ? dispose : () => {}
  })
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* ignored */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// plugin apply
// ---------------------------------------------------------------------------

export function apply(ctx) {
  try {
    fs.mkdirSync(INSTANCES_ROOT, { recursive: true })
  } catch {
    /* ignored */
  }
  if (ENV.kind === 'desktop') {
    cleanupStale()
    try {
      for (const id of Object.keys(readRegistry().instances)) scrubLogFile(id)
    } catch {
      /* ignored */
    }
    signalChanged = (action, instanceId) => {
      try {
        ctx.emit('instance-manager/changed', {
          action: String(action || 'changed'),
          instanceId: instanceId || null,
          at: new Date().toISOString(),
        })
      } catch (error) {
        console.warn('[instance-manager] changed 事件发送失败：', error && error.message ? error.message : error)
      }
    }
    // Public service for other plugins (plugin managers, dashboards, ...).
    if (typeof ctx.provide === 'function') {
      ctx.effect(() => ctx.provide('instanceManager', createInstanceManagerService()), 'instance-manager: public service')
    }
    // Persist the desktop profile location so instances can find the library.
    try {
      writeJson(path.join(INSTANCES_ROOT, 'desktop.json'), {
        profileDir: ENV.profileDir,
        kernelSource: ENV.kernelSource,
        runtimeDir: ENV.runtimeDir,
        updatedAt: new Date().toISOString(),
      })
    } catch {
      /* ignored */
    }
    ctx.effect(() => {
      const onExit = () => stopAll()
      const onSignal = () => {
        stopAll()
      }
      process.on('exit', onExit)
      process.once('SIGTERM', onSignal)
      process.once('SIGINT', onSignal)
      return () => {
        process.off('exit', onExit)
        process.off('SIGTERM', onSignal)
        process.off('SIGINT', onSignal)
      }
    }, 'instance-manager: stop instances when the desktop exits')
  }
  if (ENV.kind === 'instance') {
    const info = { instanceId: ENV.instanceId, instanceName: ENV.instanceName || ENV.instanceId }
    ctx.effect(() => {
      try {
        return installSessionAttribution(ctx, info)
      } catch (error) {
        console.warn('[instance-manager] 会话归属不可用：', error && error.message ? error.message : error)
        return () => {}
      }
    }, 'instance-manager: session attribution')
  }
  if (ENV.kind === 'desktop') {
    // A turn executed on the desktop makes the desktop the most recent executor;
    // writing it as a pseudo-instance drops any stale instance badge through the
    // merged reader (sessionOrigins skips ids without a registry record).
    const info = { instanceId: '__desktop__', instanceName: '主端' }
    ctx.effect(() => {
      try {
        return installSessionAttribution(ctx, info)
      } catch (error) {
        console.warn('[instance-manager] 会话归属不可用：', error && error.message ? error.message : error)
        return () => {}
      }
    }, 'instance-manager: desktop session attribution')
  }
  // Both kinds of hosts share the same DSH home: mirror workspace writes made by
  // the other processes so a workspace created in an instance shows up on the
  // desktop (and in every other instance) without a restart. Nothing is polled:
  // the handle is exposed to `/sync` and the clients call it on focus.
  ctx.effect(() => {
    let handle = null
    try {
      handle = installWorkspaceSync(ctx, { home: HOME })
      workspaceSyncHandle = handle
    } catch (error) {
      console.warn('[instance-manager] 工作区同步不可用：', error && error.message ? error.message : error)
    }
    return () => {
      workspaceSyncHandle = null
      if (handle && typeof handle.dispose === 'function') handle.dispose()
    }
  }, 'instance-manager: cross-process workspace sync')
  ctx.effect(() => registerRoutes(ctx), 'instance-manager: HTTP routes')
  console.log(`[instance-manager] host ready (${ENV.kind}${ENV.kind === 'instance' ? `: ${ENV.instanceId}` : ''})`)
}
