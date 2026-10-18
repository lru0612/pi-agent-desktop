# 远程主机（SSH）设计文档

> 状态：草案 · 分支 `feat/remote-hosts` · 基于 `abcwyc/pi-agent-desktop@10cc27f`（0.7.3）

## 1. 目标

在**同一个桌面窗口**里同时使用本机项目和远程服务器上的项目：

```
项目
├─ 📁 tofel
├─ 📁 my-app
├─ 📁 api-server   🌐        ← 淡蓝色地球，悬停显示 "devbox · 已连接"
└─ 📁 ml-train     🌐(灰)    ← 主机离线
```

- 远程项目的 Agent、会话文件、文件树、终端、git **都运行在远程**；关窗口 / 断网不影响远程任务（远程 pi-web 本身已保证，见 §9）。
- 远程项目使用**远程机器的配置**：模型、API Key、技能、MCP、插件、子代理、工具设置。
- 只要求用户能 `ssh <host>` 免密登录（密钥 / agent），远程无需 root、无需预装任何东西。

### 已确认的 UI 决策

| # | 决策 |
|---|---|
| 1 | 远程项目使用远程配置；设置页提供"配置范围：本机 / 某主机"切换 |
| 2 | 添加项目时先选"本机 / 某 SSH 主机"，选主机则打开远程目录浏览器 |
| 3 | 主机离线：项目保留在列表，地球变灰，点击显示"重新连接" |
| 4 | 地球标志只加在项目行上，不加在会话行上 |

### 非目标（本期不做）

- 直接公网暴露 pi-web（仍只走 SSH 隧道）。
- 本机与远程之间同步会话 / 配置。
- 远程 Web Push 推送（桌面通知通过本地汇总实现，见 §6.6）。

## 2. 与现有方案的差异

| | #114 / cheneyveron fork | 本设计 |
|---|---|---|
| 形态 | 整个窗口切到远程 URL，切换需重启 | 本地界面同时连多个后端 |
| 本地与远程同时使用 | ✗ | ✓ |
| SSH 隧道 / 远程安装 | ✗（只填 URL） | ✓ 自动 |
| 主要改动位置 | Tauri（`backend.rs`） | 本地 Node 服务 + 前端，**Rust 基本不动** |

#114 里"远程安全的文件下载流程"（下载字节到客户端、浏览器式目录选择）可以复用，见 §10。

## 3. 总体架构

```
┌──────────────── 本机 ────────────────┐            ┌────────── 远程 devbox ──────────┐
│ WebView（唯一同源 127.0.0.1:38471）    │            │                                  │
│   ├─ /api/...          → 本地路由      │            │  pi-agent-server（无界面版）      │
│   └─ /api/r/devbox/... ─┐              │            │  127.0.0.1:<rport>，带密码        │
│                         ▼              │  ssh -L    │    ├─ Agent / 会话 / 终端 / git   │
│ 本地 Node 服务（pi-web）               │ ─────────► │    └─ ~/.pi/agent（远程配置）     │
│   ├─ 远程代理 lib/remote/proxy         │            │                                  │
│   ├─ 主机管理 lib/remote/hosts         │            │  ~/.pi-remote/                   │
│   │    ├─ ssh 隧道进程（每主机一个）   │            │    ├─ versions/<ver>/            │
│   │    └─ 远程安装 / 启动脚本          │            │    ├─ secret（0600）             │
│   └─ 汇总流 /api/remote-hosts/events   │            │    └─ state.json（端口/版本）    │
└───────────────────────────────────────┘            └──────────────────────────────────┘
```

核心原则：

1. **前端只和本地同源服务通信**：没有跨域、Cookie、CORS 问题；远程密码只存在本地服务内存里。
2. **远程跑与桌面端完全相同版本的服务端**：界面由本地提供，远程只提供接口，接口必须一致。
3. **新代码放在 fork 自有文件**（`lib/remote/**`、`app/api/r/**`、`app/api/remote-hosts/**`、`components/remote/**`），尽量少改上游文件（见 §11）。

## 4. 远程端

### 4.1 无界面服务端包

现在发布物里没有无界面服务端包。需要新增：

- 产物：`pi-agent-server-<ver>-linux-x64.tar.gz`（后续加 `linux-arm64`、`darwin-arm64`）。
  内容 = `src-tauri/resources/server` + `resources/node` + `headless-launcher.cjs`。
