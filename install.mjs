// Convenience wrapper around the official DSH bundle installer.
//
// It intentionally does not copy files into the DSH checkout and does not edit
// cordis.patch.yml itself. `dsh plugin` owns profile dependencies, lockfiles,
// and bundle ordering; this script only supplies the right CLI arguments.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const projectDir = path.dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'))
const profile = process.env.DSH_PROFILE || 'web'
const uninstall = process.argv.includes('--uninstall')
const dshRoot = process.env.DSH_ROOT || 'D:\\Program Files\\dsh'
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const sourceCheckout = fs.existsSync(path.join(dshRoot, 'package.json'))
  && fs.existsSync(path.join(dshRoot, 'pnpm-workspace.yaml'))

function fail(message) {
  console.error(`[dsh-weixin] ${message}`)
  process.exit(1)
}

if (!packageJson.dsh?.bundle?.patch || !fs.existsSync(path.join(projectDir, 'cordis.patch.yml'))) {
  fail('当前目录不是完整的 DSH bundle：缺少 package.json 的 dsh.bundle.patch 或 cordis.patch.yml')
}

const cli = process.env.DSH_CLI || (sourceCheckout ? 'pnpm' : 'dsh')
let packageSpec = projectDir
let stableBundle
// `dsh plugin` forwards to pnpm through a Windows shell. A direct absolute
// path containing spaces is split by that shell before pnpm sees it. A stable
// no-space cache under DSH_HOME keeps the official command usable from
// Chinese/spaceful checkout paths and lets pnpm install dependencies normally.
if (!uninstall && process.platform === 'win32' && /\s/.test(projectDir)) {
  stableBundle = path.join(dshHome, 'bundles', 'dsh-weixin')
  fs.mkdirSync(path.dirname(stableBundle), { recursive: true })
  try {
    const stat = fs.lstatSync(stableBundle)
    if (stat.isSymbolicLink()) fs.unlinkSync(stableBundle)
    else {
      const existing = JSON.parse(fs.readFileSync(path.join(stableBundle, 'package.json'), 'utf8'))
      const compatibleNames = new Set([packageJson.name, 'dsh-weixin'])
      if (!compatibleNames.has(existing.name)) fail(`Windows 兼容缓存目录已被其他包占用：${stableBundle}`)
      fs.rmSync(stableBundle, { recursive: true, force: true })
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof SyntaxError) fail(`Windows 兼容缓存目录不是 dsh-weixin：${stableBundle}`)
      throw error
    }
  }
  fs.cpSync(projectDir, stableBundle, {
    recursive: true,
    filter: (source) => !['node_modules', '.git', 'session', 'state'].includes(path.basename(source)),
  })
  // `file:` makes pnpm install this bundle and its declared dependencies in
  // the profile. A plain `link:` would resolve dependencies from the external
  // checkout, which is not valid for a user who has not run npm install here.
  packageSpec = `file:${stableBundle}`
}
const args = sourceCheckout
  ? ['dsh', 'plugin', '--profile', profile, uninstall ? 'remove' : 'add', uninstall ? packageJson.name : packageSpec]
  : ['plugin', '--profile', profile, uninstall ? 'remove' : 'add', uninstall ? packageJson.name : packageSpec]

console.log(`[dsh-weixin] ${uninstall ? '卸载' : '安装'} bundle ${packageJson.name} 到 profile “${profile}”`)
if (sourceCheckout) console.log(`[dsh-weixin] 使用源码版 DSH：${dshRoot}`)
else console.log('[dsh-weixin] 使用 PATH 中的 dsh CLI；如需指定源码 checkout，请设置 DSH_ROOT')

const result = spawnSync(cli, args, {
  cwd: sourceCheckout ? dshRoot : projectDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (result?.error) fail(`无法执行 ${cli}：${result.error.message}`)
if (result?.status !== 0) fail(`DSH CLI 退出码为 ${result?.status}`)

console.log(`[dsh-weixin] ${uninstall ? '卸载' : '安装'}完成。启动时使用：${sourceCheckout ? 'pnpm dsh' : 'dsh'} --profile ${profile}`)
