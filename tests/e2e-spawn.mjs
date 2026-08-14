// 端到端模拟 spawnHost（无 vscode 依赖部分）：resolveDshCommand + overlay + spawn + probeBridgeHealth
// 用法：node tests/e2e-spawn.mjs <overlayPath> <port> <token> [DSH_HOME]
import { spawn } from 'node:child_process'
import { resolveDshCommand, probeBridgeHealth, waitUntil, pickFreePort, quoteCmdArg } from '../dist/host/hostUtils.js'

const [overlayPath, portArg, token] = process.argv.slice(2)
const port = Number(portArg)
const command = resolveDshCommand(undefined)
console.log('command:', JSON.stringify(command))
const args = [...command.prefix, 'web', '--patch', overlayPath, '--port', String(port)]
const spawnArgs = command.useShell ? args.map(quoteCmdArg) : args
const env = { ...process.env }
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE
console.log('spawn:', command.file, spawnArgs.join(' '))
const child = spawn(command.file, spawnArgs, {
  cwd: process.env.DSH_HOME ?? process.cwd(),
  shell: command.useShell,
  stdio: 'inherit',
  env,
  windowsHide: true,
})
let exitInfo = null
child.once('error', (error) => {
  exitInfo = `error: ${error}`
})
child.once('exit', (code, signal) => {
  exitInfo = `code=${code} signal=${signal}`
})
const url = `http://127.0.0.1:${port}`
const ready = await waitUntil(
  async () => {
    if (exitInfo !== null) throw new Error(`child exited: ${exitInfo}`)
    return probeBridgeHealth(url, token ?? '', 1500)
  },
  500,
  90_000
)
console.log(ready ? `READY ${url}` : 'TIMEOUT')
if (!ready) process.exitCode = 2
child.kill()
process.exit(ready ? 0 : 2)
