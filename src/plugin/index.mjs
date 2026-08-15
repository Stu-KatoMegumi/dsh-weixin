// src/plugin/index.mjs — DSH 插件入口（host 平面）
//
// 安装后由 $DSH_HOME/cordis.patch.yml 的 dsh-weixin 行挂载，随 `pnpm dsh web`
// 一起加载。与独立模式共用同一套核心，只是 DSH 传输层换成进程内 apiProxy
// （不经 HTTP/WebSocket，事件直接消费 apiProxy.events.mux() 的异步迭代器）。
//
// 插件配置（cordis.patch.yml 里 dsh-weixin 行的 config）：
//   sessionDir     本地 session 目录（建议指向项目文件夹，双方对话落盘处）
//   sessionCwd     微信会话的工作目录（也是「微信会话」分组的目录）
//   workspaceTitle 分组显示名，默认「微信会话」
//   preset         agent preset，默认 weixin
//   slowAckMs / turnTimeoutMs / chunkSize / pollTimeoutMs 见 README

import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { installTimestampLogging } from '../core/log.mjs'
import { WeChatClient } from '../core/wechat.mjs'
import { Store } from '../core/store.mjs'
import { Engine, modelConfig } from '../core/engine.mjs'
import { InprocTransport } from '../dsh/inproc.mjs'

installTimestampLogging() // 所有日志带时间戳

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let PLUGIN_VERSION = '1.0.0'
try {
  PLUGIN_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'version.json'), 'utf8')).version
} catch { /* 保持默认 */ }

export const name = 'dsh-weixin'
export const inject = ['apiProxy']

export const Config = z.object({
  sessionDir: z.string().default(''),
  sessionCwd: z.string().default(''),
  workspaceTitle: z.string().default('微信会话'),
  preset: z.string().default('weixin'),
  slowAckMs: z.number().default(4000),
  turnTimeoutMs: z.number().default(15 * 60 * 1000),
  chunkSize: z.number().default(1800),
  pollTimeoutMs: z.number().default(5000),
})

export function apply(ctx, config = {}) {
  const preset = config.preset || process.env.WX_BOT_PRESET || 'weixin'
  const projectDir = path.resolve(__dirname, '../..')
  const sessionCwd = path.resolve(config.sessionCwd || process.env.WX_BOT_CWD || projectDir)
  const sessionDir = path.resolve(
    config.sessionDir || process.env.WX_BOT_SESSION_DIR || path.join(sessionCwd, 'session'),
  )
  const workspaceTitle = config.workspaceTitle || '微信会话'
  const engineConfig = {
    slowAckMs: config.slowAckMs ?? Number(process.env.WX_BOT_SLOW_ACK_MS || 4000),
    turnTimeoutMs: config.turnTimeoutMs ?? Number(process.env.WX_BOT_TURN_TIMEOUT_MS || 15 * 60 * 1000),
    chunkSize: config.chunkSize ?? Number(process.env.WX_BOT_CHUNK_SIZE || 1800),
    pollTimeoutMs: config.pollTimeoutMs ?? Number(process.env.WX_BOT_POLL_TIMEOUT_MS || 5000),
    ...modelConfig(), // 模型路由：简单→flash关思考 / 复杂→pro高思考（可环境变量覆盖）
  }

  console.log(`[dsh-weixin] 插件启动: preset=${preset} sessionDir=${sessionDir} 分组=${workspaceTitle}`)

  const wechat = new WeChatClient({
    stateFile: path.join(sessionDir, 'bot.json'),
    chunkSize: engineConfig.chunkSize,
    pollTimeoutMs: engineConfig.pollTimeoutMs,
    version: PLUGIN_VERSION,
  })
  const store = new Store(sessionDir)
  const transport = new InprocTransport(ctx.apiProxy, { preset, sessionCwd, workspaceTitle })
  const engine = new Engine({ wechat, store, transport, config: engineConfig })

  ctx.effect(() => {
    engine.start()
    return () => engine.stop()
  })
}
