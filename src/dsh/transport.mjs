// Shared transport for the DSH in-process and HTTP adapters.
//
// DSH exposes one logical event contract over two physical transports.  This
// class deliberately knows only that a transport can send prompts/cancels and
// deliver MuxFrame objects; the API-specific code lives in inproc.mjs/http.mjs.

import crypto from 'node:crypto'

const DEFAULT_TIMEOUT = 15 * 60 * 1000
const DEFAULT_SLOW = 4 * 1000

function newRpcId(prefix = 'dsh-weixin') {
  return `${prefix}-${crypto.randomUUID()}`
}

function rpcError(result, fallback = 'DSH RPC failed') {
  const error = result?.error ?? result
  const message = typeof error === 'string' ? error : error?.message || fallback
  const out = new Error(message)
  if (error && typeof error === 'object') {
    out.code = error.code
    out.details = error.details
  }
  return out
}

function unwrapResult(response) {
  const result = response?.result ?? response
  if (result?.ok === false) throw rpcError(result)
  return result?.ok === true ? result.value : result
}

function textFromValue(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  if (typeof value.text === 'string') return value.text
  if (typeof value.content === 'string') return value.content
  if (Array.isArray(value.content)) {
    return value.content.map((part) => textFromValue(part)).filter(Boolean).join('')
  }
  if (Array.isArray(value.parts)) {
    return value.parts.map((part) => textFromValue(part)).filter(Boolean).join('')
  }
  if (value.message) return textFromValue(value.message)
  return ''
}

function eventText(event) {
  const data = event?.data ?? event
  return textFromValue(data?.message ?? data?.content ?? data?.text ?? data)
}

function eventKind(event) {
  return event?.type || event?.kind || event?.event || ''
}

function eventTurn(event) {
  const data = event?.data
  return data?.turn ?? event?.turn ?? data?.turnId ?? event?.turnId ?? null
}

export class BaseTransport {
  constructor({ timeoutMs = DEFAULT_TIMEOUT, slowMs = DEFAULT_SLOW } = {}) {
    this.timeoutMs = timeoutMs
    this.slowMs = slowMs
    this.started = false
    this.lastSeq = new Map()
    this.turns = new Map()
    this.waiters = new Map()
    this.questions = new Map()
    this.onQuestion = () => {}
    this.onSlow = () => {}
    this.onStall = () => {}
  }

  start() {
    if (this.started) return
    this.started = true
    try {
      this._startStream?.()
    } catch (error) {
      this.started = false
      throw error
    }
  }

