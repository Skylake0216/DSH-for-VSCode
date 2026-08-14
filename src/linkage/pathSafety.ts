/**
 * 路径安全解析（纯逻辑，无 vscode 依赖 —— node:test 直测）。
 * 所有来自 iframe/UI 的路径必须经 resolveSafePath 校验：
 * realpath 规范化 + 根前缀包含，防 `../` 逃逸与符号链接绕过。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** 大小写敏感判断（Windows/mac 不敏感）。 */
const caseSensitive = process.platform === 'linux'

/** 归一化大小写。 */
function norm(value: string): string {
  return caseSensitive ? value : value.toLowerCase()
}

/** absolute 是否位于任一 root 内（词法比较，调用方负责 realpath）。 */
function insideAny(absolute: string, roots: string[]): boolean {
  const normalized = norm(absolute)
  return roots.some((root) => {
    const normalizedRoot = norm(root)
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${path.sep}`)
  })
}

/**
 * 把输入路径解析为允许根目录内的绝对路径。
 * @param input - 绝对路径或相对路径（相对 roots 依次尝试）
 * @param roots - 允许的根目录（活动会话 cwd + 工作区文件夹），应为真实路径
 * @returns 解析后的绝对路径；越界/不存在时 undefined
 */
export function resolveSafePath(input: string, roots: string[]): string | undefined {
  if (input === '' || roots.length === 0) return undefined
  // NUL 与 Windows 尾随空格/点：显式拒绝（这些形态进 Uri.file 会抛错或被规范化成不一致的字符串）。
  if (input.includes('\0')) return undefined
  if (process.platform === 'win32') {
    // 检查原始输入的路径组件（trim 前的尾随空格/点才是问题本身）
    const segments = input.split(/[\\/]/)
    if (segments.some((segment) => segment.endsWith(' ') || segment.endsWith('.'))) return undefined
  }
  const trimmed = input.trim()
  const candidates: string[] = []
  if (path.isAbsolute(trimmed)) {
    candidates.push(trimmed)
  } else {
    for (const root of roots) candidates.push(path.resolve(root, trimmed))
  }
  // 预先把根 realpath 化（根本身可能含符号链接成分）。
  const realRoots: string[] = []
  for (const root of roots) {
    try {
      realRoots.push(fs.realpathSync(root))
    } catch {
      realRoots.push(root)
    }
  }
  // 两轮：优先"文件真实存在"的候选（多根时避免指向不存在的文件），
  // 其次词法落在根内且父目录合法的候选（agent 可能刚删除文件，允许返回路径）。
  const valid: string[] = []
  const validMissing: string[] = []
  for (const candidate of candidates) {
    const absolute = path.normalize(candidate)
    if (!insideAny(absolute, roots)) continue
    try {
      const real = fs.realpathSync(absolute)
      if (insideAny(real, realRoots)) valid.push(real)
    } catch {
      try {
        const parentReal = fs.realpathSync(path.dirname(absolute))
        if (insideAny(parentReal, realRoots)) validMissing.push(absolute)
      } catch {
        /* 父目录也不在根内/不存在：拒绝 */
      }
    }
  }
  return valid[0] ?? validMissing[0]
}
