// install.mjs — npm run install：把 weixin-bot 安装成 DSH 插件
//
// 做三件事：
//   1. 把本项目的 src/ + 插件清单 + version.json 复制到 DSH 源码的
//      packages/weixin-bot/（版本号文件防重复安装：同版本跳过，--force 可强制）
//   2. 在 $DSH_HOME/cordis.patch.yml（官方用户级挂载层）追加 weixin-bot 行
//   3. 在 DSH 源码根执行 pnpm install，让 pnpm workspace 链接新包
//
// 之后重启 dsh（Ctrl+C 后重新 pnpm dsh web）即生效。
//
// DSH 源码位置自动探测（可用环境变量 DSH_ROOT 显式指定）：
//   1) D:\Program Files\dsh（本机正在运行的实例）
//   2) 本文件夹内的 dsh\ 拷贝（如你在那边跑 dsh）
// DSH_HOME 默认 ~/.dsh

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectDir = __dirname
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const FORCE = process.argv.includes('--force')

/** 探测 DSH 源码根：env 显式指定 > 正在运行的实例目录 > 项目内拷贝 */
function detectDshRoot() {
  if (process.env.DSH_ROOT) return path.resolve(process.env.DSH_ROOT)
  const candidates = [
    'D:\\Program Files\\dsh',
    path.join(projectDir, 'dsh'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json')) && fs.existsSync(path.join(candidate, 'pnpm-workspace.yaml'))) {
      return candidate
    }
  }
  return candidates[0]
}

function fail(message) {
  console.error(`[install] 失败：${message}`)
  process.exit(1)
}

const DSH_ROOT = detectDshRoot()

// ── 1. 版本检测 ──

let version
try {
  version = JSON.parse(fs.readFileSync(path.join(projectDir, 'version.json'), 'utf8')).version
} catch {
  fail('项目根缺少 version.json')
}
console.log(`[install] weixin-bot v${version}，目标 DSH 源码：${DSH_ROOT}`)

if (!fs.existsSync(DSH_ROOT)) {
  fail(`找不到 DSH 源码目录 ${DSH_ROOT}，请设置环境变量 DSH_ROOT 指向你的 DSH 源码根`)
}

// DSH's workspace pattern is packages/*/*, so the plugin needs two directory levels.
const legacyTargetDir = path.join(DSH_ROOT, 'packages', 'weixin-bot')
const targetDir = path.join(legacyTargetDir, 'weixin-bot')
const targetVersionFile = path.join(targetDir, 'version.json')
let targetVersion = null
try {
  targetVersion = JSON.parse(fs.readFileSync(targetVersionFile, 'utf8')).version
} catch { /* 未安装过 */ }

if (targetVersion === version && !FORCE) {
  console.log(`[install] 已安装同版本 v${version}，跳过复制（--force 可强制重装）`)
  process.exit(0)
}
if (targetVersion !== null) console.log(`[install] 检测到旧版本 v${targetVersion}，升级到 v${version}…`)

// ── 2. 复制插件到 DSH packages/ ──

// Migrate the earlier single-level installation, which pnpm did not recognize as a workspace package.
if (fs.existsSync(path.join(legacyTargetDir, 'package.json'))) {
  fs.rmSync(legacyTargetDir, { recursive: true, force: true })
}
fs.rmSync(targetDir, { recursive: true, force: true })
fs.mkdirSync(targetDir, { recursive: true })
fs.cpSync(path.join(projectDir, 'src'), path.join(targetDir, 'src'), { recursive: true })

// 插件清单：用 src/plugin/package.json 模板，版本号与 version.json 对齐
const pluginManifest = JSON.parse(
  fs.readFileSync(path.join(projectDir, 'src', 'plugin', 'package.json'), 'utf8'),
)
pluginManifest.version = version
fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify(pluginManifest, null, 2) + '\n')
fs.copyFileSync(path.join(projectDir, 'version.json'), targetVersionFile)

// DSH resolves plugins using the profile directory as the module anchor.
// Register this in-box workspace package in the profile fallback so it is
// resolvable from every profile (for example ~/.dsh/profiles/web).
const profilePackageLink = path.join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-weixin-bot')
fs.mkdirSync(path.dirname(profilePackageLink), { recursive: true })
let keepProfileLink = false
try {
  const stat = fs.lstatSync(profilePackageLink)
  if (!stat.isSymbolicLink()) {
    fail(`Plugin resolution path is occupied by a non-link directory: ${profilePackageLink}`)
  }
  keepProfileLink = fs.realpathSync(profilePackageLink) === fs.realpathSync(targetDir)
  if (!keepProfileLink) fs.unlinkSync(profilePackageLink)
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
if (!keepProfileLink) fs.symlinkSync(targetDir, profilePackageLink, 'junction')
console.log(`[install] Linked plugin into DSH profile module fallback: ${profilePackageLink}`)
console.log(`[install] 已复制插件到 ${targetDir}`)

// ── 3. $DSH_HOME/cordis.patch.yml 挂载行 ──

const patchFile = path.join(DSH_HOME, 'cordis.patch.yml')
const patchBlock = [
  '',
  '# ── weixin-bot 插件（由 npm run install 自动管理，勿手改）──',
  '- insert:',
  '    - id: weixin-bot',
  "      name: '@deepseek-ai/dsh-weixin-bot'",
  '      config:',
  `        sessionDir: '${path.join(projectDir, 'session').replace(/\\/g, '/')}'`,
  `        sessionCwd: '${projectDir.replace(/\\/g, '/')}'`,
  "        workspaceTitle: '微信会话'",
  "        preset: 'weixin'",
  '',
].join('\n')

let patchText = ''
try {
  patchText = fs.readFileSync(patchFile, 'utf8')
} catch { /* 首次创建 */ }

if (patchText.includes('id: weixin-bot')) {
  console.log('[install] $DSH_HOME/cordis.patch.yml 已有 weixin-bot 行，跳过')
} else {
  fs.mkdirSync(DSH_HOME, { recursive: true })
  fs.appendFileSync(patchFile, patchBlock, 'utf8')
  console.log(`[install] 已在 ${patchFile} 追加挂载行`)
}

// ── 4. pnpm install 链接 workspace ──

console.log('[install] 在 DSH 源码根执行 pnpm install（链接新包）…')
const result = spawnSync('pnpm', ['install'], { cwd: DSH_ROOT, stdio: 'inherit', shell: true })
if (result.status !== 0) {
  console.warn('[install] pnpm install 未成功，请手动在 DSH 源码根执行 pnpm install')
} else {
  console.log('[install] pnpm install 完成 ✓')
}

console.log('')
console.log('┌────────────────────────────────────────────────────┐')
console.log('│  安装完成！                                        │')
console.log(`│  插件版本：v${version}                               │`)
console.log('│  生效方式：重启 DSH（Ctrl+C 后重新 pnpm dsh web）  │')
console.log('│  卸载方式：删除 packages/weixin-bot 与 patch 行     │')
console.log('└────────────────────────────────────────────────────┘')
