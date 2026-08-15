// src/core/wechat.mjs — ClawBot（微信官方 iLink 通道）客户端
//
// 协议依据 @tencent-weixin/openclaw-weixin 的技术解析：
//   - 登录：GET /ilink/bot/get_bot_qrcode?bot_type=3 返回登录页 URL（liteapp.weixin.qq.com）
//           → 自动打开浏览器 → 长轮询 get_qrcode_status（每次 hold 约 30s）拿 bot_token
//   - 收消息：POST /ilink/bot/getupdates（长轮询；get_updates_buf 是游标，必须持久化，
//             否则重启后重复收旧消息）
//   - 回消息：POST /ilink/bot/sendmessage，必须原样携带收到的 context_token
// 无第三方依赖，Node >= 22（全局 fetch）。

import fs from 'node:fs'
import path from 'node:path'
import { spawn, exec } from 'node:child_process'

const ILINK_DEFAULT = 'https://ilinkai.weixin.qq.com'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 在默认浏览器中打开 URL（Windows 用 cmd start，URL 必须引号包裹防 & 被当命令分隔符） */
function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      exec(`start "" "${url}"`, { windowsHide: true }, (error) => {
        if (error) console.warn('[wechat] 自动打开浏览器失败:', error.message)
      })
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
    }
    return true
  } catch (error) {
    console.warn(`[wechat] 自动打开浏览器失败: ${error.message}`)
    return false
  }
}

export class WeChatClient {
  /**
   * @param {object} opts
   * @param {string} opts.stateFile 状态文件（bot.json：token/baseUrl/updatesBuf）
   * @param {number} [opts.chunkSize] 发送分块长度，默认 1800
   * @param {number} [opts.pollTimeoutMs] 请求 getupdates 时希望的长轮询超时（毫秒），默认 5000
   * @param {(line: string) => void} [opts.log] 日志输出，默认 console
   */
  constructor({ stateFile, chunkSize = 1800, pollTimeoutMs = 5000, log = console.log }) {
    this.stateFile = stateFile
    this.chunkSize = chunkSize
    this.pollTimeoutMs = pollTimeoutMs
    this.log = log
    this.state = this.#loadState()
    this.token = this.state.botToken
    this.baseUrl = this.state.baseUrl || ILINK_DEFAULT
    this.stopped = false
  }

  // ── 状态持久化 ──

