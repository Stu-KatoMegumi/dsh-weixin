window.__ModuleLoader__.load({
  id: '@deepseek-ai/dsh-weixin',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    const input = {
      width: '100%', boxSizing: 'border-box', padding: '7px 9px', font: 'inherit', fontSize: 13,
      borderRadius: 6, border: '1px solid var(--dsw-alias-border-strong, #cbd2dc)',
      background: 'var(--dsw-alias-bg, #fff)', color: 'inherit',
    }
    const row = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }
    const field = { marginBottom: 12 }
    const label = { display: 'block', marginBottom: 4, fontSize: 12, opacity: 0.8 }

    async function api(method, payload = {}) {
      const response = await fetch(`/_dsh/dsh-weixin/api/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || !body?.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`)
      return body.value
    }

    function Field({ title, children }) {
      return h('div', { style: field }, h('label', { style: label }, title), children)
    }

    function Toggle({ title, checked, onChange }) {
      return h('label', { style: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 13 } },
        h('input', { type: 'checkbox', checked, onChange: event => onChange(event.target.checked) }), title)
    }

    function Settings() {
      const [status, setStatus] = useState(null)
      const [draft, setDraft] = useState(null)
      const [message, setMessage] = useState('')
      const [busy, setBusy] = useState(false)
      const refresh = useCallback(async () => {
        try {
          const value = await api('status')
          setStatus(value)
          setDraft(current => current || {
            ...value.settings,
            allowlistText: (value.settings.allowlist || []).join('\n'),
            adminsText: (value.settings.admins || []).join('\n'),
            jobsText: JSON.stringify(value.settings.jobs || [], null, 2),
          })
        } catch (error) { setMessage(error.message) }
      }, [])
      useEffect(() => {
        void refresh()
        const timer = setInterval(() => void refresh(), 15000)
        return () => clearInterval(timer)
      }, [refresh])
      const set = (key, value) => setDraft(current => ({ ...current, [key]: value }))
      const save = async () => {
        setBusy(true)
        try {
          const jobs = JSON.parse(draft.jobsText || '[]')
          await api('settings.update', { patch: {
            enabled: draft.enabled, streaming: draft.streaming, typing: draft.typing,
            mediaEnabled: draft.mediaEnabled, renewalEnabled: draft.renewalEnabled,
            accessPolicy: draft.accessPolicy,
            allowlist: draft.allowlistText.split(/\r?\n|,/).map(v => v.trim()).filter(Boolean),
            admins: draft.adminsText.split(/\r?\n|,/).map(v => v.trim()).filter(Boolean),
            streamFlushChars: Number(draft.streamFlushChars), streamFlushMs: Number(draft.streamFlushMs),
            slowAckMs: Number(draft.slowAckMs), turnTimeoutMs: Number(draft.turnTimeoutMs), jobs,
          } })
          setMessage('设置已保存并热更新。')
          await refresh()
        } catch (error) { setMessage(`保存失败：${error.message}`) } finally { setBusy(false) }
      }
      const login = async () => {
        setBusy(true)
        try {
          const value = await api('login.start')
          if (value.url) window.open(value.url, '_blank', 'noopener,noreferrer')
          setMessage('已生成扫码链接，请在新窗口完成扫码。')
        } catch (error) { setMessage(`生成二维码失败：${error.message}`) } finally { setBusy(false) }
      }
      if (!draft) return h('div', null, '正在读取 dsh-weixin 状态…')
      const connected = status?.wechat?.connected
      return h('div', { style: { maxWidth: 760, paddingBottom: 30 } },
        h('h2', { style: { margin: '0 0 8px' } }, '微信 dsh-weixin'),
        h('div', { style: { marginBottom: 16, fontSize: 13, color: connected ? '#258750' : '#b56a00' } },
          connected ? '● 微信已连接' : '● 微信未登录',
          ` · 已知用户 ${status?.users || 0} · 最近轮询 ${status?.wechat?.lastSuccessAt ? new Date(status.wechat.lastSuccessAt).toLocaleString() : '无'}`),
        h('button', { type: 'button', disabled: busy, onClick: login, style: { ...input, width: 'auto', cursor: 'pointer', marginBottom: 18 } },
          connected ? '扫码续期' : '扫码登录'),
        h('div', { style: row },
          h(Toggle, { title: '启用通道', checked: draft.enabled, onChange: value => set('enabled', value) }),
          h(Toggle, { title: '流式输出', checked: draft.streaming, onChange: value => set('streaming', value) }),
          h(Toggle, { title: '显示“正在输入”', checked: draft.typing, onChange: value => set('typing', value) }),
          h(Toggle, { title: '媒体/文件收发', checked: draft.mediaEnabled, onChange: value => set('mediaEnabled', value) }),
          h(Toggle, { title: '24 小时到期前提醒续期', checked: draft.renewalEnabled, onChange: value => set('renewalEnabled', value) })),
        h(Field, { title: '私聊权限模式' }, h('select', { style: input, value: draft.accessPolicy, onChange: event => set('accessPolicy', event.target.value) },
          h('option', { value: 'pairing' }, 'pairing - 允许所有私聊'), h('option', { value: 'allowlist' }, 'allowlist - 仅白名单'), h('option', { value: 'disabled' }, 'disabled - 关闭'))),
        h('div', { style: row },
          h(Field, { title: '白名单（每行一个用户 ID）' }, h('textarea', { style: { ...input, minHeight: 88 }, value: draft.allowlistText, onChange: event => set('allowlistText', event.target.value) })),
          h(Field, { title: '管理员（每行一个用户 ID）' }, h('textarea', { style: { ...input, minHeight: 88 }, value: draft.adminsText, onChange: event => set('adminsText', event.target.value) }))),
        h('div', { style: row },
          h(Field, { title: '流式分段字符数' }, h('input', { style: input, type: 'number', value: draft.streamFlushChars, onChange: event => set('streamFlushChars', event.target.value) })),
          h(Field, { title: '流式刷新间隔（ms）' }, h('input', { style: input, type: 'number', value: draft.streamFlushMs, onChange: event => set('streamFlushMs', event.target.value) })),
          h(Field, { title: '慢任务提示延迟（ms）' }, h('input', { style: input, type: 'number', value: draft.slowAckMs, onChange: event => set('slowAckMs', event.target.value) })),
          h(Field, { title: '单轮超时（ms）' }, h('input', { style: input, type: 'number', value: draft.turnTimeoutMs, onChange: event => set('turnTimeoutMs', event.target.value) }))),
        h(Field, { title: '定时任务 JSON（id / cron / userId / prompt / enabled）' },
          h('textarea', { style: { ...input, minHeight: 130, fontFamily: 'monospace' }, value: draft.jobsText, onChange: event => set('jobsText', event.target.value) })),
        h('button', { type: 'button', disabled: busy, onClick: save, style: { ...input, width: 'auto', cursor: 'pointer', background: '#2878d0', color: '#fff', border: 0 } }, busy ? '处理中…' : '保存设置'),
        message ? h('div', { style: { marginTop: 10, fontSize: 13 } }, message) : null,
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register({ name: 'settings.section', id: 'dsh-weixin', order: 25, label: '微信' }, Settings)
      }), 'dsh-weixin: settings page')
    }
    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
