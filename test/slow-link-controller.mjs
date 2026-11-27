export function createOfflineControllerFactory({ findEntry, getConfigPath, setConfigPath }) {
/**
 * 单项慢链路实验。只观察 Loader 条目配置，不代表网关定时器或手机 Controller
 * 的运行值。entry.update 没有 CAS：检查与更新之间的外部并发仍无法完全排除。
 * entry.update 会更改 Loader 共享配置，后续保存可能将其持久化；此控制器目前
 * 仅供 fake 离线测试，不得接入真实宿主。默认拒绝启动，调用方须显式证明门禁。
 * 实验保持到调用 restore；卸载时也只可尽力异步恢复，进程退出不能保证完成。
 */
return function createSlowLinkTestController({ getLoader, isEnabled, canStart = () => false }) {
  const targets = {
    heartbeat: { target: 'typert-gateway', path: 'websocketHeartbeatIntervalMs', value: 30000 },
    ready: { target: 'connection', path: 'recovery.generationReadyTimeoutMs', value: 120000 },
  }
  const limitation = '仅供 fake 离线测试；entry.update 会修改 Loader 共享配置，后续保存可能持久化。配置回读不证明网关或手机 Controller 的运行值；无原子 CAS，外部并发可能竞争。'
  let phase = 'idle'
  let current = null
  let restoreRequested = false
  let disposed = false
  let error = null

  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  function status() {
    return {
      state: phase,
      target: current?.id ?? null,
      testValue: current?.spec.value ?? null,
      pending: phase === 'applying' || phase === 'restoring',
      restoreRequested,
      error,
      limitation,
    }
  }
  function result(ok, message) {
    return { ok, ...(message ? { error: message } : {}), status: status() }
  }
  function busy() {
    return phase === 'applying' || phase === 'active' || phase === 'restoring' ||
      phase === 'restore_failed' || phase === 'conflict' || (phase === 'apply_failed' && current?.uncertain === true)
  }
  // 允许缺失父键：只清除我们创建的空父对象；非对象父键拒绝操作，避免破坏结构。
  function capture(entry, spec) {
    if (!entry?.options || typeof entry.update !== 'function') throw new Error('目标条目不可更新')
    const options = entry.options
    const configPresent = has(options, 'config')
    const config = configPresent ? options.config : {}
    if (!object(config)) throw new Error('目标配置不是对象，无法安全实验')
    const segs = spec.path.split('.')
    let node = config
    let parentMissing = false
    for (const seg of segs.slice(0, -1)) {
      if (!has(node, seg)) { parentMissing = true; break }
      if (!object(node[seg])) throw new Error('目标路径的父键不是对象，无法安全实验')
      node = node[seg]
    }
    const leaf = segs[segs.length - 1]
    return { configPresent, parentMissing, exists: !parentMissing && has(node, leaf), value: parentMissing ? undefined : node[leaf] }
  }
  function targetValue(entry, spec) {
    return getConfigPath(entry?.options?.config, spec.path)
  }
  // 不使用 setConfigPath 的 undefined 删除语义：存在但为 undefined 必须原样还原。
  function restoreOptions(entry, record) {
    const options = entry.options
    const config = options.config
    if (!object(config)) throw new Error('目标配置结构已改变')
    const nextConfig = { ...config }
    const segs = record.spec.path.split('.')
    let node = nextConfig
    const parents = []
    for (const seg of segs.slice(0, -1)) {
      if (!object(node[seg])) throw new Error('目标路径结构已改变')
      node[seg] = { ...node[seg] }
      parents.push({ node, seg })
      node = node[seg]
    }
    const leaf = segs[segs.length - 1]
    if (record.before.exists) node[leaf] = record.before.value
    else delete node[leaf]
    if (record.before.parentMissing) {
      for (let i = parents.length - 1; i >= 0; i--) {
        const { node: parent, seg } = parents[i]
        if (Reflect.ownKeys(parent[seg]).length === 0) delete parent[seg]
        else break
      }
    }
    const next = { ...options, config: nextConfig }
    if (!record.before.configPresent && Reflect.ownKeys(nextConfig).length === 0) next.config = undefined
    return next
  }
  function baselineMatches(entry, record) {
    try {
      const now = capture(entry, record.spec)
      return now.configPresent === record.before.configPresent && now.parentMissing === record.before.parentMissing &&
        now.exists === record.before.exists && (!now.exists || Object.is(now.value, record.before.value))
    } catch { return false }
  }
  async function doRestore() {
    const record = current
    restoreRequested = false
    phase = 'restoring'
    error = null
    try {
      const entry = findEntry(getLoader(), record.spec.target)
      // 恢复可能先改 options 再 reject；此时字段已非实验值，不证明 fiber
      // 已恢复。重试保守报 conflict，不能盲目再写或伪称自动恢复成功。
      if (entry !== record.entry || !Object.is(targetValue(entry, record.spec), record.spec.value)) {
        phase = 'conflict'
        error = '目标条目或字段已变化，未覆盖外部值。'
        return
      }
      const next = restoreOptions(entry, record)
      await entry.update(next)
      const after = findEntry(getLoader(), record.spec.target)
      if (after !== entry || !baselineMatches(after, record)) {
        phase = 'conflict'
        error = '恢复后回读不匹配或条目已变化，未确认恢复。'
        return
      }
      phase = 'restored'
    } catch {
      phase = 'restore_failed'
      error = '恢复更新失败或结果未知；未确认恢复。'
    }
  }
  async function doApply(record) {
    try {
      if (disposed || isEnabled() !== false || canStart() !== true) {
        phase = 'apply_failed'
        error = '总开关、实验门禁或控制器状态不允许更新。'
        return
      }
      const entry = findEntry(getLoader(), record.spec.target)
      if (entry !== record.entry || !baselineMatches(entry, record)) {
        phase = 'conflict'
        error = '更新前目标条目或字段已变化，未写入。'
        return
      }
      const nextConfig = setConfigPath(entry.options.config || {}, record.spec.path, record.spec.value)
      record.uncertain = true
      await entry.update({ ...entry.options, config: nextConfig })
      const after = findEntry(getLoader(), record.spec.target)
      if (after !== entry || !Object.is(targetValue(after, record.spec), record.spec.value)) {
        phase = 'conflict'
        error = '更新后回读不匹配或条目已变化，未确认写入。'
        return
      }
      phase = 'active'
      error = null
    } catch {
      // Entry.update 可能先改 options 再 reject；不能据 Promise 失败推断没写。
      try {
        const after = findEntry(getLoader(), record.spec.target)
        if (after === record.entry && baselineMatches(after, record)) {
          record.uncertain = false
          phase = 'apply_failed'
          error = '更新失败；配置回读仍为原值。'
        } else if (after === record.entry && Object.is(targetValue(after, record.spec), record.spec.value)) {
          phase = 'apply_failed'
          error = '更新失败但配置可能已改变，请恢复或明确放弃。'
        } else {
          phase = 'conflict'
          error = '更新失败且目标已变化，不能确认归属。'
        }
      } catch {
        phase = 'conflict'
        error = '更新失败，目标回读不可用。'
      }
    } finally {
      if (restoreRequested && (phase === 'active' || (phase === 'apply_failed' && record.uncertain))) await doRestore()
      else if (restoreRequested) restoreRequested = false
    }
  }
  function start(id) {
    if (disposed) return result(false, '实验控制器已关闭。')
    if (busy()) return result(false, '已有实验尚未完成或存在未处理冲突。')
    try {
      if (isEnabled() !== false) return result(false, '必须先关闭慢链路总开关。')
      if (canStart() !== true) return result(false, '此前慢链路配置更新尚未完成或发生失败，无法安全实验。')
    } catch {
      return result(false, '无法确认实验门禁，已拒绝启动。')
    }
    const spec = targets[id]
    if (!spec || !has(targets, id)) return result(false, '未知实验目标。')
    try {
      const entry = findEntry(getLoader(), spec.target)
      const before = capture(entry, spec)
      current = { id, spec, entry, before, uncertain: false }
      error = null
      restoreRequested = false
      if (before.exists && Object.is(before.value, spec.value)) {
        phase = 'unchanged'
        return result(true)
      }
      phase = 'applying'
      void doApply(current)
      return result(true)
    } catch {
      current = null
      phase = 'apply_failed'
      error = '目标缺失或配置结构无法安全实验。'
      return result(false, error)
    }
  }
  function restore() {
    if (phase === 'applying') {
      restoreRequested = true
      return result(true)
    }
    if (phase === 'active' || phase === 'restore_failed' || (phase === 'conflict' && current?.uncertain) ||
        (phase === 'apply_failed' && current?.uncertain)) {
      void doRestore()
      return result(true)
    }
    return result(false, '没有需要恢复的实验。')
  }
  function abandon() {
    if (phase !== 'conflict' && phase !== 'restore_failed' && !(phase === 'apply_failed' && current?.uncertain)) {
      return result(false, '当前状态不能放弃恢复。')
    }
    current = null
    phase = 'idle'
    error = null
    restoreRequested = false
    return result(true)
  }
  function dispose() {
    disposed = true
    if (phase === 'applying' || phase === 'active' || phase === 'restore_failed' ||
        (phase === 'apply_failed' && current?.uncertain)) restore()
  }
  return { start, restore, abandon, status, busy, dispose }
}
}
