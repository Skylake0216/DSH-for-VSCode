/**
 * webview relay 脚本（tsc 编译为无模块包装的普通脚本，经 asWebviewUri 注入面板）。
 * 注意：本文件必须自包含（无 import/export），否则 tsc 会加模块包装导致浏览器失败。
 *
 * 职责：iframe(bridge.js) ⇄ 扩展宿主 的双向消息转发。
 * - iframe → 宿主：校验 event.source === iframe.contentWindow 与消息守卫后
 *   acquireVsCodeApi().postMessage 转发（openFile / sessionCurrent）。
 * - 宿主 → iframe：hello（挂 iframe src）、hostStatus（加载态/错误）、theme（VSCode 主题映射）。
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
): value is
  | { type: 'hello'; url: string }
  | { type: 'hostStatus'; status: string; message?: string }
  | { type: 'theme'; kind: number; enabled: boolean } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.type === 'hello') return typeof record.url === 'string'
  if (record.type === 'hostStatus') return typeof record.status === 'string'
  if (record.type === 'theme') return typeof record.kind === 'number' && typeof record.enabled === 'boolean'
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

// —— VSCode 主题 → DSH 设计令牌（--dsw-*）映射 ——
// 值来自 webview 文档的 --vscode-* CSS 变量；bridge.js 收到后写入 DSH iframe 的 body。
// 三元组的第三项为可选模式：
//  - 'guardText'：文字色守卫。placeholder/description/tabInactive 在 VSCode 语义里是
//    “淡色提示”，直接当 DSH 的次要/三级文字用，在浅色主题里会低于可读对比度
//    （2026 浅色 placeholder #999999 对白底仅 2.85:1）。守卫把候选色与编辑器背景
//    对比，不足 3:1 时回退为编辑器前景色（见 guardTextColor）。
const VSCODE_TO_DSH: ReadonlyArray<readonly [vscodeVar: string, dshVar: string, mode?: 'direct' | 'guardText']> = [
  // 背景
  ['--vscode-editor-background', '--dsw-alias-bg-base'],
  ['--vscode-editorWidget-background', '--dsw-alias-bg-layer-1'],
  ['--vscode-input-background', '--dsw-alias-bg-layer-2'],
  ['--vscode-menu-background', '--dsw-alias-bg-layer-3'],
  ['--vscode-notifications-background', '--dsw-alias-bg-overlay'],
  ['--vscode-sideBar-background', '--dsw-specific-sidebar-fill'],
  ['--vscode-menu-background', '--dsw-specific-menu'],
  ['--vscode-input-background', '--dsw-specific-input-major'],
  ['--vscode-editorWidget-background', '--dsw-specific-tip'],
  ['--vscode-editorWidget-background', '--dsw-specific-bubble'],
  // 前景 / 文字
  // 主要/次要文字都优先用编辑器前景色：保证在聊天输入框等表面上有足够对比度。
  // 注意：绝不把 badge-foreground 映射到任何 label token——它是专为深蓝徽章设计的
  // 文字色（2026 浅色/深色为 #FFFFFF，Tomorrow Night Blue 为 #001733），直接用作
  // 通用文字色会在浅色主题“白字融白底”、在深蓝主题“深字融深底”。历史实现曾把
  // badge-foreground 覆盖到 label-secondary，正是聊天框权限/模型选项文字不可见的根因。
  ['--vscode-editor-foreground', '--dsw-alias-label-primary'],
  ['--vscode-editor-foreground', '--dsw-alias-label-secondary'],
  // placeholder/description/tabInactive 语义偏“淡”，全部走 guardText 保证可读性。
  ['--vscode-input-placeholderForeground', '--dsw-alias-label-tertiary', 'guardText'],
  ['--vscode-descriptionForeground', '--dsw-alias-label-caption', 'guardText'],
  ['--vscode-tab-inactiveForeground', '--dsw-alias-label-dimmed', 'guardText'],
  ['--vscode-button-foreground', '--dsw-alias-label-primary-foreground'],
  ['--vscode-button-foreground', '--dsw-alias-label-primary-inverted'],
  // 边框
  ['--vscode-sideBar-border', '--dsw-alias-border-l1'],
  ['--vscode-editorWidget-border', '--dsw-alias-border-l2'],
  ['--vscode-menu-border', '--dsw-alias-border-l2'],
  ['--vscode-input-border', '--dsw-alias-border-l2'],
  ['--vscode-panel-border', '--dsw-alias-border-l2'],
  ['--vscode-focusBorder', '--dsw-alias-border-l3'],
  ['--vscode-contrastActiveBorder', '--dsw-alias-border-l4'],
  // 交互 / 按钮 / 列表
  ['--vscode-button-background', '--dsw-alias-button-primary-fill'],
  ['--vscode-button-hoverBackground', '--dsw-alias-button-primary-hover'],
  ['--vscode-button-secondaryBackground', '--dsw-alias-button-info-fill'],
  ['--vscode-list-hoverBackground', '--dsw-alias-interactive-bg-hover'],
  ['--vscode-list-activeSelectionBackground', '--dsw-alias-interactive-bg-active'],
  ['--vscode-list-activeSelectionBackground', '--dsw-alias-interactive-bg-hover-accent'],
  ['--vscode-list-activeSelectionBackground', '--dsw-alias-button-ghost-active-fill'],
  ['--vscode-list-hoverBackground', '--dsw-alias-interactive-bg-hover-solid'],
  ['--vscode-sideBar-background', '--dsw-specific-sidebar-nav-item-active'],
  ['--vscode-list-hoverBackground', '--dsw-specific-sidebar-nav-item-hover'],
  ['--vscode-sideBar-background', '--dsw-specific-sidebar-nav-item-active-accent'],
  // 状态 / 品牌
  ['--vscode-errorForeground', '--dsw-alias-state-error-primary'],
  ['--vscode-charts-green', '--dsw-alias-state-success-primary'],
  ['--vscode-charts-yellow', '--dsw-alias-state-warn-primary'],
  ['--vscode-textLink-foreground', '--dsw-alias-state-business-primary'],
  ['--vscode-textLink-foreground', '--dsw-alias-brand-primary'],
  // 代码块 / 引用
  ['--vscode-textCodeBlock-background', '--dsw-alias-markdown-code-block'],
  ['--vscode-textCodeBlock-background', '--dsw-alias-markdown-code-block-banner'],
  ['--vscode-textCodeBlock-background', '--dsw-alias-markdown-inline-code'],
  ['--vscode-input-placeholderForeground', '--dsw-alias-markdown-placeholder'],
  // 滚动条
  ['--vscode-scrollbarSlider-background', '--dsw-alias-scrollbar-bg-l1'],
  ['--vscode-scrollbarSlider-background', '--dsw-alias-scrollbar-bg-l2'],
  ['--vscode-scrollbarSlider-hoverBackground', '--dsw-alias-scrollbar-hover-l1'],
  ['--vscode-scrollbarSlider-hoverBackground', '--dsw-alias-scrollbar-hover-l2'],
]

/** 最近一次宿主下发的主题 kind（Light=1 / Dark=2 / HighContrast=3 / HighContrastLight=4）。 */
let lastThemeKind: number | undefined
/** themeSync 设置开关：false 时通知 iframe 清除覆盖，恢复 DSH 自身主题。 */
let themeEnabled = true
/** 上次发给 iframe 的主题指纹；轮询发现变化时补发（兜底宿主消息丢失/事件未触发）。 */
let lastThemeFingerprint = ''

