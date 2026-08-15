import fs from 'node:fs'
import path from 'node:path'
import { formatQuestions } from './wechat.mjs'
import { safeTextCut } from './format.mjs'
import { cronMatches, minuteKey } from './scheduler.mjs'
import { PROMPT_FILES, ensurePromptFiles, renderPrompt, readPromptFile, writePromptFile, resetPromptFile, editablePromptDir } from './prompt.mjs'

const ACTION_RE = /(写|改|创建|生成|删除|移动|复制|运行|执行|启动|停止|安装|下载|上传|搜索|查询|查找|分析|总结|整理|重构|调试|测试|构建|打包|部署|提交|推送|合并|克隆|备份|翻译|转换|解压|代码|脚本|命令|文件|项目|docker|git|npm|pnpm|node|python|pip|ssh|sql|api)/i

function stringList(value) {
  if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean)
  return String(value || '').split(/[\s,;\n]+/).map(item => item.trim()).filter(Boolean)
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'string') return !['0', 'false', 'off', 'no'].includes(value.toLowerCase())
  return Boolean(value)
}

function sessionIdFrom(value) {
  return value?.sessionId || value?.session?.sessionId || value?.session?.id || value?.id
}

function within(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Extract the consumable text from one inbound iLink message.
 * Mirrors the official openclaw-weixin semantics: the first consumable item
 * wins — a text item (type 1) with quoted context, then voice transcription
 * (type 3, voice_item.text). Item types are compared numerically so string
 * serialized enums are tolerated.
 */
export function extractMessageText(msg) {
  for (const item of msg?.item_list || []) {
    const type = Number(item?.type)
    if (type === 1 && item?.text_item?.text) {
      const text = String(item.text_item.text)
      const ref = item.ref_msg
      if (!ref) return text
      const refItem = ref.message_item
      const refIsText = refItem && Number(refItem.type) === 1 && refItem.text_item?.text
      const parts = []
      if (ref.title) parts.push(String(ref.title))
      if (refIsText) parts.push(String(refItem.text_item.text))
      if (!parts.length) return text
      return `[引用: ${parts.join(' | ')}]\n${text}`
    }
    if (type === 3 && item?.voice_item?.text) return String(item.voice_item.text)
  }
  return ''
}

export function normalizeConfig(config = {}) {
  return {
    enabled: bool(config.enabled, true),
    streaming: bool(config.streaming, true),
    typing: bool(config.typing, true),
    mediaEnabled: bool(config.mediaEnabled, true),
    renewalEnabled: bool(config.renewalEnabled, true),
    accessPolicy: ['pairing', 'allowlist', 'disabled'].includes(config.accessPolicy) ? config.accessPolicy : 'pairing',
    allowlist: stringList(config.allowlist),
    admins: stringList(config.admins),
    slowAckMs: Number(config.slowAckMs ?? 4000),
    turnTimeoutMs: Number(config.turnTimeoutMs ?? 15 * 60 * 1000),
    // streamFlushChars = 单气泡长度上限；streamFlushMs = 空闲超时（无新内容自动发）
    streamFlushChars: Math.max(200, Number(config.streamFlushChars ?? 1500)),
    streamFlushMs: Math.max(500, Number(config.streamFlushMs ?? 3000)),
    maintenanceIntervalMs: Math.max(10_000, Number(config.maintenanceIntervalMs ?? 60_000)),
    complexAckText: String(config.complexAckText || '好的，我先思考一下，稍后给你结果。'),
    fastModel: config.fastModel ?? null,
    complexModel: config.complexModel ?? null,
    outboxDir: path.resolve(config.outboxDir || path.join(config.sessionCwd || process.cwd(), 'outbox')),
    jobs: Array.isArray(config.jobs) ? config.jobs : [],
  }
}

export function modelConfig(env = process.env) {
  const spec = (model, reasoning) => {
    if (!model) return null
    const slash = model.indexOf('/')
    return {
      provider: slash > 0 ? model.slice(0, slash) : 'deepseek-official',
      model: slash > 0 ? model.slice(slash + 1) : model,
      reasoningEffort: reasoning ? String(reasoning).toLowerCase() : undefined,
    }
  }
  return {
    fastModel: spec(env.WX_BOT_FAST_MODEL || 'deepseek-official/deepseek-v4-flash', env.WX_BOT_FAST_REASONING || 'off'),
    complexModel: spec(env.WX_BOT_COMPLEX_MODEL || 'deepseek-official/deepseek-v4-pro', env.WX_BOT_COMPLEX_REASONING || 'high'),
    complexAckText: env.WX_BOT_COMPLEX_ACK_TEXT || '好的，我先思考一下，稍后给你结果。',
  }
}

/**
 * 流式回复 → 微信气泡的中继。
 * 主规则：LLM 输出双回车（空行）即视为一个气泡结束，立即发送（双回车不进文案）。
 * 兜底 1（flushChars）：单个气泡达到长度上限时，在最近的换行/标点处强制切分。
 * 兜底 2（flushMs）：收到内容后超过 flushMs 没有新内容，强制发出当前气泡，避免“没反应”。
 */
export class StreamRelay {
  constructor({ wechat, to, token, enabled, flushChars, flushMs }) {
    this.wechat = wechat
    this.to = to
    this.token = token
    this.enabled = enabled
    this.flushChars = flushChars
    this.flushMs = flushMs
    this.buffer = ''
    this.all = ''
    this.sent = false
    this.timer = null
    this.chain = Promise.resolve()
  }

  push(delta) {
    if (!this.enabled || !delta) return
    this.buffer += delta
    this.all += delta
    this.#splitOnBlankLine()
    if (!this.buffer) return
    if (this.buffer.length >= this.flushChars) this.flush(false)
    else this.#arm()
  }

  /** 主规则：双回车（空行）即切气泡。 */
  #splitOnBlankLine() {
    let index
    while ((index = this.buffer.indexOf('\n\n')) >= 0) {
      const part = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 2)
      this.#sendPart(part)
    }
  }

  flush(force) {
    clearTimeout(this.timer)
    this.timer = null
    if (!this.buffer) return
    if (!force && this.buffer.length < this.flushChars) return this.#arm()
    const count = force ? this.buffer.length : safeTextCut(this.buffer, this.flushChars)
    const part = this.buffer.slice(0, count)
    this.buffer = this.buffer.slice(count)
    this.#sendPart(part)
    if (this.buffer) this.#arm()
  }

  /** 发送一个气泡；异常的超长段（超过上限）再按上限切分。 */
  #sendPart(part) {
    const trimmed = part.trim()
    if (!trimmed) return
    if (trimmed.length <= this.flushChars) {
      this.#send(trimmed)
      return
    }
    let remaining = trimmed
    while (remaining) {
      const count = safeTextCut(remaining, this.flushChars)
      const piece = remaining.slice(0, count)
      remaining = remaining.slice(count)
      if (piece.trim()) this.#send(piece.trim())
    }
  }

  #send(part) {
    this.sent = true
    this.chain = this.chain.then(() => this.wechat.sendText(this.to, this.token, part))
  }

  #arm() {
    if (!this.timer && this.buffer) this.timer = setTimeout(() => this.flush(true), this.flushMs)
  }

  async finish(finalText) {
    clearTimeout(this.timer)
    this.timer = null
    if (this.enabled) this.flush(true)
    await this.chain
    if (!this.sent) await this.wechat.sendText(this.to, this.token, finalText || '（DSH 没有返回文本内容）')
  }
}