- 构建：`release.yml` 的 ubuntu 任务在 "Prepare packaged Next.js server" 之后打包并 `gh release upload`。
  `linux-arm64` 需要在 `scripts/desktop-platform.mjs` 增加平台并加 arm64 runner。
- node-pty 自带 linux x64/arm64 预编译文件，已随 `prepare-desktop.mjs` 整包复制。

### 4.2 `desktop/headless-launcher.cjs`（新）

不能复用 `desktop-server.cjs`：它的父进程看门狗在没有 `PI_WEB_PARENT_PID` 时会立即退出。新启动器：

- 复用 ABI 检查、清理残留 `@earendil-works` 的逻辑（抽成共享模块）。
- 从 `PI_WEB_PASSWORD_FILE` 读取密码写入 `process.env.PI_WEB_PASSWORD`（不放命令行）。
- 强制 `HOSTNAME=127.0.0.1`；套用 `checkNetworkExposure` 规则。
- `require("./server.js")`。

### 4.3 远程信息接口 `GET /api/remote-info`（新，fork 自有）

运行在远程，供握手使用：

```json
{ "protocol": 1, "appVersion": "0.7.3", "piWeb": "0.10.0", "pi": "1.3.0",
  "platform": "linux-x64", "home": "/home/u", "pid": 12345 }
```

本地连接时校验 `appVersion` 严格相等（MVP），后续可放宽为 `protocol` 兼容。

### 4.4 安装 / 启动脚本（POSIX sh，经 `ssh host sh -s` 执行）

幂等，输出一行 JSON：

1. `uname -sm` 判断平台；不支持则报错。
2. 若 `~/.pi-remote/versions/<ver>/` 不存在：
   - 优先在远程 `curl`/`wget` 从 GitHub Release 下载；
   - 失败（内网）则由本地把缓存的 tar 包通过 `ssh host 'cat > …'` 上传。
3. 若无 `~/.pi-remote/secret`：生成 32 字节随机密码，`chmod 600`。
4. 读 `~/.pi-remote/state.json`：若对应进程存活且版本一致 → 直接返回端口。
5. 否则选空闲端口并启动，常驻方式依次尝试：
   - `systemd-run --user --unit=pi-remote …`（需 linger 才能在注销后存活；`doctor` 会提示）；
   - `setsid nohup … &`。
6. 写 `state.json`，输出 `{"port":…, "version":…, "pid":…}`。

密码**不经本地持久化**：每次连接时本地通过 ssh 读取 `~/.pi-remote/secret`，只保存在内存。信任根就是 SSH 登录权限。

### 4.5 多人共用一台服务器

- 每个用户各自的 `~/.pi-remote`、各自端口、各自密码。
- 服务只监听 127.0.0.1，但同机其他用户也能连 127.0.0.1，因此**密码必须开启**（§4.4 默认开启）。

## 5. 本地服务端

### 5.1 主机配置

`~/.pi/agent/pi-desktop/remote-hosts.json`：

```json
{ "hosts": [
  { "id": "devbox", "label": "devbox", "ssh": "devbox", "addedAt": "…" },
  { "id": "gpu-01", "label": "GPU 01", "ssh": "u@10.0.0.8 -p 2222" }
]}
```

- `ssh` 优先使用 `~/.ssh/config` 中的 Host 别名；"添加主机"对话框列出 config 中的 Host 供选择。
- `id` 用于 URL，限定 `[a-z0-9-]{1,32}`，保留字 `local`。
- 远程项目列表不单独存：和本地一样从远程 `/api/sessions` 推导；"刚添加、尚无会话"的远程项目沿用现有的 `selectedCwd` 机制，另在 localStorage 记录 `(hostId, root)` 以便离线时仍能显示。

### 5.2 隧道管理 `lib/remote/hosts.ts`

每台主机一个状态机：`idle → connecting → bootstrapping → online ⇄ reconnecting → offline(error)`。

- 隧道：一个长驻进程
  `ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L 127.0.0.1:<lport>:127.0.0.1:<rport> <ssh>`
- **不依赖 ControlMaster**（Windows 自带的 OpenSSH 不支持）；macOS/Linux 上可选启用以加速安装步骤。
- 断线指数退避重连（1s → 30s）；`lport` 首次随机分配后保持不变。
- 本地服务退出（关闭 App）时杀掉所有 ssh 子进程；远程服务继续运行。
- MVP 只支持免交互认证（`BatchMode=yes`）。密码 / 2FA 认证放到阶段 4（`SSH_ASKPASS` + 原生对话框）。

