// bridge.mjs — ClawBot（微信官方 iLink 通道）↔ DSH 桥
//
// 微信侧：腾讯官方 ClawBot / iLink 协议（ilinkai.weixin.qq.com），个人微信扫码登录，
//         合规、无封号风险。协议要点（依据 @tencent-weixin/openclaw-weixin 逆向文档）：
//   - 登录：GET  /ilink/bot/get_bot_qrcode?bot_type=3 取登录页链接 -> 自动打开浏览器 ->
//           长轮询 get_qrcode_status 拿 bot_token（token 持久化到 state/bot.json）
//   - 收消息：POST /ilink/bot/getupdates（Telegram 式长轮询，get_updates_buf 是游标，必须持久化）
//   - 回消息：POST /ilink/bot/sendmessage，必须原样携带收到的 context_token
// DSH 侧：dsh-client.mjs（HTTP RPC + WebSocket 事件流，与 Web 前端同协议）
//
// 运行：node bridge.mjs（首次运行自动打开浏览器，用微信扫码登录）
// 无第三方依赖，Node >= 22。

import fs from 'node:fs'
import path from 'node:path'
import { spawn, exec } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DshClient } from './dsh-client.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ILINK_DEFAULT = 'https://ilinkai.weixin.qq.com'
const STATE_DIR = path.join(__dirname, 'state')
const STATE_FILE = path.join(STATE_DIR, 'bot.json')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 微信用户 -> { from_user_id, context_token }（供提问转发/慢任务提醒使用） */
const userBySession = new Map()

// ── 状态持久化（bot_token / baseUrl / get_updates_buf 都要跨重启保留）──

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

// ── iLink 协议客户端 ──

/** 每次请求随机 X-WECHAT-UIN（防重放，协议要求） */
function randomUin() {
  const uin = (Math.random() * 0xffffffff) >>> 0
  return Buffer.from(String(uin)).toString('base64')
}

async function ilink(baseUrl, pathname, body, token) {
  const headers = {
    'content-type': 'application/json',
    'authorizationtype': 'ilink_bot_token',
    'x-wechat-uin': randomUin(),
  }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(baseUrl + pathname, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(70_000), // 长轮询最长 hold 35s，留足余量
  })
  return res.json().catch(() => ({ ret: -1, message: `HTTP ${res.status}` }))
}

/** 在默认浏览器中打开登录页（失败返回 false，不影响主流程） */
function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      // 必须用 exec 走 cmd 原生解析：URL 用引号包住，否则其中的 "&" 会被 cmd 当成命令分隔符
      exec(`start "" "${url}"`, { windowsHide: true }, (error) => {
        if (error) console.warn(`[clawbot] 自动打开浏览器失败: ${error.message}`)
      })
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
    }
    return true
  } catch (error) {
    console.warn(`[clawbot] 自动打开浏览器失败: ${error.message}`)
    return false
  }
}

/** 首次运行：取登录链接 -> 存 txt -> 自动打开浏览器 -> 长轮询扫码结果，返回 { token, baseUrl } */
async function login() {
  console.log('[clawbot] 正在获取登录二维码…')
  const qr = await fetch(`${ILINK_DEFAULT}/ilink/bot/get_bot_qrcode?bot_type=3`)
    .then((r) => r.json())
    .catch((error) => {
      throw new Error(`获取二维码失败: ${error.message}`)
    })
  if (!qr.qrcode || qr.ret !== 0) throw new Error(`获取二维码失败: ${JSON.stringify(qr)}`)

  // qrcode_img_content 是微信官方登录页 URL（liteapp.weixin.qq.com），不是图片数据
  const qrUrl = qr.qrcode_img_content || qr.url || ''
  fs.mkdirSync(STATE_DIR, { recursive: true })
  try { fs.rmSync(path.join(STATE_DIR, 'qrcode.png'), { force: true }) } catch { /* 清理旧文件 */ }
  if (qrUrl) {
    fs.writeFileSync(path.join(STATE_DIR, 'qrcode.txt'), qrUrl + '\n')
    console.log('[clawbot] 登录链接已保存到 state/qrcode.txt')
    console.log('[clawbot] 正在打开浏览器（若无反应，请手动打开上面的链接）…')
    if (!openBrowser(qrUrl)) console.log('[clawbot] 自动打开失败，请手动打开:', qrUrl)
    console.log('[clawbot] 在打开的页面里用微信扫码即可完成登录；也可把链接发到手机微信里打开')
  } else {
    console.log('[clawbot] 接口未返回登录链接，二维码票据:', qr.qrcode)
  }

  // get_qrcode_status 是长轮询：每次 hold 约 30 秒，返回 wait/confirmed/expired
  for (;;) {
    try {
      const st = await fetch(
        `${ILINK_DEFAULT}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`,
      ).then((r) => r.json())
      if (st.status === 'confirmed') {
        console.log('[clawbot] 登录成功 ✓')
        return { token: st.bot_token, baseUrl: st.baseurl || ILINK_DEFAULT }
      }
      if (st.status === 'expired' || st.status === 'cancelled') {
        throw new Error('二维码已失效，请重新运行')
      }
      console.log(`[clawbot] 等待扫码确认（${new Date().toLocaleTimeString()}）…`)
    } catch (error) {
      if (error.message === '二维码已失效，请重新运行') throw error
      console.warn(`[clawbot] 轮询扫码状态出错，3 秒后重试: ${error.message}`)
      await sleep(3000)
    }
  }
}

