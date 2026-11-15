#!/usr/bin/env node
/**
 * Packaging guard: every runtime file the plugin imports or reads must be listed
 * in package.json "files", otherwise `npm pack` / tarball / marketplace installs
 * silently miss it while a local link install keeps working.
 *
 * Wired to npm "prepack"; can also be run manually:
 *   node scripts/verify-pack-files.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const pkg = JSON.parse(read('package.json'))
const files = Array.isArray(pkg.files) ? pkg.files : []
if (!files.length) {
  console.error('[verify-pack-files] package.json has no "files" list; the whole repo would be packed')
  process.exit(1)
}

const isCovered = (rel) => files.some((entry) => {
  const normalized = entry.replace(/\\/g, '/').replace(/\/$/, '')
  return rel === normalized || rel.startsWith(normalized + '/')
})
// npm always includes these at the tarball root, regardless of "files".
const npmAlwaysIncluded = new Set(['package.json', 'README.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt'])

const required = new Set([
  'README.md',
  'package.json',
  'cordis.patch.yml',
  'client.js',
  'icon-prompt.md',
  'assets/icon.svg',
  'locale/en.json',
  'locale/zh.json',
  'host/index.js',
  'host/shell.js',
  'host/workspace-sync.js',
  'shell/main.cjs',
  'shell/preload.cjs',
  'shell/package.json',
  'docs/plugin-surface-v1.md',
])

// Runtime files imported by the host entry: catch a forgotten ./xxx.js early.
const hostEntry = read('host/index.js')
for (const match of hostEntry.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)) {
  required.add('host/' + match[1])
}

const missing = []
for (const rel of required) {
  if (!fs.existsSync(path.join(root, rel))) missing.push(`${rel} (file does not exist)`)
  else if (!npmAlwaysIncluded.has(rel) && !isCovered(rel)) missing.push(`${rel} (missing from package.json "files")`)
}

if (missing.length) {
  console.error('[verify-pack-files] packaged plugin would be incomplete:')
  for (const line of missing) console.error('  - ' + line)
  process.exit(1)
}
if (process.argv.includes('--verbose')) {
  console.log(`[verify-pack-files] ok: ${required.size} runtime files are covered by "files"`)
}