/** 一次读取当前页面所有用到的 --vscode-* 变量（root 优先、body 兜底），只做两次计算样式查询。 */
function readVscodeVars(): Map<string, string> {
  const rootStyle = getComputedStyle(document.documentElement)
  const bodyStyle = getComputedStyle(document.body)
  const vars = new Map<string, string>()
  for (const [vscodeVar] of VSCODE_TO_DSH) {
    const value = (rootStyle.getPropertyValue(vscodeVar) || bodyStyle.getPropertyValue(vscodeVar)).trim()
    if (value !== '') vars.set(vscodeVar, value)
  }
  return vars
}

/** 解析一个 CSS 颜色为不透明 RGB；半透明或无法解析返回 null（由调用方走回退）。 */
function parseRgb(color: string): { r: number; g: number; b: number } | null {
  const c = color.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c)
  if (hex) {
    const v = hex[1]
    const rgbOf = (h: string): { r: number; g: number; b: number } => ({
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    })
    if (v.length === 3) {
      return rgbOf(v[0] + v[0] + v[1] + v[1] + v[2] + v[2])
    }
    if (v.length === 6) return rgbOf(v)
    // 4/8 位带透明通道：只有完全不透明（alpha=ff）才能可靠判对比度，否则视为无法解析
    const alpha = v.length === 4 ? parseInt(v[3] + v[3], 16) : parseInt(v.slice(6, 8), 16)
    return alpha === 255 ? rgbOf(v.length === 4 ? v[0] + v[0] + v[1] + v[1] + v[2] + v[2] : v.slice(0, 6)) : null
  }
  const toNum = (s: string): number => (s.endsWith('%') ? (parseFloat(s) / 100) * 255 : parseFloat(s))
  const toAlpha = (s: string | undefined): number | undefined =>
    s === undefined ? undefined : s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s)
  // 逗号分隔 rgb()/rgba()（兼容百分比分量）
  const comma = /^rgba?\(\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*(?:,\s*([\d.]+%?)\s*)?\)$/i.exec(c)
  if (comma) {
    const alpha = toAlpha(comma[4])
    if (alpha !== undefined && alpha < 1) return null
    return { r: toNum(comma[1]), g: toNum(comma[2]), b: toNum(comma[3]) }
  }
  // 空格分隔 rgb(r g b / a) 现代语法
  const space = /^rgba?\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+%?)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/i.exec(c)
  if (space) {
    const alpha = toAlpha(space[4])
    if (alpha !== undefined && alpha < 1) return null
    return { r: toNum(space[1]), g: toNum(space[2]), b: toNum(space[3]) }
  }
  return null
}

