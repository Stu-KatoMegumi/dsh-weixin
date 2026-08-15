// dsh-client.mjs — DSH（DeepSeek Harness）对接层
//
// 与 Web 前端使用同一套协议（依据 DSH 源码 packages/host/apiproxy + client/connection）：
//   - POST /api/<method>      请求信封 { type:'client-request', rpcId, method, payload }
//                             响应信封 { type:'server-response', rpcId, result:{ok,value|error} }
//   - ws://<host>/api/events.mux  WebSocket 下行事件流（真实部署中 mux 是 WebSocket 升级路由，
//                             不是 SSE）；每条消息是一个 ServerRequest 帧，其中
//                             payload.type==='session/event' 时携带原始 SessionEvent
//
// 本文件与具体微信通道无关，任何适配器（ClawBot / 飞书 / 企业微信…）都只调 ask()。
// 无第三方依赖，Node >= 22（内置 WebSocket；22 以下需自行安装 ws 包）。

import crypto from 'node:crypto'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const RPC_TIMEOUT_MS = 120_000 // 单次 RPC 传输超时（不含模型回合耗时）

export class DshClient {
  /** mux 事件流首次建立成功的回调（ask 前等待用） */
  #resolveStreamOpen = null

  /**
   * @param {object} [opts]
   * @param {string} [opts.base] DSH Web 地址，默认取环境变量 DSH_URL 或 http://127.0.0.1:3080
   */
  constructor({ base = process.env.DSH_URL || 'http://127.0.0.1:3080' } = {}) {
    this.base = base.replace(/\/$/, '')
    this.sessionIds = new Map() // userKey -> 稳定 sessionId（跨重启复用，保持对话记忆）
    this.waiters = new Map()    // sessionId -> 当前回合等待器
    this.chains = new Map()     // sessionId -> 串行链（同一会话一次只跑一个回合）
    this.streaming = false
    this.stopped = false
    this.lastSeqs = new Map()          // sessionId -> 最近一次事件 seq（回合关联基准）
    this.pendingQuestions = new Map()  // questionRpcId -> { sessionId, questions }
    /** 会话内出现审批帧时的回调（默认 null，桥接方可提示用户去 Web 界面处理） */
    this.onStall = null
    /** 收到 question/requested 帧时的回调（rpcId, sessionId, questions） */
    this.onQuestion = null
    /** 回合超过 slowMs 仍未结束时回调（sessionId）——桥接方可用它先回一句"正在处理" */
    this.onSlow = null
  }

