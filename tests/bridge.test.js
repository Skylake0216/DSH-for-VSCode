// bridge.js 点击捕获测试（node:test + jsdom；直接 eval bridge 源文件）
const { describe, it, after } = require('node:test')
const assert = require('node:assert')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { JSDOM } = require('jsdom')

/** jsdom 内创建的对象跨 realm：断言前 JSON 往返归一化。 */
const plain = (value) => JSON.parse(JSON.stringify(value))

/** 在 jsdom 中加载 bridge.js 并返回 postMessage 捕获数组。 */
const created = [] // 记录所有 loader 以统一清理 jsdom 定时器

function loadBridge(url) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  const { window } = dom
  const posted = []
  // bridge 用 window.parent.postMessage；jsdom 中 parent === window。
  window.postMessage = (message) => {
    posted.push(message)
  }
  // bridge 内部 setInterval 会让 node 进程无法退出：路由到可控注册表。
  const intervalIds = new Set()
  window.setInterval = (fn, ms) => {
    const id = globalThis.setInterval(fn, ms)
    intervalIds.add(id)
    return id
  }
  window.clearInterval = (id) => {
    intervalIds.delete(id)
    globalThis.clearInterval(id)
  }
  const source = readFileSync(join(__dirname, '..', 'bridge', 'lib', 'bridge.js'), 'utf8')
  window.eval(source)
  const cleanup = () => {
    for (const id of intervalIds) globalThis.clearInterval(id)
    intervalIds.clear()
    dom.window.close()
  }
  created.push(cleanup)
  return { window, posted, cleanup }
}

after(() => {
  for (const cleanup of created) cleanup()
})

const EMBED_URL = 'http://127.0.0.1:3210/?dshEmbed=1'
const PLAIN_URL = 'http://127.0.0.1:3210/'

