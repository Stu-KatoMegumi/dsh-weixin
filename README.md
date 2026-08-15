# weixin-bot — 微信（ClawBot 官方通道）↔ DSH 桥

把 DeepSeek Harness（DSH）接入微信：**在微信里和一个联系人对话，消息透传到 DSH 的 agent 会话，
回复自动发回微信。合规、无封号风险** —— 因为走的是腾讯官方开放的 **ClawBot / iLink** 通道
（个人微信 Bot API，接入域名 `ilinkai.weixin.qq.com`），不是 hook 方案。

```
微信用户 ──► ClawBot/iLink（腾讯官方服务器）──► bridge.mjs ──► DSH (127.0.0.1:3080)
   ▲                                            │  session.create / session.prompt
   └──────────── 回复 ◄─────────────────────────┘  events.mux (SSE) 取回复
```

## 目录

| 文件 | 作用 |
|---|---|
| `bridge.mjs` | 微信适配层：ClawBot 登录（扫码）、长轮询收消息、带 `context_token` 回复 |
| `dsh-client.mjs` | DSH 对接层：HTTP RPC + 事件流（与 Web 前端同一协议），与微信通道无关，可复用给飞书/企业微信 |
| `state/bot.json` | 登录 token 与 `get_updates_buf` 游标（自动生成，勿提交） |
| `state/qrcode.txt` | 首次运行生成的微信官方登录链接（浏览器自动打开，此文件备用） |

## 前置条件

1. **Node.js ≥ 22**（需要内置 `fetch` 与 `WebSocket`；22 以下需自行安装 `ws` 包）。
2. **DSH 正在运行**（默认 `http://127.0.0.1:3080`，可用 `DSH_URL` 覆盖）。
3. **ClawBot 通道**：iLink 登录需要腾讯的 OpenClaw 账号体系（`@tencent-weixin/openclaw-weixin`）。
   官方安装方式：`npx @tencent-weixin/openclaw-weixin-cli install` 后扫码。
   本桥内置了裸协议登录，运行时扫码即可；若官方要求先开通/审核，按提示完成即可。
   社区现成封装可参考：`codeenxi/weixin-ClawBot-API`、`qufei1993/cc-weixin`、`bkmashiro/weixin-mcp`。

## 快速开始

```bash
cd "D:\Download Files\weixin-bot"
npm start          # 或 node bridge.mjs
```

首次运行会**自动打开默认浏览器**访问微信官方登录页（`liteapp.weixin.qq.com`，链接同时保存在
`state/qrcode.txt`），**用微信扫码**（或把链接发到手机微信里打开）完成登录，之后即可：
在微信里给机器人发消息 → DSH 跑回合（工具调用、文件操作照常）→ 回复发回微信。
DSH 的 Web 界面（3080）里能实时看到每个微信用户对应的会话轨迹。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_URL` | `http://127.0.0.1:3080` | DSH Web 地址 |
| `WX_BOT_CWD` | 本目录 | 每个微信会话的工作目录（传给 `session.create` 的 cwd） |
| `WX_BOT_PRESET` | `weixin` | agent preset 名称（专属人设，见下）；缺失时自动降级默认 |
| `WX_BOT_TURN_TIMEOUT_MS` | `900000`（15 分钟） | 单回合超时，超时自动 `session.cancel` |
| `WX_BOT_SLOW_ACK_MS` | `4000` | 任务超过该时长，先回一句"⏳ 正在处理…"，完成后发最终回复 |
| `WX_BOT_CHUNK_SIZE` | `1800` | 回复分块长度（微信单条消息限制） |

## 工作原理

**DSH 侧**（与 Web 前端完全同协议，见 DSH 源码 `packages/host/apiproxy`）：

- `POST /api/session.create`：每个微信用户映射一个稳定 `sessionId`（`wx-` + 哈希），
  跨重启复用同一会话，对话记忆延续；`cwd`/`agentPreset` 可定制。
