// src/standalone/main.mjs — 独立模式入口（npm start）
//
// 与插件模式共用同一套核心（wechat / store / engine），只是 DSH 传输层用
// HTTP RPC + WebSocket（ws 不可用时自动降级 session.history 轮询）。
//
// 配置：环境变量（DSH_URL / WX_BOT_*），见 README。

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WeChatClient } from '../core/wechat.mjs'
import { Store } from '../core/store.mjs'
import { Engine } from '../core/engine.mjs'
import { HttpTransport } from '../dsh/http.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.resolve(__dirname, '../..')
const sessionDir = path.resolve(process.env.WX_BOT_SESSION_DIR || path.join(projectDir, 'session'))

const config = {
  dshBase: process.env.DSH_URL || 'http://127.0.0.1:3080',
  preset: process.env.WX_BOT_PRESET || 'weixin',
  sessionCwd: process.env.WX_BOT_CWD || projectDir,
  workspaceTitle: '微信会话',
  slowAckMs: Number(process.env.WX_BOT_SLOW_ACK_MS || 4000),
  turnTimeoutMs: Number(process.env.WX_BOT_TURN_TIMEOUT_MS || 15 * 60 * 1000),
  chunkSize: Number(process.env.WX_BOT_CHUNK_SIZE || 1800),
  pollTimeoutMs: Number(process.env.WX_BOT_POLL_TIMEOUT_MS || 5000),
}

const store = new Store(sessionDir)
const wechat = new WeChatClient({
  stateFile: path.join(sessionDir, 'bot.json'),
  chunkSize: config.chunkSize,
  pollTimeoutMs: config.pollTimeoutMs,
})
const transport = new HttpTransport({
  base: config.dshBase,
  preset: config.preset,
  sessionCwd: config.sessionCwd,
  workspaceTitle: config.workspaceTitle,
})
const engine = new Engine({ wechat, store, transport, config })

console.log('┌──────────────────────────────────────────────────────┐')
console.log('│  weixin-bot（独立模式）                                │')
console.log('│  DSH:      ' + config.dshBase.padEnd(39) + '│')
console.log('│  preset:   ' + config.preset.padEnd(39) + '│')
console.log('│  session:  ' + sessionDir.padEnd(39) + '│')
console.log('│  会话分组：' + config.workspaceTitle.padEnd(39) + '│')
console.log('└──────────────────────────────────────────────────────┘')

engine.start()

process.on('SIGINT', () => {
  console.log('\n[main] 退出…')
  engine.stop()
  process.exit(0)
})

// 顶层错误兜底（登录失败等）
process.on('unhandledRejection', (error) => {
  console.error('[main] 未处理的拒绝:', error?.message ?? error)
})
