# weixin-bot — 微信（ClawBot 官方通道）↔ DSH 机器人

在微信里和一个联系人对话，消息透传 DSH 的 agent 会话，**DSH 的回复转发回微信显示**；
走腾讯官方 **ClawBot / iLink** 通道（`ilinkai.weixin.qq.com`），**合规、无封号风险**。

```
微信用户 ──► ClawBot/iLink（腾讯官方）──► weixin-bot ──► DSH
   ▲                                        │  每个微信用户一个独立会话
   └──────── 回复显示 ◄─────────────────────┘  自动归入「微信会话」分组
```

## 双模式

| 模式 | 命令 | 说明 |
|---|---|---|
| **独立模式** | `npm start` | 独立进程跑整套流程（HTTP RPC + WebSocket，WS 不可用时自动降级为 history 轮询） |
| **插件模式** | `npm run install` | 复制到 DSH 源码 `packages/weixin-bot/` 并挂载，随 `pnpm dsh web` 一起加载（进程内 apiProxy，无网络层） |

两种模式共用同一套核心（`src/core/` + `src/dsh/transport.mjs`），行为一致：
会话隔离、微信会话分组、双方对话落盘、提问转发、慢任务先回复。

## 目录结构

```
weixin-bot/
├── package.json / version.json / install.mjs
├── src/
│   ├── core/              微信协议 + 本地存储 + 核心编排（两种模式共享）
│   │   ├── wechat.mjs     ClawBot/iLink 客户端（登录/长轮询/发送）
│   │   ├── store.mjs      session/ 持久化（bot 状态/用户映射/双方历史）
│   │   └── engine.mjs     消息编排：微信→DSH→回复→存历史→回微信
│   ├── dsh/               DSH 传输层
│   │   ├── transport.mjs  共享回合等待/提问应答基类
│   │   ├── inproc.mjs     插件模式：进程内 apiProxy + mux 迭代器
│   │   └── http.mjs       独立模式：HTTP RPC + WS（history 轮询兜底）
│   ├── plugin/            DSH 插件入口（index.mjs + package.json）
│   └── standalone/        npm start 入口
└── session/               运行时数据（自动生成，勿提交）
    ├── bot.json           登录 token / 轮询游标
    ├── users.json         微信用户 → DSH 会话映射
    └── history/<用户>.jsonl  双方对话镜像（微信 query 与 DSH 回复都保存）
```

## 快速开始（独立模式）

```bash
npm start
```

首次运行会用 **Edge/Chrome 的独立应用窗口**直接打开微信官方扫码页（无中间步骤、无点击，
`session/qrcode.txt` 存有登录链接备用），**扫码登录成功后该窗口自动关闭**；
未找到 Edge/Chrome 时降级为默认浏览器打开（需手动关闭）。
环境变量（均可选）：`DSH_URL`、`WX_BOT_PRESET`（默认 `weixin`）、`WX_BOT_SESSION_DIR`、
`WX_BOT_CWD`、`WX_BOT_SLOW_ACK_MS`（默认 4000）、`WX_BOT_TURN_TIMEOUT_MS`、
`WX_BOT_CHUNK_SIZE`、`WX_BOT_POLL_TIMEOUT_MS`（长轮询期望超时，默认 5000）。

## 安装为 DSH 插件

```bash
npm run install
# DSH_ROOT 可显式指定源码根；默认自动探测：D:\Program Files\dsh > 本文件夹内 dsh\
# 脚本会：复制插件 → 版本检测（version.json，同版本跳过，--force 重装）→
#         写 $DSH_HOME/cordis.patch.yml 挂载行 → 执行 pnpm install
```

安装后**重启 DSH**（Ctrl+C 后重新 `pnpm dsh web`）即生效。插件随 DSH 进程存活，
微信会话自动归入「微信会话」分组，双方对话落盘在项目的 `session/` 目录。
卸载：删除 `packages/weixin-bot/` 与 `$DSH_HOME/cordis.patch.yml` 里的 weixin-bot 行。

## 体验设计

- **会话隔离**：每个微信用户一个独立 DSH 会话（`wx-` 前缀），使用专属 `weixin` preset
  （位于 `$DSH_HOME/.agent-presets/weixin/`，中文精炼快人设、工具能力完整），
  与网页 GUI 的会话互不共享；重启后同一用户自动接续历史会话。
- **网页端分组**：所有微信会话自动归入「微信会话」workspace，网页左侧分组显示，
  会话内容与网页端完全同步（就是同一个会话）。
- **慢任务先快速回复**：任务超过 `WX_BOT_SLOW_ACK_MS` 未完成时，先回
  "⏳ 收到，正在处理…"，完成后发送最终回复。
- **agent 提问转发微信**：回合中 agent 发起提问时，问题发到微信，直接回复即自动提交答案。
- **双方对话落盘**：`session/history/<用户>.jsonl` 同时保存微信用户的 query 与 DSH 的回复。
- **能在对话里干活**：工具能力与 standard preset 一致——Shell、文件、搜索、子代理、工作流
  都能在微信对话里使用，与网页端交流是同一体验。

## 已知限制

- 群聊暂不处理（只回单聊）；图片/语音/文件消息暂不支持（回复提示）。
- 审批（`approval/requested`）仍需在 DSH 网页界面处理（回合会等待）。
- 独立模式下若 WebSocket 不可用，提问转发会降级（回复仍通过 history 轮询送达）。
- iLink 长轮询由服务端 hold（空闲时最长约 35 秒）；`WX_BOT_POLL_TIMEOUT_MS` 可尝试缩短。
- 合规边界：腾讯《微信ClawBot功能使用条款》——腾讯只是管道，不存储消息内容；
  有权限流/拦截/终止，不要违规或商用滥用。

## 参考

- [iLink/ClawBot 协议技术解析（openclaw-weixin）](https://github.com/hao-ji-xing/openclaw-weixin/blob/main/weixin-bot-api.md)
- [腾讯官方 npm 包 @tencent-weixin/openclaw-weixin](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
- DSH 源码：`packages/host/apiproxy/src/api/`、`$DSH_HOME/cordis.patch.yml` 用户挂载层
