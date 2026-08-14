/**
 * dsh-vscode-bridge 页面脚本（注入到 DSH 前端 index.html 中运行）。
 *
 * 门控：仅当页面 URL 带 `?dshEmbed=1`（扩展 iframe 加载的形态）才生效，
 * 普通浏览器打开同一实例时整体 no-op，不干扰任何 DSH 原生行为。
 *
 * 能力：
 *  1. 交付文件 chips（[data-produced-files-row] 内的 button[title=路径]）：
 *     在捕获阶段拦截点击并改为 postMessage 打开 VSCode，覆盖 DSH 的
 *     "系统打开"默认行为——嵌入场景下这正是用户期望的。
 *  2. 通用路径文本/链接：非交互元素文本形如文件路径、或 <a href> 指向
 *     文件路径、或带 [data-path] 的元素——点击打开 VSCode。
 *  3. 不做任何 DOM 修改/样式注入，失败静默。
 */
(() => {
  'use strict'
  if (typeof window === 'undefined' || !window.parent) return
  const params = new URLSearchParams(window.location.search)
  if (params.get('dshEmbed') !== '1') return

  /** 向宿主（VSCode webview relay）发送 openFile 消息。 */
  const openInVscode = (path, extra) => {
    if (typeof path !== 'string' || path === '' || path === '.') return
    const message = { source: 'dsh-vscode', type: 'openFile', path, ...(extra ?? {}) }
    try {
      window.parent.postMessage(message, '*')
    } catch {
      /* 静默 */
    }
  }

  /** 形如文件路径的文本（相对/绝对，含分隔符与扩展名；宽泛但防误报）。 */
  const PATH_TEXT = /^\.{0,2}[/\\][^\s<>"|?*]+$/ // ./x、../x、/abs、C:\x 均含分隔符
  const REL_PATH = /^(?:[^/\\\s]+[/\\])+[^/\\\s]+$/ // a/b/c 至少一级目录
  const looksLikePathText = (text) => {
    const t = (text ?? '').trim()
    if (t.length === 0 || t.length > 240) return false
    return PATH_TEXT.test(t) || REL_PATH.test(t)
  }

  /** 是否交互控件（有自身行为，不应劫持）。 */
  const isInteractive = (el) =>
    el.matches?.('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]') ?? false

  /** 从点击目标向上找"文件 chip"（交付文件行内的 button[title=路径]）。
   *  title 必须形如文件路径才劫持：未来 DSH 若在该行加入其他带 title 的按钮
   *  （如"复制路径"），不会误劫持，放行其原生行为。 */
  const findChip = (target) => {
    if (!(target instanceof Element)) return null
    const row = target.closest('[data-produced-files-row]')
    if (!row) return null
    const button = target.closest('button')
    if (!button) return null
    const title = button.getAttribute('title')
    if (typeof title === 'string' && title !== '' && title !== '.' && looksLikePathText(title)) return title
    return null
  }

  /** 通用路径元素：优先 [data-path]，其次 <a href> 指向文件，再其次路径文本。 */
  const findPathEl = (target) => {
    if (!(target instanceof Element)) return null
    const explicit = target.closest('[data-path]')
    if (explicit) {
      const p = explicit.getAttribute('data-path')
      if (typeof p === 'string' && p !== '') return { path: p }
    }
    const anchor = target.closest('a[href]')
    if (anchor) {
      const href = anchor.getAttribute('href') ?? ''
      if (href.startsWith('file://')) {
        try {
          // Windows 上 URL pathname 为 /C:/x（前导斜杠需剥离，否则被当相对路径）
          return { path: decodeURIComponent(new URL(href).pathname.replace(/^\/+/, '')) }
        } catch {
          return null
        }
      }
      if (looksLikePathText(href)) return { path: href }
      return null
    }
    // 非交互元素且整段文本形如路径（如代码块内的文件引用）。
    let el = target
    for (let depth = 0; el instanceof Element && depth < 3; el = el.parentElement, depth++) {
      if (isInteractive(el)) return null
      if (el.childElementCount > 1) continue
      const text = el.textContent ?? ''
      const innerText = el instanceof HTMLElement ? el.innerText : undefined
      if (typeof innerText === 'string' && text !== innerText.trim() && !el.matches('code,span,div')) continue
      if (looksLikePathText(text)) return { path: text.trim(), fromText: true }
    }
    return null
  }

  // —— 点击拦截（捕获阶段，先于 React 根监听，stopPropagation 可阻止其 onClick）——
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target
      const chip = findChip(target)
      if (chip) {
        event.preventDefault()
        event.stopPropagation()
        openInVscode(chip)
        return
      }
      const found = findPathEl(target)
      if (found) {
        event.preventDefault()
        event.stopPropagation()
        openInVscode(found.path)
      }
    },
    true
  )

  // —— 活动会话上报：轮询 localStorage['dsh.sessions.current']（DSH 前端
  //     的当前会话快照，同源可读）。注意：值是整个快照的 JSON（DSH 用
  //     JSON.stringify(state) 持久化），必须解析出 .current 才是会话 id。
  //     变化时通知宿主，宿主据此重绑文件监听与相对路径解析基准。——
  const readCurrentSessionId = () => {
    try {
      const raw = window.localStorage.getItem('dsh.sessions.current')
      if (raw === null || raw === '') return null
      let parsed = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        /* 非 JSON：走裸 id 兜底 */
      }
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.current === 'string') {
        return parsed.current
      }
      // 防御：历史版本可能存裸 id（短字符串）
      return typeof raw === 'string' && raw.length < 128 ? raw : null
    } catch {
      return null
    }
  }
  let lastSessionId = null
  const reportSession = () => {
    const current = readCurrentSessionId()
    if (current !== lastSessionId) {
      lastSessionId = current
      try {
        window.parent.postMessage({ source: 'dsh-vscode', type: 'sessionCurrent', sessionId: current }, '*')
      } catch {
        /* 静默 */
      }
    }
  }
  reportSession()
  const sessionTimer = window.setInterval(reportSession, 2000)
  window.addEventListener('pagehide', () => window.clearInterval(sessionTimer), { once: true })
})()