export class Engine {
  constructor({ wechat, store, transport, config = {}, promptDir = null, defaultPromptDir = null, logger = null }) {
    this.wechat = wechat
    this.store = store
    this.transport = transport
    this.logger = logger || {
      log: (...args) => console.log(...args),
      warn: (...args) => console.warn(...args),
      error: (...args) => console.error(...args),
    }
    this.baseConfig = { ...config }
    this.config = normalizeConfig({ ...config, ...store.loadSettings() })
    // 可定制 prompt：可编辑副本位于频道数据目录，默认文件位于项目 src/prompt/
    this.promptDir = promptDir || editablePromptDir(store.dir)
    this.defaultPromptDir = defaultPromptDir || path.join(process.cwd(), 'src', 'prompt')
    ensurePromptFiles(this.defaultPromptDir, this.promptDir)
    this.userBySession = new Map()
    this.started = false
    this.maintenanceTimer = null
    this.jobRuns = new Map()
  }

  start() {
    if (this.started) return
    this.store.acquireLock()
    this.started = true
    this.transport.onQuestion = (rpcId, sessionId, questions) => this.#forwardQuestion(rpcId, sessionId, questions)
    this.transport.onSlow = sessionId => this.#slowAck(sessionId)
    this.transport.onStall = value => this.logger.warn('[engine] DSH 通道告警:', value)
    this.transport.start()
    this.maintenanceTimer = setInterval(() => void this.#maintenance(), this.config.maintenanceIntervalMs)
    this.maintenanceTimer.unref?.()
    void this.#startWechat()
  }

  async #startWechat() {
    try {
      await this.wechat.ensureLogin()
      this.logger.log('[engine] 微信通道已启动，正在接收消息')
      await this.wechat.startPolling(message => this.handleWechatMessage(message))
    } catch (error) {
      this.store.appendError('wechat.start', error)
      this.logger.error('[engine] 微信通道启动失败:', error.message)
    }
  }