  /** 低层 RPC：发请求信封，返回业务 value；失败抛 Error（带 .code） */
  async rpc(method, payload) {
    const rpcId = crypto.randomUUID()
    let res
    try {
      res = await fetch(`${this.base}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      })
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new Error(`DSH 请求超时（${this.base}/api/${method}）`)
      }
      throw new Error(`无法连接 DSH（${this.base}）：${error.message}`)
    }
    if (!res.ok) throw new Error(`DSH HTTP ${res.status}: ${method}`)
    const msg = await res.json()
    if (msg.type !== 'server-response' || msg.rpcId !== rpcId) {
      throw new Error(`DSH 协议异常: ${method}`)
    }
    if (!msg.result.ok) {
      const error = new Error(`${method}: ${msg.result.error?.message ?? JSON.stringify(msg.result.error)}`)
      error.code = msg.result.error?.code
      throw error
    }
    return msg.result.value
  }

  /**
   * 微信用户 -> 稳定的 DSH 会话 id。
   * 会话 id 与 preset 绑定：DSH 的会话预设一经创建就固定，换 preset 必须换会话，
   * 所以把 agentPreset 也并入哈希，避免"旧会话 + 新 preset"的冲突。
   */
  sessionIdFor(userKey, agentPreset) {
    const key = `${userKey}\u0000${agentPreset ?? ''}`
    let id = this.sessionIds.get(key)
    if (!id) {
      id = 'wx-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)
      this.sessionIds.set(key, id)
    }
    return id
  }

  /**
   * 确保会话存在（幂等：同 sessionId + 同 cwd 会复用已存在的会话，对话记忆延续）
   * @param {string} userKey 微信用户标识（from_user_id）
   * @param {{cwd?: string, agentPreset?: string}} [opts]
   */
  async ensureSession(userKey, { cwd, agentPreset } = {}) {
    const sessionId = this.sessionIdFor(userKey, agentPreset)
    const payload = { sessionId }
    if (cwd !== undefined) payload.cwd = cwd
    if (agentPreset !== undefined) payload.agentPreset = agentPreset
    await this.rpc('session.create', payload)
    return sessionId
  }

  /**
   * 发送一条消息并等待该会话下一次回合结束，返回最终助手文本。
   * 同一会话的消息自动串行（前一个回合结束才发下一条），避免交错。
   *
   * 回合关联按事件 seq 而不是 turn/start 配对：提问被回答、审批被处理后
   * 恢复的旧回合不会再发 turn/start，只有 seq 基准能正确识别"下一个结束的回合"。
   * @param {string} sessionId
   * @param {string} text
   * @param {{timeoutMs?: number, slowMs?: number}} [opts]
   *   timeoutMs 回合超时（默认 15 分钟），超时自动 session.cancel；
   *   slowMs 超过该时长未结束时触发 onSlow 回调（默认 4 秒，0 关闭）
   * @returns {Promise<string>} 助手最终回复文本（可能为空串）
   */
  async ask(sessionId, text, { timeoutMs = 15 * 60 * 1000, slowMs = 4000 } = {}) {
    // 先确保事件流已建立，避免"回合太快、WS 尚未连上"而漏掉事件
    await Promise.race([this.#ensureStreaming(), sleep(5000)])
    const prev = this.chains.get(sessionId) ?? Promise.resolve()
    const run = prev.catch(() => {}).then(() => this.#askOnce(sessionId, text, timeoutMs, slowMs))
    this.chains.set(sessionId, run.catch(() => {}))
    return run
  }

  async #askOnce(sessionId, text, timeoutMs, slowMs) {
    // 发送前记录当前事件水位；此后第一个越过该水位的 turn/end 即本消息的回合
    const baseSeq = this.lastSeqs.get(sessionId) ?? -1
    const waiter = this.#openWaiter(sessionId, timeoutMs, baseSeq, slowMs)
    try {
      const value = await this.rpc('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      })
      // 以 "/" 开头的消息走 DSH 命令注册表，不会开启模型回合：直接使用命令结果
      if (value.command) {
        const out = value.command.text ?? '（命令已执行）'
        waiter.settle(out)
        return out
      }
      return await waiter.promise
    } catch (error) {
      waiter.settle(null) // 只解除等待器，错误通过 throw 向上传播
      throw error
    }
  }

  // ── 事件流（SSE）──

  #ensureStreaming() {
    if (this.streaming) return Promise.resolve()
    this.streaming = true
    const opened = new Promise((resolve) => {
      this.#resolveStreamOpen = resolve
    })
    void this.#streamLoop().catch(() => {})
    return opened
  }

  async #streamLoop() {
    while (!this.stopped) {
      try {
        await this.#openMux()
      } catch (error) {
        console.warn(`[dsh-client] 事件流断开，3 秒后重连: ${error.message}`)
      }
      if (this.stopped) break
      await sleep(3000)
    }
  }

  /** 建立 WebSocket 事件流；连接关闭/失败时 resolve/reject，由外层循环负责重连 */
  #openMux() {
    return new Promise((resolve, reject) => {
      const wsUrl = this.base.replace(/^http/, 'ws') + '/api/events.mux'
      let ws
      try {
        ws = new WebSocket(wsUrl)
      } catch (error) {
        reject(new Error(`WebSocket 创建失败: ${error.message}`))
        return
      }
      let settled = false
      const timer = setTimeout(() => settle(new Error('mux WebSocket 打开超时')), 10_000)
      const settle = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { ws.close() } catch { /* 已关闭 */ }
        if (error) reject(error)
        else resolve()
      }
      ws.onopen = () => {
        clearTimeout(timer) // 连接已建立，撤销打开超时定时器
        this.#resolveStreamOpen?.()
        this.#resolveStreamOpen = null
      }
      ws.onerror = () => settle(new Error('mux WebSocket 连接失败'))
      ws.onmessage = (event) => {
        try {
          this.#handleFrame(JSON.parse(String(event.data)))
        } catch (error) {
          console.warn('[dsh-client] 帧解析失败:', error.message)
        }
      }
      ws.onclose = () => settle() // 无论关闭原因，交给外层重连
    })
  }

  #handleFrame(frame) {
    if (frame?.type !== 'server-request') return
    const payload = frame.payload
    if (payload?.type === 'session/event') {
      const { sessionId, event } = payload
      this.lastSeqs.set(sessionId, event.seq) // 永远推进水位
      const waiter = this.waiters.get(sessionId)
      if (!waiter || event.seq <= waiter.baseSeq) return
      if (event.type === 'assistant/message') {
        const text = (event.data?.message?.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
        if (text) waiter.text = text // 回合内取最后一份完整文本
      } else if (event.type === 'turn/end') {
        waiter.settle(waiter.text ?? '')
      }
    } else if (payload?.type === 'question/requested') {
      // 回合被挂起等待用户回答：记录并转发给桥接方，用微信回复自动应答
      // （mux 重连会重放挂起提问，rpcId 相同，避免重复转发）
      if (!this.pendingQuestions.has(frame.rpcId)) {
        this.pendingQuestions.set(frame.rpcId, { sessionId: payload.sessionId, questions: payload.questions })
        if (this.onQuestion) this.onQuestion(frame.rpcId, payload.sessionId, payload.questions)
      }
    } else if (payload?.type === 'approval/requested') {
      // 回合会被挂起等待 Web 端应答；通知桥接方，由用户去 DSH Web 界面处理
      console.warn(`[dsh-client] 会话 ${payload.sessionId} 发起 ${payload.type}，等待 Web 端应答…`)
      if (this.onStall) this.onStall(payload.sessionId, payload)
    }
  }

  /** 该会话当前是否有挂起的提问（rpcId + questions）；无则 undefined */
  pendingQuestion(sessionId) {
    for (const [rpcId, pending] of this.pendingQuestions) {
      if (pending.sessionId === sessionId) return { rpcId, questions: pending.questions }
    }
    return undefined
  }

  /**
   * 用一段文本回答挂起的提问（客户端响应，走 POST /api/respond）。
   * @param {string} rpcId 提问帧的 rpcId（稳定逻辑 id）
   * @param {string} sessionId
   * @param {string} text 用户的回复，作为 custom 答案
   */
  async answerQuestion(rpcId, sessionId, text) {
    const pending = this.pendingQuestions.get(rpcId)
    if (!pending) throw new Error(`提问 ${rpcId} 不存在或已应答`)
    const answers = (pending.questions ?? []).map((q) => ({ id: q.id, selected: [], custom: text }))
    const value = { sessionId, answer: { answers } }
    this.pendingQuestions.delete(rpcId)
    return this.respond(rpcId, value)
  }

  /** 客户端响应（应答服务端发起的提问/审批等），返回 RpcReceipt */
  async respond(rpcId, value) {
    let res
    try {
      res = await fetch(`${this.base}/api/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      })
    } catch (error) {
      throw new Error(`DSH 应答失败（${this.base}/api/respond）：${error.message}`)
    }
    return res.json()
  }

  // ── 回合等待器 ──

  #openWaiter(sessionId, timeoutMs, baseSeq, slowMs) {
    let resolveFn, rejectFn
    const waiter = {
      baseSeq,
      text: '',
      settled: false,
      promise: null,
      settle: null,
    }
    waiter.promise = new Promise((resolve, reject) => {
      resolveFn = resolve
      rejectFn = reject
    })
    // 防止超时路径出现无人 await 的未处理拒绝
    waiter.promise.catch(() => {})
    // 慢任务提醒：超过 slowMs 未结束，通知桥接方先回一句"正在处理"
    const slowTimer = slowMs > 0
      ? setTimeout(() => {
        if (!waiter.settled) {
          console.log(`[dsh-client] 会话 ${sessionId} 处理中（>${slowMs}ms）…`)
          if (this.onSlow) this.onSlow(sessionId)
        }
      }, slowMs)
      : null
    const timer = setTimeout(() => {
      if (waiter.settled) return
      waiter.settled = true
      if (slowTimer) clearTimeout(slowTimer)
      console.warn(`[dsh-client] 会话 ${sessionId} 回合超时，取消…`)
      void this.rpc('session.cancel', { sessionId }).catch(() => {})
      rejectFn(new Error(`DSH 回合超时（${Math.round(timeoutMs / 1000)}s），已取消`))
    }, timeoutMs)
    waiter.settle = (text) => {
      if (waiter.settled) return
      waiter.settled = true
      clearTimeout(timer)
      if (slowTimer) clearTimeout(slowTimer)
      resolveFn(text)
    }
    this.waiters.set(sessionId, waiter)
    return waiter
  }

  /** 供适配器在桥退出时调用 */
  stop() {
    this.stopped = true
  }
}
