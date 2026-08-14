// policy 纯逻辑测试（node:test；针对编译产物 dist/linkage/policy.js）
const { describe, it } = require('node:test')
const assert = require('node:assert')
const { decideOpen, globToRegex, inAutoOpenScope, matchesAny } = require('../dist/linkage/policy.js')

describe('decideOpen', () => {
  it('off 模式永不打开', () => {
    assert.deepStrictEqual(decideOpen('off', false, false, false), { action: 'skip', preview: true, reason: 'mode-off' })
  })

  it('excluded 优先跳过', () => {
    assert.deepStrictEqual(decideOpen('editor', false, false, true), { action: 'skip', preview: true, reason: 'excluded' })
  })

  it('未打开 → 打开（preview 模式用预览标签）', () => {
    assert.deepStrictEqual(decideOpen('preview', false, false, false), { action: 'open', preview: true, reason: 'not-open' })
    assert.deepStrictEqual(decideOpen('editor', false, false, false), { action: 'open', preview: false, reason: 'not-open' })
  })

  it('已打开且 dirty → 永不覆盖', () => {
    assert.deepStrictEqual(decideOpen('editor', true, true, false), { action: 'skip', preview: true, reason: 'open-dirty' })
  })

  it('已打开且干净 → 交给 VSCode 原生刷新', () => {
    assert.deepStrictEqual(decideOpen('editor', true, false, false), { action: 'skip', preview: true, reason: 'open-clean' })
  })
})

describe('globToRegex / matchesAny', () => {
  it('** 跨目录', () => {
    assert.strictEqual(matchesAny('src/a/b.ts', ['**/*.ts']), true)
    assert.strictEqual(matchesAny('src/a/b.txt', ['**/*.ts']), false)
  })

  it('* 不跨目录', () => {
    assert.strictEqual(matchesAny('src/a.ts', ['src/*.ts']), true)
    assert.strictEqual(matchesAny('src/deep/a.ts', ['src/*.ts']), false)
  })

  it('字面量目录', () => {
    assert.strictEqual(matchesAny('node_modules/x/y.js', ['**/node_modules/**']), true)
    assert.strictEqual(matchesAny('src/x/y.js', ['**/node_modules/**']), false)
  })

  it('反斜杠归一化（Windows 路径）', () => {
    assert.strictEqual(matchesAny('src\\a\\b.ts', ['**/*.ts']), true)
  })

  it('特殊正则字符按字面处理', () => {
    assert.strictEqual(matchesAny('a+b.ts', ['a+b.ts']), true)
    assert.strictEqual(matchesAny('axb.ts', ['a+b.ts']), false)
  })
})

describe('inAutoOpenScope', () => {
  it('include 命中且 exclude 未命中 → true', () => {
    assert.strictEqual(inAutoOpenScope('src/a.ts', ['**/*'], ['**/dist/**']), true)
  })

  it('exclude 命中 → false', () => {
    assert.strictEqual(inAutoOpenScope('dist/a.ts', ['**/*'], ['**/dist/**']), false)
  })

  it('include 未命中 → false', () => {
    assert.strictEqual(inAutoOpenScope('src/a.ts', ['src/**'], []), true)
    assert.strictEqual(inAutoOpenScope('test/a.ts', ['src/**'], []), false)
  })

  it('include 为空 = 全命中', () => {
    assert.strictEqual(inAutoOpenScope('any/a.ts', [], ['x/**']), true)
  })
})

describe('globToRegex 直测', () => {
  it('** 与前缀/后缀组合', () => {
    const regex = globToRegex('src/**/*.spec.ts')
    assert.strictEqual(regex.test('src/a.spec.ts'), true)
    assert.strictEqual(regex.test('src/x/y.spec.ts'), true)
    assert.strictEqual(regex.test('lib/a.spec.ts'), false)
    assert.strictEqual(regex.test('src/a.ts'), false)
  })

  it("单独 '**' 匹配一切（含根级文件与深层）", () => {
    const regex = globToRegex('**')
    assert.strictEqual(regex.test('a'), true)
    assert.strictEqual(regex.test('a/b/c.txt'), true)
  })

  it("'a/**' 匹配 a 下任意深度（含直接子文件）", () => {
    const regex = globToRegex('a/**')
    assert.strictEqual(regex.test('a/x'), true)
    assert.strictEqual(regex.test('a/x/y/z'), true)
    assert.strictEqual(regex.test('b/x'), false)
  })

  it("'**/x/**/y' 中间与两端组合", () => {
    const regex = globToRegex('**/x/**/y')
    assert.strictEqual(regex.test('x/y'), true)
    assert.strictEqual(regex.test('a/x/y'), true)
    assert.strictEqual(regex.test('a/x/b/c/y'), true)
    assert.strictEqual(regex.test('a/x/b/c/z'), false)
  })

  it("'?' 单字符与 '*' 组合", () => {
    const regex = globToRegex('src/a?.ts')
    assert.strictEqual(regex.test('src/a1.ts'), true)
    assert.strictEqual(regex.test('src/ab.ts'), true) // a? 匹配 'ab'（? 恰好一个字符）
    assert.strictEqual(regex.test('src/abc.ts'), false)
  })
})
