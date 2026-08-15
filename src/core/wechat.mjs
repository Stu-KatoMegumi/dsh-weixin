// src/core/wechat.mjs — ClawBot（微信官方 iLink 通道）客户端
//
// 协议依据官方包 @tencent-weixin/openclaw-weixin v2.4.6 源码逐项对齐：
//   - 登录：GET /ilink/bot/get_bot_qrcode?bot_type=3 返回登录页 URL（liteapp.weixin.qq.com）
//           → Edge/Chrome --app 独立扫码窗口 → 长轮询 get_qrcode_status 拿 bot_token
//   - 上线/下线：POST /ilink/bot/msg/notifystart | notifystop（生命周期注册，必做）
//   - 收消息：POST /ilink/bot/getupdates（长轮询；get_updates_buf 是游标，必须持久化）
//   - 回消息：POST /ilink/bot/sendmessage，必须带 context_token + client_id
//   - 所有请求：头 iLink-App-Id: bot + iLink-App-ClientVersion；体 base_info
// 无第三方依赖，Node >= 22（全局 fetch）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, exec } from 'node:child_process'

const ILINK_DEFAULT = 'https://ilinkai.weixin.qq.com'
const ILINK_APP_ID = 'bot' // 官方包注册的 appid，服务端据此识别客户端（缺失会导致投递受限）
const BOT_AGENT = 'dsh-weixin'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** iLink-App-ClientVersion：uint32 0x00MMNNPP（major<<16 | minor<<8 | patch） */
function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version).split('.').map((p) => parseInt(p, 10) || 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

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
   * @param {number} [opts.pollTimeoutMs] 长轮询超时（毫秒），默认 5000；服务端返回的
   *                                      longpolling_timeout_ms 优先
   * @param {string} [opts.version] 客户端版本号（生成 iLink-App-ClientVersion），默认 1.0.0
   * @param {(line: string) => void} [opts.log] 日志输出，默认 console
   */
  constructor({ stateFile, chunkSize = 1800, pollTimeoutMs = 5000, version = '1.0.0', log = console.log }) {
    this.stateFile = stateFile
    this.chunkSize = chunkSize
    this.pollTimeoutMs = pollTimeoutMs
    this.log = log
    this.version = version
    this.clientVersion = buildClientVersion(version)
    this.nextPollTimeoutMs = pollTimeoutMs
    this.state = this.#loadState()
    this.token = this.state.botToken
    this.baseUrl = this.state.baseUrl || ILINK_DEFAULT
    this.stopped = false
    this.scanClose = null // 扫码窗口关闭句柄（登录完成后自动关闭）
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
      // 官方协议要求：服务端据此识别客户端（缺失会导致投递受限/被限流）
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(this.clientVersion),
    }
    if (this.token) headers.authorization = `Bearer ${this.token}`
    const res = await fetch(this.baseUrl + pathname, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, base_info: { channel_version: this.version, bot_agent: BOT_AGENT } }),
      signal: AbortSignal.timeout(Math.max(this.nextPollTimeoutMs + 15_000, 70_000)),
    })
    return res.json().catch(() => ({ ret: -1, message: `HTTP ${res.status}` }))
  }

  /** 通知微信侧客户端上线（生命周期注册，官方协议步骤） */
  async notifyStart() {
    const r = await this.#ilink('/ilink/bot/msg/notifystart', {})
    if (typeof r.ret === 'number' && r.ret !== 0) {
      console.warn(`[wechat] notifyStart 返回: ${JSON.stringify(r)}`)
    } else {
      this.log('[wechat] 已通知微信侧客户端上线')
    }
    return r
  }

  /** 通知微信侧客户端下线（退出时调用） */
  async notifyStop() {
    try {
      await this.#ilink('/ilink/bot/msg/notifystop', {})
    } catch { /* 退出路径不阻塞 */ }
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
      this.log('[wechat] 登录链接已保存到 session/qrcode.txt（也可发到手机微信里打开）')
      // 直接用 Edge/Chrome 的 --app 独立窗口打开扫码页：登录成功后自动关闭该窗口
      this.log('[wechat] 正在打开扫码窗口（扫码登录成功后会自动关闭）…')
      const scan = openScanWindow(qrUrl)
      this.scanClose = scan ? scan.close : null
      if (!scan) {
        this.log('[wechat] 未找到 Edge/Chrome，改用默认浏览器打开（登录后需手动关闭页面）')
        if (!openBrowser(qrUrl)) this.log('[wechat] 自动打开失败，请手动打开:', qrUrl)
      }
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
          this.#closeScan()
          this.token = st.bot_token
          this.baseUrl = st.baseurl || ILINK_DEFAULT
          this.state.botToken = this.token
          this.state.baseUrl = this.baseUrl
          this.#saveState()
          this.log('[wechat] 登录成功 ✓（扫码窗口已自动关闭）')
          return true
        }
        if (st.status === 'expired' || st.status === 'cancelled') {
          this.#closeScan()
          throw new Error('二维码已失效，请重新运行')
        }
        // 官方文档状态：wait（等待扫描）/ scaned（已扫描）/ confirmed（已确认）/ expired（已过期）
        if (st.status === 'scaned') {
          this.log('[wechat] 已扫码，等待确认…')
        } else {
          this.log(`[wechat] 等待扫码确认（${new Date().toLocaleTimeString()}）…`)
        }
      } catch (error) {
        if (error.message === '二维码已失效，请重新运行') throw error
        console.warn(`[wechat] 轮询扫码状态出错，3 秒后重试: ${error.message}`)
        await sleep(3000)
      }
    }
  }

  #closeScan() {
    if (this.scanClose) {
      try { this.scanClose() } catch { /* 已关闭 */ }
      this.scanClose = null
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
    })
    // 成功响应没有 ret 字段（{"msgs":[...],"get_updates_buf":...}），只有失败才带 ret != 0
    if (typeof r.ret === 'number' && r.ret !== 0) throw new Error(JSON.stringify(r))
    // 服务端建议的下次长轮询超时优先
    if (typeof r.longpolling_timeout_ms === 'number' && r.longpolling_timeout_ms > 0) {
      this.nextPollTimeoutMs = r.longpolling_timeout_ms
    }
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
    // 上线通知（生命周期注册；每次进程启动都要做）
    if (!this.notified) {
      this.notified = true
      try { await this.notifyStart() } catch { /* 不阻塞轮询 */ }
    }
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

  /** 发送文本（分块；context_token 必须原样带回，client_id 为每次发送的唯一标识） */
  async sendText(fromUserId, contextToken, text) {
    for (let i = 0; i < text.length; i += this.chunkSize) {
      const part = text.slice(i, i + this.chunkSize)
      const r = await this.#ilink('/ilink/bot/sendmessage', {
        msg: {
          from_user_id: '',
          to_user_id: fromUserId,
          client_id: `dsh-weixin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          message_type: 2, // BOT 发出
          message_state: 2, // FINISH（完整消息）
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text: part } }],
        },
      })
      // 每次发送都记录服务端响应，便于排查投递问题
      const failed = typeof r.ret === 'number' && r.ret !== 0
      console.log(
        `[wechat] 发送${failed ? '失败' : '成功'}（${part.length}字）: ${failed ? JSON.stringify(r) : 'ret=' + (r.ret ?? 0)}`,
      )
    }
  }

  stop() {
    this.stopped = true
    this.#closeScan()
    void this.notifyStop()
  }
}

// ── 扫码窗口：Edge/Chrome 的 --app 独立窗口，登录成功后 kill 进程即自动关闭 ──

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].filter(Boolean)

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean)

/**
 * 用浏览器的 --app 模式打开独立扫码窗口：
 *  - 只显示扫码页的独立窗口（无标签页/地址栏），直接可扫，无中间步骤
 *  - 带独立 --user-data-dir：该窗口是独立进程树，close() 可随时将其关闭
 * 环境变量 WX_BOT_BROWSER 可指定浏览器可执行文件路径。
 * @param {string} qrUrl 微信官方登录页 URL
 * @returns {{ close: () => void, browser: string } | null} 失败返回 null（调用方降级默认浏览器）
 */
export function openScanWindow(qrUrl) {
  const candidates = [process.env.WX_BOT_BROWSER, ...EDGE_PATHS, ...CHROME_PATHS].filter(Boolean)
  for (const browser of candidates) {
    if (!fs.existsSync(browser)) continue
    let profile = ''
    try {
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-login-'))
      const child = spawn(browser, [
        `--app=${qrUrl}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
      ], { stdio: 'ignore' })
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        try { child.kill() } catch { /* 已退出 */ }
        // 清理临时配置目录（进程退出后文件锁可能延迟释放，重试几次）
        let attempts = 0
        const tryClean = () => {
          attempts += 1
          try {
            fs.rmSync(profile, { recursive: true, force: true })
          } catch {
            if (attempts < 5) setTimeout(tryClean, 1000)
          }
        }
        setTimeout(tryClean, 2000)
      }
      child.on('error', close)
      child.on('exit', close)
      return { close, browser }
    } catch {
      try { if (profile) fs.rmSync(profile, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  }
  return null
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
