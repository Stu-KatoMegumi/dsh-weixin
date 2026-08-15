// src/core/engine.mjs — 核心编排（两种模式共享）
//
// 流程：微信消息 → 复杂度判断 →（复杂：先回"好的，我先思考一下"+ 切思考模型）
//       → 保证会话存在（含「微信会话」分组）→ 存入本地历史 → 发送给 DSH 解答 →
//       回复存入本地历史 → 转发回微信显示。
// 附带：agent 提问转发微信并自动应答、慢任务兜底"正在处理"、长回复分块。

import { formatQuestions } from './wechat.mjs'

/** 复杂任务关键词（命中即判定为长任务，先思考确认再执行） */
const ACTION_RE = /(写|改|创建|生成|删除|移动|复制|运行|执行|启动|停止|安装|下载|上传|搜索|查询|查找|分析|总结|整理|重构|调试|测试|构建|打包|部署|提交|推送|合并|克隆|备份|翻译|转换|压缩|解压|读取|查看|打开|列出|统计|计算|规划|设计|开发|实现|排查|修复|对比|监控|定时|任务|项目|文件|代码|脚本|命令|目录|文件夹|网页|接口|docker|git|npm|pnpm|node|python|pip|ssh|数据库|mysql|redis|sql|api)/i

/** 从环境变量解析模型路由配置（默认：简单→flash 关思考，复杂→pro 高思考） */
export function modelConfig(env = process.env) {
  const spec = (model, reasoning) => {
    if (!model) return null
    const slash = model.indexOf('/')
    return {
      provider: slash > 0 ? model.slice(0, slash) : 'deepseek-official',
      model: slash > 0 ? model.slice(slash + 1) : model,
      reasoningEffort: reasoning ? String(reasoning).toLowerCase() : undefined, // 目录里 effort id 是小写
    }
  }
  return {
    fastModel: spec(env.WX_BOT_FAST_MODEL || 'deepseek-official/deepseek-v4-flash', env.WX_BOT_FAST_REASONING || 'off'),
    complexModel: spec(env.WX_BOT_COMPLEX_MODEL || 'deepseek-official/deepseek-v4-pro', env.WX_BOT_COMPLEX_REASONING || 'high'),
    complexAckText: env.WX_BOT_COMPLEX_ACK_TEXT || '好的，我先思考一下，稍后给你结果…',
  }
}

export class Engine {
  /**
   * @param {object} deps
   * @param {import('./wechat.mjs').WeChatClient} deps.wechat
   * @param {import('./store.mjs').Store} deps.store
   * @param {import('../dsh/transport.mjs').BaseTransport} deps.transport
   * @param {object} deps.config { slowAckMs, turnTimeoutMs, fastModel, complexModel, complexAckText }
   */
  constructor({ wechat, store, transport, config }) {
    this.wechat = wechat
    this.store = store
    this.transport = transport
    this.slowAckMs = config.slowAckMs ?? 4000
    this.turnTimeoutMs = config.turnTimeoutMs ?? 15 * 60 * 1000
    this.fastModel = config.fastModel ?? null
    this.complexModel = config.complexModel ?? null
    this.complexAckText = config.complexAckText ?? '好的，我先思考一下，稍后给你结果…'
    this.userBySession = new Map() // sessionId -> { from, token }
    this.started = false
  }

  start() {
    if (this.started) return
    this.started = true
    this.transport.onQuestion = (rpcId, sessionId, questions) => this.#forwardQuestion(rpcId, sessionId, questions)
    this.transport.onSlow = (sessionId) => this.#slowAck(sessionId)
    this.transport.onStall = (sessionId) => {
      console.warn(`[engine] 会话 ${sessionId} 发起审批，请在 DSH Web 界面处理`)
    }
    this.transport.start()
    // 微信侧：先确保登录，再开始长轮询（不阻塞启动）
    void (async () => {
      try {
        await this.wechat.ensureLogin()
        console.log('[engine] 开始长轮询收消息…')
        await this.wechat.startPolling((msg) => this.handleWechatMessage(msg))
      } catch (error) {
        console.error('[engine] 微信通道启动失败:', error.message)
      }
    })()
  }

  stop() {
    this.started = false
    this.wechat.stop()
    this.transport.stop()
  }

  // ── 微信消息入口 ──

