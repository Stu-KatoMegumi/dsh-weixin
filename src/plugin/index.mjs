import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { installTimestampLogging } from '../core/log.mjs'
import { WeChatClient } from '../core/wechat.mjs'
import { Store } from '../core/store.mjs'
import { Engine, modelConfig } from '../core/engine.mjs'
import { InprocTransport } from '../dsh/inproc.mjs'
import { registerControlApi } from './control.mjs'
import { defaultPromptDir, editablePromptDir } from '../core/prompt.mjs'

installTimestampLogging()

const dirname = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.resolve(dirname, '../..')
let pluginVersion = '1.0.1'
try { pluginVersion = JSON.parse(fs.readFileSync(path.join(projectDir, 'version.json'), 'utf8')).version } catch { /* default */ }

export const name = 'dsh-weixin'
export const inject = ['apiProxy', 'webServer']

const jobSchema = z.object({
  id: z.string().default(''),
  cron: z.string().default('0 9 * * *'),
  userId: z.string().default(''),
  prompt: z.string().default(''),
  enabled: z.boolean().default(true),
})

export const Config = z.object({
  enabled: z.boolean().default(true),
  sessionDir: z.string().default(''),
  sessionCwd: z.string().default(''),
  workspaceTitle: z.string().default('微信会话'),
  preset: z.string().default('standard'),
  accessPolicy: z.union(['pairing', 'allowlist', 'disabled']).default('pairing'),
  allowlist: z.array(z.string()).default([]),
  admins: z.array(z.string()).default([]),
  streaming: z.boolean().default(true),
  typing: z.boolean().default(true),
  mediaEnabled: z.boolean().default(true),
  renewalEnabled: z.boolean().default(true),
  slowAckMs: z.number().default(4000),
  turnTimeoutMs: z.number().default(15 * 60 * 1000),
  streamFlushChars: z.number().default(1500),
  streamFlushMs: z.number().default(3000),
  chunkSize: z.number().default(1800),
  pollTimeoutMs: z.number().default(5000),
  watchdogMs: z.number().default(90_000),
  renewAfterMs: z.number().default(24 * 60 * 60 * 1000),
  renewWarnBeforeMs: z.number().default(2 * 60 * 60 * 1000),
  outboxDir: z.string().default(''),
  jobs: z.array(jobSchema).default([]),
})

export function apply(ctx, config = {}) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const sessionCwd = path.resolve(config.sessionCwd || process.env.WX_BOT_CWD || process.cwd())
  const sessionDir = path.resolve(
    config.sessionDir || process.env.WX_BOT_SESSION_DIR || path.join(dshHome, 'channels', 'dsh-weixin'),
  )
  const preset = config.preset || process.env.WX_BOT_PRESET || 'standard'
  const engineConfig = {
    ...config,
    sessionCwd,
    outboxDir: path.resolve(config.outboxDir || path.join(sessionCwd, 'outbox')),
    slowAckMs: config.slowAckMs ?? Number(process.env.WX_BOT_SLOW_ACK_MS || 4000),
    turnTimeoutMs: config.turnTimeoutMs ?? Number(process.env.WX_BOT_TURN_TIMEOUT_MS || 15 * 60 * 1000),
    ...modelConfig(),
  }
  const store = new Store(sessionDir)
  const wechat = new WeChatClient({
    stateFile: store.botFile,
    mediaDir: path.join(sessionDir, 'media'),
    chunkSize: config.chunkSize ?? 1800,
    pollTimeoutMs: config.pollTimeoutMs ?? 5000,
    watchdogMs: config.watchdogMs ?? 90_000,
    renewAfterMs: config.renewAfterMs ?? 24 * 60 * 60 * 1000,
    renewWarnBeforeMs: config.renewWarnBeforeMs ?? 2 * 60 * 60 * 1000,
    version: pluginVersion,
  })
  const transport = new InprocTransport(ctx.apiProxy, {
    preset,
    sessionCwd,
    workspaceTitle: config.workspaceTitle || '微信会话',
    timeoutMs: engineConfig.turnTimeoutMs,
    slowMs: engineConfig.slowAckMs,
  })
  const engine = new Engine({
    wechat,
    store,
    transport,
    config: engineConfig,
    promptDir: editablePromptDir(sessionDir),
    defaultPromptDir: defaultPromptDir(projectDir),
  })

  console.log(`[dsh-weixin] v${pluginVersion} 加载：sessionDir=${sessionDir} preset=${preset}`)
  ctx.effect(() => {
    engine.start()
    return () => engine.stop()
  }, 'dsh-weixin: runtime')
  ctx.effect(() => registerControlApi(ctx.webServer, engine, wechat), 'dsh-weixin: settings api')
}
