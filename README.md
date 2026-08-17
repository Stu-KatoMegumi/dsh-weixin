# 开发人员：STU-XIE

# dsh-weixin

`dsh-weixin` 把微信 iLink/ClawBot 私聊接入 DSH agent。插件模式直接使用 DSH `apiProxy`，独立模式通过 DSH Web HTTP RPC + WebSocket 事件流连接。

## 功能

- 流式回复按模型分段：单独一行的 `---` = 新气泡（单/双换行、句子内 `---` 不切分），一轮最多 10 条；长度上限按当前气泡累计，空闲超时自动兜底
- 用户每条新消息可打断上一轮仍在生成的回复，最新输入优先处理
- Prompt 定制：system-prompt / soul / rules / memory 四个文件，网页表单编辑即时生效
- 微信“正在输入”状态，任务结束自动关闭
- 长轮询看门狗、指数退避重连和连接状态记录
- 登录约 24 小时到期前在本地生成续签二维码图片并提醒全部已知用户，旧 token 在扫码前继续工作
- 图片、语音、视频、文件接收（AES-128-ECB 解密）与文件发送
- 私聊访问策略、白名单、发送目录边界和 50 MB 媒体上限
- 用户→DSH 会话映射、对话历史、错误日志和单实例锁持久化
- DSH“设置 → 微信”页面，支持状态、扫码、权限、流式参数和定时任务热更新
- 五段 cron 定时提示任务

## 安装到 DSH

```powershell
# 可选：默认 DSH_ROOT 为 D:\Program Files\dsh，profile 为 web
$env:DSH_ROOT = 'D:\Program Files\dsh'
$env:DSH_PROFILE = 'web'
npm install
npm run install:dsh
```

安装脚本调用 DSH 官方 `plugin add` 逻辑。Windows 上源码路径含空格时，脚本会使用 `$DSH_HOME/bundles/dsh-weixin` 稳定缓存，避免生成无法解析的 profile 包链接。

```powershell
cd 'D:\Program Files\dsh'
pnpm dsh --profile web --dump-config
pnpm dsh --profile web
```

首次启动会打开扫码窗口（独立应用窗口，扫码成功后自动关闭）。登录凭据、会话映射和设置默认持久保存在 `$DSH_HOME/channels/dsh-weixin`（通常是 `~/.dsh/channels/dsh-weixin`），更新或卸载插件不会删除它。

> **插件模式不输出日志**：dsh-weixin 由 DSH 加载时给自身组件注入静默 logger（不动 DSH 自己的 `console`，因此 DSH 的启动横幅、状态输出等都保持正常）；插件自身的收发/扫码日志不打印到 DSH 终端。扫码/续期窗口在 DSH 所在机器上用独立应用窗口弹出，扫码成功后自动关闭。需要完整日志排查时请改用独立模式 `npm start`。

## 卸载

```powershell
npm run uninstall:dsh
```

卸载会从指定 DSH profile 移除 bundle，并清理安装脚本创建的稳定缓存；不删除你的会话数据。

## 微信命令

- `/help`、`/?`：查看命令（两者功能相同）
- `/new`：创建并切换到新 DSH 会话
- `/stop`：取消当前任务
- `/status`：查看连接和会话状态
- `/renew`：立即获取续签二维码图片
- `/send <相对路径>`：发送 `outboxDir` 内的文件
- `/users`、`/allow add|remove <ID>`、`/cron`：查看用户、管理白名单和查看定时任务

## 微信续签

续签功能在本地使用 `qrcode` 把 iLink 返回的二维码内容生成 PNG，再通过微信图片消息发送给所有已有 context token 的已知用户。每个用户继续使用自己的微信 context token 和 DSH session；多个用户共享同一轮续签二维码，任一用户扫码成功后，本轮收到二维码的用户都会收到续期成功提示。二维码图片属于通道管理消息，不受“媒体/文件收发”开关影响。设置页的“扫码续期”仍只在 DSH 所在机器打开本机扫码窗口。

自动提醒按运行机器的本地时间判断：通常从凭据到期前 2 小时开始，在 08:00–22:00（含 22:00）内对每个用户每 10 分钟最多提醒一次。若凭据将在夜间到期，首次提醒提前到前一天 21:30；若程序错过晚间提醒窗口后才在夜间恢复，并且旧 token 仍有效，则每个用户只紧急补发一次。所有通过现有私聊访问策略的用户都能使用全部 `/` 命令，主动执行 `/renew` 不受工作时间限制。

收到二维码后，请在电脑或另一台设备上展示图片，再打开需要续签的手机微信“扫一扫”，使用摄像头扫描并确认授权。微信聊天内长按识别不能完成该续签流程。

