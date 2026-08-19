// relay 脚本路由测试（node:test + jsdom）：消息来源校验、hello URL 白名单、转发与拒绝
const { describe, it, after } = require('node:test')
const assert = require('node:assert')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { JSDOM } = require('jsdom')

const doms = []
after(() => {
  // 关闭 jsdom 窗口：取消 attachFrame 的加载超时定时器，避免测试进程被拖住 8s
  for (const dom of doms) dom.window.close()
})

function loadRelay() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <iframe id="dsh-frame"></iframe>
      <div id="status"><div id="status-text">boot</div><div id="status-err" style="display:none"></div></div>
    </body></html>`,
    { url: 'http://127.0.0.1:1234/', runScripts: 'outside-only', pretendToBeVisual: true }
  )
  doms.push(dom)
  const { window } = dom
  const posted = []
  window.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) })
  const source = readFileSync(join(__dirname, '..', 'dist', 'webview', 'relay.js'), 'utf8')
  window.eval(source)
  const frame = window.document.getElementById('dsh-frame')
  // 记录 src 设置次数
  const srcSets = []
  Object.defineProperty(frame, 'src', {
    get() {
      return this.getAttribute('src')
    },
    set(value) {
      srcSets.push(value)
      this.setAttribute('src', value)
    },
  })
  /** 构造带指定 source/origin 的消息事件。 */
  const post = (sourceWin, origin, data) => {
    const event = new window.MessageEvent('message', { data, origin })
    Object.defineProperty(event, 'source', { value: sourceWin, configurable: true })
    window.dispatchEvent(event)
    return event
  }
  return { window, posted, frame, srcSets, post }
}

describe('relay 脚本', () => {
  it('加载即发 ready 握手', () => {
    const { posted } = loadRelay()
    assert.deepStrictEqual(JSON.parse(JSON.stringify(posted[0])), { type: 'ready' })
  })

  it('宿主 hello（合法回环 url）→ 挂载 iframe + dshEmbed=1', () => {
    const { frame, srcSets, post, window } = loadRelay()
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    // jsdom 会规范化 URL（丢弃 ? 前斜杠）
    assert.strictEqual(frame.getAttribute('src'), 'http://127.0.0.1:3080?dshEmbed=1')
    assert.strictEqual(srcSets.length, 1)
  })

  it('hello 重复到达不重复设置 src（幂等，防整页重载）', () => {
    const { srcSets, post, window } = loadRelay()
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    assert.strictEqual(srcSets.length, 1)
  })

  it('hello URL 白名单：非回环/带路径/非 http 一律拒绝', () => {
    const { frame, srcSets, post, window } = loadRelay()
    for (const url of [
      'http://evil.com:3080',
      'https://evil.com:3080',
      'http://127.0.0.1:3080/some/path',
      'http://192.168.1.5:3080',
      'javascript:alert(1)',
    ]) {
      post(window, 'null', { type: 'hello', url })
    }
    assert.strictEqual(srcSets.length, 0)
    assert.strictEqual(frame.getAttribute('src'), null)
  })

  it('iframe 伪造 hello（source=本 iframe 窗口）被拒绝（防嵌入页重定向面板）', () => {
    const { frame, srcSets, post } = loadRelay()
    post(frame.contentWindow, 'http://127.0.0.1:3080', { type: 'hello', url: 'http://127.0.0.1:3999' })
    assert.strictEqual(srcSets.length, 0)
    assert.strictEqual(frame.getAttribute('src'), null)
  })

  it('宿主消息 source 非 window（真实 webview 为外层桥接窗口/null）也生效', () => {
    const { frame, srcSets, post } = loadRelay()
    // 模拟真实 VSCode webview：宿主消息 source 为 null
    post(null, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    assert.strictEqual(frame.getAttribute('src'), 'http://127.0.0.1:3080?dshEmbed=1')
    assert.strictEqual(srcSets.length, 1)
  })

  it('iframe 上行 openFile：正确 source+origin → 转发扩展', () => {
    const { frame, posted, post } = loadRelay()
    post(frame.contentWindow, 'http://127.0.0.1:3080', { source: 'dsh-vscode', type: 'openFile', path: 'src/a.ts', line: 2, column: 3 })
    const forwarded = posted.find((m) => m.type === 'openFile')
    assert.ok(forwarded !== undefined)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(forwarded)), { type: 'openFile', path: 'src/a.ts', line: 2, column: 3 })
  })

  it('iframe 上行 origin 非回环 → 拒绝转发', () => {
    const { frame, posted, post } = loadRelay()
    post(frame.contentWindow, 'http://evil.com:3080', { source: 'dsh-vscode', type: 'openFile', path: 'src/a.ts' })
    assert.strictEqual(posted.find((m) => m.type === 'openFile'), undefined)
  })

  it('iframe 上行 line/column 类型不合法 → 拒绝转发', () => {
    const { frame, posted, post } = loadRelay()
    post(frame.contentWindow, 'http://127.0.0.1:3080', { source: 'dsh-vscode', type: 'openFile', path: 'src/a.ts', line: 'x' })
    assert.strictEqual(posted.find((m) => m.type === 'openFile'), undefined)
  })

  it('iframe 上行 sessionCurrent → 转发扩展', () => {
    const { frame, posted, post } = loadRelay()
    post(frame.contentWindow, 'http://127.0.0.1:3080', { source: 'dsh-vscode', type: 'sessionCurrent', sessionId: 's-9' })
    const forwarded = posted.find((m) => m.type === 'sessionCurrent')
    assert.ok(forwarded !== undefined)
    assert.strictEqual(forwarded.sessionId, 's-9')
  })

  it('宿主 theme 消息 → iframe load 后转发 VSCode 主题颜色到 DSH token', () => {
    const { window, frame, post } = loadRelay()
    // 模拟 VSCode webview 注入的 CSS 变量
    const style = window.document.createElement('style')
    style.textContent = ':root { --vscode-editor-background: #1e1e1e; --vscode-editor-foreground: #d4d4d4; }'
    window.document.head.appendChild(style)
    // 未挂载 iframe 前不转发
    post(window, 'null', { type: 'theme', kind: 2, enabled: true })
    // hello 挂载后会替换 contentWindow，因此先挂载再捕获 postMessage
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    const framePosted = []
    frame.contentWindow.postMessage = (message) => framePosted.push(message)
    frame.dispatchEvent(new window.Event('load'))
    assert.strictEqual(framePosted.length, 1)
    const theme = framePosted[0]
    assert.strictEqual(theme.type, 'theme')
    assert.strictEqual(theme.scheme, 'dark')
    assert.strictEqual(theme.tokens['--dsw-alias-bg-base'], '#1e1e1e')
    assert.strictEqual(theme.tokens['--dsw-alias-label-primary'], '#d4d4d4')
  })

  it('宿主 theme 消息在 iframe 已挂载时立即转发', () => {
    const { window, frame, post } = loadRelay()
    const style = window.document.createElement('style')
    style.textContent = ':root { --vscode-editor-background: #ffffff; --vscode-editor-foreground: #000000; }'
    window.document.head.appendChild(style)
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    const framePosted = []
    frame.contentWindow.postMessage = (message) => framePosted.push(message)
    frame.dispatchEvent(new window.Event('load'))
    framePosted.length = 0
    post(window, 'null', { type: 'theme', kind: 1, enabled: true })
    assert.strictEqual(framePosted.length, 1)
    assert.strictEqual(framePosted[0].scheme, 'light')
    assert.strictEqual(framePosted[0].tokens['--dsw-alias-bg-base'], '#ffffff')
  })

  it('轮询兜底：VSCode CSS 变量变化但无宿主消息时也会补发', async () => {
    const { window, frame, post } = loadRelay()
    const style = window.document.createElement('style')
    style.textContent = ':root { --vscode-editor-background: #000000; --vscode-editor-foreground: #ffffff; }'
    window.document.head.appendChild(style)
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    const framePosted = []
    frame.contentWindow.postMessage = (message) => framePosted.push(message)
    frame.dispatchEvent(new window.Event('load'))
    assert.strictEqual(framePosted.length, 1)
    // 模拟 VSCode 主题切换：仅更新 CSS 变量，不发送宿主 theme 消息
    style.textContent = ':root { --vscode-editor-background: #1e1e1e; --vscode-editor-foreground: #d4d4d4; }'
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200))
    assert.strictEqual(framePosted.length, 2)
    assert.strictEqual(framePosted[1].tokens['--dsw-alias-bg-base'], '#1e1e1e')
    assert.strictEqual(framePosted[1].tokens['--dsw-alias-label-primary'], '#d4d4d4')
  })

  it('themeSync=false 时 iframe 收到 reset（恢复 DSH 自身主题）', () => {
    const { window, frame, post } = loadRelay()
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    const framePosted = []
    frame.contentWindow.postMessage = (message) => framePosted.push(message)
    frame.dispatchEvent(new window.Event('load'))
    framePosted.length = 0
    post(window, 'null', { type: 'theme', kind: 2, enabled: false })
    assert.strictEqual(framePosted.length, 1)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(framePosted[0])), {
      source: 'dsh-vscode',
      type: 'theme',
      reset: true,
    })
  })

  it('hostStatus 状态渲染：connecting/error', () => {
    const { window, post } = loadRelay()
    const text = window.document.getElementById('status-text')
    const err = window.document.getElementById('status-err')
    post(window, 'null', { type: 'hostStatus', status: 'connecting' })
    assert.ok(text.textContent.includes('启动'))
    post(window, 'null', { type: 'hostStatus', status: 'error', message: 'boom' })
    assert.ok(text.textContent.includes('失败'))
    assert.ok(err.textContent.includes('boom'))
    assert.strictEqual(err.style.display, 'block')
  })

  it('iframe 挂载后 connecting 不再盖状态层（防覆盖层滞留）', () => {
    const { window, frame, srcSets, post } = loadRelay()
    const statusEl = window.document.getElementById('status')
    // 初始 connecting：显示覆盖层
    post(window, 'null', { type: 'hostStatus', status: 'connecting' })
    assert.strictEqual(statusEl.style.display, 'flex')
    // hello 挂载 iframe
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    assert.strictEqual(srcSets.length, 1)
    // 模拟 iframe load → 隐藏状态层、显示 iframe
    frame.dispatchEvent(new window.Event('load'))
    assert.strictEqual(statusEl.style.display, 'none')
    assert.strictEqual(frame.style.display, 'block')
    // 重启/stop 时的滞留 connecting 不得重新盖住 iframe
    post(window, 'null', { type: 'hostStatus', status: 'connecting' })
    assert.strictEqual(statusEl.style.display, 'none')
    // 同 URL hello 幂等（不重设 src）且不恢复覆盖层
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    assert.strictEqual(srcSets.length, 1)
    assert.strictEqual(statusEl.style.display, 'none')
    // 错误仍然要盖住并展示
    post(window, 'null', { type: 'hostStatus', status: 'error', message: 'boom' })
    assert.strictEqual(statusEl.style.display, 'flex')
  })

  it('theme 映射：badge-foreground 不再覆盖 label-secondary（2026 浅色白 badge 字）', () => {
    const { window, frame, post } = loadRelay()
    const style = window.document.createElement('style')
    style.textContent =
      ':root { --vscode-editor-background: #ffffff; --vscode-editor-foreground: #202020; ' +
      '--vscode-badge-foreground: #ffffff; --vscode-input-placeholderForeground: #999999; ' +
      '--vscode-descriptionForeground: #606060; --vscode-tab-inactiveForeground: #606060; }'
    window.document.head.appendChild(style)
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    const framePosted = []
    frame.contentWindow.postMessage = (message) => framePosted.push(message)
    frame.dispatchEvent(new window.Event('load'))
    const tokens = framePosted[0].tokens
    // label-secondary 保持编辑器前景色，而不是 badge 白色（否则聊天框权限/模型选项文字不可见）
    assert.strictEqual(tokens['--dsw-alias-label-secondary'], '#202020')
    // placeholder #999999 对白底约 2.85:1 不足 → 回退编辑器前景色
    assert.strictEqual(tokens['--dsw-alias-label-tertiary'], '#202020')
    // description/tabInactive #606060 对白底约 6.3:1 足够 → 保留（保持弱化层级）
    assert.strictEqual(tokens['--dsw-alias-label-caption'], '#606060')
    assert.strictEqual(tokens['--dsw-alias-label-dimmed'], '#606060')
  })

  it('theme 映射：深色主题淡色文字不足对比时回退编辑器前景色', () => {
    const { window, frame, post } = loadRelay()
    const style = window.document.createElement('style')
    style.textContent =
      ':root { --vscode-editor-background: #121314; --vscode-editor-foreground: #bbbebf; ' +
      '--vscode-input-placeholderForeground: #555555; --vscode-descriptionForeground: #8c8c8c; ' +
      '--vscode-badge-foreground: #ffffff; }'
    window.document.head.appendChild(style)
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    const framePosted = []
    frame.contentWindow.postMessage = (message) => framePosted.push(message)
    frame.dispatchEvent(new window.Event('load'))
    const tokens = framePosted[0].tokens
    // badge 白字不覆盖 label-secondary；保持编辑器前景色
    assert.strictEqual(tokens['--dsw-alias-label-secondary'], '#bbbebf')
    // #555555 对 #121314 约 2.5:1 不足 → 回退
    assert.strictEqual(tokens['--dsw-alias-label-tertiary'], '#bbbebf')
    // #8c8c8c 对 #121314 约 5.5:1 足够 → 保留
    assert.strictEqual(tokens['--dsw-alias-label-caption'], '#8c8c8c')
  })

  it('theme 映射：Tomorrow Night Blue 的深藏青 badge 字不覆盖 label-secondary', () => {
    const { window, frame, post } = loadRelay()
    const style = window.document.createElement('style')
    style.textContent =
      ':root { --vscode-editor-background: #002451; --vscode-editor-foreground: #ffffff; ' +
      '--vscode-badge-foreground: #001733; --vscode-input-background: #001733; }'
    window.document.head.appendChild(style)
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    const framePosted = []
    frame.contentWindow.postMessage = (message) => framePosted.push(message)
    frame.dispatchEvent(new window.Event('load'))
    const tokens = framePosted[0].tokens
    // 深藏青 badge 字绝不能成为 label-secondary（否则深字融深底，正是 TN Blue 问题）
    assert.strictEqual(tokens['--dsw-alias-label-secondary'], '#ffffff')
    // placeholder 未定义 → label-tertiary 不覆盖（保持 DSH 原生）
    assert.strictEqual(tokens['--dsw-alias-label-tertiary'], undefined)
  })

  it('theme 映射：颜色格式差异（3/6位hex、rgb 逗号/百分比/空格、大小写）等价处理', () => {
    // 这些写法都解析为 ~#999999（对白底 2.85:1 不足）→ 一律回退编辑器前景色
    const cases = ['#999', '#999999', '#9A9A9A', 'rgb(153, 153, 153)', 'rgb(60%, 60%, 60%)', 'rgb(153 153 153)']
    for (const placeholder of cases) {
      const { window, frame, post } = loadRelay()
      const style = window.document.createElement('style')
      style.textContent =
        ':root { --vscode-editor-background: #ffffff; --vscode-editor-foreground: #202020; ' +
        `--vscode-input-placeholderForeground: ${placeholder}; }`
      window.document.head.appendChild(style)
      post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
      const framePosted = []
      frame.contentWindow.postMessage = (message) => framePosted.push(message)
      frame.dispatchEvent(new window.Event('load'))
      assert.strictEqual(
        framePosted[0].tokens['--dsw-alias-label-tertiary'],
        '#202020',
        `placeholder=${placeholder} 应回退编辑器前景色`
      )
    }
  })

  it('theme 映射：半透明/无法解析/背景缺失的候选色一律回退前景色', () => {
    const cases = ['rgba(153, 153, 153, 0.5)', '#99999980', 'rgb(153 153 153 / 50%)', 'banana', 'currentColor', 'hsl(0, 0%, 60%)']
    for (const placeholder of cases) {
      const { window, frame, post } = loadRelay()
      const style = window.document.createElement('style')
      style.textContent =
        ':root { --vscode-editor-background: #ffffff; --vscode-editor-foreground: #202020; ' +
        `--vscode-input-placeholderForeground: ${placeholder}; }`
      window.document.head.appendChild(style)
      post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
      const framePosted = []
      frame.contentWindow.postMessage = (message) => framePosted.push(message)
      frame.dispatchEvent(new window.Event('load'))
      assert.strictEqual(
        framePosted[0].tokens['--dsw-alias-label-tertiary'],
        '#202020',
        `placeholder=${placeholder} 应回退编辑器前景色`
      )
    }
    // 编辑器背景缺失：仍回退到前景色（可读性优先）
    const { window: w2, frame: f2, post: p2 } = loadRelay()
    const style2 = w2.document.createElement('style')
    style2.textContent = ':root { --vscode-editor-foreground: #202020; --vscode-input-placeholderForeground: #999999; }'
    w2.document.head.appendChild(style2)
    p2(w2, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    const posted2 = []
    f2.contentWindow.postMessage = (message) => posted2.push(message)
    f2.dispatchEvent(new w2.Event('load'))
    assert.strictEqual(posted2[0].tokens['--dsw-alias-label-tertiary'], '#202020')
  })

  it('theme 映射：编辑器前景/背景都缺失时保留候选色（不恶化现有行为）', () => {
    const { window, frame, post } = loadRelay()
    const style = window.document.createElement('style')
    style.textContent = ':root { --vscode-input-placeholderForeground: #999999; }'
    window.document.head.appendChild(style)
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    const framePosted = []
    frame.contentWindow.postMessage = (message) => framePosted.push(message)
    frame.dispatchEvent(new window.Event('load'))
    assert.strictEqual(framePosted[0].tokens['--dsw-alias-label-tertiary'], '#999999')
  })

  it('theme 映射：对比度达标的淡色文字保留（含不透明 8 位 hex）', () => {
    const { window, frame, post } = loadRelay()
    const style = window.document.createElement('style')
    style.textContent =
      ':root { --vscode-editor-background: #ffffff; --vscode-editor-foreground: #202020; ' +
      '--vscode-descriptionForeground: #5a5a5a; --vscode-tab-inactiveForeground: #606060FF; }'
    window.document.head.appendChild(style)
    post(window, 'null', { type: 'hello', url: 'http://127.0.0.1:3080' })
    const framePosted = []
    frame.contentWindow.postMessage = (message) => framePosted.push(message)
    frame.dispatchEvent(new window.Event('load'))
    const tokens = framePosted[0].tokens
    // #5a5a5a 对白底约 6.9:1、#606060FF（不透明）约 6.3:1 → 保留弱化层级
    assert.strictEqual(tokens['--dsw-alias-label-caption'], '#5a5a5a')
    assert.strictEqual(tokens['--dsw-alias-label-dimmed'], '#606060FF')
  })
})