### 5.3 代理路由 `app/api/r/[host]/[...path]/route.ts`

- 放在 `/api/` 下：自动经过现有 `proxy.ts` 的 Host/Origin 检查和本地密码，**不用改 `proxy.ts`**。
- `/api/r/devbox/<rest>` → `http://127.0.0.1:<lport>/api/<rest>`，支持所有方法。
- 请求头处理：

  | 头 | 处理 |
  |---|---|
  | `Host` | 改为 `127.0.0.1:<lport>`（IP 字面量，远程 Host 检查直接通过） |
  | `Origin`、`Sec-Fetch-*`、`X-Forwarded-*` | 删除（否则远程 Origin 检查 403） |
  | `Cookie`、`Authorization` | 删除浏览器的；改为带远程会话 Cookie |
  | `x-pi-desktop-token` | **绝不转发** |
  | `Content-Type`、`Range`、`Last-Event-ID` | 原样转发 |

- 远程鉴权：连接成功后 `POST /api/web-auth` 一次拿 `pi_web_session` Cookie 复用；收到 401 再重新登录一次。
  不用每请求 Basic Auth，避免触发远程**全局**登录限流。
- 响应：删除 `Set-Cookie`；正文以流方式透传（SSE 不重组帧）。
- 使用**专用 undici Agent**：`bodyTimeout: 0`、不走 `HTTP_PROXY`。全局 dispatcher 有 300 秒 bodyTimeout，会切断没有心跳的文件监听 SSE。
- 拒绝列表（对远程返回 404）：`desktop/*`、`open-in-explorer`、`custom-css`、`updates`、`web-auth`、`push/*`。
  `open-in-explorer` 经隧道会被远程判为本机请求，会在**远程**弹出文件管理器，必须拦截。
- 主机离线时返回 `503 {"error":"remote_offline","host":"devbox"}`，前端据此显示离线状态。

### 5.4 主机管理接口 `app/api/remote-hosts/**`（仅本地）

| 路由 | 作用 |
|---|---|
| `GET /api/remote-hosts` | 主机列表 + 状态 + 版本 + 最近错误 |
| `POST /api/remote-hosts` | 添加主机（并立即连接） |
| `DELETE /api/remote-hosts/[id]` | 删除主机（可选：停止远程服务） |
| `POST /api/remote-hosts/[id]/connect` | 重新连接 |
| `POST /api/remote-hosts/[id]/upgrade` | 升级远程服务端 |
| `GET /api/remote-hosts/[id]/doctor` | 逐项诊断：ssh、平台、下载、端口、服务、版本、日志路径 |
| `GET /api/remote-hosts/ssh-config` | 列出 `~/.ssh/config` 中的 Host |
| `GET /api/remote-hosts/events`（SSE） | **汇总流**，见下 |

**汇总流**：本地服务对每台在线主机订阅一次远程的 `agent/running/events` 和 `scheduled-tasks/events`，与主机状态变化一起合并为一条 SSE 推给前端：

```
data: {"type":"host_status","host":"devbox","status":"online","version":"0.7.3"}
data: {"type":"running","host":"devbox","runningSessionIds":[…],"sessionListVersion":42}
data: {"type":"scheduled","host":"devbox", …}
```

理由：所有请求都打到同一个本地源，HTTP/1.1 每个源约 6 个连接，现有界面已占用多条 SSE；不能每台主机再各开几条。

## 6. 前端

### 6.1 请求路由器 `lib/remote/fetch-router.ts`（核心）

现状：约 150 处直接 `fetch("/api/…")`、10 处 `EventSource`，分布在 45 个上游文件里，没有统一封装。逐处修改会造成大量上游冲突，因此采用**全局拦截**（仓库里已有先例：`demo/mock/install.ts` 替换 `window.fetch` 和 `EventSource`）。

路由器在 AppShell 挂载时安装一次，拦截 `fetch`、`EventSource`、`XMLHttpRequest.open`，按下表决定发往哪个后端（`local` 或主机 id），再把 `/api/x` 改写为 `/api/r/<host>/x`：