提醒会标明预计到期时间。二维码生成或图片上传最终失败时，机器人发送“二维码发送失败，请在电脑端完成微信续签！”并附原始续签页面链接作为兜底；失败不会清空仍有效的旧 token。扫码确认后，插件先持久化新凭据并初始化新连接，再向本轮实际收到二维码的用户发送“✅ 微信登录续期成功，连接已更新。”；二维码超时、过期或取消时发送“❌ 微信续签二维码已超时或失效，请重新发送 /renew 获取新二维码。”。主动停止插件不会发送失败提示，暂时发送失败的结果通知会在后续微信轮询恢复后补发。

## 定时任务

在设置页填写 JSON 数组：

```json
[
  {
    "id": "morning-summary",
    "cron": "0 9 * * 1-5",
    "userId": "微信用户ID",
    "prompt": "总结今天的待办事项",
    "enabled": true
  }
]
```

cron 按运行 DSH 的本地时区解析，五个字段依次是分、时、日、月、星期。

## 独立模式

```powershell
npm start
```

默认连接 `http://127.0.0.1:3080`。配置集中放在 `config/.env`（参考 `config/.env.example`，该文件不进入版本库）：进程已有的环境变量优先，`.env` 只补充缺失项；`DSH_URL`、`WX_BOT_CWD`、`WX_BOT_SESSION_DIR`、`WX_BOT_PRESET`、`WX_BOT_ACCESS_POLICY`、`WX_BOT_ALLOWLIST`、`WX_BOT_STREAMING`、`WX_BOT_TYPING` 等均可在其中配置。

模型策略固定为 `deepseek-official/deepseek-v4-flash`：普通消息使用 `off`（关闭思考），复杂消息使用 `max`（最高思考挡位）。复杂消息仍按现有规则判断：消息长度超过 40 个字符，或包含操作类关键词时，使用 `flash + max`；其他消息使用 `flash + off`。`WX_BOT_FAST_MODEL`、`WX_BOT_COMPLEX_MODEL` 以及对应的 reasoning 环境变量不再参与模型选择，旧的持久化模型设置也会在运行时归一化为这两种组合。若 DSH 未确认目标组合，本轮会停止，不会沿用会话中的旧模型。

`WX_BOT_SEND_INTERVAL_MS`（默认 200）控制两次微信消息发送的最小间隔（毫秒），用于降低 iLink 发送限流概率；设 `0` 可关闭节流。

独立模式会在启动微信连接前调用只读 DSH API 检查服务。如果 DSH 未启动、地址错误或端口上不是 DSH，程序会提示先运行 `pnpm dsh web` 并以退出码 1 结束，不会启动扫码和微信轮询。检测超时默认为 3000 ms，可用 `DSH_STARTUP_CHECK_TIMEOUT_MS` 调整。

## 气泡与流式输出

微信一次只显示一条消息气泡。回复由模型按下列契约切成多条气泡：

- **单独一行的 `---` = 一个气泡结束**：模型在输出中用单独占一行、前后带换行的 `---`（等价于 `\n---\n`）主动切气泡，程序把它前面的内容立即作为一条消息发送（分隔符本身不进入微信文案）。单个/双换行只是段落排版，句子中间嵌入的 `---` 也只是普通文字，都不会触发切分。此契约写在 `src/prompt/system-prompt.md`，可在设置页修改。
- **一轮最多 10 条气泡**：整轮回复分隔出的气泡总数不超过 10 条，内容多时合并、精简，避免触发微信 iLink 发送限流。
- **长度兜底（按当前气泡累计）**：当前这一个气泡累计超过 `streamFlushChars`（默认 800 字符）时，在最近的标点/换行处强制切分；每切出一个气泡后从下一个气泡重新计数，不从整条回复头部累计。
- **空闲兜底**：模型超过 `streamFlushMs`（默认 30000 ms）没有新内容时，强制发出当前气泡，避免“没反应”。

## Prompt 定制（人设 / 规则 / 记忆）

项目自带默认 prompt 文件：

```text
src/prompt/
  system-prompt.md   系统设定与气泡契约
  soul.md            人设与灵魂
  rules.md           行为规则
  memory.md          背景记忆（静态，人工维护）
```

首次启动会把默认文件复制到频道数据目录（插件模式 `$DSH_HOME/channels/dsh-weixin/prompt/`，独立模式 `session/prompt/`），之后在 DSH“设置 → 微信”页面的 **Prompt 定制** 区编辑这些副本（保存/重置默认），修改对下一条消息即时生效。渲染后的 prompt 会在每次请求前注入给模型，支持 `{date}` 占位符（当前日期）。

## 开发验证

```powershell
npm test
npm run check
```
