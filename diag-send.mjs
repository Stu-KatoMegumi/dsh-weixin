// 临时诊断：直接测 sendmessage（不带 context_token），看真实返回
import fs from 'node:fs'

const state = JSON.parse(fs.readFileSync('./session/bot.json', 'utf8'))
const token = state.botToken
const baseUrl = state.baseUrl || 'https://ilinkai.weixin.qq.com'
const to = 'o9cq80wf8Z0p0u5O-NyIMkmscaZg@im.wechat'

function randomUin() {
  const uin = (Math.random() * 0xffffffff) >>> 0
  return Buffer.from(String(uin)).toString('base64')
}

async function ilink(pathname, body, timeoutMs = 20000) {
  const headers = {
    'content-type': 'application/json',
    'authorizationtype': 'ilink_bot_token',
    'x-wechat-uin': randomUin(),
    authorization: `Bearer ${token}`,
  }
  const res = await fetch(baseUrl + pathname, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  console.log('HTTP', res.status, pathname)
  let json
  try { json = JSON.parse(text) } catch { json = { _raw: text.slice(0, 500) } }
  return json
}

console.log('=== sendmessage 测试（无 context_token）===')
const send = await ilink('/ilink/bot/sendmessage', {
  msg: {
    from_user_id: '',
    to_user_id: to,
    client_id: 'diag-' + Date.now(),
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: '[诊断] 如果你在微信看到这条，说明通道通了' } }],
  },
})
console.log(JSON.stringify(send, null, 2))