  stop() {
    if (!this.started) return
    this.started = false
    clearInterval(this.maintenanceTimer)
    this.maintenanceTimer = null
    this.wechat.stop()
    this.transport.stop()
    this.store.releaseLock()
  }

  getSettings() { return { ...this.config } }

  updateSettings(patch) {
    const allowed = [
      'enabled', 'streaming', 'typing', 'mediaEnabled', 'renewalEnabled', 'accessPolicy',
      'allowlist', 'admins', 'slowAckMs', 'turnTimeoutMs', 'streamFlushChars', 'streamFlushMs',
      'complexAckText', 'outboxDir', 'jobs',
    ]
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([key]) => allowed.includes(key)))
    const stored = this.store.updateSettings(clean)
    this.config = normalizeConfig({ ...this.baseConfig, ...stored })
    return this.getSettings()
  }

  status() {
    return {
      started: this.started,
      wechat: this.wechat.status(),
      settings: this.getSettings(),
      users: Object.keys(this.store.loadUsers()).length,
      recentErrors: this.store.readErrors(10),
    }
  }

  async handleWechatMessage(msg) {
    if (msg?.message_type !== 1 || msg?.group_id || !msg?.from_user_id) return
    const userKey = String(msg.from_user_id)
    const contextToken = msg.context_token || ''
    this.wechat.rememberContext(userKey, contextToken)
    if (!this.#allowed(userKey)) {
      if (this.config.accessPolicy !== 'disabled') {
        await this.wechat.sendText(userKey, contextToken, '该微信账号尚未获得 dsh-weixin 访问权限。')
      }
      return
    }

    const itemTypes = (msg.item_list || []).map(item => item?.type ?? '?').join(',') || 'none'
    let text = extractMessageText(msg).trim()
    this.logger.log(`[engine] 收到 ${userKey} 消息（item: ${itemTypes}${msg.message_state != null ? `，state: ${msg.message_state}` : ''}）${text ? `: ${text.slice(0, 80)}` : '（无文本）'}`)
    let media = []
    if (this.config.mediaEnabled) media = await this.wechat.downloadMedia(msg, userKey)
    if (media.length) {
      const attachmentText = media.map(item => `- ${item.kind}: ${item.savedPath} (${item.size} bytes)`).join('\n')
      text = `${text}${text ? '\n\n' : ''}用户从微信发来了以下附件，请根据需要读取和处理：\n${attachmentText}`
    }
    if (!text) {
      this.logger.warn(`[engine] ${userKey} 的消息无法提取文本（item 类型: ${itemTypes}，message_state: ${msg.message_state ?? '?'}）`)
      await this.wechat.sendText(userKey, contextToken, this.config.mediaEnabled
        ? '暂时无法识别这条消息。'
        : '当前已关闭媒体接收，请发送文字。')
      return
    }

    try {
      const record = await this.#ensureUser(userKey, contextToken)
      this.logger.log(`[engine] ${userKey} -> 会话 ${record.sessionId}`)
      if (text.startsWith('/')) {
        await this.#command(userKey, contextToken, record.sessionId, text)
        return
      }
      await this.#runTurn(userKey, contextToken, record.sessionId, text)
    } catch (error) {
      this.store.appendError('message', error, { userKey })
      this.logger.error('[engine] 消息处理失败:', error.message)
      await this.wechat.setTyping(userKey, contextToken, false)
      await this.wechat.sendText(userKey, contextToken, `处理失败：${error.message}`).catch(() => {})
    }
  }

  async #ensureUser(userKey, contextToken) {
    const saved = this.store.getUser(userKey)
    const created = await this.transport.ensureSession(userKey, saved?.sessionId ? { sessionId: saved.sessionId } : {})
    const sessionId = sessionIdFrom(created) || saved?.sessionId
    if (!sessionId) throw new Error('DSH 未返回会话 ID')
    const record = this.store.touchUser(userKey, sessionId, contextToken)
    this.userBySession.set(sessionId, { from: userKey, token: contextToken })
    return record
  }

  async #runTurn(userKey, contextToken, sessionId, text) {
    const pending = this.transport.pendingQuestion(sessionId)
    if (pending) {
      this.store.appendHistory(userKey, 'user', text)
      await this.transport.answerQuestion(pending.rpcId, sessionId, text)
      await this.wechat.sendText(userKey, contextToken, '已收到你的回答，继续处理中。')
      return
    }

    this.store.appendHistory(userKey, 'user', text)
    const complex = text.length > 40 || ACTION_RE.test(text)
    if (complex && !this.config.streaming) await this.wechat.sendText(userKey, contextToken, this.config.complexAckText)
    await this.#selectModel(sessionId, complex ? this.config.complexModel : this.config.fastModel)
    if (this.config.typing) await this.wechat.setTyping(userKey, contextToken, true)
    const relay = new StreamRelay({
      wechat: this.wechat,
      to: userKey,
      token: contextToken,
      enabled: this.config.streaming,
      flushChars: this.config.streamFlushChars,
      flushMs: this.config.streamFlushMs,
    })
    try {
      const reply = await this.transport.ask(sessionId, this.#buildPromptMessage(text), {
        timeoutMs: this.config.turnTimeoutMs,
        slowMs: complex ? 0 : this.config.slowAckMs,
        onDelta: delta => relay.push(delta),
      })
      this.store.appendHistory(userKey, 'assistant', reply || '')
      await relay.finish(reply)
    } finally {
      if (this.config.typing) await this.wechat.setTyping(userKey, contextToken, false)
    }
  }

  /** 把可定制 prompt 渲染后拼到用户消息前（每次读取，改文件即热生效）。 */
  #buildPromptMessage(text) {
    const prompt = renderPrompt(this.promptDir)
    if (!prompt) return text
    return [
      '[系统设定（来自 dsh-weixin 定制，非用户输入，请始终遵守）]',
      prompt,
      '[设定结束]',
      '',
      `用户消息：\n${text}`,
    ].join('\n')
  }

  /** 设置页控制 API：prompt 文件列表（含内容与是否默认）。 */
  listPrompts() {
    return {
      dir: this.promptDir,
      files: PROMPT_FILES.map(name => ({
        name,
        content: readPromptFile(this.promptDir, name) ?? '',
        isDefault: (readPromptFile(this.promptDir, name) ?? '') === (readPromptFile(this.defaultPromptDir, name) ?? ''),
      })),
    }
  }

  savePrompt(name, content) {
    writePromptFile(this.promptDir, name, content)
    return { name, saved: true }
  }

  resetPrompt(name) {
    resetPromptFile(this.defaultPromptDir, this.promptDir, name)
    return { name, reset: true }
  }

  async #command(userKey, token, sessionId, input) {
    const [command, ...args] = input.trim().split(/\s+/)
    const admin = this.config.admins.includes(userKey)
    if (command === '/help') {
      await this.wechat.sendText(userKey, token, [
        '🤖 dsh-weixin 命令',
        '/new - 开始新会话', '/stop - 停止当前任务', '/status - 查看连接状态',
        '/send <outbox内相对路径> - 发送文件', '/renew - 扫码续期',
        ...(admin ? ['/users - 列出已知用户', '/allow add|remove <ID> - 管理白名单', '/cron - 列出定时任务'] : []),
      ].join('\n'))
      return
    }
    if (command === '/new') {
      const created = await this.transport.ensureSession(userKey, { fresh: true })
      const freshId = sessionIdFrom(created)
      if (!freshId) throw new Error('DSH 创建新会话失败')
      this.store.touchUser(userKey, freshId, token)
      this.userBySession.set(freshId, { from: userKey, token })
      await this.wechat.sendText(userKey, token, `已开始新会话：${freshId}`)
      return
    }
    if (command === '/stop') {
      await this.transport.cancel(sessionId)
      await this.wechat.sendText(userKey, token, '已请求停止当前任务。')
      return
    }
    if (command === '/status') {
      const state = this.wechat.status()
      await this.wechat.sendText(userKey, token, `微信：${state.connected ? '已连接' : '未连接'}\n流式输出：${this.config.streaming ? '开' : '关'}\n会话：${sessionId}\n最近轮询：${state.lastSuccessAt ? new Date(state.lastSuccessAt).toLocaleString() : '无'}`)
      return
    }
    if (command === '/renew') {
      const url = await this.wechat.beginRenewal(userKey, { notify: false })
      await this.wechat.sendText(userKey, token, `续期二维码链接：\n${url}`)
      return
    }
    if (command === '/send') {
      const requested = args.join(' ')
      if (!requested) throw new Error('用法：/send <outbox 内的相对路径>')
      const candidate = path.resolve(this.config.outboxDir, requested)
      if (!within(this.config.outboxDir, candidate)) throw new Error('只能发送 outbox 目录内的文件')
      if (!fs.statSync(candidate).isFile()) throw new Error('目标不是文件')
      await this.wechat.sendFile(userKey, token, candidate)
      return
    }
    if (command === '/users' && admin) {
      await this.wechat.sendText(userKey, token, Object.entries(this.store.loadUsers())
        .map(([id, value]) => `${id}  ${value.lastActiveAt || ''}`).join('\n') || '暂无用户')
      return
    }
    if (command === '/cron' && admin) {
      const lines = this.config.jobs.map(job => `${job.enabled === false ? '⏸' : '▶'} ${job.id || '-'}  ${job.cron || '-'}  ${job.userId || '-'}`)
      await this.wechat.sendText(userKey, token, lines.join('\n') || '暂无定时任务')
      return
    }
    if (command === '/allow' && admin) {
      const [operation, target] = args
      if (!['add', 'remove'].includes(operation) || !target) throw new Error('用法：/allow add|remove <用户ID>')
      const allowlist = new Set(this.config.allowlist)
      if (operation === 'add') allowlist.add(target)
      else allowlist.delete(target)
      this.updateSettings({ allowlist: [...allowlist] })
      await this.wechat.sendText(userKey, token, `白名单已更新，共 ${allowlist.size} 个用户。`)
      return
    }
    await this.wechat.sendText(userKey, token, '未知命令，发送 /help 查看用法。')
  }

  #allowed(userKey) {
    if (!this.config.enabled || this.config.accessPolicy === 'disabled') return false
    if (this.config.admins.includes(userKey)) return true
    return this.config.accessPolicy !== 'allowlist' || this.config.allowlist.includes(userKey)
  }

  async #selectModel(sessionId, spec) {
    if (!spec) return
    try { await this.transport.selectModel(sessionId, spec) } catch (error) {
      this.logger.warn(`[engine] 模型切换失败，继续使用当前模型：${error.message}`)
    }
  }

  #userOf(sessionId) {
    const direct = this.userBySession.get(sessionId)
    if (direct) return direct
    for (const [from, record] of Object.entries(this.store.loadUsers())) {
      if (record.sessionId === sessionId && record.lastContextToken) return { from, token: record.lastContextToken }
    }
    return null
  }

  #forwardQuestion(rpcId, sessionId, questions) {
    const user = this.#userOf(sessionId)
    if (!user) return this.logger.warn(`[engine] 会话 ${sessionId} 的提问无法定位微信用户`)
    void this.wechat.sendText(user.from, user.token, formatQuestions(questions)).catch(error => {
      this.store.appendError('question.forward', error, { sessionId })
    })
  }

  #slowAck(sessionId) {
    const user = this.#userOf(sessionId)
    if (user) void this.wechat.sendText(user.from, user.token, '⏳ 收到，正在处理，完成后回复你。').catch(() => {})
  }

  async #maintenance() {
    if (!this.started) return
    try {
      const users = Object.entries(this.store.loadUsers()).sort((a, b) => String(b[1].lastActiveAt).localeCompare(String(a[1].lastActiveAt)))
      const recipient = this.config.admins.find(id => this.store.getUser(id)?.lastContextToken) || users[0]?.[0]
      if (this.config.renewalEnabled) await this.wechat.checkRenewal(recipient)
      const now = new Date()
      const key = minuteKey(now)
      for (const job of this.config.jobs) {
        if (job?.enabled === false || !job?.userId || !job?.prompt || !cronMatches(job.cron, now)) continue
        const jobKey = `${job.id || job.prompt}:${key}`
        if (this.jobRuns.has(jobKey)) continue
        this.jobRuns.set(jobKey, Date.now())
        const user = this.store.getUser(job.userId)
        if (!user?.lastContextToken) continue
        const record = await this.#ensureUser(job.userId, user.lastContextToken)
        void this.#runTurn(job.userId, user.lastContextToken, record.sessionId, job.prompt).catch(error => {
          this.store.appendError('cron', error, { jobId: job.id })
        })
      }
      for (const [jobKey, at] of this.jobRuns) if (Date.now() - at > 3_600_000) this.jobRuns.delete(jobKey)
    } catch (error) {
      this.store.appendError('maintenance', error)
    }
  }
}
