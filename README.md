# dsh-weixin

`dsh-weixin` 把微信 iLink/ClawBot 私聊接入 DSH agent。插件模式直接使用 DSH `apiProxy`，独立模式通过 DSH Web HTTP + SSE 连接。

## 功能

- DSH 事件流增量输出，按字符数/时间分段回传微信
- 微信“正在输入”状态，任务结束自动关闭
- 长轮询看门狗、指数退避重连和连接状态记录
- 登录约 24 小时到期前生成新二维码，旧 token 在扫码前继续工作
- 图片、语音、视频、文件接收（AES-128-ECB 解密）与文件发送
- 白名单、管理员命令、发送目录边界和 50 MB 媒体上限
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

首次启动会打开扫码窗口。登录凭据、会话映射和设置默认持久保存在 `$DSH_HOME/channels/dsh-weixin`（通常是 `~/.dsh/channels/dsh-weixin`），更新或卸载插件不会删除它。

## 卸载

```powershell
npm run uninstall:dsh
```

卸载会从指定 DSH profile 移除 bundle，并清理安装脚本创建的稳定缓存；不删除你的会话数据。

## 微信命令

- `/help`：查看命令
- `/new`：创建并切换到新 DSH 会话
- `/stop`：取消当前任务
- `/status`：查看连接和会话状态
- `/renew`：立即生成扫码续期链接
- `/send <相对路径>`：发送 `outboxDir` 内的文件
- `/users`、`/allow add|remove <ID>`、`/cron`：管理员命令

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

默认连接 `http://127.0.0.1:3080`。可使用 `DSH_URL`、`WX_BOT_CWD`、`WX_BOT_SESSION_DIR`、`WX_BOT_PRESET`、`WX_BOT_ACCESS_POLICY`、`WX_BOT_ALLOWLIST`、`WX_BOT_ADMINS`、`WX_BOT_STREAMING`、`WX_BOT_TYPING` 等环境变量。

独立模式会在启动微信连接前调用只读 DSH API 检查服务。如果 DSH 未启动、地址错误或端口上不是 DSH，程序会提示先运行 `pnpm dsh web` 并以退出码 1 结束，不会启动扫码和微信轮询。检测超时默认为 3000 ms，可用 `DSH_STARTUP_CHECK_TIMEOUT_MS` 调整。

## 开发验证

```powershell
npm test
npm run check
```
