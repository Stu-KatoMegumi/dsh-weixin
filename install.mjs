// Install or uninstall dsh-weixin as a DSH workspace plugin.
// The installer is deliberately fail-closed: it never registers a plugin
// unless every file imported by the plugin entry point exists in this project.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectDir = __dirname
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const FORCE = process.argv.includes('--force')
const UNINSTALL = process.argv.includes('--uninstall')

const PLUGIN = {
  id: 'dsh-weixin',
  packageName: '@deepseek-ai/dsh-weixin',
  packageDir: 'dsh-weixin',
}

// Versions released before the rename registered this broken package. Keep
// these identifiers only for migration and cleanup; never install them again.
const LEGACY_PLUGIN = {
  id: 'weixin-bot',
  packageName: '@deepseek-ai/dsh-weixin-bot',
  packageDir: 'weixin-bot',
}

const REQUIRED_PLUGIN_FILES = [
  'src/plugin/index.mjs',
  'src/dsh/transport.mjs',
  'src/dsh/inproc.mjs',
]

function detectDshRoot() {
  if (process.env.DSH_ROOT) return path.resolve(process.env.DSH_ROOT)
  const candidates = ['D:\\Program Files\\dsh', path.join(projectDir, 'dsh')]
  return candidates.find(candidate => (
    fs.existsSync(path.join(candidate, 'package.json'))
    && fs.existsSync(path.join(candidate, 'pnpm-workspace.yaml'))
  )) || candidates[0]
}

