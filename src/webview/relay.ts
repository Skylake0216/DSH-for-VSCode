/**
 * webview relay 脚本（tsc 编译为无模块包装的普通脚本，经 asWebviewUri 注入面板）。
 * 注意：本文件必须自包含（无 import/export），否则 tsc 会加模块包装导致浏览器失败。
 *
 * 职责：iframe(bridge.js) ⇄ 扩展宿主 的双向消息转发。
 * - iframe → 宿主：校验 event.source === iframe.contentWindow 与消息守卫后
 *   acquireVsCodeApi().postMessage 转发（openFile / sessionCurrent）。
 * - 宿主 → iframe：hello（挂 iframe src）、hostStatus（加载态/错误）。
 * - 首条 ready 握手：通知宿主 relay 已就绪。
 */
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
}

// —— 本地消息类型守卫（与 src/messages.ts 保持一致的线上形状）——

interface OpenFileMessage {
  source: 'dsh-vscode'
  type: 'openFile'
  path: string
  line?: number
  column?: number
}

interface SessionCurrentMessage {
  source: 'dsh-vscode'
  type: 'sessionCurrent'
  sessionId: string | null
}

function isIframeMessage(value: unknown): value is OpenFileMessage | SessionCurrentMessage {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.source !== 'dsh-vscode') return false
  if (record.type === 'openFile') {
    return (
      typeof record.path === 'string' &&
      (record.line === undefined || typeof record.line === 'number') &&
      (record.column === undefined || typeof record.column === 'number')
    )
  }
  if (record.type === 'sessionCurrent') return record.sessionId === null || typeof record.sessionId === 'string'
  return false
}

function isHostMessage(
  value: unknown
): value is { type: 'hello'; url: string } | { type: 'hostStatus'; status: string; message?: string } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.type === 'hello') return typeof record.url === 'string'
  if (record.type === 'hostStatus') return typeof record.status === 'string'
  return false
}

const vscode = acquireVsCodeApi()

/** 诊断回传（输出通道可见；排查面板卡「正在启动」用）。 */
function diag(step: string, url?: string): void {
  vscode.postMessage({ type: 'relayDiag', step, url })
}

const frame = document.getElementById('dsh-frame') as HTMLIFrameElement | null
const statusEl = document.getElementById('status') as HTMLDivElement | null
const statusText = document.getElementById('status-text') as HTMLDivElement | null
const statusErr = document.getElementById('status-err') as HTMLDivElement | null

/** 允许挂载的 DSH 地址白名单：仅本机回环 http。 */
const HOST_URL_PATTERN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/?$/

/** 允许的 iframe 消息来源（同源回环页面）。 */
function isLoopbackOrigin(origin: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(origin)
}

function setStatus(text: string, error?: string): void {
  if (statusEl === null) return
  statusEl.style.display = 'flex'
  if (statusText !== null) statusText.textContent = text
  if (statusErr !== null) {
    if (error !== undefined) {
      statusErr.textContent = error
      statusErr.style.display = 'block'
    } else {
      statusErr.style.display = 'none'
    }
  }
}

/** 隐藏状态层、显示 iframe（挂载成功或 hello 重复到达时确保不残留覆盖层）。 */
function showFrame(): void {
  if (statusEl !== null) statusEl.style.display = 'none'
  if (frame !== null) frame.style.display = 'block'
}

/** 挂载 iframe：URL 带 dshEmbed=1 使 bridge.js 生效。幂等：同一 url 不重复设置（防整页重载丢草稿）。 */
let attachedUrl: string | undefined
function attachFrame(url: string): void {
  if (frame === null || !HOST_URL_PATTERN.test(url)) {
    diag('hello-rejected', url)
    return
  }
  if (attachedUrl === url) {
    // 同一 url 已挂载：可能因滞留的 connecting 状态层盖住了 iframe，确保清除
    showFrame()
    diag('hello-same-url', url)
    return
  }
  attachedUrl = url
  // 超时兜底：host 已就绪但页面 8s 内未触发 load（如 webview 网络/CSP 问题）时，
  // 换成明确提示而不是永远显示「正在启动 DSH host…」
  const loadTimer = setTimeout(() => {
    diag('attach-timeout', url)
    setStatus('DSH 页面加载超时（host 已就绪；详情见输出通道 "DSH for VSCode"）')
  }, 8000)
  frame.addEventListener(
    'load',
    () => {
      clearTimeout(loadTimer)
      showFrame()
      diag('iframe-loaded', url)
      vscode.postMessage({ type: 'iframeLoaded' })
    },
    { once: true }
  )
  const separator = url.includes('?') ? '&' : '?'
  frame.src = `${url}${separator}dshEmbed=1`
  diag('attach', frame.src)
}

window.addEventListener('message', (event: MessageEvent) => {
  const data: unknown = event.data
  // iframe 上行：source 必须是当前 iframe 窗口，且来源为回环同源页面。
  if (frame !== null && event.source === frame.contentWindow && isLoopbackOrigin(event.origin) && isIframeMessage(data)) {
    if (data.type === 'openFile') {
      vscode.postMessage({ type: 'openFile', path: data.path, line: data.line, column: data.column })
    } else {
      vscode.postMessage({ type: 'sessionCurrent', sessionId: data.sessionId })
    }
    return
  }
  // 宿主下行：VSCode webview 中宿主消息的 event.source 是外层桥接窗口（不是本页 window，
  // 各版本/平台可能为不同对象甚至 null），不能用 source === window 判定——按消息形状识别，
  // 并排除来自嵌入 iframe（event.source === frame.contentWindow）的伪造。
  if ((frame === null || event.source !== frame.contentWindow) && isHostMessage(data)) {
    if (data.type === 'hello') {
      diag('hello', data.url)
      attachFrame(data.url)
    } else if (data.type === 'hostStatus') {
      diag('hoststatus', data.status)
      if (data.status === 'error') {
        setStatus('DSH host 启动失败', data.message)
      } else if (data.status === 'connecting' && attachedUrl === undefined) {
        // iframe 已挂载后不再盖状态层（重启/stop 时让 iframe 展示实例自身状态，
        // 否则覆盖层会滞留——同 URL 的 hello 因幂等不会重新触发 load 来清除它）
        setStatus('正在启动 DSH host…')
      }
    }
  }
})

// 握手：宿主收到后如有已就绪的 host 会立即回 hello。
vscode.postMessage({ type: 'ready' })
diag('loaded')
