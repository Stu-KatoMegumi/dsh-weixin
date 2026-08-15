# dsh-weixin

`dsh-weixin` 是把微信 ClawBot/iLink 单聊消息接入 DSH agent 的官方 bundle 插件。插件模式使用 DSH 的 `apiProxy`，独立模式使用 DSH Web 的 HTTP + SSE API；两种模式共享微信客户端、会话持久化和回合编排逻辑。

## 按官方方式安装到 DSH profile

bundle 的根目录包含 `package.json`、`cordis.patch.yml` 和 `src/`。官方安装命令会把本目录作为 profile 的 link dependency，并自动维护 profile 的 `dsh.profile.bundles`：

```powershell
# 在 DSH 源码 checkout 中执行（默认 DSH_ROOT 为 D:\Program Files\dsh）
pnpm dsh plugin --profile web add "E:\path\to\dsh-weixin"

# 验证组合后的配置
pnpm dsh --profile web --dump-config

# 启动
pnpm dsh --profile web
```

也可以在本项目目录执行便利脚本；它只是上述官方命令的薄封装，不会复制源码或直接修改 DSH 的 patch：

```powershell
$env:DSH_ROOT = 'D:\Program Files\dsh' # 可选
$env:DSH_PROFILE = 'web'               # 可选，默认 web
npm run install:dsh
npm run uninstall:dsh
```

若使用已安装的 `dsh` CLI 而不是源码 checkout，请把 `dsh` 放入 `PATH`；也可以用 `DSH_CLI` 指定 CLI 可执行文件。`npm install` 只安装本项目依赖，不会触发 DSH 插件注册。

`cordis.patch.yml` 使用包名引用插件入口：

```yaml
- insert:
    - id: dsh-weixin
      name: '@deepseek-ai/dsh-weixin'
      config:
        preset: weixin
        workspaceTitle: 微信会话
```

## 独立运行

```powershell
npm install
npm start
```

独立模式默认连接 `http://127.0.0.1:3080`，可用 `DSH_URL`、`WX_BOT_CWD`、`WX_BOT_SESSION_DIR`、`WX_BOT_PRESET` 和 `WX_BOT_*_MODEL` 环境变量配置。首次运行微信通道仍需扫码登录。

## 目录

- `src/plugin/index.mjs`：DSH Cordis 插件入口。
- `src/dsh/inproc.mjs`：插件模式的 `apiProxy` transport。
- `src/dsh/http.mjs`：独立模式的 HTTP RPC + SSE transport。
- `src/dsh/transport.mjs`：会话回合、流式文本、提问回答和超时处理。
- `src/core/`：微信客户端、存储和消息编排。