- `POST /api/session.prompt`：`{ sessionId, mode:'queue', content:[{type:'text',text}] }`。
- `ws://127.0.0.1:3080/api/events.mux`（WebSocket 下行）：订阅 `session/event` 帧，
  从 `turn/start` → `assistant/message` → `turn/end` 收集最终回复文本。

**微信侧**（ClawBot / iLink 协议）：

- 登录：`get_bot_qrcode` 取码 → 轮询 `get_qrcode_status` 拿 `bot_token`（持久化）。
- 收消息：`POST /ilink/bot/getupdates` 长轮询（35s hold），`get_updates_buf` 是游标，**必须持久化**，
  否则重启后会重复收到旧消息（本桥已处理）。
- 回消息：`POST /ilink/bot/sendmessage`，**必须原样携带收到的 `context_token`**，否则消息不会进入正确的对话窗口。

## 体验设计

- **会话完全隔离**：每个微信用户映射一个独立 DSH 会话（`wx-` 前缀），使用专属 `weixin`
  preset，与你在网页 GUI 里打开的会话互不共享、互不影响；重启桥后同一用户自动接续历史会话。
  会话 id 与 preset 绑定（DSH 的会话预设一经创建就固定）：更换 `WX_BOT_PRESET` 会自动新开
  一个会话，旧会话保留在 DSH 中但不再使用。
- **专属人设（精炼快）**：preset 位于 `$DSH_HOME/.agent-presets/weixin/`（本机
  `C:\Users\WY283\.dsh\.agent-presets\weixin\`），人设为中文精炼直给结论；**工具能力与
  standard 完全一致**——Shell、文件读写、网页搜索、子代理、工作流都能在对话里用，
  和网页端交流是同一体验。想改人设直接编辑该目录下的 `agent.cordis.yml` 的 `persona` 段。
- **慢任务先快速回复**：任务超过 `WX_BOT_SLOW_ACK_MS` 未完成时，先回
  "⏳ 收到，正在处理…"，完成后发送最终回复。
- **agent 提问自动转发**：回合中 agent 发起提问（`question/requested`）时，问题会发到微信，
  你直接回复即可自动提交答案，回合继续。

## 已知限制与注意事项

- **审批仍需在 Web 界面处理**：如果 agent 发起审批（`approval/requested`），回合会挂起，
  请到 DSH Web 界面处理；想彻底避免，给机器人用不含审批环节的 agent preset。
- **同一会话别同时在 Web 界面操作**：桥按"每会话串行"工作（上一回合结束才发下一条），
  若你同时在 Web GUI 里操作同一个会话，回复可能错位。
- **只有文字消息**（v1）：图片/语音/文件暂时回复"暂时只支持文字消息"。
  iLink 协议本身支持媒体（AES-128-ECB 加密 CDN），后续可扩展。
- **群聊**：v1 跳过群消息，只处理单聊。
- **合规边界**：腾讯《微信ClawBot功能使用条款》——腾讯只是管道，不存储消息内容；
  但有权限流/拦截/终止连接，不要做违规或商用滥用。
- 长回复自动分块发送；`getupdates` 出错自动重试；token 失效需删除 `state/bot.json` 重新登录。

## 备选通道（复用同一个 dsh-client.mjs）

- **飞书**：自建应用 + 机器人，事件订阅走 **WebSocket 长连接，不需要公网 URL**；
  收到 `im.message.receive_v1` 后调 `dsh.ask(sessionId, text)`，再调飞书 `im.v1.message.reply` 回复。
  只需在 `bridge.mjs` 的位置换一个适配器（约 60 行）。
- **企业微信自建应用 / 微信客服**：官方回调 + 发消息 API，适合 B 端客服场景。

## 参考

- [iLink/ClawBot 协议技术解析（openclaw-weixin）](https://github.com/hao-ji-xing/openclaw-weixin/blob/main/weixin-bot-api.md)
- [腾讯官方 npm 包 @tencent-weixin/openclaw-weixin](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
- [微信 Claw Bot 官方仓库（tencent-weixin/openclaw-weixin）](https://github.com/tencent-weixin/openclaw-weixin)
- DSH 源码：`packages/host/apiproxy/src/api/`（sessions.ts / events.ts / rpc.ts）