// ── 主流程 ──

const state = loadState()
let botToken = state.botToken
let baseUrl = state.baseUrl || ILINK_DEFAULT
if (!botToken) {
  const loginResult = await login()
  botToken = loginResult.token
  baseUrl = loginResult.baseUrl
  state.botToken = botToken
  state.baseUrl = baseUrl
  saveState(state)
}
console.log(`[clawbot] 已登录（token 尾部 …${botToken.slice(-6)}）`)

const dsh = new DshClient({ base: process.env.DSH_URL || 'http://127.0.0.1:3080' })
const SESSION_CWD = process.env.WX_BOT_CWD || __dirname
const AGENT_PRESET = process.env.WX_BOT_PRESET || 'weixin' // 专属精炼 preset，找不到时自动降级默认
const TURN_TIMEOUT_MS = Number(process.env.WX_BOT_TURN_TIMEOUT_MS || 15 * 60 * 1000)
const CHUNK_SIZE = Number(process.env.WX_BOT_CHUNK_SIZE || 1800)
const SLOW_ACK_MS = Number(process.env.WX_BOT_SLOW_ACK_MS || 4000) // 超过该时长先回"正在处理"

dsh.onStall = (sessionId) => {
  console.warn(`[bridge] 会话 ${sessionId} 发起审批请求，请在 DSH Web 界面处理（http://127.0.0.1:3080）`)
}

// 任务超过 SLOW_ACK_MS 未完成：先回一句"正在处理"，完成后发最终回复
dsh.onSlow = (sessionId) => {
  const user = userBySession.get(sessionId)
  if (!user) return
  void sendText(user.from, user.token, '⏳ 收到，正在处理，完成后回复你…').catch((error) => {
    console.error('[bridge] 发送"正在处理"失败:', error.message)
  })
}

// agent 提问 -> 转发到微信，用户回复后自动提交答案
dsh.onQuestion = async (rpcId, sessionId, questions) => {
  const user = userBySession.get(sessionId)
  if (!user) {
    console.warn(`[bridge] 会话 ${sessionId} 有提问但找不到对应微信用户，请在 Web 界面处理`)
    return
  }
  try {
    await sendText(user.from, user.token, formatQuestions(questions))
  } catch (error) {
    console.error('[bridge] 转发提问失败:', error.message)
  }
}