| 顺序 | 规则 | 示例 |
|---|---|---|
| 1 | 已带 `/api/r/` 前缀 → 不动 | 侧边栏汇总请求 |
| 2 | 仅本地的路由 → 本地 | `desktop/*`、`updates`、`custom-css`、`web-auth`、`remote-hosts/*`；未加前缀的 `home`（本地健康探测用） |
| 3 | 按 id 定位的路由 → 查 id→主机 表 | `agent/[id]`、`sessions/[id]/**`、`subagents/[id]`、`terminal/[id]/**`、`scheduled-tasks/[id]/**` |
| 4 | 按路径 / cwd 定位的路由 → **工作区后端** | `files/<abs>`、`git/*`、`worktrees`、`file-index`、`terminal`(POST)、`agent/new`、`cwd/status`、`project-trust` |
| 5 | 全局配置路由 → **配置后端** | `models*`、`auth/*`、`mcp*`、`skills*`、`plugins*`、`subagents/profiles|settings`、`tools/settings`、`artifacts/settings` |
| 6 | 汇总路由 → 由调用方显式指定 | `sessions`、`sessions/search`、`agent/running*`、`scheduled-tasks`(GET/events) |

- **工作区后端** = 当前选中项目 / 会话所属的后端。
- **配置后端** = 设置面板打开时为面板选择的范围，否则等于工作区后端。
  这样打开设置切到别的主机时，后台的文件监听、git 轮询仍然发往当前项目所在的后端，不会串。
- **id→主机 表**的来源：汇总的会话列表（每条带 `host`）、`agent/new` 返回的 `sessionId`、终端 POST 时客户端生成的 id、URL 中的 `?host=`。
- 若配置后端 ≠ 工作区后端，路由器去掉请求里的 `cwd` 参数（该路径在另一台机器上无意义），远程会退回到全局配置。
- 路由分类表放在 `lib/remote/route-classes.ts`，并配一个测试：**遍历 `app/api/**/route.ts`，有未分类的路由就失败**。这样上游新增接口时会被立即发现。

拦截不到的位置需要显式改写（约 8 处，用 `apiUrl()`）：

- `<a href>` 下载：`FileExplorer.tsx:469`
- `<img>/<iframe src>`：`MarkdownBody.tsx:43`、`FileViewer.tsx:224/1018/1672`
- 服务端生成的相对 URL：`lib/session-reader.ts:899` 的 tool-result-image（在渲染处按会话主机加前缀）

HTML 预览里的相对路径资源（`./x.css`）在 `/api/r/devbox/files/<dir>/` 前缀下能自然解析到远程，无需处理。

### 6.2 侧边栏与项目标识

- 会话列表：本地 `/api/sessions` + 每台在线主机 `/api/r/<h>/sessions`，给每条 `SessionInfo` 加 `host` 字段后合并。
  离线主机使用 localStorage 中缓存的上次列表。
- 项目分组键从 `projectRoot` 改为 `host + projectRoot`（`lib/project-group.ts:54`）。两台机器上相同路径的项目不再被合并。
- 项目相关的持久化键（折叠、归档、上次打开的会话、草稿）：远程项目使用 `r:<host>:<root>`；本地保持原键，兼容已有数据。
- URL 增加 `?host=devbox`（本地省略）。

### 6.3 地球标志

- 位置：`SessionSidebar.tsx:1081-1083` 的项目名 `<span>` 之后、折叠计数之前；只用于远程项目组。
- 图标：12px 内联 SVG（项目里没有图标库，与现有文件夹图标的 lucide 风格一致）；`flex-shrink: 0`。
- 颜色：在 `app/native-theme.css` 新增变量（`globals.css` 必须与上游保持一致，不能改）：

  ```css
  :root     { --remote: #5ac8fa; }
  html.dark { --remote: #64d2ff; }
  .sidebar-project-remote-globe          { color: var(--remote); }
  .sidebar-project-remote-globe.offline  { color: var(--text-dim); }
  .sidebar-project-remote-globe.connecting { animation: pulse 1.2s infinite; }
  ```

- 悬停提示：`devbox（u@10.0.0.8）· 已连接 / 连接中 / 离线：<原因>`。

### 6.4 离线状态

- 主机状态来自汇总流的 `host_status`。
- 点击离线主机的项目或会话：主区域显示卡片"无法连接到 devbox"，附错误原因和两个按钮：**重新连接**、**查看诊断**（调用 `doctor`）。
- `useWorkspaceAvailability` 需要区分"主机不可达"（503 `remote_offline`）和"文件夹不存在"，避免误报"工作区已被删除"。
- 现有的全局断线横幅（`desktop-connection.ts`）只针对本地服务，保持不变。