/** WCAG 相对亮度（0-1）。 */
function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const linear = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b)
}

/** 两个颜色的 WCAG 对比度（1-21）；任一无法解析返回 0（视为不通过）。 */
function contrastRatio(a: string, b: string): number {
  const ca = parseRgb(a)
  const cb = parseRgb(b)
  if (ca === null || cb === null) return 0
  const la = relativeLuminance(ca)
  const lb = relativeLuminance(cb)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

/** 淡色文字可读性下限（WCAG 大字号/UI 组件阈值）；低于此值视为“融入背景”。 */
const MIN_TEXT_CONTRAST = 3

/**
 * guardText 模式：候选色与编辑器背景对比度不足时回退到编辑器前景色。
 * 以编辑器背景为参照：浅色主题它最浅、深色主题它最深，是文字最容易
 * “看不清”的极端表面；编辑器前景色则是 VSCode 保证与背景有足够对比的
 * 主文字色。编辑器背景/前景缺失或候选色无法解析时，一律回退到前景色
 * （前景色也缺失时才保留候选色），保证可读性优先。
 */
function guardTextColor(candidate: string, vars: Map<string, string>): string {
  const bg = vars.get('--vscode-editor-background')
  if (bg !== undefined && contrastRatio(candidate, bg) >= MIN_TEXT_CONTRAST) return candidate
  const fg = vars.get('--vscode-editor-foreground')
  return fg !== undefined ? fg : candidate
}

/** 从 webview 计算样式读取所需 --vscode-* 颜色，映射为 DSH token 覆盖表。 */
function readVscodeThemeTokens(): Record<string, string> {
  const vars = readVscodeVars()
  const tokens: Record<string, string> = {}
  for (const [vscodeVar, dshVar, mode] of VSCODE_TO_DSH) {
    const value = vars.get(vscodeVar)
    if (value === undefined) continue
    tokens[dshVar] = mode === 'guardText' ? guardTextColor(value, vars) : value
  }
  return tokens
}

/** 计算当前主题指纹（用于轮询去重）。 */
function currentThemeFingerprint(): string {
  if (!themeEnabled) return 'reset'
  const kind = lastThemeKind
  const dark = kind === 2 || kind === 3 || (kind === undefined && document.body.classList.contains('vscode-dark'))
  return JSON.stringify({ scheme: dark ? 'dark' : 'light', tokens: readVscodeThemeTokens() })
}

/** 把当前 VSCode 主题推送给 DSH iframe（仅已挂载时）。 */
function sendThemeToFrame(): void {
  if (frame === null || attachedUrl === undefined || frame.contentWindow === null) return
  if (!themeEnabled) {
    lastThemeFingerprint = 'reset'
    frame.contentWindow.postMessage({ source: 'dsh-vscode', type: 'theme', reset: true }, '*')
    return
  }
  const kind = lastThemeKind
  const dark = kind === 2 || kind === 3 || (kind === undefined && document.body.classList.contains('vscode-dark'))
  const tokens = readVscodeThemeTokens()
  lastThemeFingerprint = JSON.stringify({ scheme: dark ? 'dark' : 'light', tokens })
  frame.contentWindow.postMessage(
    {
      source: 'dsh-vscode',
      type: 'theme',
      scheme: dark ? 'dark' : 'light',
      tokens,
    },
    '*'
  )
}

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
      sendThemeToFrame()
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
    } else if (data.type === 'theme') {
      lastThemeKind = data.kind
      themeEnabled = data.enabled
      diag('theme', `${data.kind} enabled=${data.enabled}`)
      sendThemeToFrame()
    }
  }
})

// 握手：宿主收到后如有已就绪的 host 会立即回 hello。
vscode.postMessage({ type: 'ready' })
diag('loaded')

// 轮询兜底：即使 onDidChangeActiveColorTheme 消息丢失，也能在 VSCode 主题颜色变化后补发。
setInterval(() => {
  if (frame === null || attachedUrl === undefined) return
  const fingerprint = currentThemeFingerprint()
  if (fingerprint !== lastThemeFingerprint) sendThemeToFrame()
}, 1000)