/** 把一条微信消息透传给 DSH，并把回复发回微信 */
async function handleMessage(msg) {
  if (msg.message_type !== 1) return // 只处理用户消息（BOT 发出的 type=2 不回环）
  if (msg.group_id) {
    console.log('[bridge] 跳过群消息（v1 只处理单聊）:', msg.group_id)
    return
  }
  const text = msg.item_list?.find((item) => item.type === 1)?.text_item?.text
  if (!text) {
    await sendText(msg.from_user_id, msg.context_token, '暂时只支持文字消息')
    return
  }
  const userKey = msg.from_user_id
  const sessionId = await ensureBotSession(userKey)
  userBySession.set(sessionId, { from: msg.from_user_id, token: msg.context_token })

  // 若该会话正被 agent 提问挂起，则把这条消息作为回答提交，而不是开新回合
  const pending = dsh.pendingQuestion(sessionId)
  if (pending) {
    console.log(`[bridge] ${userKey} 回答提问 ${pending.rpcId.slice(0, 8)}: ${text.slice(0, 80)}`)
    try {
      await dsh.answerQuestion(pending.rpcId, sessionId, text)
      await sendText(msg.from_user_id, msg.context_token, '已收到你的回答，继续处理中…')
    } catch (error) {
      console.error('[bridge] 提交回答失败:', error.message)
      await sendText(msg.from_user_id, msg.context_token, `提交回答失败：${error.message}`)
    }
    return
  }

  console.log(`[bridge] ${userKey}: ${text.slice(0, 80)}  -> 会话 ${sessionId}`)
  try {
    const replyText = await dsh.ask(sessionId, text, { timeoutMs: TURN_TIMEOUT_MS, slowMs: SLOW_ACK_MS })
    await sendText(msg.from_user_id, msg.context_token, replyText || '（DSH 没有返回内容）')
  } catch (error) {
    console.error('[bridge] 回合失败:', error.message)
    await sendText(msg.from_user_id, msg.context_token, `出错：${error.message}`)
  }
}

/** 创建/复用微信用户会话：优先 weixin preset，缺失或无效时自动降级为默认 preset */
async function ensureBotSession(userKey) {
  try {
    return await dsh.ensureSession(userKey, { cwd: SESSION_CWD, agentPreset: AGENT_PRESET })
  } catch (error) {
    if (error.code === 'agent-preset-not-found' || error.code === 'agent-preset-invalid') {
      console.warn(`[bridge] preset "${AGENT_PRESET}" 不可用（${error.code}），降级为默认 preset`)
      return dsh.ensureSession(userKey, { cwd: SESSION_CWD })
    }
    throw error
  }
}

/** 通过 iLink sendmessage 发送文本（分块发送；context_token 必须原样带回） */
async function sendText(fromUserId, contextToken, text) {
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    const part = text.slice(i, i + CHUNK_SIZE)
    const r = await ilink(baseUrl, '/ilink/bot/sendmessage', {
      msg: {
        to_user_id: fromUserId,
        message_type: 2, // BOT 发出
        message_state: 2, // FINISH（完整消息）
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text: part } }],
      },
    }, botToken)
    if (typeof r.ret === 'number' && r.ret !== 0) console.warn('[clawbot] 发送失败:', JSON.stringify(r))
  }
}

/** 把 agent 的提问整理成一条微信消息 */
function formatQuestions(questions) {
  const lines = (questions ?? []).map((q, i) => {
    let s = `${i + 1}. ${q.question}`
    if (q.detail) s += `\n　${q.detail}`
    if (q.options?.length) s += `\n　（可选：${q.options.map((o) => o.label).join(' / ')}）`
    return s
  })
  return `📌 DSH 需要你回答：\n${lines.join('\n')}\n\n请直接回复你的答案。`
}

// ── 长轮询收消息 ──

let updatesBuf = state.updatesBuf ?? ''
console.log(`[bridge] 开始长轮询（DSH: ${dsh.base}，工作目录: ${SESSION_CWD}）…`)
console.log('[bridge] 现在可以用微信给机器人发消息了。Ctrl+C 退出。')

process.on('SIGINT', () => {
  console.log('\n[bridge] 退出…')
  dsh.stop()
  process.exit(0)
})

for (;;) {
  try {
    const r = await ilink(baseUrl, '/ilink/bot/getupdates', {
      get_updates_buf: updatesBuf,
      base_info: { channel_version: '1.0.2' },
    }, botToken)
    // 注意：成功响应没有 ret 字段（{"msgs":[...],"get_updates_buf":...}），只有失败才带 ret != 0
    if (typeof r.ret === 'number' && r.ret !== 0) throw new Error(JSON.stringify(r))
    if (r.get_updates_buf) {
      updatesBuf = r.get_updates_buf
      state.updatesBuf = updatesBuf // 持久化游标，重启不重收旧消息
      saveState(state)
    }
    for (const msg of r.msgs ?? []) {
      void handleMessage(msg).catch((error) => console.error('[bridge] 处理消息失败:', error.message))
    }
  } catch (error) {
    console.warn(`[clawbot] getupdates 出错，3 秒后重试: ${error.message}`)
    await sleep(3000)
  }
}
