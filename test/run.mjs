/**
 * Standalone checks for dsh-tweaks (no deps; runs outside a dsh profile).
 *
 *   node test/run.mjs
 *
 * Two harnesses mirroring dsh-model-info's tests:
 *   - host half: index.js evaluated in a vm with schemastery stubbed, so the
 *     pure helpers (isEnabled / describeTweaks / TWEAKS) run as-is;
 *   - browser half: lib/client.js evaluated against a fake __ModuleLoader__.
 */

import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import { homedir, hostname, tmpdir } from 'node:os'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const require_ = createRequire(import.meta.url)
function loadSchemastery() {
  const candidates = [
    join(root, 'node_modules', '@deepseek-ai', 'schemastery'),
    join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'schemastery'),
  ]
  for (const spec of candidates) {
    try { return require_(spec) } catch {}
  }
  return null
}
// 有真 schemastery 就用它（宿主半能按真 schema 构造），没有就退回空桩：
// 纯函数断言照样能跑，只有依赖 schema 求值的部分会退化。
const Schemastery = loadSchemastery()

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`)
  }
}
function ok(name, cond) {
  check(name, cond === true, true)
}

// ── host half ────────────────────────────────────────────────────────────
const hostSource = readFileSync(join(root, 'index.js'), 'utf8')
  .replace(
    /^import z from '@deepseek-ai\/schemastery'$/m,
    Schemastery ? 'const z = hostZ;' : 'const z = new Proxy(function () {}, { get: () => z, apply: () => z })',
  )
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')

const testIntervals = []
const hostCtx = {
  console,
  process,
  Buffer,
  AbortController,
  AbortSignal,
  setTimeout,
  clearTimeout,
  setInterval(fn, delay) {
    const timer = { fn, delay, cleared: false }
    testIntervals.push(timer)
    return timer
  },
  clearInterval(timer) {
    if (timer) timer.cleared = true
  },
  join,
  dirname,
  basename,
  homedir,
  hostname,
  mkdirSync,
  statSync,
  renameSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
  spawnSync,
  tmpdir,
  zstdDecompressSync,
  hostZ: Schemastery ? Schemastery.default || Schemastery : undefined,
  Promise,
  Symbol,
  Intl,
}
vm.createContext(hostCtx)
vm.runInContext(hostSource + '\n;globalThis.__host = { TWEAKS, isEnabled, describeTweaks, checkTarget, findEntry, disableEntry, restoreEntry, describeSubject, createSessionDiscovery, Config, statePath, readState, writeState, hostExecutable, restartHost, isDesktopShell, windowsDesktopHandoffScript, desktopHandoffLauncherScript, posixDesktopHandoffScript, windowsHandoffScript, posixHandoffScript, TUNING, tuningValue, describeTuning, getConfigPath, setConfigPath, applyConfigPatch, restoreConfigPatch, apply };', hostCtx)
const { TWEAKS, isEnabled, describeTweaks, checkTarget, findEntry, disableEntry, restoreEntry, describeSubject, createSessionDiscovery, Config, statePath, readState, writeState, hostExecutable, restartHost, isDesktopShell, windowsDesktopHandoffScript, desktopHandoffLauncherScript, posixDesktopHandoffScript, windowsHandoffScript, posixHandoffScript, TUNING, tuningValue, describeTuning, getConfigPath, setConfigPath, applyConfigPatch, restoreConfigPatch } = hostCtx.__host

console.log('TWEAKS registry:')
ok('is a non-empty frozen list', Array.isArray(TWEAKS) && TWEAKS.length > 0 && Object.isFrozen(TWEAKS))
ok('every tweak has id/title/why', TWEAKS.every((t) => t.id && t.title && t.why))
ok(
  'ids are unique',
  new Set(TWEAKS.map((t) => t.id)).size === TWEAKS.length,
)
{
  const slow = TWEAKS.find((t) => t.id === 'slowLinkTimeouts')
  ok('slowLinkTimeouts remains default-on', slow?.default === true)
  check('slowLinkTimeouts patches readiness only', slow?.configPatch, [
    { target: 'connection', path: 'recovery.generationReadyTimeoutMs', tuning: 'slowReadyTimeoutMs' },
  ])
}
ok('hideBuiltinDeepseek is registered', TWEAKS.some((t) => t.id === 'hideBuiltinDeepseek'))
ok('hideUnroutableModels is gone', !TWEAKS.some((t) => t.id === 'hideUnroutableModels'))
ok('fixTapWebPin is gone', !TWEAKS.some((t) => t.id === 'fixTapWebPin'))
ok('sidebarBalance is gone', !TWEAKS.some((t) => t.id === 'sidebarBalance'))
// 侧边栏底部布局修复：浏览器半类改动（无 target，靠 menu 进列表）。
{
  const t = TWEAKS.find((x) => x.id === 'sidebarFooterLayout')
  ok('sidebarFooterLayout is registered', Boolean(t))
  ok('sidebarFooterLayout has no loader target', t && !t.target)
  ok('sidebarFooterLayout reaches the list via menu', t && t.menu === true)
  ok('sidebarFooterLayout names what it fixes', t && typeof t.what === 'string' && t.what.includes('dsh-session-manager'))
  ok('sidebarFooterLayout why names the css conflict', t && t.why.includes('flex-direction:column') && t.why.includes('dshm-entry'))
  ok('sidebarFooterLayout says how to undo', t && t.why.includes('关掉'))
}
// 重启宿主：单主开关（是否启用）+ 位置多选（底部 / 右上角），menu 进列表、无 target。
{
  const t = TWEAKS.find((x) => x.id === 'restartButton')
  ok('restartButton is registered', Boolean(t))
  ok('restartButton has no loader target', t && !t.target)
  ok('restartButton reaches the list via menu', t && t.menu === true)
  ok('restartButton carries a restart action', t && t.action === 'restart')
  ok('restartButton acts on the host process', t && t.subject && t.subject.kind === 'host')
  const opts = (t && t.options) || []
  ok('restartButton offers three places as options', opts.length === 3 && opts[0].id === 'restartFooter' && opts[1].id === 'restartHeader' && opts[2].id === 'restartAgentTool')
  ok('restartButton options carry labels and notes', opts.length === 3 && opts.every((o) => typeof o.label === 'string' && typeof o.note === 'string'))
  ok('restartButton why names the handoff design', t && t.why.includes('交接'))
  ok('restartButton why explains auto-continue resume', t && t.why.includes('dsh-client-auto-continue'))
}
// 智能体工具（供智能体调用）：2026-11-16 从独立补丁行并入 restartButton 的位置选项，
// 与按钮同闸门、同交接流程；默认关（额外放开一条能退出宿主的通路要单独点开）。
{
  const t = TWEAKS.find((x) => x.id === 'restartButton')
  const opt = ((t && t.options) || []).find((o) => o.id === 'restartAgentTool')
  ok('restartAgentTool is an option of restartButton, not its own patch row', Boolean(opt) && !TWEAKS.some((x) => x.id === 'restartTool'))
  ok('restartAgentTool is off by default', opt && opt.defaultOff === true)
  ok('restartAgentTool carries a label and note', opt && typeof opt.label === 'string' && typeof opt.note === 'string')
  ok('restartButton why covers the agent tool', t && String(t.why || '').includes('restart_dsh'))
}
ok('apply() injects the tools service for restart_dsh', hostSource.includes("ctx.inject(['tools'], (toolCtx) =>"))
ok('apply() registers restart_dsh through tools.register', hostSource.includes('tools.register(defineRestartTool())'))
ok('restart tool registration is scoped and disposable', hostSource.includes("'dsh-tweaks:restart-tool'"))
ok('restart tool refuses when the policy gate is off', hostSource.includes('ERROR: 「允许重启宿主」总闸未打开'))
ok('restart tool gate needs the master switch too', hostSource.includes("isEnabled(switches, 'restartButton')") && hostSource.includes("isEnabled(switches, 'restartAgentTool')"))
ok('restart tool logs its reason to the restart log', hostSource.includes("' tool restart reason='"))
ok('restart history is recorded in source', hostSource.includes('从未发布'))

console.log('tweaks targets:')
check('hideBuiltinDeepseek targets the built-in provider', TWEAKS.find((t) => t.id === 'hideBuiltinDeepseek').target, 'llm-deepseek')
check('no tweak targets the settings models entry', TWEAKS.some((t) => t.target === 'ui-settings-models'), false)
// 改动形态分两类：Loader 条目类（有 target）与浏览器半类（menu，无 target）。
ok(
  'every tweak is either a loader target or an explicit menu entry',
  TWEAKS.every((t) => (typeof t.target === 'string' && t.target) || t.menu === true),
)
ok(
  'every tweak with no target declares menu (so it reaches the list)',
  TWEAKS.every((t) => t.target || t.menu === true),
)
ok('no tweak carries apply/restore (only entry-disabling tweaks remain)', TWEAKS.every((t) => typeof t.apply !== 'function' && typeof t.restore !== 'function'))

console.log('Config schema (基础设施参数；开关不进 Config):')
ok('Config is defined', typeof Config !== 'undefined')
// 关键：开关**不能**在 Config 里 —— 否则 settings.update 会触发条目热重载，
// 客户端分区被销毁重建（「点一下开关，内容消失」的根因）。
for (const t of TWEAKS) {
  ok(t.id + ' is NOT a Config field', !Config.dict?.[t.id])
}
// 基础设施参数仍在 Config，且都不带 volatile（避免被投影成第二个写入者）。
ok('statusRoute exists', Boolean(Config.dict?.statusRoute))
ok('sessionDiscoveryMs exists', Boolean(Config.dict?.sessionDiscoveryMs))
ok('sessionDiscoveryMs defaults to 15000', /sessionDiscoveryMs:\s*z\.number\(\)\.default\(15000\)/.test(hostSource))
ok('session discovery is wired through ctx.inject + ctx.effect', hostSource.includes("'sessionProjectionCache', 'sessions'") && hostSource.includes("'dsh-tweaks:session-discovery'"))
ok('session discovery emits the official upsert event', hostSource.includes("ctx.emit('api-session/added', summary)"))
ok('statusRoute is not volatile', Config.dict?.statusRoute?.meta?.volatile !== true)
ok('no volatile fields in Config at all', !Object.values(Config.dict || {}).some((f) => f?.meta?.volatile === true))
ok('no dataRetry (数据类改动已剥离)', !Config.dict?.dataRetry)
ok('no nested tweaks dict', !/tweaks:\s*z\.dict/.test(hostSource))
// 重启的**可调参数**已搬出 Config（2026-11-16 用户确认：不要为了改一个开关去手写
// profile patch 再重启）。它们和补丁开关同住状态文件，界面上直接给控件。
ok('allowRestart is NOT a Config field', !Config.dict?.allowRestart)
ok('restartDelayMs is NOT a Config field', !Config.dict?.restartDelayMs)
ok('restartTokenMs is NOT a Config field', !Config.dict?.restartTokenMs)
ok('restartToolCountdownMs is NOT a Config field', !Config.dict?.restartToolCountdownMs)
ok('no positiveInt(config?.restart…) fallback survives', !/positiveInt\(config\?\.restart/.test(hostSource))
ok('restart entries are NOT Config fields', !Config.dict?.restartButton && !Config.dict?.restartFooter && !Config.dict?.restartHeader && !Config.dict?.restartTool)

console.log('TUNING（状态文件里的可调参数）:')
ok('TUNING is exported and frozen', Object.isFrozen(TUNING) && TUNING.length === 5)
check('TUNING ids stay in order', TUNING.map((t) => t.id), ['allowRestart', 'restartDelayMs', 'restartTokenMs', 'restartToolCountdownMs', 'slowReadyTimeoutMs'])
ok('allowRestart is a boolean tuning defaulting off', TUNING[0].kind === 'boolean' && TUNING[0].default === false)
ok('the three restart durations are numbers with floors', TUNING.slice(1, 4).every((t) => t.kind === 'number' && typeof t.min === 'number'))
ok('the readiness duration is a number with a floor', TUNING[4].kind === 'number' && typeof TUNING[4].min === 'number')
ok('every tuning carries a label and a note', TUNING.every((t) => typeof t.label === 'string' && t.label && typeof t.note === 'string' && t.note))
check('tuningValue coerces booleans strictly', tuningValue({ allowRestart: 'yes' }, TUNING[0]), false)
check('tuningValue falls back when absent', tuningValue({}, TUNING[1]), 1000)
check('tuningValue clamps below the floor', tuningValue({ restartTokenMs: 1 }, TUNING[2]), 1000)
check('tuningValue rejects junk numbers', tuningValue({ restartDelayMs: 'abc' }, TUNING[1]), 1000)
const tuningShapes = describeTuning({ allowRestart: true, restartDelayMs: 0 })
check('describeTuning exposes the live value', tuningShapes.map((t) => t.value), [true, 0, 30000, 10000, 120000])
ok('describeTuning ships the control metadata', tuningShapes.every((t) => typeof t.id === 'string' && typeof t.kind === 'string' && 'min' in t))
check('describeTuning tags slow-link params to slowLinkTimeouts', tuningShapes.filter((t) => t.tweakId === 'slowLinkTimeouts').map((t) => t.id), ['slowReadyTimeoutMs'])
check('describeTuning tags restart params to restartButton', tuningShapes.filter((t) => t.tweakId === 'restartButton').map((t) => t.id), ['allowRestart', 'restartDelayMs', 'restartTokenMs', 'restartToolCountdownMs'])

console.log('配置值类纯 helper（getConfigPath / setConfigPath / applyConfigPatch / restoreConfigPatch）:')
check('getConfigPath reads a nested path', getConfigPath({ a: { b: { c: 7 } } }, 'a.b.c'), 7)
check('getConfigPath returns undefined for a missing segment', getConfigPath({ a: {} }, 'a.b.c'), undefined)
check('getConfigPath tolerates junk input', getConfigPath(null, 'a'), undefined)
{
  const orig = { a: { b: 1 }, keep: true }
  const out = setConfigPath(orig, 'a.b', 2)
  check('setConfigPath writes the leaf', getConfigPath(out, 'a.b'), 2)
  ok('setConfigPath does not mutate the input', orig.a.b === 1 && out.a !== orig.a)
  check('setConfigPath keeps sibling keys', out.keep, true)
}
{
  const orig = { a: { b: 1, c: 2 } }
  const out = setConfigPath(orig, 'a.b', undefined)
  ok('setConfigPath deletes the leaf on undefined', !('b' in out.a) && out.a.c === 2)
}
check('setConfigPath creates missing intermediate objects', getConfigPath(setConfigPath({}, 'a.b.c', 5), 'a.b.c'), 5)
{
  const mk = (id, config) => ({ options: { id, config }, update(next) { this.options = next; return Promise.resolve() } })
  const gateway = mk('typert-gateway', { websocketHeartbeatIntervalMs: 2000 })
  const conn = mk('connection', { trustedHosts: ['x'], recovery: { generationReadyTimeoutMs: 15000 } })
  const loader = { store: { 'typert-gateway': gateway, connection: conn }, entries: () => [gateway, conn] }
  const r = applyConfigPatch(loader, [
    { target: 'typert-gateway', path: 'websocketHeartbeatIntervalMs', value: 30000 },
    { target: 'connection', path: 'recovery.generationReadyTimeoutMs', value: 120000 },
    { target: 'ghost', path: 'x', value: 1 },
  ])
  check('applyConfigPatch writes values into entry config', [getConfigPath(gateway.options.config, 'websocketHeartbeatIntervalMs'), getConfigPath(conn.options.config, 'recovery.generationReadyTimeoutMs')], [30000, 120000])
  check('applyConfigPatch records before values', r.before.map((b) => b.value), [2000, 15000])
  check('applyConfigPatch reports changed', r.changed, true)
  check('applyConfigPatch reports a missing target', r.errors, ['target ghost is not in the loader tree'])
  const r2 = applyConfigPatch(loader, [{ target: 'typert-gateway', path: 'websocketHeartbeatIntervalMs', value: 30000 }])
  check('applyConfigPatch skips when already at target', { before: r2.before.length, changed: r2.changed }, { before: 0, changed: false })
}
{
  const mk = (id, config) => ({ options: { id, config }, update(next) { this.options = next; return Promise.resolve() } })
  const conn = mk('connection', { recovery: {} })
  const loader = { store: { connection: conn }, entries: () => [conn] }
  const applied = applyConfigPatch(loader, [{ target: 'connection', path: 'recovery.generationReadyTimeoutMs', value: 120000 }])
  check('applyConfigPatch sets a previously-absent key', getConfigPath(conn.options.config, 'recovery.generationReadyTimeoutMs'), 120000)
  restoreConfigPatch(loader, applied.before)
  ok('restoreConfigPatch deletes the leaf when it was previously absent', !('generationReadyTimeoutMs' in (conn.options.config.recovery || {})))
}

console.log('开关状态文件（切换不碰 Config/patch）:')
ok('statePath points into .cache', /statePath/.test(hostSource) && /\.cache['"],\s*'dsh-tweaks'/.test(hostSource))
ok('readState exists', /function readState/.test(hostSource))
ok('writeState exists', /function writeState/.test(hostSource))
ok('writeState uses atomic rename', /renameSync\(tmp, file\)/.test(hostSource))
// toggle 必须写状态文件 + 就地重跑，绝不调 settings.update。
ok('toggle writes the state file', /writeState\(undefined, next\)/.test(hostSource))
ok('toggle reconciles in place', /reconcileAll\(\)/.test(hostSource))
ok('toggle does NOT call settings.update', !/svc\.update\(name/.test(hostSource))
ok('toggle does NOT write cordis.patch.yml', !/writeFileSync\(file, after/.test(hostSource))
ok('reconcileAll disposes old effects first', /disposeTweak\(tweak\.id\)/.test(hostSource))

console.log('Config tunables (官方：无硬编码可调参数):')
ok('reassertLimit declared with default 10', /reassertLimit:\s*z\.number\(\)\.default\(10\)/.test(hostSource))
ok('fallbackReconcileMs defaults to 0 (event-driven, no polling)', /fallbackReconcileMs:\s*z\.number\(\)\.default\(0\)/.test(hostSource))
ok('statusRefreshMs declared with default', /statusRefreshMs:\s*z\.number\(\)\.default\(600000\)/.test(hostSource))
ok('statusRoute still defaults on', /statusRoute:\s*z\.boolean\(\)\.default\(true\)/.test(hostSource))
ok('apply() re-arms reassert/refresh from config, not literals', /positiveInt\(config\?\.reassertLimit, 10\)/.test(hostSource) && /nonNegativeInt\(config\?\.fallbackReconcileMs, 0\)/.test(hostSource))

console.log('restart plumbing (交接式重启):')
ok('apply() reads restart tunables from the state file, not config', hostSource.includes('function tuning(id)') && hostSource.includes("tuning('allowRestart')") && hostSource.includes('readTunables()'))
ok('reconcileAll re-reads the tunables before re-applying', /function reconcileAll\(\)\s*\{[\s\S]{0,200}readTunables\(\)/.test(hostSource))
{
  const saved = process.env.DSH_HOST_EXECUTABLE
  process.env.DSH_HOST_EXECUTABLE = join(root, 'index.js')
  ok('hostExecutable honors DSH_HOST_EXECUTABLE', hostExecutable() === join(root, 'index.js'))
  process.env.DSH_HOST_EXECUTABLE = join(root, 'no-such-file.exe')
  ok('hostExecutable skips missing candidates', hostExecutable() === process.execPath)
  if (saved === undefined) delete process.env.DSH_HOST_EXECUTABLE
  else process.env.DSH_HOST_EXECUTABLE = saved
}
{
  const script = windowsHandoffScript(4242, 'C:\\Program Files\\app.exe', ['--foo', "it's"])
  ok('windows script waits for the old process', script.includes('Wait-Process -Id 4242'))
  ok('windows script tolerates an exited pid', script.includes('-ErrorAction SilentlyContinue'))
  ok('windows script starts the same exe', script.includes("Start-Process -FilePath 'C:\\Program Files\\app.exe'"))
  ok('windows script passes argv with escaping', script.includes("-ArgumentList '--foo' 'it''s'"))
}
{
  const script = posixHandoffScript(4242, '/usr/bin/app', ['--foo', "it's"])
  ok('posix script waits for the old process', script.includes('while kill -0 4242 2>/dev/null'))
  ok('posix script execs the same exe with escaping', script.includes("exec '/usr/bin/app' '--foo' 'it'\\''s'"))
}
{
  ok(
    'desktop shell detection needs ipc + ELECTRON_RUN_AS_NODE',
    isDesktopShell({ ELECTRON_RUN_AS_NODE: '1' }, true, () => {}) === true
      && isDesktopShell({}, true, () => {}) === false
      && isDesktopShell({ ELECTRON_RUN_AS_NODE: '1' }, true, undefined) === false,
  )
}
{
  const script = windowsDesktopHandoffScript(4321, 999, 'C:\\Program Files\\app.exe')
  ok('desktop windows script kills the shell first', script.includes('GetProcessById(999).Kill()'))
  ok('desktop windows script waits for the host to fall', script.includes('Wait-Process -Id 4321 -Timeout 30'))
  ok('desktop windows script force-stops the host as fallback', script.includes('Stop-Process -Id 4321 -Force'))
  ok('desktop windows script delays the relaunch', script.includes('Start-Sleep -Milliseconds 1200'))
  ok('desktop windows script waits a second before handing over', script.includes('delay done') && script.includes('Start-Sleep -Milliseconds 1000'))
  ok('desktop windows script retries the relaunch', script.includes('relaunch try'))
  ok('desktop windows script logs its steps', script.includes("dsh-tweaks-restart.log"))
  // 2026-11-17：不再伪造 WM_QUERYENDSESSION / WM_ENDSESSION。
  // 原因：平台主进程只有 finishQuit() 会执行 tray.dispose()，而走到它需要
  // sessionEnding 被置位（只有真注销/真会话结束才会触发），伪造消息置不了；
  // 结果就是窗口缩进托盘、进程被强杀、托盘留下一枚 ghost 图标。
  // 现在的做法：宿主自己优雅退出，主进程走平台恢复流程（app.relaunch → finishQuit）。
  ok('desktop windows script does NOT spoof WM_ENDSESSION', !script.includes('0x0011') && !script.includes('0x0016') && !script.includes('PostMessage'))
  ok('desktop windows script leaves the main process to the platform recovery path', script.includes('main still alive') && script.includes('main already gone'))
  ok('desktop windows script reopens the app via WMI without host argv', script.includes('Invoke-CimMethod -ClassName Win32_Process') && script.includes('C:\\Program Files\\app.exe') && !script.includes('-ArgumentList'))
}
{
  const launch = desktopHandoffLauncherScript('C:\\Temp\\dsh-tweaks-handoff-1.ps1')
  ok('desktop launcher starts the script via WMI (detached from the DSH tree)', launch.includes('Invoke-CimMethod -ClassName Win32_Process') && launch.includes('-File "C:\\Temp\\dsh-tweaks-handoff-1.ps1"'))
  ok('desktop launcher runs the script in a hidden window', launch.includes('-WindowStyle Hidden'))
}
{
  const script = posixDesktopHandoffScript(4321, 999, '/usr/bin/app', 2000)
  ok('desktop posix script kills the shell then the host', script.includes('kill -9 999') && script.includes('kill -9 4321'))
  ok('desktop posix script delays the reopen', script.includes('sleep 2'))
  ok('desktop posix script reopens the app', script.includes("exec '/usr/bin/app'"))
}
{
  const spawned = []
  const exits = []
  const result = await restartHost({
    delayMs: 5,
    spawnHost: (cmd, args, opts) => {
      spawned.push({ cmd, args, opts })
      return { unref() {} }
    },
    exit: (code) => {
      exits.push(code)
    },
  })
  ok('restartHost exits cleanly with code 0', exits.join(',') === '0')
  ok('restartHost reports ok + executable + delayMs', result.ok === true && result.executable === process.execPath && result.delayMs === 5)
  ok('restartHost spawns exactly one helper', spawned.length === 1)
  if (spawned.length === 1) {
    const { cmd, args, opts } = spawned[0]
    if (process.platform === 'win32') {
      ok('windows helper is powershell -EncodedCommand', cmd === 'powershell.exe' && args[0] === '-NoProfile' && args.includes('-EncodedCommand'))
      const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le')
      ok('windows helper waits for this process then restarts it', script.includes(`Wait-Process -Id ${process.pid}`) && script.includes('Start-Process -FilePath'))
      ok('windows helper is hidden but not detached (detached powershell silently no-ops)', opts.detached !== true && opts.windowsHide === true && opts.stdio === 'ignore')
    } else {
      ok('posix helper is /bin/sh -c', cmd === '/bin/sh' && args[0] === '-c' && args[1].includes(`kill -0 ${process.pid}`))
      ok('posix helper is detached', opts.detached === true && opts.stdio === 'ignore')
    }
  }
}
{
  const exits = []
  const result = await restartHost({
    delayMs: 5,
    spawnHost: () => {
      throw new Error('boom')
    },
    exit: (code) => {
      exits.push(code)
    },
  })
  ok('restartHost reports helper failure without exiting', result.ok === false && /启动交接 helper 失败/.test(result.error) && exits.length === 0)
}
{
  const launches = []
  const scripts = []
  const exits = []
  const graceful = []
  const result = await restartHost({
    delayMs: 5,
    desktop: true,
    parentPid: 4321,
    pid: 1234,
    spawnSyncHost: (cmd, args, opts) => {
      launches.push({ cmd, args, opts })
      return { status: 0 }
    },
    writeScript: (path, content) => {
      scripts.push({ path, content })
    },
    spawnHost: () => {
      throw new Error('desktop restart must not spawn a tracked child')
    },
    exit: (code) => {
      exits.push(code)
    },
    gracefulExit: (code) => {
      graceful.push(code)
    },
  })
  ok('desktop restartHost never exits the host itself', exits.length === 0 && result.ok === true && result.desktop === true)
  // 2026-11-17：桌面版改成「宿主自己优雅退出」（见 windowsDesktopHandoffScript 的长注释）。
  ok('desktop restartHost asks the host to exit gracefully', graceful.join(',') === '0')
  ok('desktop restartHost writes the handoff script file', scripts.length === 1 && /dsh-tweaks-handoff-1234-/.test(scripts[0].path) && scripts[0].content.includes('dsh-tweaks-restart.log') && scripts[0].content.startsWith('\ufeff'))
  // 延迟用的是传入的 delayMs（本用例传 5 毫秒只为跑得快），断言跟着走。
  ok('desktop handoff script keeps the helper-first delay', scripts.length === 1 && scripts[0].content.includes('delay done') && scripts[0].content.includes('Start-Sleep -Milliseconds 5'))
  if (process.platform === 'win32') {
    ok('desktop restartHost launches the helper via WMI (spawnSync, not a child)', launches.length === 1 && launches[0].cmd === 'powershell.exe' && launches[0].args.includes('-EncodedCommand'))
    const launch = Buffer.from(launches[0].args[launches[0].args.length - 1], 'base64').toString('utf16le')
    ok('WMI launcher runs the handoff script file', launch.includes('Win32_Process') && launch.includes('-File "') && launch.includes('dsh-tweaks-handoff-1234-'))
  }
}
{
  const exits = []
  const graceful = []
  const result = await restartHost({
    delayMs: 5,
    desktop: true,
    parentPid: 0,
    spawnHost: () => ({ unref() {} }),
    exit: (code) => {
      exits.push(code)
    },
    gracefulExit: (code) => {
      graceful.push(code)
    },
  })
  // 没有可用的 parent pid → 不走桌面交接（helper 会去杀一个不存在的 pid），
  // 退回网页版那套：helper 起来后本进程干净退出。
  ok('desktop restartHost falls back to a plain exit without a usable parent pid', exits.join(',') === '0' && result.ok === true)
}
ok('windows restart spawn is not detached (detached powershell silently exits 0)', hostSource.includes("{ stdio: 'ignore', windowsHide: true }") && !hostSource.includes('{ detached: true, stdio: \'ignore\', windowsHide: true }'))
ok('restart plumbing carries no debug probe leftovers', !hostSource.includes('__dtwProbe'))

// 路由：两段式 + 双闸门（源码形态；真路由行为由装后验证覆盖）。
ok('restart route is registered', hostSource.includes('path: `${ROUTE_PREFIX}/restart`'))
ok('route gate 1 is allowRestart (403)', hostSource.includes('「允许重启宿主」总闸未打开'))
ok('route gate 2 requires the restartButton switch', hostSource.includes("isEnabled(switches, 'restartButton')"))
ok('route grants a one-time expiring token', hostSource.includes("randomBytes(18).toString('base64url')") && hostSource.includes('restartTokens.set(token, Date.now() + restartTokenMs)'))
ok('token store is capped', /restartTokens\.size > \d+/.test(hostSource))
ok('route burns the token then checks expiry', hostSource.includes('restartTokens.delete(body.token)') && hostSource.includes('Date.now() > expiry'))
ok('route rejects unknown/expired tokens', hostSource.includes('令牌无效或已被用过') && hostSource.includes('令牌已过期'))
ok('response flushes before the host exits', hostSource.indexOf("stage: 'restarting'") > -1 && hostSource.indexOf("stage: 'restarting'") < hostSource.lastIndexOf('void restartHost('))
ok('route effect is named', hostSource.includes("'dsh-tweaks:restart-route'"))
ok('tool countdown routes are registered', hostSource.includes('/restart/pending') && hostSource.includes('/restart/cancel') && hostSource.includes("'dsh-tweaks:restart-pending-route'") && hostSource.includes("'dsh-tweaks:restart-cancel-route'"))
ok('tool countdown machinery exists', hostSource.includes('function scheduleToolRestart(') && hostSource.includes('function cancelPendingRestart(') && hostSource.includes('function waitForPendingRestart(') && hostSource.includes('pendingWaiters'))
ok('restart tool starts a countdown instead of restarting immediately', hostSource.includes('scheduleToolRestart(String((args && args.reason)') && !hostSource.includes("setTimeout(() => { void restartHost({ delayMs: restartDelayMs }) }, 1000)"))
ok('status rows carry actionReady only for restart', hostSource.includes("const ready = isRestart ? allowRestart && enabled : undefined"))
ok('the config gate is gone: both gates live in the UI now', !hostSource.includes("gate.reason === 'policy'") && !hostSource.includes('actionFix:'))
ok('restart gate points at the on-card control', hostSource.includes('把本卡片里的「允许重启宿主」勾上'))
ok('status ships the tuning controls down to the UI', hostSource.includes('tuning: describeTuning(switches)'))
ok('toggle accepts tuning ids, not only patch ids', hostSource.includes('const spec = TUNING.find((t) => t.id === body.id)') && hostSource.includes('tuningValue({ [spec.id]: body.value ?? body.enabled }, spec)'))
ok('toggle answers with the normalized value', hostSource.includes('{ ok: true, id: body.id, value, enabled: value === true }'))
ok('gate message tells the user what to do, not just the flag name', hostSource.includes('把本卡片里的「允许重启宿主」勾上，勾完即可用') && hostSource.includes('把「重启宿主」这一行的勾选打开'))
ok('status config exposes the desktop flag', hostSource.includes('desktop: isDesktopShell()'))

console.log('event-driven reconcile (no polling):')
ok('reconcile listens to app-boot/config-reload', hostSource.includes("ctx.on('app-boot/config-reload'"))
ok('reconcile listens to plugin-manager/changed', hostSource.includes("ctx.on('plugin-manager/changed'"))
ok('no unconditional 3s polling', !/setInterval\(tick,\s*3000\)/.test(hostSource))
ok('fallback interval is opt-in via config', /fallbackMs > 0 \? setInterval/.test(hostSource))
ok('no hardcoded reassert ceiling', !/reasserts >= 10/.test(hostSource))

console.log('toggle route（写状态文件 + 就地重跑，不触发条目重载）:')
ok('toggle route exists', hostSource.includes('${ROUTE_PREFIX}/toggle'))
ok('no YAML import', !/^import YAML/m.test(hostSource))
ok('no settings dependency for toggling', !/ctx\.inject\(\['settings'\]/.test(hostSource))
ok('no /balance route (sidebarBalance 已剥离)', !hostSource.includes('${ROUTE_PREFIX}/balance'))
ok('no deepseekAccount usage', !/deepseekAccount/.test(hostSource))
ok('no dsh-tap references', !/dsh-tap/.test(hostSource))
ok('no webPin patch leftovers', !/TAP_WEBPIN/.test(hostSource) && !/patchTapWebPin/.test(hostSource))

console.log('loader reconciliation:')
const fakeEntry = {
  options: { id: 'llm-deepseek' },
  disabled: false,
  update(next) {
    this.options = next
    this.disabled = next.disabled === true
    return Promise.resolve()
  },
}
const fakeLoader = { store: { 'llm-deepseek': fakeEntry }, *entries() { yield fakeEntry } }
ok('findEntry resolves by store id', findEntry(fakeLoader, 'llm-deepseek') === fakeEntry)
check('findEntry returns undefined for unknown id', findEntry(fakeLoader, 'nope'), undefined)
const plan = disableEntry(fakeEntry)
check('disableEntry remembers the previous value', plan.before, undefined)
ok('disableEntry actually disables the entry', fakeEntry.disabled === true)
restoreEntry(fakeEntry, plan.before)
ok('restoreEntry re-enables the entry', fakeEntry.disabled !== true)
const again = disableEntry(fakeEntry)
ok('disableEntry is idempotent', again.changed === true && disableEntry(fakeEntry).changed === false)
ok('status route injects webServer, not a phantom server service', hostSource.includes("ctx.inject(['webServer']") && !hostSource.includes("['server']"))

console.log('registry metadata (每条都要说清「生效对象」):')
ok(
  'every tweak declares subject.kind',
  TWEAKS.every((t) => t.subject && typeof t.subject.kind === 'string' && t.subject.kind),
)
ok(
  'every tweak declares subject.label',
  TWEAKS.every((t) => t.subject && typeof t.subject.label === 'string' && t.subject.label),
)
ok(
  'every tweak declares what (一句话描述)',
  TWEAKS.every((t) => typeof t.what === 'string' && t.what),
)
ok(
  'every tweak declares effect + appliesWhen',
  TWEAKS.every((t) => typeof t.effect === 'string' && t.effect && typeof t.appliesWhen === 'string' && t.appliesWhen),
)
ok(
  'subject kinds are from the known set',
  TWEAKS.every((t) => ['entry', 'plugin', 'file', 'host'].includes(t.subject.kind)),
)
check('hideBuiltinDeepseek acts on a loader entry', TWEAKS.find((t) => t.id === 'hideBuiltinDeepseek').subject.kind, 'entry')
// 边界：没配 DeepSeek API key 时 dsh 自己就把该路由排除出模型目录，本开关只剩
// 「连 Models 设置页那一行一起藏掉」这一个差别。这段依据必须留在 why / appliesWhen 里，
// 否则半年后看到它，会误以为它在无 key 机器上也是必需的。
{
  const t = TWEAKS.find((x) => x.id === 'hideBuiltinDeepseek')
  ok('why states the API-key precondition', t.why.includes('DeepSeek API key') && t.why.includes('没有 key'))
  ok('why contrasts the two hiding surfaces', t.why.includes('模型选择器') && t.why.includes('设置页'))
  ok('appliesWhen names the precondition too', t.appliesWhen.includes('API key'))
}

console.log('describeSubject (对象状态):')
const entryTweak = TWEAKS.find((t) => t.id === 'hideBuiltinDeepseek')
check('disabled entry -> disabled', describeSubject(entryTweak, { disabled: true }, true, { ok: true }).status, 'disabled')
check('present entry not yet disabled -> pending', describeSubject(entryTweak, { disabled: false }, true, { ok: true }).status, 'pending')
check('absent entry -> missing', describeSubject(entryTweak, undefined, true, { ok: true }).status, 'missing')
check('switch off -> idle', describeSubject(entryTweak, { disabled: true }, false, undefined).status, 'idle')
check('apply error -> mismatch', describeSubject(entryTweak, { disabled: true }, true, { ok: false, error: 'boom' }).status, 'mismatch')
ok('missing carries a human reason', describeSubject(entryTweak, undefined, true, { ok: true }).label.includes('Loader'))
// 浏览器半类改动（无 target）不能被误报成「条目缺失」。
{
  const menuTweak = TWEAKS.find((t) => t.id === 'sidebarFooterLayout')
  check('menu tweak on -> ready (not missing)', describeSubject(menuTweak, undefined, true, { ok: true }).status, 'ready')
  check('menu tweak off -> idle', describeSubject(menuTweak, undefined, false, undefined).status, 'idle')
  check('menu tweak error -> mismatch', describeSubject(menuTweak, undefined, true, { ok: false, error: 'boom' }).status, 'mismatch')
}

console.log('isEnabled (state[ id ] === true):')
check('unknown state -> false', isEnabled({}, 'hideBuiltinDeepseek'), false)
check('explicit false -> false', isEnabled({ hideBuiltinDeepseek: false }, 'hideBuiltinDeepseek'), false)
check('explicit true -> true', isEnabled({ hideBuiltinDeepseek: true }, 'hideBuiltinDeepseek'), true)
check('truthy non-boolean is not enough', isEnabled({ hideBuiltinDeepseek: 'yes' }, 'hideBuiltinDeepseek'), false)
check('null state -> false', isEnabled(null, 'hideBuiltinDeepseek'), false)

console.log('readState / writeState（状态文件读写）:')
{
  const tmpHome = join(root, 'test', 'tmp-state-home')
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
  const allOff = () => Object.assign({}, Object.fromEntries(TWEAKS.map((t) => [t.id, t.default === true])), Object.fromEntries(TUNING.map((t) => [t.id, t.default])))
  check('missing file -> defaults (default-ON honoured) + tuning defaults', readState(tmpHome), allOff())
  const next = { ...Object.fromEntries(TWEAKS.map((t) => [t.id, false])), restartFooter: false, restartHeader: false, hideBuiltinDeepseek: true }
  ok('writeState succeeds', writeState(tmpHome, next) === true)
  // 键序跟着 readState 的产出走：补丁 → 位置选项 → 可调参数。
  check('readState round-trips', readState(tmpHome), {
    slowLinkTimeouts: false,
    hideBuiltinDeepseek: true,
    sidebarFooterLayout: false,
    restartButton: false,
    restartFooter: false,
    restartHeader: false,
    restartAgentTool: false,
    allowRestart: false,
    restartDelayMs: 1000,
    restartTokenMs: 30000,
    restartToolCountdownMs: 10000,
    slowReadyTimeoutMs: 120000,
  })
  ok('state file is under .cache/dsh-tweaks', readFileSync(statePath(tmpHome), 'utf8').includes('hideBuiltinDeepseek'))
  // 旧版单开关迁移：位置键缺省时跟随主开关（显式值优先）。
  writeFileSync(statePath(tmpHome), JSON.stringify({ restartButton: true }), 'utf8')
  const migrated = readState(tmpHome)
  check('legacy master migrates to every place', { master: migrated.restartButton, footer: migrated.restartFooter, header: migrated.restartHeader }, { master: true, footer: true, header: true })
  check('legacy master does NOT turn on the agent tool (it stays opt-in)', migrated.restartAgentTool, false)
  check('old restartTool key migrates into the agent-tool option', (function () {
    writeFileSync(statePath(tmpHome), JSON.stringify({ restartButton: true, restartTool: true }), 'utf8')
    return readState(tmpHome).restartAgentTool
  })(), true)
  writeFileSync(statePath(tmpHome), JSON.stringify({ restartButton: true, restartFooter: false, restartHeader: true }), 'utf8')
  const explicit = readState(tmpHome)
  check('explicit place switches win over the master fallback', { footer: explicit.restartFooter, header: explicit.restartHeader }, { footer: false, header: true })

  // 损坏文件不抛、当全关
  writeFileSync(statePath(tmpHome), 'not json', 'utf8')
  check('corrupt file -> defaults (no throw)', readState(tmpHome), allOff())
  // 迁移只认开关键，绝不把旧值当成可调参数；缺失的参数一律回默认。
  check('legacy file without tuning gets the defaults', (function () {
    writeFileSync(statePath(tmpHome), JSON.stringify({ hideBuiltinDeepseek: true }), 'utf8')
    const s = readState(tmpHome)
    return [s.allowRestart, s.restartDelayMs, s.restartTokenMs, s.restartToolCountdownMs]
  })(), [false, 1000, 30000, 10000])
  check('tuning values survive a round trip', (function () {
    writeFileSync(statePath(tmpHome), JSON.stringify({ allowRestart: true, restartDelayMs: 0 }), 'utf8')
    const s = readState(tmpHome)
    return [s.allowRestart, s.restartDelayMs, s.restartTokenMs]
  })(), [true, 0, 30000])
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
}

console.log('describeTweaks:')
const described = describeTweaks({ hideBuiltinDeepseek: true }, new Map())
check('one row per tweak', described.length, TWEAKS.length)
const row = described.find((r) => r.id === 'hideBuiltinDeepseek')
ok('reflects enabled flag', row.enabled === true)
ok('reports applied=false when not applied', row.applied === false)
const withError = describeTweaks({}, new Map([['hideBuiltinDeepseek', { ok: false, error: 'boom' }]]))
ok('surfaces apply error', withError.find((r) => r.id === 'hideBuiltinDeepseek').error === 'boom')

console.log('checkTarget:')
check('no target -> ok', checkTarget(null, []).ok, true)
check('no target -> present null', checkTarget(null, []).present, null)
check('no tree -> ok (unverifiable is not a failure)', checkTarget('x', null).ok, true)
check('no tree -> present null', checkTarget('x', null).present, null)
check('target found by id', checkTarget('llm-deepseek', [{ id: 'llm-deepseek' }]).present, true)
check('target found by name', checkTarget('pkg', [{ name: 'pkg' }]).present, true)
check('target missing -> not ok', checkTarget('gone', [{ id: 'other' }]).ok, false)
check('target missing -> present false', checkTarget('gone', [{ id: 'other' }]).present, false)
ok('target missing -> reason names the target', checkTarget('gone', []).reason.includes('gone'))

console.log('session discovery (cold sync + API upsert):')
{
  const now = Date.now()
  const visibleHeader = { id: 'existing-visible', createdAt: now - 3600000, cwd: 'C:\\\\workspace', isSeeded: false }
  const staleHeader = { id: 'existing-stale', createdAt: now - 3600000, cwd: 'C:\\\\workspace', isSeeded: false }
  // 同步在 DSH 关着时到手、快照里连 eventCount 都没有的会话：只靠「blank 且被藏起来」就该被修。
  const hiddenHeader = { id: 'existing-hidden', createdAt: now - 7200000, cwd: 'C:\\\\workspace', isSeeded: false }
  let snapshots = [
    { header: visibleHeader, revision: 'v1', eventCount: 20 },
    { header: staleHeader, revision: 's1', eventCount: 20 },
    { header: hiddenHeader, revision: 'h1' },
  ]
  const summaryById = new Map([
    ['existing-visible', { sessionId: 'existing-visible', blank: false, cwd: visibleHeader.cwd }],
    ['existing-stale', { sessionId: 'existing-stale', blank: true, cwd: staleHeader.cwd }],
    ['existing-hidden', { sessionId: 'existing-hidden', blank: true, cwd: hiddenHeader.cwd }],
  ])
  const headerById = new Map([
    ['existing-visible', visibleHeader],
    ['existing-stale', staleHeader],
    ['existing-hidden', hiddenHeader],
  ])
  const eventsById = new Map([
    ['existing-visible', [{ type: 'user/message', seq: 1 }]],
    ['existing-stale', [{ type: 'user/message', seq: 1 }]],
    ['existing-hidden', [{ type: 'user/message', seq: 1 }]],
  ])
  const readAttempts = new Map()
  const listSignals = []
  const failReadRemaining = new Map([['remote-new', 1]])
  const liveIds = new Set()
  const emitted = []
  const coldCalls = []
  const workspace = {
    path: visibleHeader.cwd,
    sessionIds: [],
    async attachSession(id) { this.sessionIds.push(id) },
  }
  const discoveryCtx = {
    sessionPersistence: { async list(options) { ok('list receives cancellation signal', options?.signal instanceof AbortSignal); return snapshots.slice() } },
    workspaceRegistry: { async resolveByPath(path) { check('resolveByPath uses session cwd', path, workspace.path); return workspace } },
    sessionController: { async list(request, signal) { listSignals.push(signal); ok('controller list is read-only request', JSON.stringify(request) === '{}'); ok('controller list receives cancellation signal', signal instanceof AbortSignal); return { items: [...summaryById.values()] } } },
    sessionQuery: {
      async readSession(id) {
        readAttempts.set(id, (readAttempts.get(id) || 0) + 1)
        const remaining = failReadRemaining.get(id) || 0
        if (remaining > 0) {
          failReadRemaining.set(id, remaining - 1)
          throw new Error('partial sync')
        }
        return { session: headerById.get(id), inheritedEventCount: 0, events: eventsById.get(id) || [] }
      },
    },
    sessionProjectionCache: {
      coldSnapshot(header, inheritedEventCount, events) {
        coldCalls.push({ id: header.id, inheritedEventCount, eventCount: events.length })
        const callCount = coldCalls.filter((call) => call.id === header.id).length
        const blank = events.length === 0
        if (header.id !== 'remote-delayed-cache' || callCount > 1) {
          summaryById.set(header.id, { sessionId: header.id, cwd: header.cwd, blank, running: false, agentAvailable: false })
        }
        return { values: { sessionListMetadata: { blank } } }
      },
    },
    sessions: { get(id) { return liveIds.has(id) ? { id } : undefined } },
    emit(event, summary) { emitted.push({ event, summary }) },
    logger: { warn() {} },
  }
  const discovery = createSessionDiscovery(discoveryCtx, 1000)
  await discovery.scan()
  check('interval uses configured delay', testIntervals[testIntervals.length - 1].delay, 1000)
  check('baseline visible log is not replayed', readAttempts.get('existing-visible') || 0, 0)
  check('stale nonblank cache is rebuilt on baseline', readAttempts.get('existing-stale'), 1)
  check('hidden blank row is rebuilt on baseline even without eventCount', readAttempts.get('existing-hidden'), 1)
  check('stale cache is pushed as visible summary', emitted.map((x) => x.summary.sessionId), ['existing-stale', 'existing-hidden'])

  const remoteHeader = { id: 'remote-new', createdAt: Date.now(), cwd: workspace.path, isSeeded: false }
  headerById.set(remoteHeader.id, remoteHeader)
  eventsById.set(remoteHeader.id, [{ type: 'user/message', seq: 1 }])
  summaryById.set(remoteHeader.id, { sessionId: remoteHeader.id, blank: true, cwd: remoteHeader.cwd })
  snapshots.push({ header: remoteHeader, revision: 'r1', eventCount: 6 })
  await discovery.scan()
  check('partial sync failure is retried, not emitted', emitted.length, 2)
  await discovery.scan()
  check('new session is reread after same-revision failure', readAttempts.get(remoteHeader.id), 2)
  check('new session attaches to owning workspace', workspace.sessionIds.includes(remoteHeader.id), true)
  check('new session is emitted through api-session/added', emitted.at(-1)?.event, 'api-session/added')
  check('new session row is upserted', emitted.at(-1)?.summary.sessionId, remoteHeader.id)

  snapshots = snapshots.map((s) => s.header.id === remoteHeader.id ? { ...s, revision: 'r2', eventCount: 7 } : s)
  eventsById.set(remoteHeader.id, [...eventsById.get(remoteHeader.id), { type: 'assistant/message', seq: 2 }])
  await discovery.scan()
  check('changed revision refreshes the row', emitted.filter((x) => x.summary.sessionId === remoteHeader.id).length, 2)

  const delayedHeader = { id: 'remote-delayed-cache', createdAt: Date.now(), cwd: workspace.path, isSeeded: false }
  headerById.set(delayedHeader.id, delayedHeader)
  eventsById.set(delayedHeader.id, [{ type: 'user/message', seq: 1 }])
  summaryById.set(delayedHeader.id, { sessionId: delayedHeader.id, blank: true, cwd: delayedHeader.cwd })
  snapshots.push({ header: delayedHeader, revision: 'd1', eventCount: 6 })
  const emittedBeforeDelayed = emitted.length
  await discovery.scan()
  check('async cache-write race stays pending', emitted.length, emittedBeforeDelayed)
  await discovery.scan()
  check('same revision retries after cold cache write', readAttempts.get(delayedHeader.id), 2)
  check('async cache-write race eventually emits', emitted.at(-1)?.summary.sessionId, delayedHeader.id)

  const blankHeader = { id: 'remote-blank', createdAt: Date.now(), cwd: workspace.path, isSeeded: false }
  headerById.set(blankHeader.id, blankHeader)
  eventsById.set(blankHeader.id, [])
  summaryById.set(blankHeader.id, { sessionId: blankHeader.id, blank: true, cwd: blankHeader.cwd })
  snapshots.push({ header: blankHeader, revision: 'b1', eventCount: 3 })
  await discovery.scan()
  check('empty blank session stays hidden', emitted.some((x) => x.summary.sessionId === blankHeader.id), false)

  const childHeader = { id: 'subagent-child', createdAt: Date.now(), cwd: workspace.path, origin: 'subagent', isSeeded: false }
  const localHeader = { id: 'local-live', createdAt: Date.now(), cwd: workspace.path, isSeeded: false }
  headerById.set(childHeader.id, childHeader)
  headerById.set(localHeader.id, localHeader)
  liveIds.add(localHeader.id)
  snapshots.push({ header: childHeader, revision: 'c1', eventCount: 10 }, { header: localHeader, revision: 'l1', eventCount: 10 })
  await discovery.scan()
  check('subagent is not read or emitted', readAttempts.get(childHeader.id) || 0, 0)
  check('local live session stays on the native live path', readAttempts.get(localHeader.id) || 0, 0)

  // 消失了怎么办：别的机器归档/删掉会话后，本机宿主没有任何生命周期事件
  // （session/disposed 只认本进程）。所以我们推上去过的行，得由我们撤下来。
  // 两轮确认：对端删除后同步有延迟，单轮缺席可能只是半份文件还在路上。
  const removalsOf = (id) => emitted.filter((x) => x.event === 'api-session/removed' && x.summary === id).length
  snapshots = snapshots.filter((s) => s.header.id !== remoteHeader.id)
  await discovery.scan()
  check('first missing round does not retract the row yet', removalsOf(remoteHeader.id), 0)
  await discovery.scan()
  check('second missing round retracts the advertised row', removalsOf(remoteHeader.id), 1)
  check('retraction carries the session id', emitted.at(-1)?.event, 'api-session/removed')
  await discovery.scan()
  check('a retracted row is not retracted twice', removalsOf(remoteHeader.id), 1)

  // 反向：从没被我们推上去过的会话（子代理自己消失）不归我们撤。
  snapshots = snapshots.filter((s) => s.header.id !== childHeader.id)
  await discovery.scan()
  await discovery.scan()
  check('a session we never advertised is not retracted', removalsOf(childHeader.id), 0)

  // 缺席后又回来（对端只是暂时写坏 / 重新同步到位）：计数要归零，行不能丢。
  snapshots.push({ header: remoteHeader, revision: 'r3', eventCount: 8 })
  summaryById.set(remoteHeader.id, { sessionId: remoteHeader.id, blank: false, cwd: remoteHeader.cwd, origin: 'user' })
  await discovery.scan()
  check('a reappearing session is advertised again', emitted.at(-1)?.event, 'api-session/added')

  snapshots = snapshots.filter((s) => s.header.id !== remoteHeader.id)
  await discovery.scan()
  check('the reappeared row needs two fresh missing rounds', removalsOf(remoteHeader.id), 1)
  await discovery.scan()
  check('the reappeared row is retracted after both rounds', removalsOf(remoteHeader.id), 2)

  const timer = testIntervals[testIntervals.length - 1]
  discovery()
  check('disposer clears polling timer', timer.cleared, true)
  check('disposer aborts service work', listSignals[0]?.aborted, true)
}

// ── browser half ─────────────────────────────────────────────────────────
const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
let def = null
// fetch 桩：让 toggle() 能在测试里真的跑一遍（抓未定义常量这类运行时错）。
const fetchCalls = []
const clientCtx = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: (url, opts) => {
    fetchCalls.push({ url: String(url), method: opts && opts.method, body: opts && opts.body })
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ ok: true, id: 'hideBuiltinDeepseek', enabled: false })),
      json: () => Promise.resolve({ tweaks: [{ id: 'hideBuiltinDeepseek', target: 'llm-deepseek', enabled: false }] }),
    })
  },
  window: {
    __ModuleLoader__: {
      load(d) {
        def = d
      },
    },
  },
}
vm.createContext(clientCtx)
vm.runInContext(clientSource, clientCtx)
ok('client called ModuleLoader.load', def !== null)
ok('loader contract uses factory (not exports fn)', typeof def.factory === 'function')
// client 现在用 slots（React）渲染插件页开关列表——测试里给一个最小的 React 桩。
const fakeReact = { createElement: () => { throw new Error('no render in tests') }, useState: () => [{}, () => {}], useEffect: () => {} }
const client = def.factory(function (name) {
  if (name === 'react') return fakeReact
  throw new Error('client must not require modules besides react')
})
const api = client.__internals
ok('client declares the slots service', Array.isArray(client.inject) && client.inject.includes('slots'))

console.log('client:')
check('readTweaks with no doc -> no rows', api.readTweaks(null).rows.length, 0)
check(
  'readTweaks lists tweaks that have a target',
  api.readTweaks({ tweaks: [{ id: 'hideBuiltinDeepseek', target: 'llm-deepseek', enabled: true }] }).rows.length,
  1,
)
check(
  'readTweaks ignores unknown ids',
  api.readTweaks({ tweaks: [{ id: 'nope', target: null, enabled: true }] }).rows.length,
  0,
)

console.log('卡片字段（启用状态/描述/生效对象/对象状态/生效条件）:')
const cardRow = api.readTweaks({
  tweaks: [{
    id: 'hideBuiltinDeepseek',
    target: 'llm-deepseek',
    enabled: true,
    title: '隐藏内置供应商',
    what: '模型列表里只留「DeepSeek 账号」',
    why: '为什么',
    subjectKind: 'entry',
    subjectLabel: '内置 DeepSeek 供应商',
    subjectStatus: 'disabled',
    subjectStatusLabel: '条目在位，已被本开关禁用',
    effect: '禁用该条目',
    appliesWhen: '该条目在当前 profile 里存在',
  }],
}).rows[0]
check('carries title', cardRow.title, '隐藏内置供应商')
check('carries what (描述)', cardRow.what, '模型列表里只留「DeepSeek 账号」')
check('carries subjectKind (生效对象类型)', cardRow.subjectKind, 'entry')
check('carries subjectLabel (生效对象)', cardRow.subjectLabel, '内置 DeepSeek 供应商')
check('carries subjectStatus (对象状态)', cardRow.subjectStatus, 'disabled')
ok('carries subjectStatusLabel', cardRow.subjectStatusLabel.includes('已被本开关禁用'))
check('carries appliesWhen (生效条件)', cardRow.appliesWhen, '该条目在当前 profile 里存在')
ok('carries enabled (启用状态)', cardRow.enabled === true)
const bareRow = api.readTweaks({ tweaks: [{ id: 'x', target: 'y', enabled: false }] }).rows[0]
check('missing fields degrade safely', [bareRow.what, bareRow.subjectKind, bareRow.subjectLabel], ['', '', ''])
check('unknown subject status degrades safely', bareRow.subjectStatus, 'unknown')

console.log('入口划分（补丁开关在 settings.section，插件页只读）:')
ok('registers settings.section', /slots\.inject\("settings\.section"/.test(clientSource))
ok('section id is a short slug', /id: SECTION_ID/.test(clientSource) && /SECTION_ID = "tweaks"/.test(clientSource))
ok('section label is 增强补丁', /label: function \(\) \{ return "增强补丁"; \}/.test(clientSource))
ok('TweakCard keeps an interactive checkbox', /type: "checkbox"/.test(clientSource))
ok('checkbox toggles the tweak', /onChange: function \(e\) \{ toggle\(row\.id, e\.target\.checked\); \}/.test(clientSource))
ok('registers plugins.bundle.config with read-only info', /slots\.inject\("plugins\.bundle\.config"/.test(clientSource) && /\}, PluginInfo\);/.test(clientSource))
ok('PluginInfo explains why switches moved', /改开关会触发插件重载/.test(clientSource))

console.log('重启卡片（两段式确认）:')
{
  const before = fetchCalls.length
  const out = await api.restart()
  const call = fetchCalls[before]
  ok('restart() POSTs to /dsh-tweaks/restart', call && call.method === 'POST' && call.url === '/dsh-tweaks/restart')
  check('restart() first click sends an empty body (token request)', call && JSON.parse(call.body), {})
  check('restart() returns { status, doc }', out && out.status, 200)
  ok('restart() surfaces the confirm stage', out && out.doc && out.doc.ok === true)
}
ok('two-stage: second click carries the token', clientSource.includes('body: JSON.stringify(token ? { token: token } : {})'))
ok('confirm button says the session will be interrupted', clientSource.includes('确认重启（会话会被中断）'))
ok('confirm phase offers a cancel button', clientSource.includes('"取消重启"'))
ok('connection drop is treated as restarting, not failure', clientSource.includes('连接已断开，宿主正在重启'))
ok('restart state machine is shared across cards', clientSource.includes('function useRestart(row)'))
ok('restart action is NOT wired into the tweak card (buttons live in the sidebar)', !clientSource.includes('RestartAction'))
ok('restart endpoint constant matches the host route', clientSource.includes('var RESTART = "/dsh-tweaks/restart"'))
ok('readTweaks parses the action field', clientSource.includes('action: typeof t.action === "string" ? t.action : null'))
ok('blocked reason is surfaced as plain text on the card', clientSource.includes('row.actionBlockedBy || "闸门未开"'))
ok('card renders the place multi-select', clientSource.includes('className: "dtw-options"') && clientSource.includes('className: "dtw-opt"'))
ok('place toggles reuse the optimistic applyToggle', clientSource.includes('applyToggle(state.rows, id, next === true)') && clientSource.includes('applyToggle(state.rows, id, next !== true)'))
ok('place options lay out horizontally and wrap on narrow screens', clientSource.includes('display:flex;flex-wrap:wrap;gap:4px 16px'))
ok('confirm state offers a real one-click restart button', clientSource.includes('"一键重启"') && clientSource.includes('dtw-footerBtn-confirm'))
ok('icon turns into a same-size cancel cross', clientSource.includes('function CancelIcon') && clientSource.includes('M4.5 4.5l7 7') && clientSource.includes('className: "dtw-footerBtn dtw-footerBtn-confirm"'))
ok('confirm state counts down ten seconds', clientSource.includes('var CONFIRM_SECONDS = 10;'))
ok('countdown fires the restart when it reaches zero', clientSource.includes('if (s[0].phase === "confirm" && s[0].countdown === 0 && !s[0].busy) act();'))
ok('footer confirm button shows the remaining seconds', clientSource.includes('"一键重启（" + st.countdown + "s）"'))
ok('header entry also counts down', clientSource.includes('function RestartHeaderButton(props)') && clientSource.includes('"一键重启（" + st.countdown + "s）"'))

// 回归：toggle() 必须真的能跑通。
{
  let threw = null
  const before = fetchCalls.length
  try {
    await api.toggle('hideBuiltinDeepseek', false)
  } catch (e) {
    threw = e
  }
  ok('toggle() runs without throwing', threw === null)
  const first = fetchCalls[before]
  ok('toggle() POSTs to /dsh-tweaks/toggle', first && first.method === 'POST' && first.url === '/dsh-tweaks/toggle')
  check('toggle() body carries id + enabled', first && JSON.parse(first.body), { id: 'hideBuiltinDeepseek', enabled: false })
  ok('toggle() polls /dsh-tweaks/status afterwards', fetchCalls.some((c) => c.url === '/dsh-tweaks/status'))
}

console.log('侧边栏底部修复开关（按状态注入 / 摘除，不常驻）:')
ok('client exposes the fix sync', typeof api.syncSidebarFooterFix === 'function')
check('fix id matches the host tweak', api.SIDEBAR_FOOTER_FIX_ID, 'sidebarFooterLayout')
ok('fix css targets only the broken button', /^\[data-slot="sidebar\.footer\.action"\] \.sm-footerBtn-wide\{/.test(api.SIDEBAR_FOOTER_FIX_CSS))
ok('fix css neutralises flex growth', api.SIDEBAR_FOOTER_FIX_CSS.includes('flex:none!important'))
ok('fix css neutralises the horizontal negative margin', api.SIDEBAR_FOOTER_FIX_CSS.includes('margin-left:0!important') && api.SIDEBAR_FOOTER_FIX_CSS.includes('margin-right:0!important'))
// 关键：这条修复**不能**常驻在 CSS_TEXT 里（否则开关关不掉）。
ok('fix is NOT baked into the always-on CSS_TEXT', !/CSS_TEXT = \[[\s\S]*sm-footerBtn-wide[\s\S]*\]\.join/.test(clientSource))
ok('fix is injected under its own style tag', clientSource.includes('dsh-tweaks-sidebar-footer'))
ok('fix syncs on every status landing', /syncSidebarFooterFix\(\)/.test(clientSource))
ok('fix is removed on dispose', /parentNode\.removeChild\(fix\)/.test(clientSource))

console.log('侧栏底部重启入口（2026-11-15 应用户拍板恢复）:')
ok('registers sidebar.footer.action again', clientSource.includes('ctx.slots.inject("sidebar.footer.action"'))
ok('footer entry keeps its own id and sorts last', clientSource.includes('id: "restart-footer"') && /id: "restart-footer",[\s\S]{0,120}order: 40,/.test(clientSource))
ok('footer entry wires RestartFooterButton', /\}, RestartFooterButton\);/.test(clientSource))
ok('no dead slot id or old component name', !clientSource.includes('RESTART_SLOT_ID') && !clientSource.includes('SidebarRestart'))
ok('footer button reuses the shared restart state machine', /function RestartFooterButton\(props\)[\s\S]{0,300}useRestart\(row\)/.test(clientSource))
ok('footer button follows wide/rail', clientSource.includes('var wide = props.wide === true;'))
ok('footer button renders nothing while the switch is off', clientSource.includes('if (!row || row.enabled !== true) return null;'))
ok('footer button reads the master row', clientSource.includes('findRestartRow(s.rows, "restartButton")'))
ok('footer button renders nothing while the footer place is off', clientSource.includes('if (!optionOn(row, "restartFooter")) return null;'))
// 图标出现 == 可以点（用户 2026-11-16 拍板）：闸门未开时整枚不渲染，不渲染灰图标。
ok('footer button renders nothing when the restart gate is closed', /if \(!optionOn\(row, "restartFooter"\)\) return null;[\s\S]{0,300}if \(row\.actionReady !== true\) return null;/.test(clientSource))
ok('footer button is only disabled while a restart is in flight', /var iconCls = "dtw-footerBtn"[\s\S]{0,200}disabled: st\.busy,/.test(clientSource))
ok('no disabled grey-icon tooltip remains in the footer', !/重启未开放/.test(clientSource))
ok('readTweaks keeps the position options from /status', clientSource.includes("options: Array.isArray(t.options)"))
ok('header records the user-approved exemption', clientSource.includes('2026-11-15 用户拍板'))
ok('header records that the avatar menu has no item slot', clientSource.includes('没有任何菜单项 slot'))

console.log('右上角（会话标签栏）入口:')
ok('registers the header utilities slot', clientSource.includes('ctx.slots.inject("conversation.session.header.utilities"'))
ok('header entry keeps its own id and order', clientSource.includes('id: "restart-header"') && /id: "restart-header",[\s\S]{0,120}order: 31,/.test(clientSource))
ok('header entry wires RestartHeaderButton', /\}, RestartHeaderButton\);/.test(clientSource))
ok('header button reuses the shared restart state machine', /function RestartHeaderButton\(props\)[\s\S]{0,300}useRestart\(row\)/.test(clientSource))
ok('header button respects the header place option', clientSource.includes('if (!optionOn(row, "restartHeader")) return null;'))
ok('header button renders nothing when the restart gate is closed', /if \(!optionOn\(row, "restartHeader"\)\) return null;[\s\S]{0,300}if \(row\.actionReady !== true\) return null;/.test(clientSource))
ok('header button is only disabled while a restart is in flight', /var tip = st\.phase === "restarting"[\s\S]{0,300}disabled: st\.busy,/.test(clientSource))
ok('header button has its own compact styles', clientSource.includes('.dtw-headerBtns{display:inline-flex;gap:4px;align-items:center}'))
ok('confirm seconds are declared at module scope', /^\t\tvar CONFIRM_SECONDS = 10;$/m.test(clientSource))

console.log('工具重启倒计时弹窗（restart_dsh）:')
ok('polling + cancel endpoints exist', clientSource.includes('RESTART_PENDING = "/dsh-tweaks/restart/pending"') && clientSource.includes('RESTART_CANCEL = "/dsh-tweaks/restart/cancel"'))
ok('overlay component renders a fixed backdrop', clientSource.includes('function RestartOverlay(props)') && clientSource.includes('className: "dtw-modal-backdrop"') && clientSource.includes('.dtw-modal-backdrop{position:fixed;inset:0'))
ok('overlay has its own slot occupant and sorts after the button', clientSource.includes('id: "restart-overlay"') && /id: "restart-overlay",[\s\S]{0,120}order: 50,/.test(clientSource) && /\}, RestartOverlay\);/.test(clientSource))
ok('overlay offers a cancel button', clientSource.includes('"取消重启"') && clientSource.includes('if (doc && doc.ok && doc.cancelled) setPending(null);'))

console.log('卡片精简（详情进悬浮，不平铺）:')
ok('tooltip carries the full rationale', clientSource.includes('"依据：" + row.why') && clientSource.includes('"生效条件：" + row.appliesWhen') && clientSource.includes('"生效方式：" + row.effect'))
ok('tooltip carries enabled + subject + status', clientSource.includes('"当前：已启用"') && clientSource.includes('"对象状态：" + row.subjectStatusLabel'))
ok('card body renders only title + what', clientSource.includes('className: "dtw-title"') && clientSource.includes('className: "dtw-what"'))
ok('card meta shows only subject + status chips', clientSource.includes('dtw-meta'))
ok('errors still surface as a line', clientSource.includes('dtw-note-error'))

console.log('client static discipline (no dsh-tap DOM probing):')
// 顶部折叠按钮旁的 DOM 注入入口已按用户要求移除：只留官方 slot，不再有观察器/注入代码。
ok('top dom injection is fully removed', !clientSource.includes('TOP_MARK') && !clientSource.includes('MutationObserver') && !clientSource.includes('data-dsh-mobile-toggle') && !clientSource.includes('scheduleTopSync'))
ok('no dsh-tap anchor selectors', !/cbc-group-title/.test(clientSource) && !/cbc-unroutable/.test(clientSource))
ok('no hide-unroutable CSS', !/cbc-listrow/.test(clientSource))
ok('no balance widget', !/installBalanceWidget/.test(clientSource) && !/BALANCE_CSS/.test(clientSource))
ok('no group subgroup machinery', !/groupByField/.test(clientSource) && !/SUBGROUP_LABEL/.test(clientSource))

console.log('client no dead requests / no hardcoded refresh:')
ok('refresh interval comes from the host status route', /state\.refreshMs/.test(clientSource) && /config\.statusRefreshMs/.test(clientSource))
ok('client still declares the slots service', clientSource.includes('inject = ["slots"]'))

console.log('回归：点开关后列表不能消失（transient /status 失败必须保留旧数据）:')
ok('transient failure keeps rows (no rows: [])', !/\.catch\(function \(\) \{\s*\n\s*state = \{ rows: \[\]/.test(clientSource))
ok('transient failure marks stale instead', /stale: true/.test(clientSource) && /rows: state\.rows \|\| \[\]/.test(clientSource))
ok('toggle failure keeps the list', /lastError: String/.test(clientSource) && /rows: state\.rows \|\| \[\]/.test(clientSource))
ok('page shows a stale banner', clientSource.includes('宿主正在重载'))
ok('page shows the last operation error', clientSource.includes('上一次操作失败'))

console.log('回归：按归属对象分组（owner）:')
ok('groups by owner', clientSource.includes('function groupRows(rows)') && /r\.ownerName \|\| "other"/.test(clientSource))
ok('owner order puts DSH first', /OWNER_ORDER = \["dsh"\]/.test(clientSource))
ok('renders a group header', clientSource.includes('function GroupHeader'))
ok('group header summarises enabled count', clientSource.includes('已启用'))
ok('group header flags abnormal objects', clientSource.includes('项异常'))
ok('groups wrap the cards', /React\.createElement\(GroupHeader/.test(clientSource))

console.log('回归：标题文案:')
check('hideBuiltinDeepseek title', TWEAKS.find((t) => t.id === 'hideBuiltinDeepseek').title, '隐藏内置供应商')

console.log('重启行查找（主开关 + 位置选项）:')
{
  const rows = [
    { id: 'sidebarFooterLayout' },
    {
      id: 'restartButton', action: 'restart', enabled: true, actionReady: false, actionBlockedBy: '总闸未打开：把本卡片里的「允许重启宿主」勾上，勾完即可用。',
      options: [{ id: 'restartFooter', enabled: true }, { id: 'restartHeader', enabled: false }],
    },
    { id: 'hideBuiltinDeepseek' },
  ]
  check('findRestartRow picks the restart row by id', api.findRestartRow(rows, 'restartButton'), rows[1])
  check('findRestartRow without id picks the first restart row', api.findRestartRow(rows), rows[1])
  check('findRestartRow tolerates junk input', api.findRestartRow(null), null)
  check('restartRow reads the shared state snapshot', api.restartRow('restartButton'), null)
  check('optionOn reads a checked place', api.optionOn(rows[1], 'restartFooter'), true)
  check('optionOn reads an unchecked place', api.optionOn(rows[1], 'restartHeader'), false)
  check('optionOn tolerates a row without options', api.optionOn({}, 'restartHeader'), false)
}

console.log('路由注册不重名（webserver 的 (kind, path) 唯一约束）:')
{
  // 平台 webserver 的路由表以 (kind, path) 为键，同一路径注册两次直接抛
  // `webserver: duplicate exact route "..."`；而这些注册都在同一个 effect 里，
  // 抛错会让整条插件条目 failed —— 所有 /dsh-tweaks/* 路由一起消失（整包 404）。
  // 这里用**会重名就抛**的假 webserver 跑一次真 apply()，把这条约束变成回归测试。
  const registered = new Map()
  const fakeWebServer = {
    register(route) {
      const key = `${route.kind} ${route.path}`
      if (registered.has(key)) {
        throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      }
      registered.set(key, route)
      return () => registered.delete(key)
    },
  }
  const effects = []
  const fakeCtx = {
    console,
    process,
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval: () => ({ cleared: false }),
    clearInterval: () => {},
    Promise,
    Symbol,
    Date,
    JSON,
    Math,
    Number,
    Object,
    Array,
    String,
    Error,
    Set,
    Map,
    // ctx.get 免 inject 声明，直接读服务仓库（这里不需要任何服务，留着验证不抛）。
    get() {
      return undefined
    },
    // 裸属性访问模拟 Cordis 的「不在 inject 清单里就抛」：路由若误用裸访问会落到这里。
    get sessionPersistence() {
      throw new Error('cannot get property "sessionPersistence" without inject')
    },
    inject(services, callback) {
      const deps = Array.isArray(services) ? services : [services]
      const names = deps.map((d) => (typeof d === 'string' ? d : d.name))
      if (names.includes('webServer')) {
        const wsctx = {
          webServer: fakeWebServer,
          effect(fn, label) {
            effects.push({ fn, label })
            return () => {}
          },
        }
        callback(wsctx)
      }
    },
    effect(fn, label) {
      effects.push({ fn, label })
      return () => {}
    },
    on() {},
    logger: { warn() {}, info() {}, error() {} },
  }
  let applyError = null
  try {
    hostCtx.__host.apply(fakeCtx, { statusRoute: true })
  } catch (error) {
    applyError = error
  }
  ok('apply() itself does not throw', applyError === null)
  let routeError = null
  for (const effect of effects) {
    try {
      effect.fn()
    } catch (error) {
      routeError = error
      break
    }
  }
  ok('no webserver route is registered twice', routeError === null)
  if (routeError !== null) console.log(`         route error: ${routeError.message}`)
  const paths = [...registered.values()].map((r) => r.path)
  ok('the health route is registered exactly once',
    paths.filter((p) => p.endsWith('/client-health')).length === 1)
  ok('the health route serves both GET and POST from one handler',
    paths.filter((p) => p.endsWith('/client-health')).length === 1)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
