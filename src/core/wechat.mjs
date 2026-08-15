import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { downloadInboundItem, uploadOutboundFile } from './media.mjs'
import { formatForWeChat, safeTextCut } from './format.mjs'

const ILINK_DEFAULT = 'https://ilinkai.weixin.qq.com'
const ILINK_APP_ID = 'bot'
const BOT_AGENT = 'dsh-weixin'
const DEFAULT_RENEW_AFTER_MS = 24 * 60 * 60 * 1000
const DEFAULT_RENEW_WARN_MS = 2 * 60 * 60 * 1000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export class SessionExpiredError extends Error {
  constructor(message = '微信登录凭据已过期') {
    super(message)
    this.name = 'SessionExpiredError'
    this.code = 'ILINK_SESSION_EXPIRED'
  }
}

function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version).split('.').map(value => Number.parseInt(value, 10) || 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(temporary, file)
}

function openUrl(url) {
  try {
    if (process.platform === 'win32') {
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
    }
    return true
  } catch {
    return false
  }
}

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

export function openScanWindow(qrUrl) {
  const candidates = [process.env.WX_BOT_BROWSER, ...EDGE_PATHS, ...CHROME_PATHS].filter(Boolean)
  for (const browser of candidates) {
    if (!fs.existsSync(browser)) continue
    let profile = ''
    try {
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-login-'))
      const child = spawn(browser, [
        `--app=${qrUrl}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
      ], { stdio: 'ignore', windowsHide: true })
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        try { child.kill() } catch { /* already closed */ }
        setTimeout(() => {
          try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* locked browser files */ }
        }, 2000)
      }
      child.on('error', close)
      child.on('exit', close)
      return { close, browser }
    } catch {
      try { if (profile) fs.rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
  return null
}

/** Tencent iLink/ClawBot protocol client with reconnect and renewal supervision. */
export class WeChatClient {
  constructor({
    stateFile,
    mediaDir = path.join(path.dirname(stateFile), 'media'),
    chunkSize = 2000,
    pollTimeoutMs = 8000,
    watchdogMs = 90_000,
    renewAfterMs = DEFAULT_RENEW_AFTER_MS,
    renewWarnBeforeMs = DEFAULT_RENEW_WARN_MS,
    version = '1.0.0',
    log = console.log,
    warn = console.warn,
    error = console.error,
  }) {
    this.stateFile = stateFile
    this.mediaDir = mediaDir
    this.chunkSize = Math.max(200, chunkSize)
    this.pollTimeoutMs = pollTimeoutMs
    this.watchdogMs = watchdogMs
    this.renewAfterMs = renewAfterMs
    this.renewWarnBeforeMs = renewWarnBeforeMs
    this.version = version
    this.log = log
    this.warn = warn
    this.error = error
    this.clientVersion = buildClientVersion(version)
    this.state = this.#loadState()
    this.token = this.state.botToken || ''
    this.baseUrl = this.state.baseUrl || ILINK_DEFAULT
    this.nextPollTimeoutMs = pollTimeoutMs
    this.stopped = false
    this.notified = false
    this.scanClose = null
    this.renewal = null
    this.typingTickets = new Map()
    this.lastPollAt = 0
    this.lastSuccessAt = 0
    this.lastError = null
  }

  #loadState() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) } catch { return {} }
  }

  #saveState() {
    atomicJson(this.stateFile, this.state)
  }

  #randomUin() {
    return Buffer.from(String((Math.random() * 0xffffffff) >>> 0)).toString('base64')
  }

  async #ilink(pathname, body, { timeoutMs } = {}) {
    const response = await fetch(this.baseUrl + pathname, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorizationtype: 'ilink_bot_token',
        authorization: `Bearer ${this.token}`,
        'x-wechat-uin': this.#randomUin(),
        'iLink-App-Id': ILINK_APP_ID,
        'iLink-App-ClientVersion': String(this.clientVersion),
      },
      body: JSON.stringify({ ...body, base_info: { channel_version: this.version, bot_agent: BOT_AGENT } }),
      signal: AbortSignal.timeout(timeoutMs ?? Math.max(this.nextPollTimeoutMs + 15_000, 70_000)),
    })
    const value = await response.json().catch(() => ({ ret: -1, message: `HTTP ${response.status}` }))
    const code = value?.errcode ?? value?.ret
    if (code === -14) {
      this.invalidateCredentials()
      throw new SessionExpiredError()
    }
    if (!response.ok || (typeof value?.ret === 'number' && value.ret !== 0)) {
      const error = new Error(value?.errmsg || value?.message || `iLink HTTP ${response.status}`)
      error.code = code
      throw error
    }
    return value
  }

  status() {
    const loginAt = Number(this.state.loginAt || 0)
    return {
      connected: Boolean(this.token),
      loginAt: loginAt || null,
      expiresAt: loginAt ? loginAt + this.renewAfterMs : null,
      renewalPending: Boolean(this.renewal),
      lastPollAt: this.lastPollAt || null,
      lastSuccessAt: this.lastSuccessAt || null,
      lastError: this.lastError?.message || null,
    }
  }

  invalidateCredentials() {
    this.token = ''
    delete this.state.botToken
    delete this.state.loginAt
    delete this.state.updatesBuf
    this.#saveState()
  }

  async notifyStart() {
    await this.#ilink('/ilink/bot/msg/notifystart', {})
    this.notified = true
  }

  async notifyStop() {
    if (!this.token) return
    try { await this.#ilink('/ilink/bot/msg/notifystop', {}, { timeoutMs: 10_000 }) } catch { /* best effort */ }
  }

  async #newQrCode() {
    const response = await fetch(`${ILINK_DEFAULT}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      signal: AbortSignal.timeout(20_000),
    })
    const qr = await response.json()
    if (!response.ok || qr.ret !== 0 || !qr.qrcode) throw new Error(`获取登录二维码失败：${qr.message || qr.ret}`)
    return { ticket: qr.qrcode, url: qr.qrcode_img_content || qr.url || '' }
  }

  async #pollQr(qr, signal) {
    while (!signal.aborted && !this.stopped) {
      try {
        const response = await fetch(`${ILINK_DEFAULT}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.ticket)}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
        })
        const value = await response.json()
        if (value.status === 'confirmed') return value
        if (value.status === 'expired' || value.status === 'cancelled') throw new Error('二维码已失效')
      } catch (error) {
        if (signal.aborted || this.stopped || error?.message === '二维码已失效') throw error
        this.warn('[wechat] 查询扫码状态失败，将继续重试:', error.message)
      }
      await sleep(1000)
    }
    throw signal.reason || new Error('登录已停止')
  }

  #persistQr(url) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
    fs.writeFileSync(path.join(path.dirname(this.stateFile), 'qrcode.txt'), `${url}\n`, 'utf8')
  }

  #acceptCredentials(value) {
    this.token = value.bot_token
    this.baseUrl = value.baseurl || ILINK_DEFAULT
    this.state.botToken = this.token
    this.state.baseUrl = this.baseUrl
    this.state.loginAt = Date.now()
    delete this.state.updatesBuf
    this.#saveState()
    this.notified = false
  }

  async ensureLogin() {
    if (this.token) {
      if (!this.state.loginAt) {
        this.state.loginAt = Date.now()
        this.#saveState()
      }
      return false
    }
    const qr = await this.#newQrCode()
    this.#persistQr(qr.url)
    this.log(`[wechat] 请扫码登录：${qr.url}`)
    const scan = openScanWindow(qr.url)
    this.scanClose = scan?.close || null
    if (!scan) openUrl(qr.url)
    const controller = new AbortController()
    try {
      const value = await this.#pollQr(qr, controller.signal)
      this.#acceptCredentials(value)
      this.log('[wechat] 登录成功')
      return true
    } finally {
      controller.abort()
      this.#closeScan()
    }
  }

  /** Start a parallel QR renewal while the old token remains usable. */
  async beginRenewal(recipient, { notify = true, open = true } = {}) {
    if (this.renewal) return this.renewal.url
    const qr = await this.#newQrCode()
    this.#persistQr(qr.url)
    const controller = new AbortController()
    this.renewal = { ...qr, controller, startedAt: Date.now(), recipient, lastReminderAt: Date.now(), scanClose: null }
    // When no recipient can carry the link (settings page / auto-renewal), open
    // a dedicated scan app-window so the server holds the handle and can close
    // it automatically right after the scan succeeds. openScanWindow returns a
    // `{ close }` handle; fall back to the default browser when no browser is
    // available (that window then closes on its own as the user leaves it).
    if (!recipient && open) {
      const scan = openScanWindow(qr.url)
      this.renewal.scanClose = scan?.close || null
      if (!scan) openUrl(qr.url)
    }
    void this.#pollQr(qr, controller.signal).then(async (value) => {
      const closeScan = this.renewal?.scanClose
      if (typeof closeScan === 'function') {
        try { closeScan() } catch { /* window already gone */ }
      }
      this.#acceptCredentials(value)
      this.renewal = null
      if (recipient) await this.sendText(recipient, this.state.contextTokens?.[recipient] || '', '✅ 微信连接续期成功。')
    }).catch((error) => {
      // Keep swallowing errors silently when the polling was intentionally cancelled.
      if (this.renewal?.scanClose) {
        try { this.renewal.scanClose() } catch { /* ignore */ }
      }
      if (!controller.signal.aborted) this.warn('[wechat] 续期未完成:', error.message)
      this.renewal = null
    })
    if (notify && recipient && this.token) {
      const token = this.state.contextTokens?.[recipient] || ''
      await this.sendText(recipient, token, `🔐 微信登录凭据即将到期，请打开下面链接扫码续期：\n${qr.url}`).catch(error => {
        this.warn('[wechat] 续期提醒发送失败:', error.message)
      })
    }
    return qr.url
  }

  async checkRenewal(recipient) {
    if (!this.token) return
    if (this.renewal) {
      if (recipient && Date.now() - this.renewal.lastReminderAt >= 30 * 60 * 1000) {
        this.renewal.lastReminderAt = Date.now()
        await this.sendText(recipient, this.state.contextTokens?.[recipient] || '', `⏰ 微信连接仍等待扫码续期：\n${this.renewal.url}`).catch(() => {})
      }
      return
    }
    const loginAt = Number(this.state.loginAt || Date.now())
    if (Date.now() - loginAt >= this.renewAfterMs - this.renewWarnBeforeMs) await this.beginRenewal(recipient)
  }

  #closeScan() {
    try { this.scanClose?.() } catch { /* ignore */ }
    this.scanClose = null
  }

  async pollOnce() {
    const value = await this.#ilink('/ilink/bot/getupdates', { get_updates_buf: this.state.updatesBuf || '' })
    this.lastPollAt = Date.now()
    this.lastSuccessAt = this.lastPollAt
    this.lastError = null
    if (Number(value.longpolling_timeout_ms) > 0) this.nextPollTimeoutMs = Number(value.longpolling_timeout_ms)
    if (value.get_updates_buf) {
      this.state.updatesBuf = value.get_updates_buf
      this.#saveState()
    }
    return value.msgs || []
  }

  async startPolling(handler) {
    let backoff = 1000
    while (!this.stopped) {
      try {
        if (!this.token) await this.ensureLogin()
        if (!this.notified) await this.notifyStart()
        const startedAt = Date.now()
        const messages = await this.pollOnce()
        if (Date.now() - startedAt > this.watchdogMs) this.warn('[wechat] 长轮询响应过慢，已进入下一轮监听')
        for (const message of messages) {
          if (this.stopped) return
          void Promise.resolve(handler(message)).catch(error => this.error('[wechat] 消息处理失败:', error.message))
        }
        backoff = 1000
      } catch (error) {
        if (this.stopped) return
        this.lastError = error
        this.notified = false
        this.warn(`[wechat] 连接异常，${Math.ceil(backoff / 1000)} 秒后重试：${error.message}`)
        await sleep(backoff)
        backoff = Math.min(30_000, backoff * 2)
      }
    }
  }

  rememberContext(userId, contextToken) {
    if (!contextToken) return
    this.state.contextTokens ||= {}
    this.state.contextTokens[userId] = contextToken
    this.#saveState()
  }

  async sendItems(to, contextToken, itemList) {
    const value = await this.#ilink('/ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: `dsh-weixin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        message_type: 2,
        message_state: 2,
        context_token: contextToken || undefined,
        item_list: itemList,
      },
    })
    return value
  }

  async sendText(to, contextToken, text, { format = true } = {}) {
    const normalized = format ? formatForWeChat(text) : String(text || '')
    if (!normalized) return
    let remaining = normalized
    while (remaining) {
      const cut = safeTextCut(remaining, this.chunkSize)
      const part = remaining.slice(0, cut).trim()
      remaining = remaining.slice(cut).trimStart()
      if (part) await this.sendItems(to, contextToken, [{ type: 1, text_item: { text: part } }])
    }
  }

  async setTyping(userId, contextToken, active) {
    try {
      let ticket = this.typingTickets.get(userId)?.ticket
      if (!ticket) {
        const config = await this.#ilink('/ilink/bot/getconfig', {
          ilink_user_id: userId,
          context_token: contextToken || '',
        }, { timeoutMs: 15_000 })
        ticket = config.typing_ticket
        if (ticket) this.typingTickets.set(userId, { ticket, at: Date.now() })
      }
      if (!ticket) return
      await this.#ilink('/ilink/bot/sendtyping', {
        ilink_user_id: userId,
        typing_ticket: ticket,
        status: active ? 1 : 2,
      }, { timeoutMs: 15_000 })
    } catch (error) {
      this.typingTickets.delete(userId)
      this.warn('[wechat] typing 状态发送失败:', error.message)
    }
  }

  async getUploadUrl(parameters) {
    const value = await this.#ilink('/ilink/bot/getuploadurl', {
      filekey: parameters.filekey,
      media_type: parameters.mediaType,
      to_user_id: parameters.toUserId,
      rawsize: parameters.rawsize,
      rawfilemd5: parameters.rawfilemd5,
      filesize: parameters.filesize,
      no_need_thumb: true,
      aeskey: parameters.aeskeyHex,
    }, { timeoutMs: 30_000 })
    return { uploadFullUrl: value.upload_full_url || '', uploadParam: value.upload_param || '' }
  }

  async sendFile(to, contextToken, filePath, caption = '') {
    const item = await uploadOutboundFile(this, filePath, to)
    if (caption) await this.sendText(to, contextToken, caption)
    await this.sendItems(to, contextToken, [item])
  }

  async downloadMedia(message, userKey) {
    const saveDir = path.join(this.mediaDir, String(userKey).replace(/[^a-zA-Z0-9_-]/g, '_'))
    const results = []
    for (const item of message.item_list || []) {
      try {
        const result = await downloadInboundItem(item, saveDir)
        if (result) results.push(result)
      } catch (error) {
        this.warn('[wechat] 媒体下载失败:', error.message)
      }
    }
    return results
  }

  stop() {
    this.stopped = true
    this.#closeScan()
    if (this.renewal?.scanClose) {
      try { this.renewal.scanClose() } catch { /* ignore */ }
    }
    this.renewal?.controller.abort()
    this.renewal = null
    void this.notifyStop()
  }
}

export function formatQuestions(questions) {
  const lines = (questions || []).map((question, index) => {
    let line = `${index + 1}. ${question.question}`
    if (question.detail) line += `\n　${question.detail}`
    if (question.options?.length) line += `\n　可选：${question.options.map(option => option.label).join(' / ')}`
    return line
  })
  return `📋 DSH 需要你回答：\n${lines.join('\n')}\n\n请直接回复答案。`
}
