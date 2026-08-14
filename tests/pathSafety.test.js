// resolveSafePath 安全解析测试（node:test；针对编译产物 dist/linkage/pathSafety.js）
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { resolveSafePath } = require('../dist/linkage/pathSafety.js')

// 沙箱内测试：临时目录放在工作区下，测试后清理。
const sandbox = mkdtempSync(join(process.cwd(), '.tmp-tests-'))
const root = join(sandbox, 'root')
const outside = join(sandbox, 'outside')

before(() => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'x')
  writeFileSync(join(root, 'README.md'), 'y')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'z')
})

after(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('resolveSafePath', () => {
  it('根内绝对路径 → 原样', () => {
    assert.strictEqual(resolveSafePath(join(root, 'src', 'a.ts'), [root]), join(root, 'src', 'a.ts'))
  })

  it('相对路径相对根解析', () => {
    assert.strictEqual(resolveSafePath('src/a.ts', [root]), join(root, 'src', 'a.ts'))
  })

  it('../ 逃逸被拒', () => {
    assert.strictEqual(resolveSafePath('../outside/secret.txt', [root]), undefined)
  })

  it('绝对路径越界被拒', () => {
    assert.strictEqual(resolveSafePath(join(outside, 'secret.txt'), [root]), undefined)
  })

  it('多根：依次尝试', () => {
    assert.strictEqual(resolveSafePath('secret.txt', [root, outside]), join(outside, 'secret.txt'))
  })

  it('不存在的根内文件：词法校验通过（父目录在根内）', () => {
    assert.strictEqual(resolveSafePath('src/not-yet.ts', [root]), join(root, 'src', 'not-yet.ts'))
  })

  it('不存在的文件且父目录越界 → 拒绝', () => {
    assert.strictEqual(resolveSafePath('../../outside/nope.ts', [root]), undefined)
  })

  it('空输入/空根 → undefined', () => {
    assert.strictEqual(resolveSafePath('', [root]), undefined)
    assert.strictEqual(resolveSafePath('a.ts', []), undefined)
  })

  it('符号链接逃逸被拒（无权限时跳过）', () => {
    try {
      symlinkSync(outside, join(root, 'link'), 'junction')
    } catch {
      return // 无符号链接权限：跳过
    }
    assert.strictEqual(resolveSafePath('link/secret.txt', [root]), undefined)
  })

  it('NUL 输入拒绝', () => {
    assert.strictEqual(resolveSafePath('src/a\0.ts', [root]), undefined)
  })

  it('Windows 尾随空格/点拒绝（POSIX 语义不同则跳过）', () => {
    if (process.platform !== 'win32') return
    assert.strictEqual(resolveSafePath('src/a.ts ', [root]), undefined)
    assert.strictEqual(resolveSafePath('src/trailing.', [root]), undefined)
  })
})
