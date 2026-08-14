#!/usr/bin/env node
/**
 * DSH 会话日志检查 / 修复工具。
 *
 * 背景：DSH 的会话日志（~/.dsh/sessions/<项目>/<会话id>/session.jsonl.zstd）是
 * 追加式 JSONL（zstd 帧容器）。每个事件的 `seq` 必须是严格连续递增的全局序号。
 * 当两个 DSH host 进程（如浏览器实例 + 本扩展 spawn 的实例）并发写同一个会话
 * 时，它们可能各自读到相同尾部、分配相同的下一个 seq 并都追加，导致 committed
 * region 出现重复 seq —— 加载时报：
 *   corrupt session log: seq gap in committed region at line N (expected X, got Y)
 *
 * 本工具：
 *  1. 用与 DSH 官方读取器相同的逻辑扫描日志（zstd 帧扫描 + decodeStorageRecord），
 *     报告每个不一致的行（重复 / 乱序 / 缺失）。
 *  2. `--fix` 时：删除重复/乱序的行（保留每个 seq 的第一次出现），校验修复后
 *     完全连续，备份原文件后原子替换。
 *
 * 用法：
 *   node tools/session-log-check.mjs <会话目录或 .jsonl.zstd/.jsonl 文件>   # 只读诊断
 *   node tools/session-log-check.mjs <同上> --fix                          # 备份后修复
 *   node tools/session-log-check.mjs <同上> --fix --no-backup              # 不备份（不推荐）
 *
 * 修复前请先停止所有 DSH 实例（浏览器 dsh web、VSCode 扩展的 host、其他窗口），
 * 否则修复可能再次被并发写入破坏。
 */
