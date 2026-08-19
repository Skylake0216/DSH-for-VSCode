/**
 * DSH for VSCode — 扩展入口。
 *
 * 组装：
 *  - HostManager：spawn/connect 一个与浏览器 WebUI 共享的 DSH 实例
 *    （同一 ~/.dsh：会话/设置/凭据天然共享；sharePort 时浏览器可连到插件托管的实例）。
 *  - DshPanel：编辑器区 webview + iframe 嵌入完整 DSH Web GUI（全部插件兼容）。
 *  - LinkageWatcher：agent 写入文件自动在 VSCode 打开（dirty 红线保护）。
 *  - 会话 cwd 跟踪：bridge.js 上报 sessionCurrent + session.list 轮询兜底。
 */
import * as vscode from 'vscode'
import { HostManager, type HostState } from './host/hostManager'
import { DshPanel } from './webview/panel'
import { LinkageWatcher, defaultOpenFile } from './linkage/watcher'
import { openFromMessage } from './linkage/opener'
import { pickLikelyActive, updateThemePreference, type SessionSummary } from './host/dshApi'
import type { WebviewToHost } from './messages'
import { cpSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 模块级引用：deactivate 时同步结束托管 host（不依赖 subscriptions 释放时序）。 */
let hostManager!: HostManager

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // 常开输出通道：host 生命周期/连接探测始终可查（View → Output → DSH for VSCode），
  // 不依赖 debugLog（debugLog 仅额外写扩展控制台）。
  const output = vscode.window.createOutputChannel('DSH for VSCode')
  context.subscriptions.push(output)
  const log = (message: string): void => {
    output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`)
    if (vscode.workspace.getConfiguration('dshVscode').get('debugLog', false)) {
      console.log(`[dsh-vscode] ${message}`)
    }
  }
  log(`activate（hostMode=${vscode.workspace.getConfiguration('dshVscode').get('hostMode', 'auto')}）`)

  hostManager = new HostManager({
    extensionPath: context.extensionPath,
    storageDir: context.globalStorageUri.fsPath,
    getSetting: <T,>(key: string, fallback: T): T => {
      const config = vscode.workspace.getConfiguration('dshVscode')
      return (config.get<T>(key.slice('dshVscode.'.length)) ?? fallback) as T
    },
    getState: <T,>(key: string): T | undefined => context.globalState.get<T>(key),
    setState: (key: string, value: unknown) => context.globalState.update(key, value),
    workspaceFolder: () => vscode.workspace.workspaceFolders?.[0],
    onStateChange: (state: HostState) => {
      panel.pushState()
      updateStatusBar(state)
      if (state.status === 'ready') {
        void onHostReady()
        void syncThemeViaSettings()
      }
    },
    log,
  })

  // —— 文件联动 ——
  const watcher = new LinkageWatcher({
    getOpenMode: () => getSetting<string>('autoOpenFiles', 'preview') as 'preview' | 'editor' | 'off',
    getInclude: () => getSetting<string[]>('autoOpenInclude', ['**/*']),
    getExclude: () => getSetting<string[]>('autoOpenExclude', []),
    closeOnDelete: () => true,
    preserveFocus: () => true,
    openFile: defaultOpenFile,
    notifyDirty: (uri) => {
      // 红线提示：不覆盖、不弹窗，状态栏一句话。
      const rel = workspaceRelative(uri)
      statusBar.text = `$(warning) DSH 修改了 ${rel}（有未保存编辑，未覆盖）`
      setTimeout(() => updateStatusBar(hostManager.state), 5000)
    },
    log,
  })

  // —— 面板 ——
  const panel = new DshPanel(
    context,
    {
      onMessage: (message: WebviewToHost) => {
        if (message.type === 'relayDiag') {
          // relay 内部诊断（排查面板卡「正在启动」）
          log(`relay: ${message.step}${message.url !== undefined ? ` url=${message.url}` : ''}`)
        } else if (message.type === 'ready') {
          // relay 已就绪：补发当前状态（面板重开/序列化恢复时 hello 可能早于 relay 加载而丢失）
          panel.pushState()
          panel.pushTheme()
          if (hostManager.state.status !== 'ready') {
            // 序列化恢复的面板 host 可能从未启动（无命令触发 start()）：补一次。
            // start() 幂等：in-flight 的启动复用同一 promise，不会双 spawn。
            void ensureHost()
          } else {
            // 兜底：个别 VSCode 版本在 webview 刚就绪时可能丢一条 postMessage，1s 后补发
            setTimeout(() => {
              if (hostManager.state.status === 'ready') panel.pushState()
            }, 1000)
          }
        } else if (message.type === 'iframeLoaded') {
          // iframe 已加载：再补一次主题，确保 DSH 页面拿到最新 VSCode 颜色
          panel.pushTheme()
        } else if (message.type === 'openFile') {
          void openFromMessage(message.path, currentRoots(), {
            preview: false,
            line: message.line,
            column: message.column,
          }).then((result) => {
            if (result === 'outside') void vscode.window.showWarningMessage(`路径在工作区之外：${message.path}`)
            else if (result === 'failed') void vscode.window.showWarningMessage(`无法打开文件：${message.path}`)
          })
        } else if (message.type === 'sessionCurrent') {
          activeSessionId = message.sessionId ?? undefined
          void refreshSessionCwd()
        }
      },
      onDispose: () => {
        /* host 保留运行：下次打开 reattach */
      },
    },
    () => hostManager.state
  )
  panel.registerSerializer()

  /** connect 到无 bridge 实例时的主题兜底：用 DSH 官方 settings API 同步明/暗，无需改实例。 */
  async function syncThemeViaSettings(): Promise<void> {
    if (!vscode.workspace.getConfiguration('dshVscode').get<boolean>('themeSync', true)) return
    const runtime = hostManager.current
    if (runtime === undefined || runtime.hasBridge || runtime.mode !== 'connect') return
    const kind = vscode.window.activeColorTheme.kind
    const preference = kind === 2 || kind === 3 ? 'dark' : 'light'
    try {
      await updateThemePreference(runtime.url, preference)
      log(`settings ui-theme.preference → ${preference}（connect 无 bridge 兜底）`)
    } catch (error) {
      log(`settings ui-theme.preference 更新失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 主题切换时，若 connect 实例无 bridge，走 settings API 兜底同步明暗
  context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(() => void syncThemeViaSettings()))

  // —— 状态栏 ——
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBar.command = 'dsh-vscode.open'
  statusBar.show()
  const updateStatusBar = (state: HostState): void => {
    if (state.status === 'ready' && state.runtime !== undefined) {
      statusBar.text = `$(comment-discussion) DSH :${state.runtime.port}${state.runtime.mode === 'connect' ? ' (共享)' : ''}`
      statusBar.tooltip = `DSH ${state.runtime.url}（点击打开面板）`
    } else if (state.status === 'error') {
      statusBar.text = '$(error) DSH 启动失败'
      statusBar.tooltip = state.message ?? '未知错误'
    } else {
      statusBar.text = '$(sync~spin) DSH 启动中…'
      statusBar.tooltip = 'DSH host 启动中'
    }
  }

  // —— 会话 cwd 跟踪 ——
  let activeSessionId: string | undefined
  let sessionCwd: string | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined

  const currentRoots = (): string[] => {
    const roots: string[] = []
    if (sessionCwd !== undefined && sessionCwd !== '') roots.push(sessionCwd)
    for (const folder of vscode.workspace.workspaceFolders ?? []) roots.push(folder.uri.fsPath)
    return [...new Set(roots)]
  }

  const refreshSessionCwd = async (): Promise<void> => {
    if (hostManager.state.status !== 'ready') return
    try {
      const { items } = await hostManager.listSessions()
      const session = activeSessionId !== undefined ? items.find((item) => item.sessionId === activeSessionId) : undefined
      const active: SessionSummary | undefined = session ?? pickLikelyActive(items)
      const cwd = active?.cwd
      if (cwd !== sessionCwd) {
        sessionCwd = cwd
        log(`session cwd → ${cwd ?? '(none)'}（activeSession=${activeSessionId ?? '(unknown)'}）`)
        await watcher.watch(cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)
      }
    } catch {
      /* host 未就绪/不可达：静默，下次轮询重试 */
    }
  }

  const onHostReady = async (): Promise<void> => {
    await refreshSessionCwd()
    if (pollTimer === undefined) {
      pollTimer = setInterval(() => void refreshSessionCwd(), 3000)
    }
  }

  // —— 命令 ——
  const ensureHost = async (): Promise<void> => {
    try {
      await hostManager.start()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void vscode.window.showErrorMessage(`DSH host 启动失败：${message}`)
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('dsh-vscode.open', async () => {
      panel.createOrShow()
      await ensureHost()
    }),
    vscode.commands.registerCommand('dsh-vscode.openInBrowser', async () => {
      await ensureHost()
      const runtime = hostManager.current
      if (runtime === undefined) {
        void vscode.window.showWarningMessage('DSH host 尚未就绪')
        return
      }
      await vscode.env.openExternal(vscode.Uri.parse(runtime.url))
    }),
    vscode.commands.registerCommand('dsh-vscode.restartHost', async () => {
      await hostManager.stop()
      await ensureHost()
    }),
    vscode.commands.registerCommand('dsh-vscode.stopHost', async () => {
      await hostManager.stop()
    }),
    vscode.commands.registerCommand('dsh-vscode.exportBridgeOverlay', async () => {
      await exportBridgeOverlay(context.extensionPath)
    }),
    statusBar,
    watcher,
    hostManager,
    { dispose: () => { if (pollTimer !== undefined) clearInterval(pollTimer) } }
  )
}

/**
 * 导出独立桥接叠加层：把 bridge 插件复制到用户选定目录，生成 --patch 叠加层，
 * 供用户**手动托管共享实例**时使用：
 *   dsh web --patch <导出的 yml>          # 默认 3080，浏览器与扩展（connect/auto 模式）都连它
 * 导出的叠加层自包含（bridge 已复制到同级目录），不依赖扩展安装路径。
 */
async function exportBridgeOverlay(extensionPath: string): Promise<void> {
  const defaultUri = vscode.Uri.file(join(homedir(), '.dsh', 'vscode-bridge-overlay.yml'))
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { YAML: ['yml', 'yaml'] },
    saveLabel: '导出桥接叠加层',
  })
  if (target === undefined) return
  const targetPath = target.fsPath
  const targetDir = dirname(targetPath)
  const bridgeSrc = join(extensionPath, 'bridge')
  const bridgeDest = join(targetDir, 'dsh-vscode-bridge')
  /** YAML 单引号转义（防路径含单引号时截断）。 */
  const yamlScalar = (value: string): string => `'${value.replace(/'/g, "''")}'`
  try {
    mkdirSync(targetDir, { recursive: true })
    cpSync(bridgeSrc, bridgeDest, { recursive: true, force: true })
    const overlay = [
      '# 由 DSH for VSCode 导出 —— 手动托管共享实例：',
      `#   dsh web --patch ${yamlScalar(targetPath)}`,
      '# bridge 插件已随本文件复制到同级目录 dsh-vscode-bridge/（更新扩展后请重新导出）。',
      '- insert:',
      '    - id: dsh-vscode-bridge',
      `      name: ${yamlScalar(join(bridgeDest, 'lib', 'index.js').replace(/\\/g, '/'))}`,
      '',
    ].join('\n')
    writeFileSync(targetPath, overlay, 'utf8')
    void vscode.window.showInformationMessage(
      `已导出桥接叠加层。手动启动共享实例：dsh web --patch "${targetPath}"（默认端口 3080；扩展 hostMode 用 connect/auto 即接回同一实例）`
    )
  } catch (error) {
    void vscode.window.showErrorMessage(`导出失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function getSetting<T>(key: string, fallback: T): T {
  return (vscode.workspace.getConfiguration('dshVscode').get<T>(key) ?? fallback) as T
}

function workspaceRelative(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false)
}

export function deactivate(): void {
  // 同步结束托管 host（spawn / auto 托管场景；stopHostOnExit 关闭时保留运行）。
  // VSCode 退出时宿主进程会立即终止，async 清理（await setState 后才 kill）可能
  // 来不及执行而留下孤儿进程——stopOnExit 里 kill 是同步先发的。
  hostManager?.stopOnExit()
}
