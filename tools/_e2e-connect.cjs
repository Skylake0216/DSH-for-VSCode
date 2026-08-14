#!/usr/bin/env node
/**
 * connect 模式端到端复现（诊断用，非测试套件）：
 *  - mock 'vscode' 模块（Module._load 拦截）
 *  - 真实 dist/extension.js activate() + 注册命令
 *  - 真实 dist/webview/relay.js 跑在 jsdom 里接收宿主消息
 *  - 驱动 dsh-vscode.open，观察：状态迁移、宿主→webview 消息序列、iframe 是否挂载
 * 用法：node tools/_e2e-connect.cjs [connectUrl]
 */
const Module = require('node:module')
const { JSDOM } = require('jsdom')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const CONNECT_URL = process.argv[2] ?? 'http://127.0.0.1:3080'
const SETTINGS = {
  hostMode: 'connect',
  connectUrl: CONNECT_URL,
  debugLog: true,
  autoOpenFiles: 'preview',
  autoOpenInclude: ['**/*'],
  autoOpenExclude: [],
  openColumn: 'beside',
  sharePort: true,
  stopHostOnExit: true,
  stopConnectedInstanceOnExit: false,
  allowDualInstance: false,
  autoModeSpawn: false,
  executablePath: '',
  profileName: 'web',
  readyTimeoutSec: 60,
  hostCwd: '',
}

// —— jsdom + 真实 relay ——
const dom = new JSDOM(
  `<!doctype html><html><head></head><body>
    <iframe id="dsh-frame"></iframe>
    <div id="status"><div id="status-text">boot</div><div id="status-err" style="display:none"></div></div>
  </body></html>`,
  { url: 'http://127.0.0.1:1234/', runScripts: 'outside-only', pretendToBeVisual: true }
)
const window = dom.window
const frame = window.document.getElementById('dsh-frame')
const srcSets = []
Object.defineProperty(frame, 'src', {
  get() { return this.getAttribute('src') },
  set(v) { srcSets.push(v); this.setAttribute('src', v) },
})

const webviewMessages = [] // 宿主 → webview 的消息（按到达顺序）
let hostMessageHandler = null // webview → 宿主

window.acquireVsCodeApi = () => ({
  postMessage: (m) => {
    if (hostMessageHandler !== null) hostMessageHandler(m)
  },
})
const relaySource = readFileSync(join(__dirname, '..', 'dist', 'webview', 'relay.js'), 'utf8')
window.eval(relaySource)

// —— mock vscode ——
const commands = {}
const vscodeMock = {
  workspace: {
    getConfiguration: () => ({ get: (k, fb) => (k in SETTINGS ? SETTINGS[k] : fb) }),
    workspaceFolders: undefined,
    textDocuments: [],
    asRelativePath: (uri) => uri.fsPath,
  },
  window: {
    createOutputChannel: () => ({ appendLine: (m) => console.log('[OUT]', m), dispose() {} }),
    createWebviewPanel: () => {
      const panel = {
        webview: {
          postMessage: (m) => {
            webviewMessages.push(JSON.parse(JSON.stringify(m)))
            const event = new window.MessageEvent('message', { data: JSON.parse(JSON.stringify(m)), origin: 'null' })
            Object.defineProperty(event, 'source', { value: window, configurable: true })
            window.dispatchEvent(event)
            return Promise.resolve()
          },
          onDidReceiveMessage: (h) => { hostMessageHandler = h },
          asWebviewUri: (u) => u,
          cspSource: 'vscode-webview://test',
        },
        reveal: () => {},
        onDidDispose: () => {},
      }
      return panel
    },
    createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {} }),
    showErrorMessage: (m) => console.log('[TOAST-ERROR]', m),
    showWarningMessage: (m) => console.log('[TOAST-WARN]', m),
    showInformationMessage: (m) => console.log('[TOAST-INFO]', m),
    showSaveDialog: async () => undefined,
    registerWebviewPanelSerializer: () => {},
    activeTextEditor: undefined,
    tabGroups: { all: [], close: async () => {} },
    showTextDocument: async () => {},
  },
  ViewColumn: { Active: 1, Beside: 2, One: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  commands: { registerCommand: (name, fn) => { commands[name] = fn; return { dispose() {} } } },
  Uri: { file: (p) => ({ fsPath: p }) },
  env: { openExternal: async () => true },
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock
  return originalLoad.apply(this, arguments)
}

// —— 驱动扩展 ——
const { activate } = require('../dist/extension.js')
const globalState = { get: () => undefined, update: async () => {} }
const context = {
  extensionPath: join(__dirname, '..'),
  globalStorageUri: { fsPath: join(process.env.TEMP ?? '.', 'dsh-mock-storage') },
  globalState,
  subscriptions: [],
}

async function main() {
  console.log('=== activate ===')
  await activate(context)
  console.log('registered commands:', Object.keys(commands).join(', '))
  console.log('=== run dsh-vscode.open (connectUrl=' + CONNECT_URL + ') ===')
  await commands['dsh-vscode.open']()
  await new Promise((r) => setTimeout(r, 3000))
  console.log('=== host→webview 消息序列 ===')
  for (const m of webviewMessages) console.log('  ', JSON.stringify(m))
  console.log('=== relay iframe ===')
  console.log('  srcSets:', JSON.stringify(srcSets))
  console.log('  frame.src:', frame.getAttribute('src'))
  const statusEl = window.document.getElementById('status')
  console.log('  status display:', statusEl.style.display)
  console.log('=== relay 发给宿主的消息 ===')
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) }).finally(() => process.exit(0))