  #loadState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
    } catch {
      return {}
    }
  }

  #saveState() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2))
  }

  // ── iLink 请求 ──

  /** 每次请求随机 X-WECHAT-UIN（防重放，协议要求） */
  #randomUin() {
    const uin = (Math.random() * 0xffffffff) >>> 0
    return Buffer.from(String(uin)).toString('base64')
  }

  async #ilink(pathname, body) {
    const headers = {
      'content-type': 'application/json',
      'authorizationtype': 'ilink_bot_token',
      'x-wechat-uin': this.#randomUin(),
    }
    if (this.token) headers.authorization = `Bearer ${this.token}`
    const res = await fetch(this.baseUrl + pathname, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(this.pollTimeoutMs + 15_000, 70_000)),
    })
    return res.json().catch(() => ({ ret: -1, message: `HTTP ${res.status}` }))
  }

  // ── 登录 ──

  /** 确保已登录；未登录则走扫码流程（返回 true 表示本调用完成了登录） */
  async ensureLogin() {
    if (this.token) return false
    this.log('[wechat] 需要登录，正在获取登录二维码…')
    const qr = await fetch(`${ILINK_DEFAULT}/ilink/bot/get_bot_qrcode?bot_type=3`)
      .then((r) => r.json())
      .catch((error) => { throw new Error(`获取二维码失败: ${error.message}`) })
    if (!qr.qrcode || qr.ret !== 0) throw new Error(`获取二维码失败: ${JSON.stringify(qr)}`)

    // qrcode_img_content 是微信官方登录页 URL，不是图片数据
    const qrUrl = qr.qrcode_img_content || qr.url || ''
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
    try { fs.rmSync(path.join(path.dirname(this.stateFile), 'qrcode.png'), { force: true }) } catch { /* 清理 */ }
    if (qrUrl) {
      fs.writeFileSync(path.join(path.dirname(this.stateFile), 'qrcode.txt'), qrUrl + '\n')
      this.log('[wechat] 登录链接已保存到 session/qrcode.txt')
      this.log('[wechat] 正在打开浏览器（若无反应，请手动打开上面的链接）…')
      if (!openBrowser(qrUrl)) this.log('[wechat] 自动打开失败，请手动打开:', qrUrl)
      this.log('[wechat] 在打开的页面里用微信扫码即可完成登录；也可把链接发到手机微信里打开')
    } else {
      this.log('[wechat] 接口未返回登录链接，二维码票据:', qr.qrcode)
    }

    // get_qrcode_status 是长轮询：每次 hold 约 30 秒
    for (;;) {
      if (this.stopped) throw new Error('已停止')
      try {
        const st = await fetch(
          `${ILINK_DEFAULT}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`,
        ).then((r) => r.json())
        if (st.status === 'confirmed') {
          this.token = st.bot_token
          this.baseUrl = st.baseurl || ILINK_DEFAULT
          this.state.botToken = this.token
          this.state.baseUrl = this.baseUrl
          this.#saveState()
          this.log('[wechat] 登录成功 ✓')
          return true
        }
        if (st.status === 'expired' || st.status === 'cancelled') {
          throw new Error('二维码已失效，请重新运行')
        }
        this.log(`[wechat] 等待扫码确认（${new Date().toLocaleTimeString()}）…`)
      } catch (error) {
        if (error.message === '二维码已失效，请重新运行') throw error
        console.warn(`[wechat] 轮询扫码状态出错，3 秒后重试: ${error.message}`)
        await sleep(3000)
      }
    }
  }

  // ── 收消息 ──

  /**
   * 长轮询一次 getupdates，返回消息数组；无消息返回 []。
   * 响应里的 get_updates_buf 游标会持久化。
   */
  async pollOnce() {
    const buf = this.state.updatesBuf ?? ''
    const r = await this.#ilink('/ilink/bot/getupdates', {
      get_updates_buf: buf,
      base_info: { channel_version: '1.0.2' },
      // 尝试缩短服务端 hold（若服务端支持；不支持则忽略，保持原 35s 行为）
      longpolling_timeout_ms: this.pollTimeoutMs,
    })
    // 成功响应没有 ret 字段（{"msgs":[...],"get_updates_buf":...}），只有失败才带 ret != 0
    if (typeof r.ret === 'number' && r.ret !== 0) throw new Error(JSON.stringify(r))
    if (r.get_updates_buf) {
      this.state.updatesBuf = r.get_updates_buf
      this.#saveState()
    }
    return r.msgs ?? []
  }

  /**
   * 持续轮询，把每条消息交给 handler（fire-and-forget：长回合不阻塞后续消息接收；
   * 同一会话的串行由传输层 ask() 的串行链保证）。
   * @param {(msg: object) => void | Promise<void>} handler
   */
  async startPolling(handler) {
    for (;;) {
      if (this.stopped) return
      try {
        const msgs = await this.pollOnce()
        for (const msg of msgs) {
          if (this.stopped) return
          void Promise.resolve(handler(msg)).catch((error) => {
            console.error('[wechat] 处理消息失败:', error.message)
          })
        }
      } catch (error) {
        console.warn(`[wechat] getupdates 出错，3 秒后重试: ${error.message}`)
        await sleep(3000)
      }
    }
  }

  // ── 发消息 ──

  /** 发送文本（分块；context_token 必须原样带回） */
  async sendText(fromUserId, contextToken, text) {
    for (let i = 0; i < text.length; i += this.chunkSize) {
      const part = text.slice(i, i + this.chunkSize)
      const r = await this.#ilink('/ilink/bot/sendmessage', {
        msg: {
          to_user_id: fromUserId,
          message_type: 2, // BOT 发出
          message_state: 2, // FINISH（完整消息）
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text: part } }],
        },
      })
      if (typeof r.ret === 'number' && r.ret !== 0) console.warn('[wechat] 发送失败:', JSON.stringify(r))
    }
  }

  stop() {
    this.stopped = true
  }
}

/** 把 agent 的提问整理成一条微信消息 */
export function formatQuestions(questions) {
  const lines = (questions ?? []).map((q, i) => {
    let s = `${i + 1}. ${q.question}`
    if (q.detail) s += `\n　${q.detail}`
    if (q.options?.length) s += `\n　（可选：${q.options.map((o) => o.label).join(' / ')}）`
    return s
  })
  return `📌 DSH 需要你回答：\n${lines.join('\n')}\n\n请直接回复你的答案。`
}
