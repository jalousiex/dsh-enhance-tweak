/**
 * Isolated slow-link test controller checks.
 * Reads index.js into a VM; never imports or starts the plugin and never touches
 * its state/config files. Loader updates use manually settled promises.
 *
 * Run from any directory with a permitted Node executable:
 *   node test/slow-link-test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createOfflineControllerFactory } from './slow-link-controller.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'index.js'), 'utf8')
  .replace(/^import z from '@deepseek-ai\/schemastery'$/m,
    'const z = new Proxy(function () {}, { get: () => z, apply: () => z })')
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
// Nothing inside the VM can reach real OS state. Even a regression in the
// apply()/route harness has only inert, in-memory filesystem and process stubs.
const vmIo = { reads: 0, forbidden: 0 }
const forbidden = () => { vmIo.forbidden++; throw new Error('forbidden VM operation') }
const sandbox = {
  console, Promise, AbortController, AbortSignal,
  process: { env: { DSH_HOME: '/fake-memory-only' }, platform: 'isolated', exit: forbidden },
  homedir: () => '/fake-memory-only', tmpdir: () => '/fake-memory-only',
  join, dirname,
  readFileSync: () => { vmIo.reads++; return '{"slowLinkTimeouts":false}' },
  writeFileSync: forbidden, appendFileSync: forbidden, mkdirSync: forbidden,
  renameSync: forbidden, rmSync: forbidden, statSync: forbidden,
  spawn: forbidden, spawnSync: forbidden, setTimeout: forbidden, setInterval: forbidden,
  clearTimeout: () => {}, clearInterval: () => {},
}
vm.createContext(sandbox)
vm.runInContext(source + '\n;globalThis.testHelpers = { findEntry, getConfigPath, setConfigPath }; globalThis.observe = observeSlowLinkValues; globalThis.testApply = apply', sandbox, { filename: 'index.js' })
const createController = createOfflineControllerFactory(sandbox.testHelpers)
const observe = sandbox.observe
assert.equal(typeof createController, 'function', 'controller must be exported')
assert.equal(typeof observe, 'function', 'observation helper must be exported')

// Both timings matter: a deferred fake publishes only on resolve, while the
// real Loader's Entry.update publishes options before awaiting fiber updates.
// The eager fake keeps those options even if the returned promise rejects.
function fakeEntry(id, config, { eager = false } = {}) {
  const entry = {
    options: { id, config: structuredClone(config) },
    calls: [],
    update(next) {
      let resolve, reject
      const promise = new Promise((yes, no) => { resolve = yes; reject = no })
      const call = {
        next: structuredClone(next), settled: false,
        publish() {
          for (const [key, value] of Object.entries(call.next)) {
            if (value === undefined || value === null) delete entry.options[key]
            else entry.options[key] = value
          }
        },
        resolve() { assert.equal(call.settled, false); call.settled = true; if (!eager) call.publish(); resolve() },
        reject() { assert.equal(call.settled, false); call.settled = true; reject(new Error('simulated update rejection')) },
      }
      entry.calls.push(call)
      if (eager) call.publish()
      return promise
    },
  }
  return entry
}
function fixture({ enabled = false, missing = null, heartbeatConfig, readyConfig, eager = false, canStart = () => true, isEnabled = null } = {}) {
  const gateway = fakeEntry('typert-gateway', heartbeatConfig ?? { websocketHeartbeatIntervalMs: 2345, sibling: 'gateway-sibling' }, { eager })
  const connection = fakeEntry('connection', readyConfig ?? { recovery: { generationReadyTimeoutMs: 16789, sibling: 'recovery-sibling' }, sibling: 'connection-sibling' }, { eager })
  const store = { 'typert-gateway': gateway, connection }
  if (missing) delete store[missing]
  const loader = { store, entries: () => Object.values(store) }
  const gate = { enabled }
  const options = { getLoader: () => loader, isEnabled: isEnabled || (() => gate.enabled) }
  if (canStart !== null) options.canStart = canStart
  const controller = createController(options)
  return { gateway, connection, loader, gate, controller }
}
async function flush() {
  // The fake update has no timers or I/O. Drain promise reactions without a
  // wall-clock sleep; the bounded loop also prevents a test from hanging.
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
function current(controller) { return controller.status() }
function state(controller) { return current(controller).state }
function expectState(controller, expected) { assert.equal(state(controller), expected) }
function assertNoCapturedBaseline(status) {
  const json = JSON.stringify(status)
  assert.ok(!json.includes('2345') && !json.includes('16789'), 'status must not leak the original values')
}
const cases = []
function test(name, fn) { cases.push({ name, fn }) }

for (const target of ['heartbeat', 'ready']) {
  test(`${target}: isolated pending apply and normal restore`, async () => {
    const f = fixture()
    const selected = target === 'heartbeat' ? f.gateway : f.connection
    const other = target === 'heartbeat' ? f.connection : f.gateway
    const initialSelected = structuredClone(selected.options)
    const initialOther = structuredClone(other.options)
    const started = f.controller.start(target)
    assert.equal(started.ok, true)
    await flush()
    expectState(f.controller, 'applying')
    assert.equal(current(f.controller).pending, true)
    assert.deepEqual(selected.options, initialSelected, 'pending update cannot yet change the entry')
    assert.deepEqual(other.options, initialOther)
    assert.equal(selected.calls.length, 1)
    assert.equal(other.calls.length, 0)
    assertNoCapturedBaseline(current(f.controller))
    selected.calls[0].resolve()
    await flush()
    expectState(f.controller, 'active')
    assert.equal(current(f.controller).pending, false)
    assert.notDeepEqual(selected.options, initialSelected)
    assert.deepEqual(other.options, initialOther)
    if (target === 'heartbeat') assert.equal(selected.options.config.sibling, 'gateway-sibling')
    else {
      assert.equal(selected.options.config.sibling, 'connection-sibling')
      assert.equal(selected.options.config.recovery.sibling, 'recovery-sibling')
    }
    assert.equal(f.controller.restore().ok, true)
    await flush()
    expectState(f.controller, 'restoring')
    assert.equal(selected.calls.length, 2)
    selected.calls[1].resolve()
    await flush()
    expectState(f.controller, 'restored')
    assert.deepEqual(selected.options, initialSelected)
    assert.deepEqual(other.options, initialOther)
  })
}

test('explicit or default-denied canStart blocks tests without writing', async () => {
  for (const canStart of [() => false, null]) {
    for (const target of ['heartbeat', 'ready']) {
      const f = fixture({ canStart })
      assert.equal(f.controller.start(target).ok, false)
      await flush()
      assert.equal(f.gateway.calls.length + f.connection.calls.length, 0)
    }
  }
})

test('throwing isEnabled or canStart fails closed with fixed redacted error and no writes', async () => {
  for (const gateName of ['isEnabled', 'canStart']) {
    const messages = []
    for (const sentinel of ['GATE_SENSITIVE_FIRST', 'GATE_SENSITIVE_SECOND']) {
      const opts = { [gateName]: () => { throw new Error(sentinel) } }
      const f = fixture(opts)
      const result = f.controller.start('heartbeat')
      assert.equal(result.ok, false)
      assert.equal(result.error, '无法确认实验门禁，已拒绝启动。')
      assert.ok(!JSON.stringify(result).includes(sentinel))
      messages.push(result.error)
      await flush()
      assert.equal(f.gateway.calls.length + f.connection.calls.length, 0)
    }
    assert.equal(messages[0], messages[1], 'error must be fixed, not derived from the thrown value')
  }
})

test('experiment gate requires strict booleans', async () => {
  for (const [isEnabled, canStart] of [
    [() => undefined, () => true], [() => 0, () => true],
    [() => false, () => 1], [() => false, () => 'true'],
  ]) {
    const f = fixture({ isEnabled, canStart })
    assert.equal(f.controller.start('heartbeat').ok, false)
    await flush()
    assert.equal(f.gateway.calls.length + f.connection.calls.length, 0)
  }
})

test('master switch enabled blocks either independent test', async () => {
  for (const target of ['heartbeat', 'ready']) {
    const f = fixture({ enabled: true })
    assert.equal(f.controller.start(target).ok, false)
    await flush()
    assert.equal(f.gateway.calls.length + f.connection.calls.length, 0)
  }
})

test('missing target is rejected without touching the other entry', async () => {
  for (const [target, missing] of [['heartbeat', 'typert-gateway'], ['ready', 'connection']]) {
    const f = fixture({ missing })
    assert.equal(f.controller.start(target).ok, false)
    await flush()
    assert.equal(f.gateway.calls.length + f.connection.calls.length, 0)
  }
})

test('unchanged test value requires no update and no rollback', async () => {
  for (const [target, option, testValue] of [
    ['heartbeat', { heartbeatConfig: { websocketHeartbeatIntervalMs: 30000, sibling: 1 } }, 30000],
    ['ready', { readyConfig: { recovery: { generationReadyTimeoutMs: 120000, sibling: 2 } } }, 120000],
  ]) {
    const f = fixture(option)
    assert.equal(f.controller.start(target).ok, true)
    await flush()
    expectState(f.controller, 'unchanged')
    assert.equal(current(f.controller).testValue, testValue)
    assert.equal(f.gateway.calls.length + f.connection.calls.length, 0)
    assert.equal(f.controller.restore().ok, false)
  }
})

test('invalid target is rejected without updating either entry', async () => {
  const f = fixture()
  assert.equal(f.controller.start('unknown').ok, false)
  await flush()
  assert.equal(f.gateway.calls.length + f.connection.calls.length, 0)
})

test('rejected apply is reported and never writes an entry', async () => {
  const f = fixture()
  assert.equal(f.controller.start('heartbeat').ok, true)
  await flush()
  f.gateway.calls[0].reject()
  await flush()
  expectState(f.controller, 'apply_failed')
  assert.equal(current(f.controller).pending, false)
  assert.equal(f.gateway.options.config.websocketHeartbeatIntervalMs, 2345)
  assert.equal(f.connection.calls.length, 0)
})

test('eager update rejection keeps recovery information', async () => {
  const f = fixture({ eager: true })
  const baseline = structuredClone(f.gateway.options)
  assert.equal(f.controller.start('heartbeat').ok, true)
  assert.equal(f.gateway.options.config.websocketHeartbeatIntervalMs, 30000)
  expectState(f.controller, 'applying')
  assert.equal(current(f.controller).pending, true)
  f.gateway.calls[0].reject()
  await flush()
  expectState(f.controller, 'apply_failed')
  assert.equal(f.gateway.options.config.websocketHeartbeatIntervalMs, 30000, 'rejection can follow a real options mutation')
  assert.equal(f.controller.start('ready').ok, false)
  assert.equal(f.controller.restore().ok, true)
  await flush()
  assert.equal(f.gateway.calls.length, 2)
  assert.deepEqual(f.gateway.options, baseline, 'restore can publish baseline before completion')
  expectState(f.controller, 'restoring')
  f.gateway.calls[1].resolve()
  await flush()
  expectState(f.controller, 'restored')
})

test('eager queued restore waits for rejected apply then restores', async () => {
  const f = fixture({ eager: true })
  const baseline = structuredClone(f.gateway.options)
  assert.equal(f.controller.start('heartbeat').ok, true)
  assert.equal(f.controller.restore().ok, true)
  assert.equal(f.gateway.calls.length, 1, 'restore must not overlap an unsettled update')
  f.gateway.calls[0].reject()
  await flush()
  assert.equal(f.gateway.calls.length, 2)
  expectState(f.controller, 'restoring')
  assert.deepEqual(f.gateway.options, baseline)
  f.gateway.calls[1].resolve()
  await flush()
  expectState(f.controller, 'restored')
})

test('eager restore rejection is not reported as restored even after options change', async () => {
  const f = fixture({ eager: true })
  const baseline = structuredClone(f.gateway.options)
  assert.equal(f.controller.start('heartbeat').ok, true)
  f.gateway.calls[0].resolve()
  await flush()
  assert.equal(f.controller.restore().ok, true)
  assert.deepEqual(f.gateway.options, baseline, 'eager restore publishes before fiber completion')
  expectState(f.controller, 'restoring')
  f.gateway.calls[1].reject()
  await flush()
  expectState(f.controller, 'restore_failed')
  assert.deepEqual(f.gateway.options, baseline)
  assert.equal(f.controller.start('ready').ok, false)
  assert.equal(f.controller.restore().ok, true)
  await flush()
  expectState(f.controller, 'conflict')
  assert.equal(f.gateway.calls.length, 2, 'retry must not overwrite a value no longer owned')
  // Baseline options alone do not prove that the real fiber completed its update.
  assert.deepEqual(f.gateway.options, baseline)
})

test('a rejected deferred apply still at baseline needs no restore', async () => {
  const f = fixture()
  assert.equal(f.controller.start('heartbeat').ok, true)
  await flush()
  f.gateway.calls[0].reject()
  await flush()
  expectState(f.controller, 'apply_failed')
  assert.equal(f.controller.busy(), false)
  assert.equal(f.controller.restore().ok, false)
  assert.equal(f.gateway.calls.length, 1)
})

test('restore during apply waits for it before restoring', async () => {
  const f = fixture()
  const baseline = structuredClone(f.gateway.options)
  assert.equal(f.controller.start('heartbeat').ok, true)
  await flush()
  assert.equal(f.controller.restore().ok, true)
  await flush()
  assert.equal(f.gateway.calls.length, 1, 'no restore can race the pending apply')
  f.gateway.calls[0].resolve()
  await flush()
  assert.equal(f.gateway.calls.length, 2)
  f.gateway.calls[1].resolve()
  await flush()
  expectState(f.controller, 'restored')
  assert.deepEqual(f.gateway.options, baseline)
})

test('restoring an originally missing key removes it while preserving siblings', async () => {
  const f = fixture({ readyConfig: { recovery: { sibling: 'kept' }, sibling: 9 } })
  const baseline = structuredClone(f.connection.options)
  assert.equal(f.controller.start('ready').ok, true)
  await flush()
  f.connection.calls[0].resolve()
  await flush()
  assert.equal(f.controller.restore().ok, true)
  await flush()
  f.connection.calls[1].resolve()
  await flush()
  expectState(f.controller, 'restored')
  assert.deepEqual(f.connection.options, baseline)
})

test('an entirely absent config is deleted on restore', async () => {
  const f = fixture({ eager: true })
  delete f.gateway.options.config
  const baseline = structuredClone(f.gateway.options)
  assert.equal(f.controller.start('heartbeat').ok, true)
  assert.equal(f.gateway.options.config.websocketHeartbeatIntervalMs, 30000)
  f.gateway.calls[0].resolve()
  await flush()
  assert.equal(f.controller.restore().ok, true)
  assert.deepEqual(f.gateway.options, baseline)
  assert.equal(Object.hasOwn(f.gateway.options, 'config'), false)
  f.gateway.calls[1].resolve()
  await flush()
  expectState(f.controller, 'restored')
})

test('an explicitly undefined original leaf retains its own property on restore', async () => {
  const f = fixture({ readyConfig: { recovery: { generationReadyTimeoutMs: undefined, sibling: 7 } }, eager: true })
  assert.equal(f.controller.start('ready').ok, true)
  f.connection.calls[0].resolve()
  await flush()
  assert.equal(f.controller.restore().ok, true)
  const recovery = f.connection.options.config.recovery
  assert.equal(Object.hasOwn(recovery, 'generationReadyTimeoutMs'), true)
  assert.equal(recovery.generationReadyTimeoutMs, undefined)
  assert.equal(recovery.sibling, 7)
  f.connection.calls[1].resolve()
  await flush()
  expectState(f.controller, 'restored')
})

test('a created missing parent is removed again on restore', async () => {
  const f = fixture({ readyConfig: { sibling: 9 } })
  const baseline = structuredClone(f.connection.options)
  assert.equal(f.controller.start('ready').ok, true)
  await flush()
  f.connection.calls[0].resolve()
  await flush()
  assert.equal(f.controller.restore().ok, true)
  await flush()
  f.connection.calls[1].resolve()
  await flush()
  assert.deepEqual(f.connection.options, baseline)
})

test('restore preserves a concurrent unrelated sibling change', async () => {
  const f = fixture()
  assert.equal(f.controller.start('heartbeat').ok, true)
  await flush()
  f.gateway.calls[0].resolve()
  await flush()
  f.gateway.options = { ...f.gateway.options, config: { ...f.gateway.options.config, sibling: 'external' } }
  assert.equal(f.controller.restore().ok, true)
  await flush()
  f.gateway.calls[1].resolve()
  await flush()
  expectState(f.controller, 'restored')
  assert.equal(f.gateway.options.config.websocketHeartbeatIntervalMs, 2345)
  assert.equal(f.gateway.options.config.sibling, 'external')
})

test('external change is a conflict, not a rollback', async () => {
  const f = fixture()
  assert.equal(f.controller.start('heartbeat').ok, true)
  await flush()
  f.gateway.calls[0].resolve()
  await flush()
  f.gateway.options = { ...f.gateway.options, config: { ...f.gateway.options.config, websocketHeartbeatIntervalMs: 9876 } }
  f.controller.restore()
  await flush()
  expectState(f.controller, 'conflict')
  assert.equal(f.gateway.calls.length, 1)
  assert.equal(f.gateway.options.config.websocketHeartbeatIntervalMs, 9876)
})

test('replacement entry is a conflict, not a rollback', async () => {
  const f = fixture()
  assert.equal(f.controller.start('ready').ok, true)
  await flush()
  f.connection.calls[0].resolve()
  await flush()
  const replacement = fakeEntry('connection', { recovery: { generationReadyTimeoutMs: 55555 } })
  f.loader.store.connection = replacement
  f.controller.restore()
  await flush()
  expectState(f.controller, 'conflict')
  assert.equal(replacement.calls.length, 0)
  assert.equal(replacement.options.config.recovery.generationReadyTimeoutMs, 55555)
})

test('failed restore is reported rather than silently successful', async () => {
  const f = fixture()
  assert.equal(f.controller.start('heartbeat').ok, true)
  await flush()
  f.gateway.calls[0].resolve()
  await flush()
  assert.equal(f.controller.restore().ok, true)
  await flush()
  f.gateway.calls[1].reject()
  await flush()
  expectState(f.controller, 'restore_failed')
  assert.equal(current(f.controller).pending, false)
  assert.equal(f.controller.start('ready').ok, false, 'unresolved restore failure blocks another experiment')
  assert.equal(f.connection.calls.length, 0)
})

test('dispose queues best-effort restore while apply is pending', async () => {
  const f = fixture()
  const baseline = structuredClone(f.gateway.options)
  assert.equal(f.controller.start('heartbeat').ok, true)
  await flush()
  f.controller.dispose()
  assert.equal(f.gateway.calls.length, 1)
  f.gateway.calls[0].resolve()
  await flush()
  assert.equal(f.gateway.calls.length, 2)
  f.gateway.calls[1].resolve()
  await flush()
  assert.deepEqual(f.gateway.options, baseline)
})

test('second test request is rejected during pending and active work', async () => {
  const f = fixture()
  assert.equal(f.controller.start('heartbeat').ok, true)
  assert.equal(f.controller.start('ready').ok, false)
  await flush()
  f.gateway.calls[0].resolve()
  await flush()
  assert.equal(f.controller.start('ready').ok, false)
  assert.equal(f.connection.calls.length, 0)
})

// Observation tests use fake fibers only. Raw entry config contains a sentinel
// and different numbers: only active fiber effectiveConfig may be observed.
function observationFixture() {
  const sentinel = 'SENSITIVE_SENTINEL_DO_NOT_OUTPUT'
  const gateway = {
    options: { id: 'typert-gateway', name: '@deepseek-ai/dsh-api-gateway', config: { websocketHeartbeatIntervalMs: 1111, secret: sentinel } },
    fiber: { state: 2, inertia: null, effectiveConfig: { websocketHeartbeatIntervalMs: 3579, secret: sentinel } },
    calls: 0,
    update() { this.calls++; throw new Error('observe must not write') },
  }
  const connection = {
    options: { id: 'connection', name: '@deepseek-ai/dsh-client-connection', config: { recovery: { generationReadyTimeoutMs: 2222 }, secret: sentinel } },
    fiber: { state: 2, inertia: null, effectiveConfig: { recovery: { generationReadyTimeoutMs: 24680, secret: sentinel }, secret: sentinel } },
    calls: 0,
    update() { this.calls++; throw new Error('observe must not write') },
  }
  const store = { 'typert-gateway': gateway, connection }
  return { sentinel, gateway, connection, loader: { store, entries: () => Object.values(store) } }
}
function assertObservedWhitelist(out, sentinel) {
  assert.deepEqual(Object.keys(out).sort(), ['heartbeat', 'limitation', 'ready'])
  for (const row of [out.heartbeat, out.ready]) {
    const allowed = row.status === 'error'
      ? ['error', 'fiberState', 'pending', 'status', 'value']
      : ['fiberState', 'pending', 'status', 'value']
    assert.deepEqual(Object.keys(row).sort(), allowed)
    assert.ok(row.value === null || (typeof row.value === 'number' && Number.isFinite(row.value)))
  }
  assert.ok(!JSON.stringify(out).includes(sentinel), 'observation must not expose unrelated config or errors')
  assert.match(out.limitation, /mux/)
  assert.match(out.limitation, /Android/)
  assert.match(out.limitation, /不代表/)
}

test('observe returns only two active effectiveConfig numbers and a limitation', () => {
  const f = observationFixture()
  const out = observe(f.loader)
  assertObservedWhitelist(out, f.sentinel)
  assert.equal(out.heartbeat.status, 'observed')
  assert.equal(out.heartbeat.fiberState, 2)
  assert.equal(out.heartbeat.pending, false)
  assert.equal(out.heartbeat.value, 3579)
  assert.equal(out.ready.status, 'observed')
  assert.equal(out.ready.value, 24680)
  assert.equal(f.gateway.calls + f.connection.calls, 0)
})

test('observe refuses ambiguous, unverifiable and unverified identities', () => {
  for (const [id, row] of [['typert-gateway', 'heartbeat'], ['connection', 'ready']]) {
    const duplicate = observationFixture()
    const impostor = { options: { id, name: duplicate.loader.store[id].options.name }, fiber: { state: 2, effectiveConfig: {} } }
    duplicate.loader.entries = () => [...Object.values(duplicate.loader.store), impostor]
    let out = observe(duplicate.loader)
    assertObservedWhitelist(out, duplicate.sentinel)
    assert.equal(out[row].status, 'ambiguous')
    assert.equal(out[row].value, null)
    const sameObject = observationFixture()
    sameObject.loader.entries = () => [...Object.values(sameObject.loader.store), sameObject.loader.store[id]]
    out = observe(sameObject.loader)
    assert.equal(out[row].status, 'observed', 'same object yielded twice is not two identities')
    const noEntries = observationFixture()
    delete noEntries.loader.entries
    out = observe(noEntries.loader)
    assert.equal(out[row].status, 'unverifiable')
    assert.equal(out[row].value, null)
    noEntries.loader.entries = () => { throw new Error(noEntries.sentinel) }
    out = observe(noEntries.loader)
    assert.equal(out[row].status, 'unverifiable')
    assert.equal(out[row].value, null)
    assertObservedWhitelist(out, noEntries.sentinel)
    for (const wrongName of [undefined, 'not-the-official-package', '@deepseek-ai/dsh-api-gateway-evil']) {
      const unverified = observationFixture()
      unverified.loader.store[id].options.name = wrongName
      out = observe(unverified.loader)
      assert.equal(out[row].status, 'identity_unverified')
      assert.equal(out[row].value, null)
      assertObservedWhitelist(out, unverified.sentinel)
    }
  }
})

test('observe revalidates uniqueness and package identity after reading', () => {
  for (const change of ['duplicate', 'name']) {
    const f = observationFixture()
    const original = f.gateway.fiber.effectiveConfig
    Object.defineProperty(f.gateway.fiber, 'effectiveConfig', { get() {
      if (change === 'name') f.gateway.options.name = 'untrusted-package'
      else {
        const duplicate = { options: { id: 'typert-gateway', name: '@deepseek-ai/dsh-api-gateway' } }
        f.loader.entries = () => [f.gateway, f.connection, duplicate]
      }
      return original
    } })
    const out = observe(f.loader)
    assert.equal(out.heartbeat.status, change === 'duplicate' ? 'ambiguous' : 'identity_unverified')
    assert.equal(out.heartbeat.value, null)
  }
})

test('observe reports absent entries and fibers without exposing stale config', () => {
  for (const [key, row] of [['typert-gateway', 'heartbeat'], ['connection', 'ready']]) {
    const missingEntry = observationFixture()
    delete missingEntry.loader.store[key]
    let out = observe(missingEntry.loader)
    assertObservedWhitelist(out, missingEntry.sentinel)
    assert.equal(out[row].status, 'entry_missing')
    assert.equal(out[row].value, null)
    const missingFiber = observationFixture()
    delete missingFiber.loader.store[key].fiber
    out = observe(missingFiber.loader)
    assert.equal(out[row].status, 'fiber_missing')
    assert.equal(out[row].value, null)
  }
})

test('observe refuses inactive or transitioning stale fiber values', () => {
  for (const key of ['typert-gateway', 'connection']) {
    const row = key === 'typert-gateway' ? 'heartbeat' : 'ready'
    for (const state of [0, 1, 3, 4, 5]) {
      const f = observationFixture()
      f.loader.store[key].fiber.state = state
      const out = observe(f.loader)
      assert.equal(out[row].status, 'inactive')
      assert.equal(out[row].fiberState, state)
      assert.equal(out[row].value, null)
    }
    const f = observationFixture()
    f.loader.store[key].fiber.inertia = Promise.resolve()
    const out = observe(f.loader)
    assert.equal(out[row].status, 'transitioning')
    assert.equal(out[row].pending, true)
    assert.equal(out[row].value, null)
  }
})

test('observe rejects absent and non-finite/non-number values', () => {
  for (const value of [undefined, null, NaN, Infinity, -Infinity, '3579', {}, true]) {
    const f = observationFixture()
    f.gateway.fiber.effectiveConfig.websocketHeartbeatIntervalMs = value
    const out = observe(f.loader)
    assert.equal(out.heartbeat.status, value == null ? 'value_missing' : 'value_invalid')
    assert.equal(out.heartbeat.value, null)
    assertObservedWhitelist(out, f.sentinel)
  }
  const f = observationFixture()
  delete f.connection.fiber.effectiveConfig.recovery.generationReadyTimeoutMs
  const out = observe(f.loader)
  assert.equal(out.ready.status, 'value_missing')
  assert.equal(out.ready.value, null)
})

test('observe catches throwing getters without leaking exception messages', () => {
  const f = observationFixture()
  Object.defineProperty(f.gateway.fiber, 'effectiveConfig', { get() { throw new Error(f.sentinel) } })
  const out = observe(f.loader)
  assertObservedWhitelist(out, f.sentinel)
  assert.equal(out.heartbeat.status, 'error')
  assert.equal(out.heartbeat.error, '读取宿主配置失败。')
  assert.equal(out.ready.status, 'observed', 'the other observation remains available')
})

test('observe discards values if entry or fiber transitions while reading', () => {
  const f = observationFixture()
  const fiber = f.gateway.fiber
  Object.defineProperty(fiber, 'effectiveConfig', { get() {
    f.loader.store['typert-gateway'] = { options: { id: 'typert-gateway', name: '@deepseek-ai/dsh-api-gateway' }, fiber: { state: 2, inertia: null, effectiveConfig: { websocketHeartbeatIntervalMs: 4444 } } }
    return { websocketHeartbeatIntervalMs: 3579 }
  } })
  assert.equal(observe(f.loader).heartbeat.status, 'fiber_changed')
  const g = observationFixture()
  let inertiaReads = 0
  Object.defineProperty(g.gateway.fiber, 'inertia', { get() { return ++inertiaReads === 1 ? null : Promise.resolve() } })
  const out = observe(g.loader)
  assert.equal(out.heartbeat.status, 'transitioning')
  assert.equal(out.heartbeat.value, null)
})

test('observe route is GET-only, whitelisted, and performs no update or OS I/O', async () => {
  const f = observationFixture()
  const effects = new Map()
  const routes = new Map()
  let loaderReads = 0
  let authCalls = 0
  let authMode = 'success'
  const auth = { async admit(request) {
    assert.equal(request.method, 'GET', 'non-GET must be denied before admission')
    authCalls++
    if (authMode === 'success') return { peer: { id: 'fake-peer' } }
    if (authMode === 'reject401') return { rejection: 401, detail: f.sentinel }
    if (authMode === 'reject403') return { rejection: 403, detail: f.sentinel }
    if (authMode === 'reject-with-peer') return { rejection: 401, peer: { id: 'fake-peer' }, detail: f.sentinel }
    if (authMode === 'throw') throw new Error(f.sentinel)
    if (authMode === 'malformed') return { peer: null, detail: f.sentinel }
    if (authMode === 'other-rejection') return { rejection: 418, detail: f.sentinel }
    throw new Error('unknown fake mode')
  } }
  const wsctx = {
    webServer: { register(route) { assert.equal(routes.has(route.path), false); routes.set(route.path, route); return () => {} } },
    get(name) {
      assert.equal(name, 'connection')
      if (authMode === 'missing') return undefined
      if (authMode === 'badservice') return {}
      if (authMode === 'sync') return { admit(request) { assert.equal(request.method, 'GET'); authCalls++; return { peer: { id: 'fake-peer' } } } }
      if (authMode === 'service-throws') throw new Error(f.sentinel)
      return auth
    },
    effect(fn, label) { effects.set(label, fn); return () => {} },
  }
  const ctx = {
    get(name) { if (name === 'loader') { loaderReads++; return f.loader }; return undefined },
    effect() { return () => {} },
    inject(names, callback) { if (names.includes('webServer')) callback(wsctx) },
    on: forbidden,
  }
  const reads = vmIo.reads
  const forbiddenCount = vmIo.forbidden
  sandbox.testApply(ctx, { statusRoute: true, clientHealthRoute: false, sessionDiscoveryMs: 0 })
  assert.equal(vmIo.reads, reads + 1, 'state is read from stub only')
  const register = effects.get('dsh-tweaks:slow-link-observe-route')
  assert.equal(typeof register, 'function')
  register()
  const route = routes.get('/dsh-tweaks/slow-link-observe')
  assert.equal(route.kind, 'exact')
  async function request(method) {
    const result = {}
    await route.handler({ method }, {
      writeHead(code, headers) { result.code = code; result.headers = headers },
      end(body) { result.body = JSON.parse(body) },
    })
    return result
  }
  const get = await request('GET')
  assert.equal(get.code, 200)
  assert.equal(get.headers['cache-control'], 'no-store')
  assertObservedWhitelist(get.body, f.sentinel)
  assert.equal(get.body.heartbeat.value, 3579)
  assert.equal(get.body.ready.value, 24680)
  for (const [mode, code, message] of [
    ['reject401', 401, '认证失败。'], ['reject403', 403, '访问被拒绝。'],
    ['reject-with-peer', 401, '认证失败。'], ['missing', 503, '认证服务不可用。'],
    ['badservice', 503, '认证服务不可用。'], ['throw', 503, '认证服务不可用。'], ['service-throws', 503, '认证服务不可用。'],
    ['malformed', 503, '认证服务不可用。'], ['other-rejection', 503, '认证服务不可用。'],
  ]) {
    authMode = mode
    const beforeReads = loaderReads
    const denied = await request('GET')
    assert.equal(denied.code, code, `admit mode ${mode}`)
    assert.equal(denied.body.error, message)
    assert.equal(loaderReads, beforeReads, 'unauthenticated requests must not inspect Loader')
    assert.ok(!JSON.stringify(denied.body).includes(f.sentinel), 'admission details must not leak')
  }
  authMode = 'sync'
  const syncAdmitted = await request('GET')
  assert.equal(syncAdmitted.code, 200)
  assertObservedWhitelist(syncAdmitted.body, f.sentinel)
  authMode = 'success'
  Object.defineProperty(f.gateway.fiber, 'effectiveConfig', { get() { throw new Error(f.sentinel) } })
  const fault = await request('GET')
  assert.equal(fault.code, 200)
  assertObservedWhitelist(fault.body, f.sentinel)
  assert.equal(fault.body.heartbeat.status, 'error')
  assert.equal(fault.body.heartbeat.error, '读取宿主配置失败。')
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    const beforeReads = loaderReads
    const beforeAdmissions = authCalls
    const denied = await request(method)
    assert.equal(denied.code, 405)
    assert.equal(denied.headers.allow, 'GET')
    assert.equal(loaderReads, beforeReads)
    assert.equal(authCalls, beforeAdmissions)
    assert.ok(!JSON.stringify(denied.body).includes(f.sentinel))
  }
  assert.equal(f.gateway.calls + f.connection.calls, 0)
  assert.equal(vmIo.forbidden, forbiddenCount, 'no real I/O, process, restart or timers')
})

test('observation route is not registered when statusRoute is disabled', () => {
  const effects = new Map()
  const ctx = {
    get() { return undefined },
    effect() { return () => {} },
    inject(names, callback) {
      if (names.includes('webServer')) callback({
        effect(fn, label) { effects.set(label, fn); return () => {} },
        webServer: { register: forbidden },
      })
    },
    on: forbidden,
  }
  const previous = vmIo.forbidden
  sandbox.testApply(ctx, { statusRoute: false, sessionDiscoveryMs: 0 })
  assert.equal(effects.has('dsh-tweaks:slow-link-observe-route'), false)
  assert.equal(vmIo.forbidden, previous)
})

// Exercise the real apply/reconcile path in a separate VM. All state, timers,
// routes and Loader entries below are fakes; no live profile is ever opened.
test('legacy slow-link state applies readiness only and disabling restores it', async () => {
  for (const initiallyEnabled of [false, true]) {
    const legacy = {
      slowLinkTimeouts: initiallyEnabled, slowHeartbeatMs: 45678,
      slowReadyTimeoutMs: 87654, sidebarFooterLayout: true,
      restartButton: false, restartFooter: true, restartHeader: false,
      restartAgentTool: false, allowRestart: false, restartDelayMs: 1234,
    }
    let stateText = JSON.stringify(legacy)
    let pendingText = null
    const timers = new Map()
    let timerId = 0
    const forbiddenCalls = []
    const blocked = (name) => () => { forbiddenCalls.push(name); throw new Error(`forbidden ${name}`) }
    const isolated = {
      console, Promise, AbortController, AbortSignal,
      process: { env: { DSH_HOME: '/fake-memory-only' }, platform: 'isolated', exit: blocked('exit') },
      homedir: () => '/fake-memory-only', tmpdir: () => '/fake-memory-only', join, dirname,
      readFileSync: () => stateText,
      mkdirSync: () => {},
      writeFileSync: (_path, text) => { pendingText = text },
      renameSync: () => { assert.notEqual(pendingText, null); stateText = pendingText; pendingText = null },
      appendFileSync: blocked('append'), rmSync: blocked('remove'), statSync: blocked('stat'),
      spawn: blocked('spawn'), spawnSync: blocked('spawnSync'),
      setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id },
      clearTimeout(id) { timers.delete(id) },
      setInterval: blocked('interval'), clearInterval: blocked('clearInterval'),
    }
    vm.createContext(isolated)
    vm.runInContext(source + '\n;globalThis.testApply = apply; globalThis.testReadState = readState', isolated, { filename: 'index.js' })
    const clean = (value) => JSON.parse(JSON.stringify(value))
    const initialState = clean(isolated.testReadState())
    assert.equal(initialState.slowLinkTimeouts, initiallyEnabled)
    assert.equal(initialState.slowReadyTimeoutMs, 87654)
    assert.equal(Object.hasOwn(initialState, 'slowHeartbeatMs'), false)
    for (const key of ['sidebarFooterLayout', 'restartButton', 'restartFooter', 'restartHeader', 'restartAgentTool', 'allowRestart', 'restartDelayMs']) {
      assert.equal(initialState[key], legacy[key], `legacy ${key} is retained`)
    }
    function entry(id, config) {
      return {
        options: { id, config: structuredClone(config) }, calls: [],
        update(next) { this.calls.push(clean(next)); this.options = clean(next); return Promise.resolve() },
      }
    }
    const gateway = entry('typert-gateway', { websocketHeartbeatIntervalMs: 2345, sibling: 'untouched' })
    const connection = entry('connection', { recovery: { generationReadyTimeoutMs: 16789, sibling: 'keep' }, sibling: 'keep' })
    const baselineGateway = structuredClone(gateway.options)
    const baselineConnection = structuredClone(connection.options)
    const loader = { store: { 'typert-gateway': gateway, connection } }
    const routes = new Map()
    const wsctx = {
      webServer: { register(route) { routes.set(route.path, route); return () => {} } },
      effect(fn, label) { if (label === 'dsh-tweaks:toggle-route') return fn(); return () => {} },
    }
    const ctx = {
      get(name) { return name === 'loader' ? loader : undefined },
      effect(fn, label) { return label === 'dsh-tweaks:slowLinkTimeouts' ? fn() : () => {} },
      on() { return () => {} },
      inject(names, callback) { if (names.includes('webServer')) callback(wsctx) },
    }
    const tick = () => { const queued = [...timers.values()]; timers.clear(); for (const fn of queued) fn() }
    async function toggle(id, enabled) {
      const body = JSON.stringify({ id, enabled })
      const request = { on(event, fn) { if (event === 'data') fn(body); else if (event === 'end') fn() } }
      const result = {}
      await routes.get('/dsh-tweaks/toggle').handler(request, {
        writeHead(code) { result.code = code }, end(bodyText) { result.body = JSON.parse(bodyText) },
      })
      return result
    }
    isolated.testApply(ctx, { statusRoute: true, clientHealthRoute: false, sessionDiscoveryMs: 0 })
    tick()
    if (!initiallyEnabled) {
      assert.deepEqual(connection.options, baselineConnection)
      assert.equal((await toggle('slowLinkTimeouts', true)).code, 200)
      tick()
    }
    assert.equal(connection.calls.length, 1)
    assert.deepEqual(connection.options.config, {
      recovery: { generationReadyTimeoutMs: 87654, sibling: 'keep' }, sibling: 'keep',
    })
    assert.equal(gateway.calls.length, 0)
    assert.deepEqual(gateway.options, baselineGateway)
    const beforeUnknown = stateText
    assert.equal((await toggle('slowHeartbeatMs', true)).code, 400)
    assert.equal(stateText, beforeUnknown)
    assert.equal(connection.calls.length, 1)
    assert.equal((await toggle('slowLinkTimeouts', false)).code, 200)
    tick()
    assert.equal(connection.calls.length, 2)
    assert.deepEqual(connection.options, baselineConnection)
    assert.equal(gateway.calls.length, 0)
    assert.deepEqual(gateway.options, baselineGateway)
    const saved = JSON.parse(stateText)
    assert.equal(saved.slowLinkTimeouts, false)
    assert.equal(saved.slowReadyTimeoutMs, 87654)
    assert.equal(Object.hasOwn(saved, 'slowHeartbeatMs'), false)
    for (const key of ['sidebarFooterLayout', 'restartButton', 'restartFooter', 'restartHeader', 'restartAgentTool', 'allowRestart', 'restartDelayMs']) {
      assert.equal(saved[key], legacy[key], `saved ${key} is retained`)
    }
    assert.deepEqual(forbiddenCalls, [])
  }
})

let failures = 0
for (const { name, fn } of cases) {
  try { await fn(); console.log(`  ok   ${name}`) }
  catch (error) { failures++; console.error(`  FAIL ${name}\n`, error) }
}
console.log(`\n${cases.length - failures} passed, ${failures} failed`)
process.exitCode = failures ? 1 : 0