function fail(message) {
  console.error(`[dsh-weixin] 安装失败：${message}`)
  process.exit(1)
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function installationDir(dshRoot, plugin) {
  // DSH workspaces are discovered with packages/*/*.
  return path.join(dshRoot, 'packages', plugin.packageDir, plugin.packageDir)
}

function packageRoot(dshRoot, plugin) {
  return path.join(dshRoot, 'packages', plugin.packageDir)
}

function profilePackageLink(plugin) {
  return path.join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', plugin.packageName.slice('@deepseek-ai/'.length))
}

function isOwnedPackage(dir, plugin) {
  return readJson(path.join(dir, 'package.json'))?.name === plugin.packageName
}

function removePackage(dshRoot, plugin) {
  const root = packageRoot(dshRoot, plugin)
  if (!fs.existsSync(root)) return false

  // Do not delete a similarly named directory that is not our package.
  if (!isOwnedPackage(root, plugin) && !isOwnedPackage(installationDir(dshRoot, plugin), plugin)) {
    console.warn(`[dsh-weixin] 跳过未识别的目录：${root}`)
    return false
  }
  fs.rmSync(root, { recursive: true, force: true })
  return true
}

function removeProfileLink(plugin) {
  const link = profilePackageLink(plugin)
  try {
    const stat = fs.lstatSync(link)
    if (!stat.isSymbolicLink()) {
      console.warn(`[dsh-weixin] 保留非链接的模块目录：${link}`)
      return false
    }
    let linkedDir
    try {
      linkedDir = fs.realpathSync(link)
    } catch (error) {
      // A dangling link at this exact package path belongs to a previous
      // interrupted install and must not survive an uninstall/migration.
      if (error?.code === 'ENOENT') {
        fs.unlinkSync(link)
        return true
      }
      throw error
    }
    if (!isOwnedPackage(linkedDir, plugin)) {
      console.warn(`[dsh-weixin] 保留指向未知包的链接：${link}`)
      return false
    }
    fs.unlinkSync(link)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function blockContainsPlugin(block, plugins) {
  return plugins.some((plugin) => {
    const id = escapeRegExp(plugin.id)
    const packageName = escapeRegExp(plugin.packageName)
    return block.some(line => (
      new RegExp(`^\\s*-\\s+id:\\s*['\"]?${id}['\"]?\\s*$`).test(line)
      || new RegExp(`^\\s+name:\\s*['\"]?${packageName}['\"]?\\s*$`).test(line)
    ))
  })
}

function removePatchEntries(patchFile, plugins) {
  let text
  try { text = fs.readFileSync(patchFile, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }

  const lines = text.split(/\r?\n/)
  const kept = []
  let removed = 0
  for (let index = 0; index < lines.length;) {
    if (!/^-\s+insert:\s*$/.test(lines[index])) {
      kept.push(lines[index++])
      continue
    }
    let end = index + 1
    while (end < lines.length && !/^-\s+/.test(lines[end])) end++
    const block = lines.slice(index, end)
    if (blockContainsPlugin(block, plugins)) {
      removed++
    } else {
      kept.push(...block)
    }
    index = end
  }

  // A comment-only or empty patch file parses as null, not as the array DSH
  // requires. Keep an explicit empty array after removing the last entry.
  const hasTopLevelEntry = kept.some(line => /^-\s+/.test(line))
  if (removed > 0 || !hasTopLevelEntry) {
    fs.writeFileSync(patchFile, hasTopLevelEntry ? kept.join('\n') : '[]\n', 'utf8')
  }
  return removed
}

function removeInstallations(dshRoot, plugins) {
  const patchFile = path.join(DSH_HOME, 'cordis.patch.yml')
  const links = plugins.filter(plugin => removeProfileLink(plugin)).length
  const packages = plugins.filter(plugin => removePackage(dshRoot, plugin)).length
  const patches = removePatchEntries(patchFile, plugins)
  return { packages, links, patches }
}

function verifySource() {
  const missing = REQUIRED_PLUGIN_FILES.filter(file => !fs.existsSync(path.join(projectDir, file)))
  if (missing.length === 0) return
  fail(`源码不完整，缺少 ${missing.join('、')}。已拒绝注册插件，以免 DSH 无法启动。`)
}

function readVersion() {
  const version = readJson(path.join(projectDir, 'version.json'))?.version
  if (typeof version !== 'string' || version.length === 0) fail('项目根目录缺少有效的 version.json')
  return version
}

function ensureProfileLink(targetDir) {
  const link = profilePackageLink(PLUGIN)
  fs.mkdirSync(path.dirname(link), { recursive: true })
  try {
    const stat = fs.lstatSync(link)
    if (!stat.isSymbolicLink()) fail(`插件解析路径被非链接目录占用：${link}`)
    if (fs.realpathSync(link) === fs.realpathSync(targetDir)) return
    fs.unlinkSync(link)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  fs.symlinkSync(targetDir, link, 'junction')
}

function addPatchEntry() {
  const patchFile = path.join(DSH_HOME, 'cordis.patch.yml')
  let patchText = ''
  try { patchText = fs.readFileSync(patchFile, 'utf8') } catch { /* first install */ }
  if (patchText.trim() === '[]') patchText = ''
  if (blockContainsPlugin(patchText.split(/\r?\n/), [PLUGIN])) return false

  const patchBlock = [
    '',
    '# ── dsh-weixin 插件（由 npm run install 自动管理）──',
    '- insert:',
    `    - id: ${PLUGIN.id}`,
    `      name: '${PLUGIN.packageName}'`,
    '      config:',
    `        sessionDir: '${path.join(projectDir, 'session').replace(/\\/g, '/')}'`,
    `        sessionCwd: '${projectDir.replace(/\\/g, '/')}'`,
    "        workspaceTitle: '微信会话'",
    "        preset: 'weixin'",
    '',
  ].join('\n')
  fs.mkdirSync(DSH_HOME, { recursive: true })
  fs.writeFileSync(patchFile, patchText + patchBlock, 'utf8')
  return true
}

const DSH_ROOT = detectDshRoot()
if (!fs.existsSync(DSH_ROOT)) fail(`找不到 DSH 源码目录：${DSH_ROOT}。请设置 DSH_ROOT。`)

if (UNINSTALL) {
  const removed = removeInstallations(DSH_ROOT, [PLUGIN, LEGACY_PLUGIN])
  console.log(`[dsh-weixin] 卸载完成：删除 ${removed.packages} 个包目录、${removed.links} 个 profile 链接、${removed.patches} 个挂载配置。`)
  console.log('[dsh-weixin] 请重启 DSH：pnpm dsh web')
  process.exit(0)
}

// A previous release used weixin-bot and could make DSH fail at boot. Remove
// that registration before checking the new source, so even a failed install
// leaves the existing DSH installation bootable.
const migrated = removeInstallations(DSH_ROOT, [LEGACY_PLUGIN])
if (migrated.packages + migrated.links + migrated.patches > 0) {
  console.log(`[dsh-weixin] 已清理旧 weixin-bot 安装：${migrated.packages} 个包、${migrated.links} 个链接、${migrated.patches} 条配置。`)
}

verifySource()
const version = readVersion()
const targetDir = installationDir(DSH_ROOT, PLUGIN)
const currentVersion = readJson(path.join(targetDir, 'version.json'))?.version
const targetIsComplete = REQUIRED_PLUGIN_FILES.every(file => fs.existsSync(path.join(targetDir, file)))
const targetManifest = readJson(path.join(targetDir, 'package.json'))
const shouldCopy = FORCE || currentVersion !== version || !targetIsComplete || targetManifest?.name !== PLUGIN.packageName

if (shouldCopy) {
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.mkdirSync(targetDir, { recursive: true })
  fs.cpSync(path.join(projectDir, 'src'), path.join(targetDir, 'src'), { recursive: true })
  const manifest = readJson(path.join(projectDir, 'src', 'plugin', 'package.json'))
  if (manifest === null) fail('缺少插件清单 src/plugin/package.json')
  manifest.version = version
  fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  fs.copyFileSync(path.join(projectDir, 'version.json'), path.join(targetDir, 'version.json'))
  console.log(`[dsh-weixin] 已复制插件 v${version} 到 ${targetDir}`)
} else {
  console.log(`[dsh-weixin] 插件 v${version} 已完整安装，检查注册链接。`)
}

ensureProfileLink(targetDir)
console.log(`[dsh-weixin] 已注册 profile 模块链接：${profilePackageLink(PLUGIN)}`)
if (addPatchEntry()) console.log(`[dsh-weixin] 已写入挂载配置：${path.join(DSH_HOME, 'cordis.patch.yml')}`)

console.log('[dsh-weixin] 执行 pnpm install 以刷新 DSH workspace…')
const result = spawnSync('pnpm', ['install'], { cwd: DSH_ROOT, stdio: 'inherit', shell: true })
if (result.status !== 0) fail('pnpm install 未完成；插件已复制，请先解决 DSH workspace 依赖后再重试。')

console.log(`[dsh-weixin] 安装完成 v${version}。请重启 DSH：pnpm dsh web`)
