# DSH for VSCode

[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.90-blue?logo=visualstudiocode)](https://code.visualstudio.com/)
[![Node](https://img.shields.io/badge/Node-20%2B-green?logo=nodedotjs)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/license/mit)

> **语言 / Language**：[中文](#中文) · [English](#english)

---

## 中文

把 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) **完整搬进 VSCode**：整个 Web GUI——聊天、会话、设置、以及全部 DSH 插件——以 iframe 嵌入编辑区面板，文件编辑与 VSCode 原生编辑器**双向联动**，并与浏览器 WebUI **共享同一个运行中的实例**。

⚠️**本项目由 Deepseek-V4-Flash 和 Deepseek-V4-Pro 生成，发布者仅测试其功能正常，不保证项目安全性**⚠️

### 特性

- **完整 Web GUI，全部插件兼容**——运行的是真实 `dsh web` 前端，由 iframe 嵌入到编辑区：聊天、会话、设置、模型与 agent preset，以及任何插件原样可用。
- **文件互通**：
  - agent 创建/修改文件时，按策略在vscode编辑区打开对应文件；
  - 已打开且有**未保存修改**的文档不会自动覆盖；
  - 在编辑区保存后 agent 读到的就是最新磁盘内容；
  - 点击dsh中的交付文件 chips / 路径文本时，在vscode编辑区打开；
  - agent 删除文件时自动关闭对应文件标签页（dirty 则保留）；
  - 在 agent 中切换工作区时会将标签页切换到新工作区已打开的文件。
- **不改变profile**——插件本身只是将web ui嵌入到vscode，不修改你 profile 的 `package.json` / `cordis.patch.yml`；卸载即无痕。

### 环境要求

- 桌面版 VS Code `>= 1.90`（Windows / macOS / Linux）。请注意，由于访问的是回环地址，Remote、容器与 vscode.dev **不受支持**。
- PATH 上有 Node.js `>= 20`。
- 可用的 DSH 安装与已配置的 profile——`npm i -g @deepseek-ai/dsh`（或 npx 安装），且 `~/.dsh` 已配置（settings / API key，`dsh web` 能正常启动）。扩展复用你现有的 `~/.dsh`。

### 安装

**从 VSIX 安装**

```sh
npm install
npm run package        # 生成 dsh-for-vscode-<version>.vsix
```

然后在 VSCode 中：扩展视图 → `...` → **从 VSIX 安装…** → 重载。

### 快速开始

1. 命令面板运行 **`DSH: 打开 DSH 面板`**——面板在编辑器旁打开，DSH GUI（含你的全部插件）在其中启动。
2. 正常聊天。agent 写文件时自动在 VSCode 打开；点击聊天里的交付文件 chip 即在 VSCode 编辑器中打开。
3. 状态栏显示当前实例（`DSH :端口`），点击可随时重开面板。

### 实例共享

**实例** 即一个 **DSH host 进程** 。实例共享指的是VSCode与浏览器指向同一个DSH host 进程，从而获得相同的界面。该行为由设置项`hostMode`管理。

| 参数值 | 做法 | 说明 |
|---|---|---|
| `spawn` | 使用面板；浏览器打开状态栏端口，或运行 `DSH: 在浏览器中打开共享实例` |  `spawn`会尝试拉起一个DSH host 进程，同时VSCode会连接到这个进程。为防止再两个不同的实例上同时运行同一段对话导致会话日志损坏，当发现DSH默认端口已有实例运行时，默认不拉起新的实例。该行为可在设置项`allowDualInstance`修改。 |
| `Connect` | 终端运行 `dsh web`（3080），在命令面板运行 `DSH：打开DSH面板` | `Connect`参数下扩展会尝试连接到默认端口`connectUrl`下的 DSH host 进程 |
| `auto` | 自动连接 | connectUrl 上已有可用实例则连接，否则仅当 autoModeSpawn 开启时托管启动 |

### 命令

| 命令 | 说明 |
|---|---|
| `DSH: 打开 DSH 面板` | 打开/聚焦 DSH 面板 |
| `DSH: 在浏览器中打开共享实例` | 用默认浏览器打开当前实例 URL |
| `DSH: 重启 Host` | 停止并重启托管实例 |
| `DSH: 停止 Host` | 停止托管实例（connect 模式仅清空状态） |
| `DSH: 导出桥接叠加层（供手动托管共享实例）` | 导出自包含的 `--patch` 叠加层，用于手动托管共享实例 |

### 设置（`dshVscode.*`）

| 设置 | 默认 | 说明 |
|---|---|---|
| `hostMode` | `auto` | `auto`：`connectUrl` 上已有可用实例则连接，否则仅当 `autoModeSpawn` 开启时托管启动。`spawn`：总是托管（检测到已有实例在跑则默认拒绝，见 `allowDualInstance`）。`connect`：总是连接。 |
| `connectUrl` | `http://127.0.0.1:3080` | connect / auto 检测的实例地址（仅回环）。 |
| `sharePort` | `true` | spawn 时优先用 3080（空闲则用），浏览器可连到同一实例。 |
| `autoModeSpawn` | `false` | auto 模式下，若 3080（`connectUrl`）没有 dsh web 在运行，是否唤起（托管启动）dsh web。默认关闭：auto 仅连接已有实例，无实例时提示错误而不是自动启动。 |
| `allowDualInstance` | `false` | spawn 前检测到已有 DSH 实例在运行（`connectUrl` / 共享端口 / 本扩展上次托管的实例）时，是否允许再启动一个。两个实例共享同一 `~/.dsh` 并发写会话日志会损坏日志（`corrupt session log: seq gap`）。默认关闭（拒绝并提示）；开启自担风险。 |
| `stopHostOnExit` | `true` | 退出 VSCode 时自动结束由本扩展托管的 host 进程（spawn 模式，或 auto 模式下由扩展启动的实例）。关闭时保留运行，下次打开面板 reattach 同一实例。 |
| `stopConnectedInstanceOnExit` | `false` | connect 模式下，退出 VSCode 时是否同时结束所连接的 DSH 实例。仅对带 `dsh-vscode-bridge` 的实例生效（经桥接 health 拿 PID 后结束进程树）；无桥接的实例无法结束。默认关闭：connect 模式的实例由外部管理，退出 VSCode 不影响它。 |
| `autoOpenFiles` | `preview` | agent 写文件时的自动打开策略：`preview`（可复用预览标签）/ `editor`（持久标签）/ `off`。 |
| `autoOpenInclude` / `autoOpenExclude` | — | 自动打开的 glob 白名单 / 黑名单（默认排除 `node_modules`、`.git`、二进制等）。 |
| `openColumn` | `beside` | DSH 面板打开位置（`beside` / `active`）。 |
| `hostCwd` | （空） | host 工作目录（留空 = 当前工作区文件夹，无文件夹用主目录）。 |
| `executablePath` | （空） | 显式 dsh 路径（可执行文件或 `lib/bin.js`）。留空 = 自动查找（npx 缓存 / 全局 npm / PATH）。 |
| `profileName` | `web` | 启动的 profile（须为带 Web 界面的 profile）。 |
| `readyTimeoutSec` | `60` | host 就绪等待超时。 |
| `debugLog` | `false` | 扩展控制台额外诊断（host stdout/stderr 始终写入 `logs/host-*.log`）。 |

### 项目结构

```
├─ src/                      # 扩展宿主源码（TypeScript → dist/）
│  ├─ extension.ts           # 激活、命令、组装
│  ├─ messages.ts            # 消息协议类型与守卫
│  ├─ host/
│  │  ├─ hostManager.ts      # spawn/connect/reattach/清理 + 叠加层生成
│  │  ├─ hostUtils.ts        # dsh 查找、端口、严格就绪探测
│  │  └─ dshApi.ts           # /api RPC 客户端（session.list → cwd）
│  ├─ webview/
│  │  ├─ panel.ts            # webview 面板、CSP、序列化恢复
│  │  └─ relay.ts            # 自包含的 iframe⇄宿主消息中继
│  └─ linkage/
│     ├─ nodeWatcher.ts      # fs.watch 递归目录监听（跨工作区）
│     ├─ watcher.ts          # 防抖、dirty 安全策略、tab 关闭
│     ├─ policy.ts           # 纯决策逻辑（glob→正则、打开决策）
│     ├─ pathSafety.ts       # 防目录穿越/符号链接的路径解析
│     └─ opener.ts           # 带行列的 showTextDocument
├─ bridge/                   # DSH 侧桥接插件（纯 ESM JS，无构建步骤）
│  └─ lib/
│     ├─ index.js            # cordis host 插件：/dsh-vscode 路由 + tapIndex + systemPrompt 公告
│     └─ bridge.js           # 页面内脚本：点击捕获、会话跟踪（dshEmbed 门控）
├─ tests/                    # node:test + jsdom 套件（74 个测试，零原生依赖）
├─ tools/
│  └─ session-log-check.mjs  # 会话日志检查/修复工具（corrupt session log: seq gap 恢复）
├─ .github/workflows/ci.yml  # CI：push/PR 时构建 + 测试
├─ package.json              # 扩展清单与脚本
└─ tsconfig*.json            # host（CJS）与 webview（普通脚本）配置
```

产物（`dist/`、`node_modules/`、`*.vsix`、`.npm-cache/`）已被 .gitignore 排除——其余全部提交。

### 已知限制

- 仅桌面版 VSCode；不支持 Remote / 容器 / vscode.dev。
- webview 内的下载（会话 ZIP）与剪贴板可能受 Electron 环境限制。
- 两个 VSCode 窗口共享工作区时，第二个窗口 reattach 到既有实例（不重复 spawn）。两个窗口**同一时刻**首次打开可能各起一个实例——先开一个面板即可避免。
- 桥接的点击捕获针对交付文件行（`[data-produced-files-row]`）与路径形 title——DSH 未来改版可能需要小幅更新（路径形过滤保证失效时安全放行）。
> [!WARNING]
> 两个不同的实例上同时运行同一段对话可能会导致会话日志损坏

### 贡献

本项目由Deepseek Harness搭配Deepseek-V4-Flash和Deepseek-V4-Pro生成，发布者全程Vibe Coding，用于感受新模型搭配Harness的Vibe Coding体验。

### 许可证

[MIT](https://opensource.org/license/mit)

---

## English

Bring [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) **fully into VSCode**: the entire Web GUI — chat, sessions, settings, and all DSH plugins — embedded in the editor area via an iframe, with **two-way file sync** to the native VSCode editor, and **sharing the same running instance** as the browser WebUI.

⚠️**This project was generated by Deepseek-V4-Flash and Deepseek-V4-Pro. The publisher has only verified that it functions and does not guarantee its security.**⚠️

### Features

- **Complete Web GUI, all plugins compatible** — runs the real `dsh web` frontend, embedded in the editor area via an iframe: chat, sessions, settings, models & agent presets, and any plugin work exactly as-is.
- **File interop**:
  - when the agent creates/modifies files, the corresponding files open in the VSCode editor area per the policy;
  - documents that are open with **unsaved changes** are never overwritten automatically;
  - after you save in the editor, the agent reads the latest on-disk content;
  - clicking delivered-file chips / path text in DSH opens them in the VSCode editor area;
  - when the agent deletes a file, its editor tab closes automatically (dirty tabs are kept);
  - when the agent switches workspaces, tabs switch to files already open in the new workspace.
- **No profile mutation** — the plugin only embeds the web UI into VSCode; it does not modify your profile's `package.json` / `cordis.patch.yml`; uninstalling leaves no trace.

### Requirements

- Desktop VS Code `>= 1.90` (Windows / macOS / Linux). Note: because it accesses loopback addresses, Remote, containers, and vscode.dev are **not supported**.
- Node.js `>= 20` on PATH.
- A working DSH install with a configured profile — `npm i -g @deepseek-ai/dsh` (or install via npx), with `~/.dsh` configured (settings / API key, so `dsh web` starts properly). The extension reuses your existing `~/.dsh`.

### Installation

**Install from VSIX**

```sh
npm install
npm run package        # generates dsh-for-vscode-<version>.vsix
```

Then in VSCode: Extensions view → `...` → **Install from VSIX…** → Reload.

### Quick Start

1. Run **`DSH: Open DSH Panel`** from the command palette — the panel opens beside the editor and the DSH GUI (including all your plugins) starts inside it.
2. Chat normally. When the agent writes files they auto-open in VSCode; clicking a delivered-file chip in the chat opens it in the VSCode editor.
3. The status bar shows the current instance (`DSH :port`); click it to reopen the panel anytime.

### Instance Sharing

An **instance** is a **DSH host process**. Instance sharing means VSCode and the browser point at the same DSH host process, getting the same UI. This behavior is governed by the `hostMode` setting.

| Value | How | Notes |
|---|---|---|
| `spawn` | Use the panel; open the status-bar port in a browser, or run `DSH: Open Shared Instance in Browser` | `spawn` tries to start a DSH host process, and VSCode connects to it. To prevent running the same conversation on two different instances at once (which corrupts session logs), a new instance is not started by default when one is already running on the default port. This behavior can be changed with the `allowDualInstance` setting. |
| `connect` | Run `dsh web` (3080) in a terminal, then run `DSH: Open DSH Panel` from the command palette | In `connect` mode the extension tries to connect to the DSH host process at the default port `connectUrl` |
| `auto` | Auto-connect | Connects if a usable instance exists on `connectUrl`, otherwise starts a managed one only when `autoModeSpawn` is on |

### Commands

| Command | Description |
|---|---|
| `DSH: Open DSH Panel` | Open/focus the DSH panel |
| `DSH: Open Shared Instance in Browser` | Open the current instance URL in the default browser |
| `DSH: Restart Host` | Stop and restart the managed instance |
| `DSH: Stop Host` | Stop the managed instance (connect mode only clears state) |
| `DSH: Export Bridge Overlay…` | Export a self-contained `--patch` overlay for manually hosting a shared instance |

### Settings (`dshVscode.*`)

| Setting | Default | Description |
|---|---|---|
| `hostMode` | `auto` | `auto`: connect if a usable instance exists on `connectUrl`, otherwise start a managed one only when `autoModeSpawn` is on. `spawn`: always host (refused by default when another live instance is detected — see `allowDualInstance`). `connect`: always connect. |
| `connectUrl` | `http://127.0.0.1:3080` | Instance URL for connect / auto detection (loopback only). |
| `sharePort` | `true` | When spawning, prefer port 3080 if free, so the browser can join the same instance. |
| `autoModeSpawn` | `false` | In `auto` mode, whether to spawn (host) `dsh web` when none is running on 3080 (`connectUrl`). Off (default): `auto` only connects to an existing instance and errors instead of auto-starting one. |
| `allowDualInstance` | `false` | Allow starting another instance when a live DSH instance is detected (`connectUrl` / shared port / a previously managed instance). Two instances sharing the same `~/.dsh` write session logs concurrently and corrupt them (`corrupt session log: seq gap`). Off (default) refuses with a clear error; on is at your own risk. |
| `stopHostOnExit` | `true` | End the extension-managed host process when VSCode exits (spawn mode, or an instance started by the extension in `auto` mode). Off keeps it running so the next panel open reattaches to the same instance. |
| `stopConnectedInstanceOnExit` | `false` | In `connect` mode, whether to also end the connected DSH instance when VSCode exits. Only works for instances with the `dsh-vscode-bridge` (the PID is obtained via the bridge health route, then its process tree is ended); bridgeless instances cannot be ended. Off (default): the connected instance is managed externally and is unaffected by VSCode exiting. |
| `autoOpenFiles` | `preview` | Auto-open policy for agent writes: `preview` (reusable preview tab) / `editor` (persistent tab) / `off`. |
| `autoOpenInclude` / `autoOpenExclude` | — | Glob allow/deny lists for auto-open (excludes `node_modules`, `.git`, binaries, … by default). |
| `openColumn` | `beside` | Where the DSH panel opens (`beside` / `active`). |
| `hostCwd` | (empty) | Working directory for the host (empty = current workspace folder, else home). |
| `executablePath` | (empty) | Explicit dsh path (executable or `lib/bin.js`). Empty = auto-detect (npx cache / global npm / PATH). |
| `profileName` | `web` | Profile to boot (must be a web-capable profile). |
| `readyTimeoutSec` | `60` | Host readiness timeout. |
| `debugLog` | `false` | Extra diagnostics in the extension log console (host stdout/stderr always goes to `logs/host-*.log`). |

### Project Structure

```
├─ src/                      # extension host source (TypeScript → dist/)
│  ├─ extension.ts           # activation, commands, wiring
│  ├─ messages.ts            # message protocol types & guards
│  ├─ host/
│  │  ├─ hostManager.ts      # spawn/connect/reattach/cleanup + overlay generation
│  │  ├─ hostUtils.ts        # dsh lookup, ports, strict readiness probing
│  │  └─ dshApi.ts           # /api RPC client (session.list → cwd)
│  ├─ webview/
│  │  ├─ panel.ts            # webview panel, CSP, serializer restore
│  │  └─ relay.ts            # self-contained iframe⇄host message relay
│  └─ linkage/
│     ├─ nodeWatcher.ts      # recursive fs.watch directory watching (cross-workspace)
│     ├─ watcher.ts          # debounce, dirty-safe policy, tab closing
│     ├─ policy.ts           # pure decision logic (glob→regex, open decision)
│     ├─ pathSafety.ts       # path resolution against traversal/symlink escapes
│     └─ opener.ts           # showTextDocument with line/column
├─ bridge/                   # DSH-side bridge plugin (plain ESM JS, no build step)
│  └─ lib/
│     ├─ index.js            # cordis host plugin: /dsh-vscode routes + tapIndex + systemPrompt notice
│     └─ bridge.js           # in-page script: click capture, session tracking (dshEmbed-gated)
├─ tests/                    # node:test + jsdom suite (74 tests, zero native deps)
├─ tools/
│  └─ session-log-check.mjs  # session-log check/repair tool (corrupt session log: seq gap recovery)
├─ .github/workflows/ci.yml  # CI: build + test on push/PR
├─ package.json              # extension manifest & scripts
└─ tsconfig*.json            # host (CJS) and webview (plain script) configs
```

Generated artifacts (`dist/`, `node_modules/`, `*.vsix`, `.npm-cache/`) are gitignored — commit the rest.

### Known Limitations

- Desktop VSCode only; Remote / containers / vscode.dev are **not supported**.
- Downloads (session ZIP) and clipboard inside the webview may be restricted by the Electron environment.
- When two VSCode windows share a workspace, the second reattaches to the existing instance (no duplicate spawn). If both windows open a panel for the first time at the **exact same moment**, each may start its own instance — open one panel first to avoid it.
- The bridge's click capture targets the delivered-files row (`[data-produced-files-row]`) and path-shaped titles — future DSH UI redesigns may need a small update here (the path-shaped filter keeps it fail-safe).
> [!WARNING]
> Running the same conversation on two different instances at the same time may corrupt the session log.

### Contributing

This project was generated by the Deepseek Harness with Deepseek-V4-Flash and Deepseek-V4-Pro. The publisher vibe-coded all the way through, to experience the vibe-coding experience of the new models paired with the Harness.

### License

[MIT](https://opensource.org/license/mit)
