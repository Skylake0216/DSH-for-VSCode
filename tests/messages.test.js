// messages 类型守卫测试（node:test）
const { describe, it } = require('node:test')
const assert = require('node:assert')
const { isIframeToWebview } = require('../dist/messages.js')

describe('isIframeToWebview', () => {
  it('openFile 合法消息', () => {
    assert.strictEqual(isIframeToWebview({ source: 'dsh-vscode', type: 'openFile', path: 'a/b.ts' }), true)
    assert.strictEqual(isIframeToWebview({ source: 'dsh-vscode', type: 'openFile', path: '/abs/c.ts', line: 3, column: 5 }), true)
  })
  it('sessionCurrent 合法消息', () => {
    assert.strictEqual(isIframeToWebview({ source: 'dsh-vscode', type: 'sessionCurrent', sessionId: 's-1' }), true)
    assert.strictEqual(isIframeToWebview({ source: 'dsh-vscode', type: 'sessionCurrent', sessionId: null }), true)
  })
  it('非法消息拒绝', () => {
    assert.strictEqual(isIframeToWebview(null), false)
    assert.strictEqual(isIframeToWebview(undefined), false)
    assert.strictEqual(isIframeToWebview('x'), false)
    assert.strictEqual(isIframeToWebview({}), false)
    assert.strictEqual(isIframeToWebview({ type: 'openFile', path: 'x' }), false) // 缺 source
    assert.strictEqual(isIframeToWebview({ source: 'other', type: 'openFile', path: 'x' }), false)
    assert.strictEqual(isIframeToWebview({ source: 'dsh-vscode', type: 'openFile' }), false) // 缺 path
    assert.strictEqual(isIframeToWebview({ source: 'dsh-vscode', type: 'openFile', path: 123 }), false)
    assert.strictEqual(isIframeToWebview({ source: 'dsh-vscode', type: 'unknown' }), false)
    assert.strictEqual(isIframeToWebview({ source: 'dsh-vscode', type: 'sessionCurrent', sessionId: {} }), false)
  })
})
