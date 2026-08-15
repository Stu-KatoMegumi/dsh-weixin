import crypto from 'node:crypto'
import { BaseTransport, unwrapResult } from './transport.mjs'

function sessionIdFor(userKey) {
  const digest = crypto.createHash('sha256').update(String(userKey)).digest('hex').slice(0, 32)
  return `wx-${digest}`
}

function workspaceFor(items, cwd, title) {
  const normalized = String(cwd).replace(/[\\/]+$/, '').toLowerCase()
  return items.find((item) => String(item.path).replace(/[\\/]+$/, '').toLowerCase() === normalized)
    || items.find((item) => item.title === title)
}

export class HttpTransport extends BaseTransport {
  constructor({ base = 'http://127.0.0.1:3080', preset = 'weixin', sessionCwd = process.cwd(), workspaceTitle = '微信会话', ...options } = {}) {
    super(options)
    this.base = String(base).replace(/\/$/, '')
    this.preset = preset
    this.sessionCwd = sessionCwd
    this.workspaceTitle = workspaceTitle
    this.abortController = null
    this.streamTask = null
  }

  async call(method, payload) {
    const rpcId = `dsh-weixin-${crypto.randomUUID()}`
    const response = await fetch(`${this.base}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new Error(`DSH HTTP ${method} failed: ${response.status}`)
    if (body?.rpcId !== rpcId) throw new Error(`DSH RPC id mismatch for ${method}`)
    return unwrapResult(body)
  }

  async respond(message) {
    const response = await fetch(`${this.base}/api/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    })
    return response.json().catch(() => ({ accepted: false, reason: 'bad-response' }))
  }

  _startStream() {
    this.abortController = new AbortController()
    const signal = this.abortController.signal
    this.streamTask = (async () => {
      try {
        const response = await fetch(`${this.base}/api/events.mux`, { signal, headers: { accept: 'text/event-stream' } })
        if (!response.ok || !response.body) throw new Error(`DSH event stream failed: HTTP ${response.status}`)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!signal.aborted) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const data = chunk.split(/\r?\n/)
              .filter((line) => line.startsWith('data: '))
              .map((line) => line.slice(6))
              .join('')
            if (!data) continue
            try {
              const full = JSON.parse(data)
              this._handleEnvelope({ rpcId: full.rpcId, payload: full.payload })
            } catch (error) {
              console.warn('[dsh-weixin] 丢弃格式错误的 DSH 事件:', error.message)
            }
          }
        }
        await reader.cancel().catch(() => {})
      } catch (error) {
        if (!signal.aborted) this.onStall(error?.message || 'DSH 事件流已断开')
      }
    })()
  }

  _stopStream() {
    this.abortController?.abort()
    this.abortController = null
    this.streamTask = null
  }

  async _ensureSession(userKey) {
    const sessionId = sessionIdFor(userKey)
    let workspace
    try {
      const listing = await this.call('workspace.list', {})
      workspace = workspaceFor(listing?.items || [], this.sessionCwd, this.workspaceTitle)
      if (!workspace) workspace = (await this.call('workspace.create', { path: this.sessionCwd }))?.workspace
      if (workspace && this.workspaceTitle && workspace.title !== this.workspaceTitle) {
        try {
          workspace = (await this.call('workspace.rename', {
            workspaceId: workspace.workspaceId,
            title: this.workspaceTitle,
          }))?.workspace || workspace
        } catch (error) {
          if (error?.code !== 'workspace-name-conflict') throw error
        }
      }
    } catch (error) {
      if (error?.code && error.code !== 'internal') throw error
    }
    return this.call('session.create', workspace?.workspaceId
      ? { workspaceId: workspace.workspaceId, sessionId, agentPreset: this.preset }
      : { cwd: this.sessionCwd, sessionId, agentPreset: this.preset })
  }

  async _prompt(sessionId, text) {
    await this.call('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: String(text) }],
    })
  }

  async _cancel(sessionId) {
    await this.call('session.cancel', { sessionId })
  }

  async _selectModel(sessionId, model) {
    return (await this.call('session.selectModel', {
      sessionId,
      provider: model.provider,
      model: model.model,
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    }))?.selected || model
  }

  async _respondQuestion(rpcId, sessionId, questions, text) {
    const answers = (questions || []).map((question) => ({ id: question.id, selected: [], custom: String(text) }))
    const response = await this.respond({
      type: 'client-response',
      rpcId,
      result: {
        ok: true,
        value: { sessionId, answer: { answers } },
      },
    })
    if (response?.accepted === false) throw new Error(`DSH 未接受问题回答：${response.reason || 'unknown'}`)
  }
}

export { sessionIdFor }