describe('bridge.js', () => {
  it('无 dshEmbed=1 时整体 no-op', () => {
    const { window, posted } = loadBridge(PLAIN_URL)
    window.document.body.innerHTML = `<div data-produced-files-row><button type="button" title="src/a.ts">a.ts</button></div>`
    window.document.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.deepStrictEqual(plain(posted), [])
  })

  it('交付文件 chip 点击 → openFile 且阻止默认行为', () => {
    const { window, posted } = loadBridge(EMBED_URL)
    window.document.body.innerHTML = `<div data-produced-files-row><button type="button" title="src/foo.ts">foo.ts</button></div>`
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    window.document.querySelector('button').dispatchEvent(event)
    assert.deepStrictEqual(plain(posted), [{ source: 'dsh-vscode', type: 'openFile', path: 'src/foo.ts' }])
    assert.strictEqual(event.defaultPrevented, true)
  })

  it("chip 的 '.'（显示文件夹）不触发", () => {
    const { window, posted } = loadBridge(EMBED_URL)
    window.document.body.innerHTML = `<div data-produced-files-row><button type="button" title=".">show in folder</button></div>`
    window.document.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.deepStrictEqual(plain(posted), [])
  })

  it('row 内非路径 title 的按钮不劫持（放行原生行为）', () => {
    const { window, posted } = loadBridge(EMBED_URL)
    window.document.body.innerHTML = `<div data-produced-files-row><button type="button" title="复制路径">复制</button></div>`
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    window.document.querySelector('button').dispatchEvent(event)
    assert.deepStrictEqual(plain(posted), [])
    assert.strictEqual(event.defaultPrevented, false)
  })

  it('file:// href 点击 → 剥前导斜杠的路径（Windows）', () => {
    const { window, posted } = loadBridge(EMBED_URL)
    window.document.body.innerHTML = `<a href="file:///C:/workspace/src/app.ts">app</a>`
    window.document.querySelector('a').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.deepStrictEqual(plain(posted), [{ source: 'dsh-vscode', type: 'openFile', path: 'C:/workspace/src/app.ts' }])
  })

  it('data-path 元素点击 → openFile', () => {
    const { window, posted } = loadBridge(EMBED_URL)
    window.document.body.innerHTML = `<span data-path="docs/guide.md">guide</span>`
    window.document.querySelector('span').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.deepStrictEqual(plain(posted), [{ source: 'dsh-vscode', type: 'openFile', path: 'docs/guide.md' }])
  })

  it('非路径文本元素不触发', () => {
    const { window, posted } = loadBridge(EMBED_URL)
    window.document.body.innerHTML = `<span>随便一句话</span>`
    window.document.querySelector('span').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.deepStrictEqual(plain(posted), [])
  })

  it('收到 VSCode 主题消息 → 设置深色并注入 DSH token 覆盖样式', () => {
    const { window } = loadBridge(EMBED_URL)
    const event = new window.MessageEvent('message', {
      data: {
        source: 'dsh-vscode',
        type: 'theme',
        scheme: 'dark',
        tokens: {
          '--dsw-alias-bg-base': '#1e1e1e',
          '--dsw-alias-label-primary': '#d4d4d4',
        },
      },
    })
    Object.defineProperty(event, 'source', { value: window.parent })
    window.dispatchEvent(event)
    assert.strictEqual(window.document.documentElement.style.colorScheme, 'dark')
    assert.ok(window.document.body.hasAttribute('data-ds-dark-theme'))
    const style = window.document.getElementById('dsh-vscode-theme-overrides')
    assert.ok(style, '应存在主题覆盖样式节点')
    assert.match(style.textContent, /--dsw-alias-bg-base: #1e1e1e !important/)
    assert.match(style.textContent, /--dsw-alias-label-primary: #d4d4d4 !important/)
  })

  it('收到浅色主题消息 → 移除深色属性并更新覆盖样式', () => {
    const { window } = loadBridge(EMBED_URL)
    const postTheme = (scheme) => {
      const event = new window.MessageEvent('message', {
        data: { source: 'dsh-vscode', type: 'theme', scheme, tokens: { '--dsw-alias-bg-base': '#ffffff' } },
      })
      Object.defineProperty(event, 'source', { value: window.parent })
      window.dispatchEvent(event)
    }
    postTheme('dark')
    assert.ok(window.document.body.hasAttribute('data-ds-dark-theme'))
    postTheme('light')
    assert.strictEqual(window.document.documentElement.style.colorScheme, 'light')
    assert.ok(!window.document.body.hasAttribute('data-ds-dark-theme'))
    const style = window.document.getElementById('dsh-vscode-theme-overrides')
    assert.match(style.textContent, /--dsw-alias-bg-base: #ffffff !important/)
  })

  it('收到 reset 消息 → 移除覆盖样式且不强制明暗', () => {
    const { window } = loadBridge(EMBED_URL)
    const send = (data) => {
      const event = new window.MessageEvent('message', { data })
      Object.defineProperty(event, 'source', { value: window.parent })
      window.dispatchEvent(event)
    }
    send({ source: 'dsh-vscode', type: 'theme', scheme: 'dark', tokens: { '--dsw-alias-bg-base': '#000' } })
    assert.ok(window.document.getElementById('dsh-vscode-theme-overrides'))
    send({ source: 'dsh-vscode', type: 'theme', reset: true })
    assert.strictEqual(window.document.getElementById('dsh-vscode-theme-overrides'), null)
    assert.strictEqual(window.document.documentElement.style.colorScheme, '')
  })

  it('主题消息来源不是父窗口 → 忽略', () => {
    const { window } = loadBridge(EMBED_URL)
    const event = new window.MessageEvent('message', {
      data: { source: 'dsh-vscode', type: 'theme', scheme: 'dark', tokens: { '--dsw-alias-bg-base': '#000' } },
    })
    Object.defineProperty(event, 'source', { value: {} })
    window.dispatchEvent(event)
    assert.strictEqual(window.document.getElementById('dsh-vscode-theme-overrides'), null)
  })

  it('非交互元素路径文本触发（相对路径含目录层级）', () => {
    const { window, posted } = loadBridge(EMBED_URL)
    window.document.body.innerHTML = `<code>deploy/base/deployment.yaml</code>`
    window.document.querySelector('code').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.deepStrictEqual(plain(posted), [{ source: 'dsh-vscode', type: 'openFile', path: 'deploy/base/deployment.yaml' }])
  })

  it('活动会话轮询上报变化（快照 JSON 形态：解析出 .current）', async () => {
    const { window, posted } = loadBridge(EMBED_URL)
    window.localStorage.setItem('dsh.sessions.current', JSON.stringify({ current: 'session-1', byId: {} }))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2300))
    const sessionMessages = posted.filter((m) => m.type === 'sessionCurrent')
    assert.ok(sessionMessages.length >= 1, '应至少上报一次会话变化')
    assert.deepStrictEqual(plain(sessionMessages[0]), { source: 'dsh-vscode', type: 'sessionCurrent', sessionId: 'session-1' })
  })

  it('活动会话轮询：裸 id 兜底与二次切换上报', async () => {
    const { window, posted } = loadBridge(EMBED_URL)
    window.localStorage.setItem('dsh.sessions.current', 'session-raw')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2300))
    const first = posted.filter((m) => m.type === 'sessionCurrent')
    assert.ok(first.length >= 1)
    assert.strictEqual(first[0].sessionId, 'session-raw')
    // 二次切换：JSON 形态新会话
    window.localStorage.setItem('dsh.sessions.current', JSON.stringify({ current: 'session-2' }))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2300))
    const all = posted.filter((m) => m.type === 'sessionCurrent')
    assert.deepStrictEqual(plain(all[all.length - 1]), { source: 'dsh-vscode', type: 'sessionCurrent', sessionId: 'session-2' })
  })
})
