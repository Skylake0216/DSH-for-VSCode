/**
 * webview 面板：编辑器区 createWebviewPanel + iframe 嵌入 DSH 前端。
 * - CSP 使用回环端口通配（CSP3 host-source 的 `:*` 合法，动态端口刚需）。
 * - iframe 不加 sandbox（保持同源 —— DSH 前端要求 origin 非 null）。
 * - relay.js（esbuild 产物）经 asWebviewUri 加载。
 * - 面板先于 host 就绪创建（加载态），就绪后经 hello 消息挂上 iframe src。
 * - registerWebviewPanelSerializer：VSCode 重载后恢复面板。
 */
import * as vscode from 'vscode'
import { join } from 'node:path'
import type { HostState } from '../host/hostManager'
import type { HostToWebview, WebviewToHost } from '../messages'

export const PANEL_VIEW_TYPE = 'dshVscode.chat'

export interface PanelCallbacks {
  /** webview 上行的 openFile / sessionCurrent 等消息。 */
  onMessage(message: WebviewToHost): void
  /** 面板被关闭。 */
  onDispose(): void
}

export class DshPanel {
  private panel: vscode.WebviewPanel | undefined

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly callbacks: PanelCallbacks,
    private readonly getHostState: () => HostState
  ) {}

  /** 创建或聚焦面板。 */
  createOrShow(): vscode.WebviewPanel {
    if (this.panel !== undefined) {
      this.panel.reveal(vscode.ViewColumn.Beside, true)
      return this.panel
    }
    const openColumnSetting = vscode.workspace.getConfiguration('dshVscode').get<string>('openColumn', 'beside')
    const column =
      openColumnSetting === 'active' && vscode.window.activeTextEditor !== undefined
        ? vscode.ViewColumn.Active
        : vscode.window.activeTextEditor === undefined
          ? vscode.ViewColumn.One
          : vscode.ViewColumn.Beside
    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      'DSH',
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(join(this.context.extensionPath, 'dist'))],
      }
    )
    this.panel = panel
    panel.webview.onDidReceiveMessage((message: unknown) => {
      this.callbacks.onMessage(message as WebviewToHost)
    })
    panel.onDidDispose(() => {
      this.panel = undefined
      this.callbacks.onDispose()
    })
    panel.webview.html = this.buildHtml(panel.webview)
    this.pushState()
    return panel
  }

  /** 把当前 host 状态推给 webview（启动中/就绪/错误）。 */
  pushState(): void {
    if (this.panel === undefined) return
    const state = this.getHostState()
    let message: HostToWebview
    if (state.status === 'ready' && state.runtime !== undefined) {
      message = { type: 'hello', url: state.runtime.url }
    } else if (state.status === 'error') {
      message = { type: 'hostStatus', status: 'error', message: state.message }
    } else {
      message = { type: 'hostStatus', status: 'connecting' }
    }
    void this.panel.webview.postMessage(message)
  }

  private buildHtml(webview: vscode.Webview): string {
    const relayUri = webview.asWebviewUri(
      vscode.Uri.file(join(this.context.extensionPath, 'dist', 'webview', 'relay.js'))
    )
    // CSP 端口通配（CSP3 host-source 合法）：面板创建早于 host 就绪，端口未知，
    // 写死端口会在就绪后拦死 iframe。iframe 内部文档无 CSP（DSH 服务器不设）。
    const csp = [
      "default-src 'none'",
      'frame-src http://127.0.0.1:* http://localhost:*',
      `script-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data: blob:`,
      'connect-src http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*',
    ].join('; ')
    // 内联状态文本全部来自扩展常量/配置（无用户输入直插）。
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH</title>
<style>
  html, body { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; background: #1e1e1e; }
  #dsh-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: none; }
  #status { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 12px; align-items: center; justify-content: center;
            color: #cccccc; font: 13px/1.6 var(--vscode-font-family, sans-serif); padding: 24px; text-align: center; }
  #status .err { color: #f48771; white-space: pre-wrap; max-width: 640px; }
  #status .spin { width: 22px; height: 22px; border: 2px solid #3c3c3c; border-top-color: #cccccc; border-radius: 50%;
                  animation: dsh-spin 1s linear infinite; }
  @keyframes dsh-spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<iframe id="dsh-frame" allow="clipboard-read; clipboard-write; downloads; fullscreen"></iframe>
<div id="status"><div class="spin"></div><div id="status-text">正在启动 DSH host…</div><div class="err" id="status-err" style="display:none"></div></div>
<script src="${relayUri}"></script>
</body>
</html>`
  }

  /** 序列化恢复（VSCode 重载）。 */
  registerSerializer(): void {
    vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel: vscode.WebviewPanel) => {
        this.panel = panel
        panel.webview.onDidReceiveMessage((message: unknown) => {
          this.callbacks.onMessage(message as WebviewToHost)
        })
        panel.onDidDispose(() => {
          this.panel = undefined
          this.callbacks.onDispose()
        })
        panel.webview.html = this.buildHtml(panel.webview)
        this.pushState()
      },
    })
  }

  dispose(): void {
    this.panel?.dispose()
    this.panel = undefined
  }
}
