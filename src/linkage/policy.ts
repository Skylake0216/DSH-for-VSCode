/**
 * 文件联动策略：纯决策逻辑（vitest 直测）。
 * 红线：打开中且 dirty 的文档永不自动覆盖。
 */

export type OpenMode = 'preview' | 'editor' | 'off'

export type OpenAction = 'open' | 'skip'

export interface PolicyDecision {
  action: OpenAction
  /** action=open 时：preview=true 表示预览标签。 */
  preview: boolean
  reason: 'not-open' | 'open-clean' | 'open-dirty' | 'mode-off' | 'excluded'
}

/**
 * 决定一次"文件被外部（agent）写入"是否自动打开。
 * @param openMode - 设置项 autoOpenFiles
 * @param isOpen - 文件当前是否已在编辑器中打开
 * @param isDirty - 打开中的文档是否有未保存修改
 * @param excluded - 是否命中 exclude 黑名单（或未命中 include 白名单）
 */
export function decideOpen(openMode: OpenMode, isOpen: boolean, isDirty: boolean, excluded: boolean): PolicyDecision {
  if (excluded) return { action: 'skip', preview: true, reason: 'excluded' }
  if (openMode === 'off') return { action: 'skip', preview: true, reason: 'mode-off' }
  if (!isOpen) return { action: 'open', preview: openMode === 'preview', reason: 'not-open' }
  if (isDirty) return { action: 'skip', preview: true, reason: 'open-dirty' }
  // 已打开且干净：VSCode 原生自动刷新缓冲区，无需动作。
  return { action: 'skip', preview: true, reason: 'open-clean' }
}

/** 最小 glob→正则：支持 `**`（跨目录）、`*`（不含分隔符）、字面量。 */
export function globToRegex(pattern: string): RegExp {
  let source = '^'
  const normalized = pattern.replace(/\\/g, '/')
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]!
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        // ** 跨目录；吞掉随后的 /
        index += 1
        if (normalized[index + 1] === '/') index += 1
        source += '(?:[^/]*(?:/|$))*'
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  source += '$'
  return new RegExp(source)
}

/** 相对路径是否命中任一 glob。 */
export function matchesAny(relPath: string, patterns: string[]): boolean {
  const normalized = relPath.replace(/\\/g, '/')
  return patterns.some((pattern) => globToRegex(pattern).test(normalized))
}

/**
 * 文件是否在自动打开范围内：
 *  1. include 任一命中（默认值为全命中 glob）
 *  2. 且 exclude 无一命中
 * @param relPath - 相对监视根的路径
 * @param include - include glob 列表（空 = 全命中）
 */
export function inAutoOpenScope(relPath: string, include: string[], exclude: string[]): boolean {
  const included = include.length === 0 || matchesAny(relPath, include)
  if (!included) return false
  return !matchesAny(relPath, exclude)
}