### 6.5 添加项目

- "+" 按钮弹出菜单：

  ```
  本机文件夹…
  ───────────
  🌐 devbox
  🌐 gpu-01
  ───────────
  添加 SSH 主机…
  ```

- 本机：沿用现有原生对话框流程。
- 远程主机：复用已有的 `DirectoryPicker`（基于 `/api/cwd/browse`），请求走 `/api/r/<h>/cwd/browse`；选定后调用 `/api/r/<h>/cwd/validate`（把路径加入远程的允许列表）。
- 添加 SSH 主机：列出 `~/.ssh/config` 的 Host，或手填 `user@host[:port]`；点"连接"后逐步显示进度：SSH 连接 → 检测平台 → 下载 / 上传 → 启动 → 握手。

注意：远程重启后其内存中的允许列表会丢失，重连成功后本地要对已知的远程项目根重新调用 `cwd/validate`。

### 6.6 设置、原生功能与通知

**设置**
- 标题旁加"配置范围：本机 ▾ / devbox / gpu-01"，默认等于当前项目所在的后端。
- 远程范围下隐藏仅本地的行：更新、自定义 CSS、桌面相关设置、网页登录。
- 新增"远程主机"分区（仅本机范围），列出主机、状态、版本，可重连、升级、删除、诊断。

**原生功能**（远程项目里隐藏）
- 在 Finder 中显示：`SessionSidebar.tsx:271/1406`
- 用默认程序打开 / 用其他应用打开：`FileViewer.tsx:281`、`useFileContextMenu.ts:91`
- "另存为"改为通过远程 `type=download` 获取字节，再用本地 `/api/desktop/save` 的原始字节模式写入（参考 #114）。

**通知**
- 汇总流里的 `running` 事件交给现有 `notifyDesktop`，标题带主机名，比如"devbox · 任务完成"。

## 7. 安全模型

- 远程服务只监听 127.0.0.1，并始终开启密码；密码只在远程文件（0600）和本地服务内存中。
- 本地 `proxy.ts` 的 Host/Origin 检查保持不变，`/api/r/**` 同样受保护。
- 本地的 desktop token 永不转发；仅本地的路由在代理层直接拒绝。
- 远程终端 shell 环境中会去掉 `PI_WEB_PASSWORD`（现有 `terminal-manager.ts` 的行为）。
- SSH 是唯一信任根，不引入新的凭据类型。

## 8. 版本与升级

- MVP：本地与远程 `appVersion` 必须严格相等。不一致时主机状态为 `version_mismatch`，提示升级。
- 升级流程：
  1. 查询远程 `agent/running`；
  2. 有任务在运行 → 提示"N 个任务运行中"，可选择**完成后自动升级**或强制升级；
  3. 安装新版本 → 停旧进程 → 启动新进程 → 握手。
- 旧版本目录保留最近 2 个，便于回滚。

## 9. 已有行为（无需实现，供参考）

- 前端断开 SSE 只会注销订阅，不会中止 Agent；重连时服务端发送 `connected` 事件和当前流式消息快照。
- 空闲回收（`PI_WEB_IDLE_TIMEOUT_MS`，默认 10 分钟）只回收**未运行**且无租约的会话，回收后从文件重新加载。
- 与远程 CLI 同时打开同一会话会产生分支，见 §12 风险 3。

## 10. 分阶段计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0 验证** | 无界面包 + `headless-launcher.cjs` + `/api/remote-info`；手动 `ssh -L` | 在 Linux 上运行，浏览器访问正常、终端可用 |
| **M1 服务端** | `remote-hosts` 配置、隧道状态机、安装脚本、`/api/r/**` 代理、汇总流、`doctor` | 用 curl 对远程完成会话、SSE、文件、终端全流程 |
| **M2 前端核心** | fetch 路由器 + 路由分类表及测试、侧边栏汇总、地球标志、离线状态、添加项目流程 | 本地与远程项目同时可用，可新建远程会话 |
| **M3 完善** | 设置范围切换、远程主机分区、原生功能隐藏、媒体 URL、通知、复用 #114 的下载流程 | 端到端可日常使用 |
| **M4 增强** | OAuth 回调端口临时转发、ASKPASS 交互认证、升级流程、linux-arm64、Docker sshd 端到端测试、英文文档 | 可提交上游 PR |

