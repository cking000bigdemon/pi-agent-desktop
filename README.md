# pi-web-desktop（Pi Agent）

把 [pi-web](https://github.com/cking000bigdemon/pi-web)（fork 自 [agegr/pi-web](https://github.com/agegr/pi-web)，pi 编程智能体的网页界面，发布为 npm 包 **`@cking000/pi-web`**）打包成一个**开箱即用的桌面应用**：
双击即用，没有浏览器、没有地址栏、没有常驻终端窗口，**目标机器无需预装任何运行时**。

它不只是「pi-web 套壳」——而是一台**电池全含的 AI 工作站**：内置 Node 与 Python 两套运行时、6 个默认扩展、一套 OKF 知识库技能（编译 / 查询 / 检查 / 可视化）和 PPT 生成技能 `ppt-master`，拷到空电脑双击即可使用。

**核心特性**
- 🧳 **内置 Node + Python 运行时** —— 目标机器无需 Node/npm/Python，拷到空电脑双击即用。
- ⚡ **就地运行，首启秒开** —— 直接从（可写的）安装目录跑 pi-web，不做首启复制。
- 🔄 **运行时自更新** —— App 内「检查更新」直接 `npm install @cking000/pi-web@latest`（npm 包自带预构建 `.next`，免编译），独立更新 pi-web + pi-coding-agent，**无需重新发版、不碰外壳代码**。
- 🧩 **默认扩展随装** —— 6 个 pi 扩展每次启动从仓库同步进 `~/.pi/agent/extensions/`，仓库为唯一真源。
- 📚 **默认技能随装** —— OKF 知识库技能 + `ppt-master` 演示文稿生成，每次启动同步进 `~/.pi/agent/skills/`，所有工作目录可用。
- 🐍 **零依赖 Python 技能** —— 内置 Python 让 Python 技能「装完即用、离线零 pip」；环境守卫强制用户项目走干净的 `.venv`。
- 🪟 **原生窗口** —— 内嵌 Next.js 服务隐藏运行在随机 `127.0.0.1` 端口，关窗即停。

## 目录结构

```
pi-web-desktop/
├── electron/
│   ├── main.js         # 主进程:解析运行时、起内置 node 服务、开窗、检查更新、同步扩展/技能、注入 Python 环境、退出清理
│   ├── updater.js      # 自更新逻辑(用内置 npm 查询/安装 @cking000/pi-web@latest)
│   ├── preload.js      # 最小安全桥(contextIsolation 开启)—— 自定义能力的暴露入口
│   ├── features/       # dashboard / subagents 等外壳后端逻辑
│   ├── loading.html / updating.html / error.html
│   └── ui/             # ★ 自定义能力的前端页面(可选,见「开发约束」)
├── vendor/node/        # 内置 Node.js 运行时(node.exe + npm) → resources/node            ← 构建输入(手动下载)
├── vendor/python/      # 内置 Python(python-build-standalone + ppt-master 依赖预装) → resources/python ← 构建输入(npm run seed:python)
├── runtime-seed/       # @cking000/pi-web 的 npm 生产安装(含 .next) → resources/runtime-seed        ← 构建输入(npm run seed)
├── extensions-seed/    # 默认随装的 7 个 pi 扩展(.ts 源码已入库;node_modules 为构建输入) → resources/extensions-seed
├── skills-seed/        # 默认随装的技能(wiki 系列 OKF + ppt-master,源码已入库) → resources/skills-seed
├── scripts/            # seed-python.ps1 + vendor-python-requirements.txt(供给 vendor/python)
├── build/              # 应用图标(icon.svg / icon.png / icon.ico)
├── electron-builder.yml
└── package.json
```

> **构建输入 vs 入库源码**:`vendor/`、`runtime-seed/`、`extensions-seed/node_modules`、以及 pi-web fork 的本地工作副本 `pi-web/` 都体积大、已 gitignore,需按[下文](#从零准备构建输入)重新准备。
> **已纳入版本库**:`extensions-seed/` 的 7 个 `.ts` 扩展源码、`skills-seed/` 全部技能源码(含 `ppt-master` 的模板/脚本)、`scripts/` 供给脚本——这些是产品源码,直接随仓库走。

## 运行架构

1. **解析运行时目录**（`runtimeDir()`）：
   - 安装目录里的 `resources/runtime-seed` **可写** → **就地运行**（默认，秒开，无复制）；
   - 只读（如装到 `C:\Program Files`）→ 回退：用 **robocopy**（长路径安全）把种子复制到 `%APPDATA%/pi-web-desktop/runtime`，写 `.seeded` 标记（只复制一次）。
2. **同步默认扩展与技能**（启动时，非阻塞、失败不挡启动）：
   - `ensureBundledExtensions()` 把 7 个扩展同步进 `~/.pi/agent/extensions/`；
   - `ensureBundledSkills()` 把技能同步进 `~/.pi/agent/skills/`（见下「内置的扩展与技能」）。
3. **注入 Python 环境**：spawn pi 服务时，把 `vendor/python` 前置到 `PATH` 并设 `PI_BUNDLED_PYTHON` / `PI_PY_GUARD_PYTHON` / `PI_PY_GUARD_BUNDLED_PYTHON`，供环境守卫与 `ppt-master` 使用。
4. **启动服务**：用 `resources/node/node.exe` 跑 `next start`，绑定 `127.0.0.1` 随机空闲端口，隐藏窗口、无控制台。
5. **加载窗口**：轮询服务就绪后 `loadURL` 到该端口。
6. **检查更新**（菜单 `App → 检查更新…`，或启动后自动静默检查）：用内置 npm `view` 对比版本，有新版则 `npm install @cking000/pi-web@latest --omit=dev`，重启服务并刷新窗口。
7. **退出**：`taskkill /T`（Windows）结束服务进程树，不留僵尸进程。

数据目录沿用 pi 的 `~/.pi/agent`（会话、`models.json`、模型凭证），与终端 `pi`、全局 `pi-web` 共享。

## 内置的扩展与技能

仓库的 `extensions-seed/` 与 `skills-seed/` 是这些能力的**唯一真源、在此开发**；每次启动按内容差异同步进 `~/.pi/agent/`，**仓库改 → 重装 / 重新运行即部署**。仓库外的其它扩展/技能一律不动。
**⚠ 不要手改数据目录里这些受管文件——会被下次启动覆盖。**

### 7 个默认扩展（`extensions-seed/` → `~/.pi/agent/extensions/`）

| 扩展 | 作用 |
|---|---|
| `agents-md-injector` | 把 AGENTS.md / CLAUDE.md 注入会话上下文 |
| `auto-session-title` | 自动生成会话标题 |
| `general-agent-prompt` | 通用 agent 系统提示增强 |
| `mcp-bridge` | 桥接 `mcp.json` 里的 MCP server（stdio/sse/http） |
| `python-workdir-guard` | **Python 工作目录守卫**：自动建 `.venv`、强制 Python 走 `.venv`（见下「零依赖 Python」） |
| `skill-shell-injection` | **Skill 动态上下文注入**：补上 Pi 原生没有的 Claude Code 式 `` !\`cmd\` `` / ```` ```! ```` 语法——SKILL.md/prompt 被加载时在 shell 执行内嵌命令、把输出内联替换进内容；钩 `read` 自动生效，另提供 `/skillx <name>` 直调 |
| `variflight-web-search` | 内置 web 搜索工具 |

受管文件**内容不同即覆盖**；`node_modules` 在缺失或 lockfile 变化时刷新。运行时 `@earendil-works/pi-coding-agent` 由 pi 注入扩展加载器，**不打包**；唯一需打包的依赖是 `@modelcontextprotocol/sdk`（mcp-bridge 用），由 `npm run seed:extensions` 准备。见 `main.js` 的 `ensureBundledExtensions()`。

### 默认技能（`skills-seed/` → `~/.pi/agent/skills/`）

pi 自动发现 `~/.pi/agent/skills/` 下的技能，因此它们在**每个工作目录**都可用。`ensureBundledSkills()` 用每技能的 `.seed-version` 签名（`路径|大小|mtime` 的 md5，仅 stat 不读文件体）做快速跳过——内容没变就整跳过同步，避免 `ppt-master` 的上万文件每次启动深度比对。

**OKF 知识库技能**（纯 Python 标准库，无 pip 依赖；把工作区文档编译成可移植的 [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) 知识库）：

| 技能 | 作用 |
|---|---|
| `wiki-init` | 在工作区自举 `okf.config.json` + 空 bundle 骨架（先跑这个） |
| `wiki-compile` | 扫描源文档 → 抽取概念 → 写概念文章 + 索引 + 术语表 |
| `wiki-query` | 两跳索引导航 + 概念文章合成带引用的回答 |
| `wiki-lint` | 一致性 / 新鲜度 / 覆盖度 / 关联 / 空白 / 尺寸 六类体检 |
| `okf-visualizer` | 把知识库渲染成单文件、离线、自包含的 HTML 关系图谱 |

> 两个方言由 `okf.config.json` 切换：`okf-pure`（默认，标准 markdown 链接，给任意编辑器/智能体用）与 `obsidian`（wikilink / callout / Dataview）。

**`ppt-master`**（演示文稿生成）：把源文档（PDF/DOCX/URL/Markdown）通过多角色流水线生成高质量 SVG 页面并导出 PPTX。依赖较重（python-pptx / PyMuPDF / svglib / Pillow / numpy …），已**预装在内置 Python**，跑 `$PI_BUNDLED_PYTHON` 离线即用、零 pip。配图默认占位模式（无 API Key 也能出整套 deck）。

### 零依赖 Python（守卫 + 内置 Python + ppt-master）

让打包后的 app 跑 Python 技能做到「装完即用、离线零依赖」，靠三件套咬合：

1. **内置 Python**（`vendor/python`）——可重定位的 python-build-standalone，ppt-master 依赖已预装。
2. **`main.js` 注入**——把它前置到 pi 服务进程的 `PATH`，并设三个 `PI_PY_GUARD_*` / `PI_BUNDLED_PYTHON` 环境变量。
3. **`python-workdir-guard` 守卫**——
   - 用内置 Python 创建项目 `.venv`（**无需系统 Python**）；
   - 放行内置解释器 `$PI_BUNDLED_PYTHON`，让 `ppt-master` 直接用它（重依赖现成）；
   - **用户自己的项目 Python 代码仍被强制走干净的 `.venv`**（方案 B：技能依赖留在内置 Python 的 base，不污染项目 venv）。

## 安装注意（首启是否秒开取决于安装目录）

| 装到哪 | 可写? | 首启 |
|---|---|---|
| **默认位置** `%LOCALAPPDATA%\Programs\pi-web`，或任意用户可写目录（如 `D:\Apps\pi-web`） | 是 | **就地运行，秒开** |
| `C:\Program Files\...`（无管理员权限时只读） | 否 | 回退复制运行时种子到 AppData，**首次约 1–2 分钟**（仅第一次，之后秒开） |

> 安装时**保持默认目录**即可秒开。装到 Program Files 不是坏掉，只是首启被迫做一次复制。
> `ppt-master` 首次部署约上万文件（含图标库）到 `~/.pi/agent/skills/`，约十几秒，仅第一次；之后靠 `.seed-version` 签名秒级跳过。

## 目标机器需要装什么?

- **不需要 Node / npm / Python**（已全部内置）。
- 需要在 App 内配置一个**模型提供商的 API Key**（侧边栏 Models / 登录面板）才能真正对话；空机器首次没有任何凭证。
- `ppt-master` 的 **AI 配图**需要 provider key（默认占位模式，无 key 也能出 deck；要真配图，复制技能内 `.env.example` 到 `~/.ppt-master/.env` 填 key）。
- 更新功能、首次模型调用、联网取数需要**联网**。
- 仅 **Windows x64**（内置运行时为 win-x64）；未签名，SmartScreen 提示「未知发布者」点「仍要运行」。

## 从零准备构建输入

```powershell
# 1. 安装 Electron 壳依赖
npm install

# 2. 运行时种子(@cking000/pi-web 生产安装,含预构建 .next)
mkdir runtime-seed; cd runtime-seed; npm init -y
npm install @cking000/pi-web@latest --omit=dev --registry=https://registry.npmmirror.com
cd ..

# 2b. 默认扩展的共享依赖(6 个 .ts 扩展源码已入库;此步只装它们的 node_modules)
npm run seed:extensions

# 3. 内置 Node 运行时(win-x64)
#    下载 node-v22.12.0-win-x64.zip 解压为 vendor/node(含 node.exe + npm)
#    例:https://registry.npmmirror.com/-/binary/node/v22.12.0/node-v22.12.0-win-x64.zip

# 4. 内置 Python(win-x64,ppt-master 依赖预装,~340MB) —— 全自动
npm run seed:python
```

> `skills-seed/` 全部技能源码（含 `ppt-master`）已入库，**无需额外准备**。
> 之后日常只需 `npm run seed` 把运行时种子升到最新发布版再打包。

## 开发 / 运行

```bash
npm start
```

开发态直接就地从项目里的 `runtime-seed` 运行，**秒开**；关窗自动结束后台服务。
排障：主进程把关键步骤写到 `%TEMP%/pi-web-desktop-debug.log`（看 `ensureBundledExtensions/Skills done`、`startOrRestartServer returned ok`）。

可选环境变量：
- `PI_WEB_REGISTRY` —— 自更新使用的 npm registry（默认 `https://registry.npmmirror.com`）。
- `PI_WEB_AUTO_UPDATE_CHECK=0` —— 关闭启动后的自动检查更新。
- `PI_CODING_AGENT_DIR` —— 指定 pi 会话数据目录（默认 `~/.pi/agent`）。

**开发默认扩展**：改 `extensions-seed/*.ts`，`npm start` 启动时同步进 `~/.pi/agent/extensions/`（内容不同即覆盖），重启即可验证；新增/变更依赖则改 `extensions-seed/package.json` 后跑 `npm run seed:extensions`。
**开发默认技能**：改 `skills-seed/<skill>/`，`npm start` 启动时按 `.seed-version` 签名同步进 `~/.pi/agent/skills/`（文件 mtime 变即重新部署）；Python 技能用 `$PI_BUNDLED_PYTHON` 调用脚本，新增重依赖请加进 `scripts/vendor-python-requirements.txt` 并 `npm run seed:python` 重供给。

## 打包安装程序

确保 `build/icon.ico` 存在，且 `vendor/node`、`vendor/python`（`npm run seed:python`）、`runtime-seed`、`extensions-seed`（其 `node_modules` 跑 `npm run seed:extensions` 准备）已就绪，然后：

```bash
npm run dist        # 生成 dist/Pi Agent Setup x.x.x.exe (NSIS)
npm run dist:dir    # 仅生成解包目录(调试更快)
```

> 国内首次打包会从 npmmirror 拉 electron / nsis 二进制（`.npmrc` 已配镜像）。
> 若遇 winCodeSign「无法创建符号链接」，是 Windows 软链权限问题——预先手动解压其缓存即可。

---

## 开发约束（加新能力必读）

> **本仓库只开发 Electron 外壳层。pi-web 和 pi-coding-agent 一律以 npm 包形式获取，本仓库不包含、不修改它们的源码。**

这是一个**两仓库分工**的项目，职责严格分离：

| 仓库 | 职责 | 改动流向 |
|---|---|---|
| **[cking000bigdemon/pi-web](https://github.com/cking000bigdemon/pi-web)**（fork 自 agegr/pi-web） | pi-web 网页端本身的功能/页面/接口 | 在本地工作副本 `pi-web/` 改 → push 到该仓库 → `npm run build` 构建 → 发布为 `@cking000/pi-web` 上 npm |
| **本仓库 pi-web-desktop** | Electron 外壳：窗口、内置运行时、自更新、dashboard、IPC、默认扩展/技能、自定义能力 | 在 `electron/`、`extensions-seed/`、`skills-seed/` 改 → 重新打包安装程序 |

**两条铁律：**

1. **pi-web 的任何修改，只能在 fork 仓库里做**（本地 `pi-web/` → push 到 `https://github.com/cking000bigdemon/pi-web`），经构建发布为新版本的 `@cking000/pi-web`，再由本项目的 `runtime-seed` / 自更新从 npm 拉取。**绝不在本仓库或 `runtime-seed` 里直接改 pi-web 源码 / `.next`**——那会被下一次 `npm install @cking000/pi-web@latest` 冲掉。
2. **pi-web 和 pi-coding-agent 只从 npm 获取**：
   - pi-web = 你 fork 发布的 **`@cking000/pi-web`**；
   - pi-coding-agent = 上游 **`@earendil-works/pi-coding-agent`**（作为 pi-web 的依赖随之安装，**不 fork、不改**）。
   - 本仓库不 vendoring、不内联它们的源码；`runtime-seed` 只是这两个 npm 包的一次生产安装。

### 分层与红线

```
你拥有、随便改 ─┐  electron/ · extensions-seed/ · skills-seed/ · scripts/        ← 本仓库
                │
pi-web 的功能  ─┤  在 fork 仓库 cking000bigdemon/pi-web 里改 → 发布 @cking000/pi-web
                │
内置运行时     ─┤  resources/node · resources/python
                │
只读、不在此改 ─┘  resources/runtime-seed = @cking000/pi-web(npm 包) · ~/.pi 数据目录
```

- ✅ **本仓库允许**：在 `electron/` 下加能力（Node 全权限）、加 IPC、加 preload API、加 UI；在 `extensions-seed/` 加默认扩展、`skills-seed/` 加默认技能。
- ✅ **pi-web 的改动**：去 fork 仓库改并发版，这里通过升级 npm 包吃到。
- ❌ **禁止**：在本仓库 / `runtime-seed` 里改 pi-web 源码或编译产物；fork、修改或内联 `@earendil-works/pi-coding-agent`。
- 需要"后端能力"且不属于 pi-web 网页层时，放在 **Electron main 里用 IPC 暴露**（等价于你自己的后端）。

### 外壳层新能力三件套

1. **数据访问** —— 放 `electron/features/<name>.js`。取数优先**直接读 `~/.pi`**（稳定），或用内置 node `spawn` 运行时里的 `pi` CLI 兜底。
2. **暴露通道** —— `ipcMain.handle("<域>:<动作>", …)` + `preload.js` 里 `contextBridge.exposeInMainWorld("piDesktop", { … })`。pi-web 本体不受影响。
3. **展示界面** —— 三选一（按耦合度）：菜单 + 独立窗口（推荐，零耦合）/ preload 注入悬浮入口（体验一体，依赖注入点）/ 托盘 · 全局快捷键（轻量触发）。

### 升级安全 & 给上游/fork 回流

- 你的 `electron/`、`extensions-seed/`、`skills-seed/` 全在外壳层，自更新只换 `runtime-seed`，**碰不到**。
- pi-web 的修复/功能在 fork 仓库维护；**通用、非定制的改动应尽量给 [agegr/pi-web](https://github.com/agegr/pi-web) 上游提 PR**，合并后即可丢弃 fork 中对应的本地补丁。
- 定期 `git fetch upstream && rebase` 把 fork 同步到上游，解决冲突后重新发版。

---

## 已知取舍

- **安装包体积**：内置 Node + Python + 运行时种子 + 技能（含 ppt-master 图标库），约 **500MB+**；换来空电脑「装完即用、零依赖」。
- **只读目录安装首启较慢**（复制运行时种子，仅第一次）；可写目录安装则秒开。
- **`ppt-master` 首次部署**约十几秒（上万文件），之后靠 `.seed-version` 签名秒级跳过。
- **Python 仅 Windows x64**（与 `vendor/node` 一致）；mac/linux 暂未捆绑 Python。
- **自更新粒度**是 pi-web 这一层；Electron 外壳（含扩展/技能/内置运行时）更新仍需重新发安装包。
- **维护成本**：拥有 fork 意味着要自行同步上游 + 重新发版（换来"修复/定制不必等上游合并"的自由）。
