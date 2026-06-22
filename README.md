# pi-web-desktop

把 [pi-web](https://github.com/cking000bigdemon/pi-web)(fork 自 [agegr/pi-web](https://github.com/agegr/pi-web),pi 编程智能体的网页界面,发布为 npm 包 **`@cking000/pi-web`**)打包成一个**独立桌面应用**:
双击即用,没有浏览器、没有地址栏、没有常驻终端窗口。

**核心特性**
- 🧳 **内置 Node.js 运行时** —— 目标机器无需预装 Node/npm,拷到空电脑双击即用。
- ⚡ **就地运行,首启秒开** —— 直接从(可写的)安装目录跑 pi-web,不做首启复制。
- 🔄 **运行时自更新** —— App 内「检查更新」直接 `npm install @cking000/pi-web@latest`(npm 包自带预构建 `.next`,免编译),独立更新 pi-web + pi-coding-agent,**无需重新发版、不碰外壳代码**。
- 🪟 **原生窗口** —— 内嵌 Next.js 服务隐藏运行在随机 `127.0.0.1` 端口,关窗即停。

```
pi-web-desktop/
├── electron/
│   ├── main.js         # 主进程:解析运行时目录、起内置 node 服务、开窗、检查更新、退出清理
│   ├── updater.js      # 自更新逻辑(用内置 npm 查询/安装 @cking000/pi-web@latest)
│   ├── preload.js      # 最小安全桥(contextIsolation 开启)—— 自定义能力的暴露入口
│   ├── loading.html / updating.html / error.html
│   ├── features/       # ★ 自定义能力的后端逻辑(可选,见「开发约束」)
│   └── ui/             # ★ 自定义能力的前端页面(可选,见「开发约束」)
├── vendor/node/        # 内置 Node.js 运行时(node.exe + npm) → 打包进 resources/node   ← 构建输入
├── runtime-seed/       # @cking000/pi-web 的 npm 生产安装(含 .next) → 打包进 resources/runtime-seed ← 构建输入
├── build/              # 应用图标(icon.svg / icon.png / icon.ico)
├── electron-builder.yml
└── package.json
```

> `vendor/`、`runtime-seed/`、以及 pi-web fork 的本地工作副本 `pi-web/` 都是构建输入或独立仓库,体积大、已 gitignore,需按下文重新准备。
> `features/`、`ui/` 标 ★ 的是给后续自定义能力预留的位置,初始可不存在。

## 运行架构

1. **解析运行时目录**(`runtimeDir()`):
   - 安装目录里的 `resources/runtime-seed` **可写** → **就地运行**(默认,秒开,无复制);
   - 只读(如装到 `C:\Program Files`)→ 回退:用 **robocopy**(长路径安全)把种子复制到
     `%APPDATA%/pi-web-desktop/runtime`,写 `.seeded` 标记(只复制一次)。
2. **启动服务**:用 `resources/node/node.exe` 跑 `next start`,绑定 `127.0.0.1` 随机空闲端口,隐藏窗口、无控制台。
3. **加载窗口**:轮询服务就绪后 `loadURL` 到该端口。
4. **检查更新**(菜单 `App → 检查更新…`,或启动后自动静默检查):
   用内置 npm `view` 对比版本,有新版则 `npm install @cking000/pi-web@latest --omit=dev`,重启服务并刷新窗口。
5. **退出**:`taskkill /T`(Windows)结束服务进程树,不留僵尸进程。

数据目录沿用 pi 的 `~/.pi/agent`(会话、`models.json`、模型凭证),与终端 `pi`、全局 `pi-web` 共享。

## 安装注意(首启是否秒开取决于安装目录)

| 装到哪 | 可写? | 首启 |
|---|---|---|
| **默认位置** `%LOCALAPPDATA%\Programs\pi-web`,或任意用户可写目录(如 `D:\Apps\pi-web`) | 是 | **就地运行,秒开** |
| `C:\Program Files\...`(无管理员权限时只读) | 否 | 回退复制 ~10 万文件到 AppData,**首次约 1–2 分钟**(仅第一次,之后秒开) |

> 安装时**保持默认目录**即可秒开。装到 Program Files 不是坏掉,只是首启被迫做一次复制。

## 目标机器需要装什么?

- **不需要 Node/npm**(已内置)。
- 需要在 App 内配置一个**模型提供商的 API Key**(侧边栏 Models/登录面板)才能真正对话;空机器首次没有任何凭证。
- 更新功能、首次模型调用需要**联网**。
- 仅 **x64**;ARM Windows 走 x64 模拟。未签名,SmartScreen 提示「未知发布者」点「仍要运行」。

## 从零准备构建输入

```powershell
# 1. 安装 Electron 壳依赖
npm install

# 2. 准备运行时种子(@cking000/pi-web 生产安装,含预构建 .next)
mkdir runtime-seed; cd runtime-seed; npm init -y
npm install @cking000/pi-web@latest --omit=dev --registry=https://registry.npmmirror.com
cd ..

# 3. 准备内置 Node 运行时(win-x64)
#    下载 node-v22.12.0-win-x64.zip 解压为 vendor/node(含 node.exe + npm)
#    例:https://registry.npmmirror.com/-/binary/node/v22.12.0/node-v22.12.0-win-x64.zip
```

> 之后只需 `npm run seed` 把运行时种子升到最新发布版再打包。

## 开发 / 运行

```bash
npm start
```

开发态直接就地从项目里的 `runtime-seed` 运行,**秒开**;关窗自动结束后台服务。

可选环境变量:
- `PI_WEB_REGISTRY` —— 自更新使用的 npm registry(默认 `https://registry.npmmirror.com`)。
- `PI_WEB_AUTO_UPDATE_CHECK=0` —— 关闭启动后的自动检查更新。
- `PI_CODING_AGENT_DIR` —— 指定 pi 会话数据目录(默认 `~/.pi/agent`)。

排障:主进程会把关键步骤写到 `%TEMP%/pi-web-desktop-debug.log`。

## 打包安装程序

确保 `build/icon.ico` 存在,且 `vendor/node`、`runtime-seed` 已准备好,然后:

```bash
npm run dist        # 生成 dist/Pi Agent Setup x.x.x.exe (NSIS)
npm run dist:dir    # 仅生成解包目录(调试更快)
```

> 国内首次打包会从 npmmirror 拉 electron / nsis 二进制(`.npmrc` 已配镜像)。
> 若遇 winCodeSign「无法创建符号链接」,是 Windows 软链权限问题——预先手动解压其缓存即可。

---

## 开发约束(加新能力必读)

> **本仓库只开发 Electron 外壳层。pi-web 和 pi-coding-agent 一律以 npm 包形式获取,本仓库不包含、不修改它们的源码。**

这是一个**两仓库分工**的项目,职责严格分离:

| 仓库 | 职责 | 改动流向 |
|---|---|---|
| **[cking000bigdemon/pi-web](https://github.com/cking000bigdemon/pi-web)**(fork 自 agegr/pi-web) | pi-web 网页端本身的功能/页面/接口 | 在本地工作副本 `pi-web/` 改 → push 到该仓库 → `npm run build` 构建 → 发布为 `@cking000/pi-web` 上 npm |
| **本仓库 pi-web-desktop** | Electron 外壳:窗口、内置运行时、自更新、dashboard、IPC、自定义能力 | 在 `electron/` 改 → 重新打包安装程序 |

**两条铁律:**

1. **pi-web 的任何修改,只能在 fork 仓库里做**(本地 `pi-web/` → push 到 `https://github.com/cking000bigdemon/pi-web`),经构建发布为新版本的 `@cking000/pi-web`,再由本项目的 `runtime-seed` / 自更新从 npm 拉取。**绝不在本仓库或 `runtime-seed` 里直接改 pi-web 源码 / `.next`**——那会被下一次 `npm install @cking000/pi-web@latest` 冲掉。
2. **pi-web 和 pi-coding-agent 只从 npm 获取**:
   - pi-web = 你 fork 发布的 **`@cking000/pi-web`**;
   - pi-coding-agent = 上游 **`@earendil-works/pi-coding-agent`**(作为 pi-web 的依赖随之安装,**不 fork、不改**)。
   - 本仓库不 vendoring、不内联它们的源码;`runtime-seed` 只是这两个 npm 包的一次生产安装。

### 分层与红线

```
你拥有、随便改 ─┐  electron/main.js · preload.js · features/ · ui/        ← 本仓库
                │
pi-web 的功能  ─┤  在 fork 仓库 cking000bigdemon/pi-web 里改 → 发布 @cking000/pi-web
                │
内置 node 运行时 ┤  resources/node
                │
只读、不在此改 ─┘  resources/runtime-seed = @cking000/pi-web(npm 包) · ~/.pi 数据目录
```

- ✅ **本仓库允许**:在 `electron/` 下加能力(Node 全权限)、加 IPC、加 preload API、加你自己的 UI 窗口/页面。
- ✅ **pi-web 的改动**:去 fork 仓库改并发版,这里通过升级 npm 包吃到。
- ❌ **禁止**:在本仓库 / `runtime-seed` 里改 pi-web 源码或编译产物;fork、修改或内联 `@earendil-works/pi-coding-agent`。
- 需要"后端能力"且不属于 pi-web 网页层时,放在 **Electron main 里用 IPC 暴露**(等价于你自己的后端)。

### 外壳层新能力三件套

1. **数据访问** —— 放 `electron/features/<name>.js`。取数优先**直接读 `~/.pi`**(稳定),或用内置 node `spawn` 运行时里的 `node_modules/.bin/pi` CLI 兜底。
2. **暴露通道** —— `ipcMain.handle("<域>:<动作>", …)` + `preload.js` 里 `contextBridge.exposeInMainWorld("piDesktop", { … })`。pi-web 本体不受影响。
3. **展示界面** —— 三选一(按耦合度):
   - **① 菜单 + 独立窗口(推荐)**:菜单项打开 `electron/ui/<name>.html`,页面调 `window.piDesktop.*` 渲染。零耦合、最稳。
   - **② preload 注入悬浮入口**:往 pi-web 页面注入一个按钮/侧栏触发 IPC,体验"一体";但依赖注入点,pi-web 大改样式时按钮位置可能要微调(功能不受影响)。
   - **③ 托盘 / 全局快捷键**:适合轻量触发。

### 升级安全 & 给上游/fork 回流

- 你的 `features/`、`ui/`、IPC、preload 全在外壳层,自更新只换 `runtime-seed`,**碰不到**。
- pi-web 的修复/功能在 fork 仓库维护;**通用、非定制的改动应尽量给 [agegr/pi-web](https://github.com/agegr/pi-web) 上游提 PR**,合并后即可丢弃 fork 中对应的本地补丁,减少长期维护负担。
- 定期 `git fetch upstream && rebase` 把 fork 同步到上游,解决冲突后重新发版。

---

## 已知取舍

- **只读目录安装首启较慢**(~1–2 分钟复制,仅第一次);可写目录安装则秒开。后续可优化为压缩包快速解压,彻底消除该差异。
- **安装包体积**:内置 Node + 运行时种子,压缩后约 250MB;换来空电脑开箱即用。
- **自更新粒度**是 pi-web 这一层;Electron 外壳本身更新仍需重新发安装包。
- **维护成本**:拥有 fork 意味着要自行同步上游 + 重新发版(换来"修复/定制不必等上游合并"的自由)。
