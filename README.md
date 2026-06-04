# pi-web-desktop

把 [pi-web](https://github.com/agegr/pi-web)(pi 编程智能体的网页界面)打包成一个**独立桌面应用**:
双击即用,没有浏览器、没有地址栏、没有常驻终端窗口。

**v2 特性**
- 🧳 **内置 Node.js 运行时** —— 目标机器无需预装 Node/npm,拷到空电脑双击即用。
- 🔄 **运行时自更新** —— App 内「检查更新」直接 `npm install @agegr/pi-web@latest`(上游 npm 包自带预构建 `.next`,免编译),独立更新 pi-web + pi-coding-agent,无需重新发版。
- 🪟 **原生窗口** —— 内嵌 Next.js 服务隐藏运行在随机 `127.0.0.1` 端口,关窗即停。

```
pi-web-desktop/
├── electron/
│   ├── main.js        # 主进程:首启 seed→用户目录、起内置 node 服务、开窗、检查更新、退出清理
│   ├── updater.js     # 自更新逻辑(用内置 npm 查询/安装 @agegr/pi-web@latest)
│   ├── preload.js     # 最小安全桥(contextIsolation 开启)
│   ├── loading.html / updating.html / error.html
├── vendor/node/       # 内置 Node.js 运行时(node.exe + npm),打包进 resources/node  ← 需准备
├── runtime-seed/      # @agegr/pi-web 的 npm 生产安装(含 .next),打包进 resources/runtime-seed  ← 需准备
├── build/             # 应用图标(icon.svg / icon.png / icon.ico)
├── electron-builder.yml
└── package.json
```

> `vendor/` 和 `runtime-seed/` 是构建输入,体积大、已 gitignore,需按下文重新准备。

## 运行架构

1. **首次启动**:把 `resources/runtime-seed` 用 **robocopy**(长路径安全)复制到可写的用户目录
   `%APPDATA%/pi-web/runtime`,写入 `.seeded` 标记(避免重复复制)。
2. **启动服务**:用 `resources/node/node.exe` 跑 `next start`,绑定 `127.0.0.1` 随机空闲端口,隐藏窗口、无控制台。
3. **加载窗口**:轮询服务就绪后 `loadURL` 到该端口。
4. **检查更新**(菜单 `App → 检查更新…`,或启动后自动静默检查):
   用内置 npm `view` 对比版本,有新版则 `npm install @agegr/pi-web@latest --omit=dev`,
   重启内嵌服务并刷新窗口。
5. **退出**:`taskkill /T`(Windows)结束服务进程树,不留僵尸进程。

数据目录沿用 pi 的 `~/.pi/agent`(会话、`models.json`、模型凭证),与终端 `pi`、全局 `pi-web` 共享。

## 目标机器需要装什么?

- **不需要 Node/npm**(已内置)。
- 需要在 App 内配置一个**模型提供商的 API Key**(侧边栏 Models/登录面板)才能真正对话;空机器首次没有任何凭证。
- 更新功能与首次无种子场景需要**联网**。

## 从零准备构建输入

```powershell
# 1. 安装 Electron 壳依赖
npm install

# 2. 准备运行时种子(@agegr/pi-web 生产安装,含预构建 .next)
mkdir runtime-seed; cd runtime-seed; npm init -y
npm install @agegr/pi-web@latest --omit=dev --registry=https://registry.npmmirror.com
cd ..

# 3. 准备内置 Node 运行时(win-x64)
#    下载 node-v22.12.0-win-x64.zip 解压为 vendor/node(含 node.exe + npm)
#    例:从 https://registry.npmmirror.com/-/binary/node/v22.12.0/node-v22.12.0-win-x64.zip
```

> 之后只需 `npm run seed` 即可把运行时种子升到上游最新版再打包。

## 开发 / 运行

```bash
npm start
```

先显示「正在启动 pi-web…」,首启会复制运行时(约 10 万文件,**首次需 ~1 分钟**;之后秒开),
就绪后自动加载界面。关窗自动结束后台服务。

可选环境变量:
- `PI_WEB_REGISTRY` —— 自更新使用的 npm registry(默认 `https://registry.npmmirror.com`)。
- `PI_WEB_AUTO_UPDATE_CHECK=0` —— 关闭启动后的自动检查更新。
- `PI_CODING_AGENT_DIR` —— 指定 pi 会话数据目录(默认 `~/.pi/agent`)。

排障:主进程会写调试日志到 `%TEMP%/pi-web-desktop-debug.log`。

## 打包安装程序

确保 `build/icon.ico` 存在,且 `vendor/node`、`runtime-seed` 已准备好,然后:

```bash
npm run dist        # 生成 dist/pi-web Setup x.x.x.exe (NSIS)
npm run dist:dir    # 仅生成解包目录(调试更快)
```

> 国内首次打包会从 npmmirror 拉 electron / nsis 二进制(`.npmrc` 已配镜像)。
> 若遇 winCodeSign「无法创建符号链接」,是 Windows 软链权限问题——预先手动解压其缓存即可(详见提交记录)。

## 已知取舍

- **首次启动较慢**(~1 分钟复制运行时);后续启动秒开。可后续优化为压缩包解压。
- **安装包体积**:内置 Node + 运行时种子,压缩后约百 MB 级;换来空电脑开箱即用。
- 自更新粒度是 pi-web 这一层;Electron 外壳更新仍需重新发安装包。