  stop() {
    this.started = false
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timeout)
      clearTimeout(waiter.slowTimer)
      waiter.reject(new Error('DSH transport stopped'))
    }
    this.waiters.clear()
    this.questions.clear()
    this.turns.clear()
    this._stopStream?.()
  }

  pendingQuestion(sessionId) {
    for (const question of this.questions.values()) {
      if (question.sessionId === sessionId) return question
    }
    return null
  }

  async ensureSession(userKey) {
    return this._ensureSession(String(userKey))
  }

  async selectModel(sessionId, model) {
    if (!model) return null
    return this._selectModel(sessionId, model)
  }

  async ask(sessionId, text, { timeoutMs = this.timeoutMs, slowMs = this.slowMs } = {}) {
    if (!this.started) this.start()
    const baseline = this.lastSeq.get(sessionId) ?? 0
    const key = `${sessionId}:${newRpcId('turn')}`
    const promise = new Promise((resolve, reject) => {
      const waiter = {
        sessionId,
        baseline,
        resolve,
        reject,
        slowTimer: null,
        timeout: null,
      }
      if (slowMs > 0) {
        waiter.slowTimer = setTimeout(() => {
          if (this.waiters.has(key)) this.onSlow(sessionId)
        }, slowMs)
      }
      waiter.timeout = setTimeout(() => {
        if (!this.waiters.has(key)) return
        this.waiters.delete(key)
        clearTimeout(waiter.slowTimer)
        void Promise.resolve(this._cancel(sessionId)).catch(() => {})
        this.onStall(sessionId)
        reject(new Error(`DSH session timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.waiters.set(key, waiter)
    })

    try {
      await this._prompt(sessionId, text)
    } catch (error) {
      const waiter = this.waiters.get(key)
      if (waiter) {
        this.waiters.delete(key)
        clearTimeout(waiter.timeout)
        clearTimeout(waiter.slowTimer)
        waiter.reject(error)
      }
    }
    return promise
  }

  async answerQuestion(rpcId, sessionId, text) {
    const question = this.questions.get(rpcId)
    if (!question || question.sessionId !== sessionId) {
      throw new Error('该提问已过期或不属于当前会话')
    }
    await this._respondQuestion(rpcId, sessionId, question.questions, text)
    this.questions.delete(rpcId)
  }

  _handleEnvelope(envelope) {
    // apiProxy.events.mux() yields RpcRequest<Frame>; HTTP/WebSocket yields a
    // server-request envelope.  Both have the same rpcId/payload shape here.
    const frame = envelope?.payload ?? envelope
    if (!frame || typeof frame !== 'object') return
    if (frame.type === 'question/requested') {
      const rpcId = envelope?.rpcId || newRpcId('question')
      const record = { rpcId, sessionId: frame.sessionId, questions: frame.questions || [] }
      this.questions.set(rpcId, record)
      this.onQuestion(rpcId, record.sessionId, record.questions)
      return
    }
    if (frame.type === 'question/resolved') {
      this.questions.delete(frame.questionRpcId)
      return
    }
    if (frame.type === 'session/subscribed') {
      this.lastSeq.set(frame.sessionId, Number(frame.lastSeq) || 0)
      return
    }
    if (frame.type === 'stream/error') {
      this.onStall(frame.error?.message || 'DSH 事件流发生错误')
      return
    }
    if (frame.type !== 'session/event' || !frame.event) return

    const sessionId = frame.sessionId
    const seq = Number(frame.event.seq ?? frame.event.sequence ?? 0)
    if (seq) this.lastSeq.set(sessionId, Math.max(seq, this.lastSeq.get(sessionId) ?? 0))
    this._handleSessionEvent(sessionId, frame.event)
  }

  _handleSessionEvent(sessionId, event) {
    const kind = eventKind(event)
    const turn = eventTurn(event)
    let state = this.turns.get(sessionId)
    if (!state || (turn != null && state.turn != null && String(state.turn) !== String(turn))) {
      state = { turn, text: '' }
      this.turns.set(sessionId, state)
    } else if (turn != null && state.turn == null) {
      state.turn = turn
    }

    if (kind === 'assistant/chunk' || kind === 'assistant/delta' || kind === 'message/chunk') {
      const chunk = event?.data?.chunk ?? event?.chunk ?? event?.data
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') state.text += chunk.text
      else if (typeof chunk?.text === 'string') state.text += chunk.text
      return
    }
    if (kind === 'assistant/message' || kind === 'message/assistant') {
      const text = eventText(event)
      if (text) state.text = text
      return
    }
    if (kind !== 'turn/end' && kind !== 'turn/ended') return

    const waiterEntries = [...this.waiters.entries()].filter(([, waiter]) => (
      waiter.sessionId === sessionId && (Number(event.seq ?? 0) === 0 || Number(event.seq) > waiter.baseline)
    ))
    const reason = event?.data?.reason ?? event?.reason
    const failed = reason?.kind === 'error' || reason?.type === 'error' || reason?.error
    for (const [key, waiter] of waiterEntries) {
      this.waiters.delete(key)
      clearTimeout(waiter.timeout)
      clearTimeout(waiter.slowTimer)
      if (failed) waiter.reject(new Error(reason?.message || reason?.error || 'DSH 回合失败'))
      else waiter.resolve(state?.text || '')
    }
    this.turns.delete(sessionId)
  }

  // Implemented by subclasses.
  _startStream() {}
  _stopStream() {}
  async _ensureSession() { throw new Error('Transport does not implement ensureSession') }
  async _prompt() { throw new Error('Transport does not implement prompt') }
  async _cancel() {}
  async _selectModel() { throw new Error('Transport does not implement selectModel') }
  async _respondQuestion() { throw new Error('Transport does not implement question responses') }
}

export { DEFAULT_TIMEOUT, DEFAULT_SLOW, eventText, unwrapResult, rpcError }