import { readFileSync, writeFileSync, copyFileSync, renameSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'

// —— zstd 帧扫描（与 dsh-session-persistence-jsonl/lib/index.js scanZstdFrames 一致）——
const ZSTD_MAGIC = 4247762216
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = blockHeader >>> 1 & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/** 定位 @deepseek-ai/dsh-session（环境变量 DSH_SESSION_PKG 优先，其次 npx 缓存 / 全局 npm）。 */
function resolveSessionPkg() {
  if (process.env.DSH_SESSION_PKG && existsSync(process.env.DSH_SESSION_PKG)) return process.env.DSH_SESSION_PKG
  const candidates = []
  const localAppData = process.env.LOCALAPPDATA ?? ''
  if (localAppData !== '') {
    const npxRoot = join(localAppData, 'npm-cache', '_npx')
    try {
      for (const hash of readdirSync(npxRoot)) {
        candidates.push(join(npxRoot, hash, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js'))
      }
    } catch { /* ignore */ }
  }
  const appData = process.env.APPDATA ?? ''
  if (appData !== '') candidates.push(join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js'))
  return candidates.find((candidate) => existsSync(candidate))
}

function parseArgs(argv) {
  const args = { target: undefined, fix: false, backup: true, dumpSeq: undefined, dumpRange: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--fix') args.fix = true
    else if (arg === '--no-backup') args.backup = false
    else if (arg === '--dump-seq') args.dumpSeq = Number(argv[++i])
    else if (arg === '--dump-range') {
      const [from, to] = String(argv[++i]).split('-').map(Number)
      args.dumpRange = { from, to }
    } else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`)
    else if (args.target === undefined) args.target = arg
    else throw new Error(`多余参数：${arg}`)
  }
  if (args.target === undefined) throw new Error('用法：node tools/session-log-check.mjs <会话目录或日志文件> [--fix] [--dump-seq <n>] [--dump-range <a>-<b>] [--no-backup]')
  return args
}

function resolveArtifact(target) {
  let path = target
  if (existsSync(path) && statIsDir(path)) {
    const zstd = join(path, 'session.jsonl.zstd')
    const plain = join(path, 'session.jsonl')
    if (existsSync(zstd)) path = zstd
    else if (existsSync(plain)) path = plain
    else throw new Error(`目录中没有 session.jsonl.zstd / session.jsonl：${path}`)
  }
  const compressed = path.endsWith('.zstd')
  return { path, compressed }
}

function statIsDir(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

/** 读取原始字节并解出完整 JSONL 明文（忽略撕裂的尾部帧）。 */
function readPlaintext(path, compressed) {
  if (!compressed) return { plaintext: readFileSync(path, 'utf8'), tornBytes: 0, frameCount: 1 }
  const buffer = readFileSync(path)
  const { frames, tornStart } = scanZstdFrames(buffer)
  const chunks = []
  for (const frame of frames) chunks.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
  const tornBytes = tornStart === undefined ? 0 : buffer.length - tornStart
  return { plaintext: Buffer.concat(chunks).toString('utf8'), tornBytes, frameCount: frames.length }
}

function splitLines(plaintext) {
  const lines = plaintext.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 逐行扫描，模拟官方 SessionLogScanner：expected 为已接受事件数（seq 0 起）。
 * @returns { lines, headerLine, issues, dropped, tornTail }
 */
function scanEvents(lines, decode) {
  let expected = 0
  const issues = [] // { line, expected, got, raw, reason }
  const dropped = [] // 修复模式下计划删除的行号（1 起）
  const kept = [] // 修复后保留的行（不含头）
  let headerLine
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const line = lines[i]
    if (i === 0) {
      headerLine = line
      continue
    }
    let events
    try {
      events = decode(JSON.parse(line))
    } catch {
      issues.push({ line: lineNo, expected, got: undefined, reason: 'unparsable', raw: truncate(line) })
      dropped.push(lineNo)
      continue
    }
    const seqs = events.map((event) => event.seq)
    let consistent = seqs.length > 0 && seqs[0] === expected
    if (consistent) {
      for (let k = 1; k < seqs.length; k++) {
        if (seqs[k] !== seqs[k - 1] + 1) { consistent = false; break }
      }
    }
    if (consistent) {
      kept.push(line)
      expected += seqs.length
    } else {
      const first = seqs[0]
      const reason = first < expected
        ? `重复 seq（expected ${expected}，本行从 ${first} 开始）`
        : `缺失 seq（expected ${expected}，本行从 ${first} 开始）`
      issues.push({ line: lineNo, expected, got: first, reason, raw: truncate(line) })
      dropped.push(lineNo)
    }
  }
  return { headerLine, issues, dropped, kept, totalEvents: expected, totalLines: lines.length }
}

function truncate(text, max = 220) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function formatIssues(issues) {
  return issues.map((issue) =>
    `  line ${issue.line}: ${issue.reason}${issue.got !== undefined ? ` (got seq ${issue.got})` : ''}\n    ${issue.raw}`
  ).join('\n')
}

// —— 主流程 ——
const args = parseArgs(process.argv.slice(2))
const { path, compressed } = resolveArtifact(args.target)
const pkg = resolveSessionPkg()
if (pkg === undefined) {
  console.error('未找到 @deepseek-ai/dsh-session 包：设置环境变量 DSH_SESSION_PKG 指向其 lib/index.js')
  process.exit(2)
}
const { decodeStorageRecord } = await import(pathToFileURL(pkg).href)

console.log(`检查：${path}`)
const { plaintext, tornBytes, frameCount } = readPlaintext(path, compressed)
if (tornBytes > 0) console.log(`提示：文件尾部有 ${tornBytes} 字节未完成的 zstd 帧（撕裂的写尾，正常读取时会截断忽略）`)

const lines = splitLines(plaintext)
const { headerLine, issues, dropped, kept, totalEvents, totalLines } = scanEvents(lines, decodeStorageRecord)

console.log(`行数：${totalLines}（头 1 + 事件行 ${totalLines - 1}） 事件数：${totalEvents} 帧数：${frameCount}`)
if (headerLine === undefined) {
  console.error('错误：空文件或缺少头行')
  process.exit(1)
}

if (args.dumpSeq !== undefined) {
  console.log(`\n--dump-seq ${args.dumpSeq}：包含该 seq 的行：`)
  for (let i = 1; i < lines.length; i++) {
    let events
    try {
      events = decodeStorageRecord(JSON.parse(lines[i]))
    } catch {
      continue
    }
    if (events.some((event) => event.seq === args.dumpSeq)) {
      console.log(`  line ${i + 1}: ${truncate(lines[i], 600)}`)
    }
  }
}

if (args.dumpRange !== undefined) {
  console.log(`\n--dump-range ${args.dumpRange.from}-${args.dumpRange.to}：行号 → seq 范围 → 事件类型：`)
  for (let i = Math.max(1, args.dumpRange.from); i <= Math.min(lines.length - 1, args.dumpRange.to); i++) {
    let events
    try {
      events = decodeStorageRecord(JSON.parse(lines[i]))
    } catch {
      console.log(`  line ${i + 1}: <unparsable>`)
      continue
    }
    const seqs = events.map((event) => event.seq)
    const types = [...new Set(events.map((event) => event.type))].join(',')
    const first = events[0]
    const brief = first && first.type === 'assistant/message'
      ? ` text=${truncate(JSON.stringify(first.data?.message?.content?.[0]?.text ?? ''), 80)}`
      : first && first.type === 'user/message'
        ? ` text=${truncate(JSON.stringify(first.data?.message?.content?.[0]?.text ?? ''), 80)}`
        : ''
    console.log(`  line ${i + 1}: seq ${seqs.length === 1 ? seqs[0] : `${seqs[0]}..${seqs[seqs.length - 1]}`} [${types}]${brief}`)
  }
}

if (issues.length === 0) {
  console.log('✅ 日志 seq 完全连续，无损坏。')
  if (args.fix) console.log('无需修复。')
  process.exit(0)
}

console.log(`❌ 发现 ${issues.length} 个不一致行（seq 不连续）：`)
console.log(formatIssues(issues))
console.log(`修复方案：删除以上 ${dropped.length} 行（保留每个 seq 的第一次出现），其余内容原样保留。`)

if (!args.fix) {
  console.log('\n（只读诊断，未写任何文件。加 --fix 执行修复；修复前先停止所有 DSH 实例。）')
  process.exit(1)
}

// —— 修复 ——
if (args.backup) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${path}.bak-${stamp}`
  copyFileSync(path, backup)
  console.log(`已备份：${backup}`)
}

const repairedPlaintext = [headerLine, ...kept].join('\n') + '\n'
// 修复后自校验
const repairedLines = splitLines(repairedPlaintext)
const check = scanEvents(repairedLines, decodeStorageRecord)
if (check.issues.length > 0) {
  console.error('修复后日志仍有不一致，已中止写入（未改动原文件）：')
  console.error(formatIssues(check.issues))
  process.exit(1)
}
console.log(`修复后：${check.totalEvents} 个事件，seq 完全连续。`)

const finalPath = path
if (compressed) {
  const headerFrame = zstdCompressSync(headerLine + '\n')
  const eventFrame = zstdCompressSync([...kept].join('\n') + (kept.length > 0 ? '\n' : ''))
  const content = Buffer.concat([headerFrame, eventFrame])
  const tmp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, finalPath)
} else {
  const tmp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, repairedPlaintext)
  renameSync(tmp, finalPath)
}
console.log(`✅ 已写入修复后的日志：${finalPath}`)
console.log('请重启 DSH（浏览器 / 扩展）后再打开该会话。')