  async handleWechatMessage(msg) {
    if (msg.message_type !== 1) return // 只处理用户消息（BOT 发出的 type=2 不回环）
    if (msg.group_id) {
      console.log('[engine] 跳过群消息（当前只处理单聊）:', msg.group_id)
      return
    }
    const text = msg.item_list?.find((item) => item.type === 1)?.text_item?.text
    if (!text) {
      await this.wechat.sendText(msg.from_user_id, msg.context_token, '暂时只支持文字消息')
      return
    }

    const userKey = msg.from_user_id
    const { sessionId } = await this.transport.ensureSession(userKey)
    this.store.touchUser(userKey, sessionId, msg.context_token)
    this.userBySession.set(sessionId, { from: userKey, token: msg.context_token })

    // 若该会话正被 agent 提问挂起，则把这条消息作为回答提交，而不是开新回合
    const pending = this.transport.pendingQuestion(sessionId)
    if (pending) {
      this.store.appendHistory(userKey, 'user', text)
      console.log(`[engine] ${userKey} 回答提问 ${pending.rpcId.slice(0, 8)}: ${text.slice(0, 80)}`)
      try {
        await this.transport.answerQuestion(pending.rpcId, sessionId, text)
        await this.wechat.sendText(userKey, msg.context_token, '已收到你的回答，继续处理中…')
      } catch (error) {
        console.error('[engine] 提交回答失败:', error.message)
        await this.wechat.sendText(userKey, msg.context_token, `提交回答失败：${error.message}`)
      }
      return
    }

    this.store.appendHistory(userKey, 'user', text)
    console.log(`[engine] ${userKey}: ${text.slice(0, 80)}  -> 会话 ${sessionId}`)
    try {
      // 复杂度判断：复杂任务先回"好的，我先思考一下"并切思考模型；简单任务切快模型秒回
      const complex = this.#isComplex(text)
      let model = null
      let slowMs = this.slowAckMs
      if (complex) {
        await this.wechat.sendText(userKey, msg.context_token, this.complexAckText)
        model = await this.#selectModel(sessionId, this.complexModel)
        slowMs = 0 // 已有"思考中"文案，关闭 4 秒兜底提示
      } else {
        model = await this.#selectModel(sessionId, this.fastModel)
      }
      const reply = await this.transport.ask(sessionId, text, {
        timeoutMs: this.turnTimeoutMs,
        slowMs,
      })
      const out = reply || '（DSH 没有返回内容）'
      this.store.appendHistory(userKey, 'assistant', out)
      await this.wechat.sendText(userKey, msg.context_token, out)
      console.log(
        `[engine] 回合完成（${complex ? '复杂' : '简单'}` +
        (model ? `，模型=${model.model}/${model.reasoningEffort || '默认'}` : '') + '）',
      )
    } catch (error) {
      console.error('[engine] 回合失败:', error.message)
      await this.wechat.sendText(userKey, msg.context_token, `出错：${error.message}`)
    }
  }

  // ── 内部：复杂度判断与模型路由 ──

  /** 短文本且无动作关键词 = 简单任务（秒回）；否则视为复杂任务（先思考） */
  #isComplex(text) {
    if (text.length > 40) return true
    return ACTION_RE.test(text)
  }

  /** 切换会话模型；失败不阻塞（沿用会话当前模型） */
  async #selectModel(sessionId, spec) {
    if (!spec || typeof this.transport.selectModel !== 'function') return null
    try {
      await this.transport.selectModel(sessionId, spec)
      return spec
    } catch (error) {
      console.warn(`[engine] 模型切换失败（${spec.provider}/${spec.model}）: ${error.message}`)
      return null
    }
  }

  // ── 内部：定位微信用户（优先本次运行见过的，其次本地 users.json 兜底）──

  #userOf(sessionId) {
    const direct = this.userBySession.get(sessionId)
    if (direct) return direct
    const users = this.store.loadUsers()
    for (const [key, rec] of Object.entries(users)) {
      if (rec.sessionId === sessionId && rec.lastContextToken) {
        return { from: key, token: rec.lastContextToken }
      }
    }
    return null
  }

  #forwardQuestion(rpcId, sessionId, questions) {
    const user = this.#userOf(sessionId)
    if (!user) {
      console.warn(`[engine] 会话 ${sessionId} 有提问但找不到对应微信用户，请在 Web 界面处理`)
      return
    }
    void this.wechat.sendText(user.from, user.token, formatQuestions(questions)).catch((error) => {
      console.error('[engine] 转发提问失败:', error.message)
    })
  }

  #slowAck(sessionId) {
    const user = this.#userOf(sessionId)
    if (!user) return
    void this.wechat.sendText(user.from, user.token, '⏳ 收到，正在处理，完成后回复你…').catch((error) => {
      console.error('[engine] 发送"正在处理"失败:', error.message)
    })
  }
}