## 11. 对上游文件的改动预算

**新增（fork 自有，登记到 `scripts/fork-ownership.json` 的 `forkOwnedPaths`）**

- `lib/remote/**`、`app/api/r/**`、`app/api/remote-hosts/**`、`app/api/remote-info/**`
- `components/remote/**`、`desktop/headless-launcher.cjs`
- `docs/agents/fork-remote.md`

**修改的上游文件（需 `npm run drift` 并记录处置）**

| 文件 | 改动 | 预估 |
|---|---|---|
| `components/SessionSidebar.tsx` | 分组键带 host、地球、"+"菜单、离线点击、Finder 项隐藏 | 中 |
| `components/AppShell.tsx` | 安装路由器、URL `host` 参数、离线卡片挂载点 | 小 |
| `components/SettingsPanel.tsx` | 范围切换挂载点、隐藏仅本地行 | 小 |
| `components/ProjectPicker.tsx` | 主机选择 | 小 |
| `lib/project-group.ts` | 分组键 | 小 |
| `FileViewer.tsx`、`FileExplorer.tsx`、`MarkdownBody.tsx`、`useFileContextMenu.ts` | `apiUrl()`、原生功能判断 | 各几行 |
| `hooks/useWorkspaceAvailability.ts` | 区分主机离线 | 小 |
| `app/native-theme.css` | 新变量和样式（fork 自有样式文件） | — |

`proxy.ts`、`lib/request-security.ts`、`lib/web-auth.ts`、`lib/rpc-manager.ts` **不改**。

## 12. 风险与待定问题

1. **全局拦截的隐式性**：请求被悄悄改写，排查困难。缓解：开发模式在控制台打印路由决定；分类表配测试。
2. **版本强绑定**：每次桌面端更新都要升级远程。若上游发版频繁，体验会差 → 考虑尽早引入 `protocol` 兼容号。
3. **并发打开同一会话**：远程 CLI `pi --resume` 与桌面同时写同一会话会产生分支（pi 没有文件锁）。后续可加占用锁文件。
4. **OAuth 登录**：远程的 OAuth 回调监听在远程 localhost，浏览器却跳到本机。MVP 使用已有的"粘贴回调地址 / 代码"兜底；M4 临时转发回调端口。
5. **HTTP/1.1 连接数**：当前会话事件流、终端、文件监听都经过本地同一源，与现状相同；新增的只有一条汇总流。
6. **上游接受度**：#114 被直接关闭且未说明原因。动手前应在上游开 issue 确认方向，并请求在每次发版时附带无界面服务端包。
7. **`DirectoryPicker` 的上游状态**：`AGENTS.md:227` 把它列为上游拒绝合并的界面，但本仓库在用。复用前需确认它是否属于 fork 自有。

## 附录 A：路由分类摘要

完整清单（80 个路由）由 M2 的 `lib/remote/route-classes.ts` 维护。按族概括：

| 类 | 路由族 |
|---|---|
| 仅本地 | `desktop/*`、`open-in-explorer`、`custom-css`、`updates`、`web-auth`、`push/*`、`remote-hosts/*` |
| 按 id | `agent/[id]/**`、`sessions/[id]/**`、`subagents/[id]`、`terminal/[id]/**`、`scheduled-tasks/[id]/**`、`auth/login`（POST，粘性 token）、`mcp/sign-in/[flowId]` |
| 按路径 / cwd | `files/**`、`file-index`、`git/*`、`worktrees/**`、`terminal`（POST）、`agent/new`、`cwd/status`、`project-trust`、`scheduled-tasks`（POST） |
| 选择后端但不属于项目 | `home`、`cwd/browse`、`cwd/validate`、`default-cwd`（添加项目流程和 `~` 显示中显式加 `/api/r/<h>/` 前缀；远程 home 也可从 `remote-info` 取得） |
| 全局配置 | `models/**`、`models-config/**`、`auth/*`、`provider-usage/*`、`mcp/**`、`skills/**`、`plugins/**`、`subagents/profiles|settings`、`tools/settings`、`artifacts/settings` |
| 汇总 | `sessions`、`sessions/search`、`agent/running`、`agent/running/events`、`scheduled-tasks`（GET）、`scheduled-tasks/events` |
| 无状态（任一后端皆可） | `models-config/catalog`、`skills/search`、`scheduled-tasks/preview`（注意时区默认取服务端） |
