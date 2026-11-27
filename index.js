/**
 * dsh-tweaks —— 宿主半（host half）。
 *
 * 这是一个**小改动登记处**：每个改动单独开关。目的是跨机同步 ——
 * 开关集合集中在一个 YAML 配置块里，于是「我开了哪些小开关」
 * 随 profile 一起走，而不是散落在十来个文件里靠记忆维持。
 *
 * 设计规则（对齐 dsh 架构说明）：
 *
 *  1. **配置是数据，不是代码。** 每个改动只有 `enabled: bool` 加少量参数。
 *     加一个改动 = `TWEAKS` 里加一行；启用它 = `cordis.patch.yml` 里加一行。
 *     不给任何改动做专属接线。
 *
 *  2. **改动落到 Loader 的条目上。** 一个改动的效果就是把目标条目的
 *     `disabled` 置为 true；这里用的是 Loader 自己提供的 `loader` 服务，
 *     不伸手进任何插件包的内部。关闭或卸载时把原值还原。
 *
 *  3. **幂等且可逆。** 重复应用不会叠加；`ctx.effect` 的清理回调负责还原。
 *
 *  4. **绝不阻塞启动。** 某个改动应用失败只记进状态路由然后跳过 ——
 *     应用照常启动。
 *
 *  5. **如实汇报。** `GET /dsh-tweaks/status` 对每个改动同时给出
 *     「是否启用」「是否应用成功」「目标条目此刻是否真的 disabled」，
 *     让「我开了但没反应」可查，而不是变成玄学。
 *
 * 路由（loopback，与 GUI 同源）：
 *   GET  /dsh-tweaks/status  —— 所有已知改动 + 配置 + 生效状态
 */

import z from '@deepseek-ai/schemastery'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-tweaks'

/** 路由前缀；所有路由都收在同一命名空间下，便于 grep。 */
export const ROUTE_PREFIX = '/dsh-tweaks'

/**
 * The tweak registry.
 *
 * `id`     — stable key used in `config.<id>.enabled`. Never rename casually:
 *            it is what a user's saved config refers to.
 * `title`  — human label (Chinese first, since the user-facing docs are Chinese).
 * `what`   — one short sentence: what it changes (the card body).
 * `why`    — long rationale, shown by the status route / hover.
 * `target` — the Loader entry id this tweak disables. Omitted = nothing to
 *            disable (the client half renders something instead).
 * `subject`— WHAT the tweak acts on. `kind` picks the status check
 *            (entry / plugin / file / host); `name`/`label` are for display.
 * `owner`  — WHICH thing the switch belongs to, for grouping in the UI.
 *            Deliberately separate from `subject.kind` so a single component's
 *            tweaks stay together regardless of how each is implemented.
 */
export const TWEAKS = Object.freeze([
  {
    id: 'slowLinkTimeouts',
    title: '慢链路连接就绪超时',
    default: true,
    what: '放宽实时连接的初始化就绪超时，实际效果尚未证实，不保证改善连接。',
    why:
      '连接就绪超时由每机 state.json 决定，默认 120000ms，出厂默认 15000ms；' +
      '关闭时尝试恢复改写前的基线值（可能由配置覆盖），并发修改时不能保证完全恢复。',
    subject: {
      kind: 'entry',
      name: 'connection',
      label: '连接就绪超时',
    },
    owner: { name: 'dsh', label: 'DeepSeek Harness', kind: 'host' },
    effect:
      '改写 connection 条目的 recovery.generationReadyTimeoutMs；关闭时尝试恢复改写前的值。',
    appliesWhen:
      '该 profile 里存在 connection（@deepseek-ai/dsh-client-connection）条目；' +
      '就绪超时可在下方可调参数里按机调整。',
    menu: true,
    // 「配置值类」改动：不是禁用条目，而是往目标条目的 config 写值。
    // 每项的 `tuning` 指向一个 TUNING 参数，取它的当前值作为要写入的值。
    configPatch: [
      { target: 'connection', path: 'recovery.generationReadyTimeoutMs', tuning: 'slowReadyTimeoutMs' },
    ],
  },
  {
    id: 'hideBuiltinDeepseek',
    title: '隐藏内置供应商',
    what: '模型列表里只留「DeepSeek 账号」，去掉重复的内置 API key 那一组。',
    why:
      '内置 llm-deepseek 是 API key 路由，和「DeepSeek 账号」（llm-deepseek-account）' +
      '在设置与模型下拉里并列出两组同名模型。只用账号登录时，把内置那组关掉，' +
      '列表里就只剩「DeepSeek 账号」。' +
      '边界：本开关只在配置了 DeepSeek API key 时才有意义 —— 没有 key 时 dsh 自己' +
      '就不把这个路由放进模型目录（discoverModels 返回空目录 → 目录按空组过滤掉），' +
      '模型下拉里本来就不会出现它；此时开不开都一样。两者的差别在于作用面：' +
      'dsh 的自动隐藏只影响模型选择器，Models 设置页那一行仍在（方便随时补 key）；' +
      '本开关禁用整条 Loader 条目，设置页那一行也一起消失。',
    // 生效对象：Loader 条目（宿主侧的插件行）。
    subject: { kind: 'entry', name: 'llm-deepseek', label: '内置 DeepSeek 供应商' },
    // 归属：DSH 自身的内置供应商条目。
    owner: { name: 'dsh', label: 'DeepSeek Harness', kind: 'host' },
    effect: '禁用该条目（disabled），不改任何文件。',
    appliesWhen:
      '该条目在当前 profile 里存在，且配置了 DeepSeek API key（无 key 时 dsh 已自动' +
      '隐藏该路由，本开关无可隐藏之物）。',
    target: 'llm-deepseek',
  },
  {
    id: 'sidebarFooterLayout',
    title: '修复侧边栏底部入口错位',
    what:
      'dsh-session-manager 的底部入口被拉高、偏右几乎看不到；这里把它按官方行样式摆正。',
    why:
      '同槽 CSS 冲突：dsh-m（插件市场）用 !important 把 sidebar.footer.action 改成 ' +
      'flex-direction:column，却只给自己的 .dshm-entry 补了 flex:none；' +
      'dsh-session-manager 的 .sm-footerBtn-wide 仍带着为 row 布局写的 ' +
      'flex:1 1 100% / width:calc(100% + 8px) / margin:4px -4px，进了列向容器' +
      '就被拉高、偏右几乎看不到。' +
      '本开关只给该槽位的 .sm-footerBtn-wide 补 flex:none + align-self:stretch + ' +
      '归零水平负 margin，选择器不命中 dsh-mobile 等同槽其它条目。' +
      '关掉即恢复原样（那条入口会重新错位——这是上游 dsh-m / ' +
      'dsh-session-manager 之间的缺陷，等它们自己修好即可关掉本开关）。',
    // 生效对象：浏览器界面的一个槽位（不是 Loader 条目，也不是磁盘文件）。
    // kind 用官方既有的 host（本插件不扩 subject.kind 取值集合）。
    subject: { kind: 'host', name: 'sidebar.footer.action', label: '侧边栏底部入口（sidebar.footer.action）' },
    // 归属：被这个缺陷弄坏的入口属于 dsh-session-manager。
    owner: { name: 'dsh-session-manager', label: '会话管理器 dsh-session-manager', kind: 'plugin' },
    effect:
      '浏览器半按本开关注入 / 摘除一段 CSS，只改该槽位的 .sm-footerBtn-wide 布局，' +
      '不碰任何插件文件。',
    appliesWhen:
      'dsh-m 与 dsh-session-manager 同时启用（dsh-m 会把该槽位改成列向），' +
      '且侧边栏处于展开态。',
    // 浏览器半渲染类改动：没有 Loader 条目可收敛，靠 menu 进列表。
    menu: true,
  },
  {
    // 多层级：一个主开关（是否启用重启入口）+ options 里的位置多选（勾哪里出现哪里）。
    // 位置选项的 id 同时是状态文件里的布尔键（restartFooter / restartHeader /
    // restartAgentTool）。2026-11-16 用户要求把原「重启宿主 · 智能体工具」独立补丁行
    // 并入这里 —— 它与本行本来就是同一套逻辑（同闸门、同交接流程），分开只是多一行。
    id: 'restartButton',
    title: '重启宿主',
    what: '干净退出当前宿主进程，由 helper 等它真正退场后再原样拉起。位置多选：侧栏底部图标 / 会话标签栏右上角图标，以及把重启注册成智能体工具 restart_dsh。',
    why:
      '官方没有能重启宿主的服务（hmr 只重载模块与配置，pluginManager 只改 profile 文件并报 ' +
      'restart-required），真重启只能自己退进程。旧实现「先拉起新进程再退出」会和新进程抢监听' +
      '端口；现在的交接式实现先启动 helper（Windows 桌面用 WMI 拉起独立 powershell，窗口隐藏；' +
      '网页版用 powershell -EncodedCommand / POSIX 用 sh），等 helper 就绪后再延迟 1 秒发退出命令，' +
      '由它等本进程退出、端口释放后再 Start-Process 原样拉起，两代进程不重叠。' +
      '桌面版 helper 主动点恢复框「重启」按钮（只点第一个匹配、排除「禁用」），' +
      '让主进程走 finishQuit() 干净退出（顺带清 tray 图标），退不动才兜底强杀。' +
      '本进程以退出码 0 干净关机；被打断的回合由 dsh-client-auto-continue 的启动恢复在下次' +
      '启动时续跑（该插件未装或未开启动恢复时，中断即中断，不丢已落盘的历史）。' +
      '两道闸门：状态文件里的「允许重启宿主」总闸（默认关）与本开关都要开，且走两段式令牌确认；' +
      '位置里的智能体工具 restart_dsh 与按钮共用这一整套交接流程，只是入口从「点按钮」换成' +
      '「会话里一句话」；它默认关，要单独点开。',
    // 生效对象：侧栏两处可点位置 + 智能体工具（宿主进程本身由 action 表达）。
    subject: { kind: 'host', name: 'sidebar', label: '侧栏重启入口（底部 / 右上角 / 智能体工具）' },
    owner: { name: 'dsh', label: 'DeepSeek Harness', kind: 'host' },
    effect:
      '浏览器半按主开关与位置选项，在侧栏对应位置注册 / 注入紧凑图标；点击后走两段式令牌确认；' +
      '勾了智能体工具时宿主半另外向 tools 服务注册 restart_dsh；' +
      '宿主进程本身由 /dsh-tweaks/restart 退出并交接。',
    appliesWhen:
      '「允许重启宿主」总闸已打开且本开关已打开；勾选的位置出现图标（底部：展开态叠设置行右端、收窄轨 36×36；右上角：会话标签栏右侧与 unlag 同排），勾了智能体工具则注册 restart_dsh。两项闸门都在本页控件里，不用改配置文件。',
    // 数据类改动：效果是一个动作（重启），不是禁用某个条目。
    action: 'restart',
    // 没有 target，靠 menu 进列表。
    menu: true,
    // 位置多选：id 同时是状态文件里的布尔键（顶部折叠按钮旁的入口已移除：
    // 会被标题行挤压，用户 2026-11-15 决定不保留）。
    // `defaultOff` 的选项在主开关打开时**不**跟着打开 —— 智能体工具属于
    // 「额外放开一条能退出宿主的通路」，必须单独点开（2026-11-16 用户要求
    // 把它从独立补丁行并入这里，但默认值不能跟着主开关翻）。
    options: [
      { id: 'restartFooter', label: '底部图标', note: '展开态在设置行右端，收窄轨 36×36' },
      { id: 'restartHeader', label: '右上角图标', note: '会话标签栏右侧（unlag 旁）' },
      {
        id: 'restartAgentTool',
        label: '智能体工具 restart_dsh',
        note: '把「重启宿主」注册成智能体可调用的工具；默认关，单独点开才生效',
        defaultOff: true,
      },
    ],
  },
])

/**
 * Config schema —— **只放不在运行时切换的参数**。
 *
 * 开关值（每个 tweak 的 enabled）**不在这里**：它们存在插件自己的状态文件
 * （`~/.dsh/.cache/dsh-tweaks/state.json`），切换走 `/dsh-tweaks/toggle`，
 * 写文件后就地重跑 apply/restore。
 *
 * 为什么不能放 Config：profile 是 `patchReload: live`，任何 `settings.update`
 * 写入都会让**本插件条目热重载**；条目一重载，客户端注册的 slot（含设置窗口的
 * 「增强补丁」分区）就随之销毁重建 —— 表现就是「点一下开关，整个界面闪一下/
 * 分区消失」。把开关移出 Config 才能让切换过程完全不碰条目生命周期。
 *
 * 用户会调的重启参数（允许重启的总闸、交接延迟、令牌有效期、工具倒计时）**也不在
 * 这里**，它们走同一个状态文件（见 TUNING），界面上直接给控件 —— 不必手改 profile
 * patch，改完也不需要重启宿主。
 *
 * 注意：这里的字段都**不加** `.volatile()`。平台的设置表单只投影带 `.volatile()`
 * 的字段，所以它们不会出现在表单里，也就没有第二个写入者。这是刻意的：本区块都是
 * 「基础设施参数」，改了要么没用，要么会与状态文件里的活值打架。
 */
export const Config = z.object({
  /** 是否暴露状态路由（默认开；它只读且在 loopback 上）。 */
  statusRoute: z.boolean().default(true),
  /**
   * 对账型改动的重断言上限：目标条目被反复弹回启用时，放弃并如实报
   * 「target flips back after disable」，避免无休止地改写别人的条目。
   */
  reassertLimit: z.number().default(10),
  /**
   * 兜底对账间隔（毫秒）。默认 0 = 只在启动与 Loader/插件组合变化时对账
   * （事件驱动，不轮询）；>0 才额外启用这个间隔的兜底定时器。
   */
  fallbackReconcileMs: z.number().default(0),
  /** 浏览器半的状态兜底刷新间隔（毫秒），由 /dsh-tweaks/status 下发给客户端。 */
  statusRefreshMs: z.number().default(600000),
  /** 跨机冷会话发现间隔（毫秒）；0 关闭。 */
  sessionDiscoveryMs: z.number().default(15000),
  /**
   * 是否暴露「客户端自报健康」路由（默认开）。
   *
   * 浏览器半把「我跑起来了没有 / 槽注册了没有 / 动画是不是被系统的减少动态效果
   * 关掉了」这些**只有浏览器侧知道**的事实 POST 上来，宿主如实存一份供人查看。
   * 这是插件里唯一接收浏览器写入的路由，收的是诊断快照，不参与业务逻辑。
   */
  clientHealthRoute: z.boolean().default(true),
})

/**
 * 用户会在界面上调的重启参数。
 *
 * 为什么不在 Config 里（2026-11-16 用户问「配置文件必须要自行修改吗」）：Config 落在
 * profile 的 `cordis.patch.yml`，改一次要手写 YAML 再重启宿主；而这几个参数本来就不
 * 需要「重启才生效」。放在状态文件里则：与补丁开关共用 `/toggle` 通道 → 立刻生效、
 * 不触发本插件条目热重载，还能在设置窗口的「增强补丁」页直接给出控件。
 *
 * `kind` 决定控件形态：`boolean` → 勾选框；`number` → 数字输入（`min` 为下限）。
 */
export const TUNING = Object.freeze([
  {
    id: 'allowRestart',
    tweakId: 'restartButton',
    kind: 'boolean',
    default: false,
    label: '允许重启宿主',
    note: '重启是唯一会让宿主进程退出的动作，必须显式打开；打开后才出现重启入口。',
  },
  {
    id: 'restartDelayMs',
    tweakId: 'restartButton',
    kind: 'number',
    default: 1000,
    min: 0,
    label: '交接延迟（毫秒）',
    note: '先把独立 helper 启起来，再等这么久发退出命令，避免窗口先关、helper 还没就位。',
  },
  {
    id: 'restartTokenMs',
    tweakId: 'restartButton',
    kind: 'number',
    default: 30000,
    min: 1000,
    label: '确认令牌有效期（毫秒）',
    note: '两段式确认的一次性令牌多久过期；过期要重新点一次。',
  },
  {
    id: 'restartToolCountdownMs',
    tweakId: 'restartButton',
    kind: 'number',
    default: 10000,
    min: 0,
    label: '智能体工具倒计时（毫秒）',
    note: 'restart_dsh 被调用后先在界面上弹倒计时，留出取消时间；0 表示不等待。',
  },
  {
    id: 'slowReadyTimeoutMs',
    tweakId: 'slowLinkTimeouts',
    kind: 'number',
    default: 120000,
    min: 15000,
    label: '连接就绪超时（毫秒）',
    note:
      'connection 的 recovery.generationReadyTimeoutMs：实时连接初始化期限。' +
      '默认 120000（出厂 15000）。放宽后实际效果尚未证实，不保证改善连接。',
  },
])

/** 归一一个可调参数的值：缺失或类型不对一律退回默认值，数字夹到下限。 */
export function tuningValue(state, tuning) {
  const raw = state?.[tuning.id]
  if (tuning.kind === 'boolean') return raw === true
  if (raw === undefined || raw === null || raw === '') return tuning.default
  const n = Number(raw)
  if (!Number.isFinite(n)) return tuning.default
  const min = typeof tuning.min === 'number' ? tuning.min : 0
  return n < min ? min : n
}

/** 可调参数快照，供 /status 下发给界面渲染控件。 */
export function describeTuning(state) {
  return TUNING.map((t) => ({
    id: t.id,
    tweakId: t.tweakId || null,
    kind: t.kind,
    label: t.label,
    note: t.note || null,
    min: typeof t.min === 'number' ? t.min : null,
    value: tuningValue(state, t),
  }))
}

/** 开关状态文件位置：本机 `.cache`，不进同步盘（属一次性运行时状态）。 */
export function statePath(dshHome) {
  return join(dshHome || dshHomePath(), '.cache', 'dsh-tweaks', 'state.json')
}

/**
 * 读开关状态文件。返回 `{ <tweakId>: boolean }`。
 * 文件缺失/损坏一律当「全关」，绝不抛错（启动不能被它拖住）。
 */
export function readState(dshHome) {
  try {
    const doc = JSON.parse(readFileSync(statePath(dshHome), 'utf8'))
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {}
    const out = {}
    for (const t of TWEAKS) out[t.id] = doc[t.id] === undefined ? t.default === true : doc[t.id] === true
    // 位置选项（restartButton.options 下）：id 是独立状态键，多选。
    // 旧版只有 restartButton 时，视为各位置都勾选（升级后入口不凭空消失）；
    // `defaultOff` 的选项例外 —— 它必须由用户单独点开，不被主开关带起来。
    const restart = TWEAKS.find((t) => t.id === 'restartButton')
    for (const opt of (restart && restart.options) || []) {
      const value = doc[opt.id]
      if (value === undefined && opt.defaultOff === true) {
        out[opt.id] = false
        continue
      }
      out[opt.id] = value === undefined ? out.restartButton === true : value === true
    }
    // 旧键迁移：`restartTool` 曾是独立补丁行，2026-11-16 并入 restartButton
    // 的位置选项 `restartAgentTool`。老状态文件里若显式开过，升级后不该被关掉。
    if (doc.restartTool === true && doc.restartAgentTool === undefined) out.restartAgentTool = true
    // 可调参数（TUNING）与开关同住一个文件：缺失/类型不对一律退回默认值，
    // 这样界面上永远能显示出一个可用的数字。
    for (const t of TUNING) out[t.id] = tuningValue(doc, t)
    return out
  } catch {
    const out = Object.fromEntries(TWEAKS.map((t) => [t.id, t.default === true]))
    for (const t of TUNING) out[t.id] = tuningValue(undefined, t)
    return out
  }
}

/** 写开关状态文件（临时文件 + rename 原子替换），失败返回 false 不抛。 */
export function writeState(dshHome, next) {
  const file = statePath(dshHome)
  const tmp = file + '.tmp'
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    try { rmSync(tmp, { force: true }) } catch {}
    return false
  }
}

/** 从状态对象里解出某个改动的实际启用状态。 */
export function isEnabled(state, id) {
  return state?.[id] === true
}

/** 所有已知改动及其开关状态快照，供状态路由使用。 */
export function describeTweaks(config, applied) {
  return TWEAKS.map((t) => {
    const enabled = isEnabled(config, t.id)
    const state = applied.get(t.id)
    const subject = describeSubject(t, undefined, enabled, state)
    return {
      id: t.id,
      title: t.title,
      what: t.what || null,
      why: t.why,
      target: t.target ?? null,
      action: t.action ?? null,
      enabled,
      applied: applied.has(t.id),
      error: state?.error ?? null,
      subject: t.subject || null,
      owner: t.owner || null,
      ownerName: t.owner?.name ?? null,
      ownerLabel: t.owner?.label ?? null,
      ownerKind: t.owner?.kind ?? null,
      group: t.group ?? null,
      subjectKind: t.subject?.kind ?? null,
      subjectLabel: t.subject?.label ?? null,
      subjectStatus: subject.status,
      subjectStatusLabel: subject.label,
      effect: t.effect || null,
      appliesWhen: t.appliesWhen || null,
    }
  })
}

/**
 * Verify a tweak's declared `target` entry actually exists in the live config
 * tree. Pure helper so the test harness can cover it without a ctx.
 *
 * Returns `{ ok, present, reason }`. When there is no tree to inspect (bundle
 * config not reachable from this plugin) we return `{ ok: true, present: null }`
 * and say so — an unverifiable target must not be reported as a failure, or
 * every status call would look broken.
 */
export function checkTarget(target, tree) {
  if (!target) return { ok: true, present: null, reason: 'no target declared' }
  if (!Array.isArray(tree)) return { ok: true, present: null, reason: 'config tree not visible from plugin' }
  const hit = tree.find((e) => e && (e.id === target || e.name === target))
  return hit
    ? { ok: true, present: true, reason: `found ${target}` }
    : { ok: false, present: false, reason: `target ${target} is not in the config tree` }
}

/** 取 Loader 服务（Cordis Loader 以 `loader` 名注册）。取不到返回 undefined。 */
export function loaderOf(ctx) {
  try {
    return ctx?.get ? ctx.get('loader') : undefined
  } catch {
    return undefined
  }
}

function dshHomePath() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * 本插件 Config 的落点（profile 的 cordis.patch.yml）。
 *
 * 为什么是这里而不是 ③ `~/.dsh/cordis.patch.yml`：③ 里**必须留空** dsh-tweaks 段，
 * 否则 settings.update 会报「Configuration for "dsh-tweaks" is overridden by a home
 * patch」并拒绝写入。config 参数（statusRoute 等）由设置窗口写进 ② profile patch；
 * 重启那几项不在 Config 而在状态文件（见 TUNING），所以界面上改它们不碰 patch 层。
 */
export function configFilePath(environment = process.env) {
  const home = environment.DSH_HOME || dshHomePath()
  const profile = environment.DSH_PROFILE || 'desktop'
  return join(home, 'profiles', profile, 'cordis.patch.yml')
}

/**
 * 用系统里的编辑器打开配置文件（只打开 configFilePath 算出来的那个）。
 * 依次试 VS Code → 系统默认关联；不接收任意路径 —— 调用方传进来的 file
 * 一律忽略，避免这个路由变成「点一下就能打开任意文件」。
 *
 * 用 detached + unref 的 `spawn`：编辑器是长驻进程，用 spawnSync 会把宿主
 * 卡到用户关掉编辑器为止（`start`/`notepad` 也一样，多数编辑器不立刻返回）。
 */
export function openConfigFile({ spawnHost = spawn, file = configFilePath(), platform = process.platform } = {}) {
  const target = file || configFilePath()
  const candidates = platform === 'win32'
    ? [['code.cmd', [target]], ['cmd.exe', ['/c', 'start', '', target]]]
    : [['code', [target]], ['xdg-open', [target]]]
  for (const [command, argv] of candidates) {
    try {
      const child = spawnHost(command, argv, {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
        shell: platform === 'win32' && command.endsWith('.cmd'),
      })
      if (child && typeof child.unref === 'function') child.unref()
      return { ok: true, file: target, opener: command }
    } catch {}
  }
  return { ok: false, file: target, error: '起不来编辑器（试过 ' + candidates.map((c) => c[0]).join(' / ') + '）' }
}


// ── 优雅重启宿主进程（restartButton 主开关 + 位置选项）──────────────────
// 官方没有任何 Host 服务能做这件事（`ctx.hmr` 只重载模块与配置、覆盖不到
// node_modules；`pluginManager` 只改 profile 文件并在结果里报 restart-required），
// 所以真重启只能由本插件自己退出当前进程、再拉起同一个可执行文件。
//
// 「优雅」在哪：不是「先拉起新进程、再退旧的」（那会和新进程抢监听端口/单例锁），
// 而是先启动一个 helper 子进程，由它等本进程**真正退出**、端口释放之后，
// 再把宿主按原命令行原样拉起。本进程退出码 0 = 干净关机，不弹崩溃提示；
// 被打断的会话由 dsh-client-auto-continue 的启动恢复在下次启动时续跑。
//
// 两道闸门守住它：`allowRestart`（TUNING 总闸，默认 false）与任一重启入口开关
// 开关都要开，且必须走「先取令牌、再带令牌确认」两段式——重启会硬断所有会话。
//
// 历史：这份能力曾以硬重启形态存在，后整段迁出到「独立插件 dsh-restart」并
// 删除；那个目标插件从未发布（GitHub 404），此处是回归后的交接式重写。
//
// 桌面版（Electron 壳）：宿主退出会被主进程当成异常并弹崩溃恢复框，因此桌面下
// 改为「先结束主进程 → 宿主随 IPC 断开优雅停机 → helper 重新打开应用」，不再 exit(0)。

/** 本机可执行文件路径（Electron 桌面宿主）。取不到就如实报，不硬编路径。 */
export function hostExecutable() {
  const candidates = [
    process.env.DSH_HOST_EXECUTABLE,
    process.execPath,
    process.argv0,
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return null
}

/**
 * Windows 交接脚本：等旧进程退出，再原样拉起。
 * 用 `powershell -EncodedCommand`（base64 utf16le）传给 helper，
 * 避开多层引号转义；Wait-Process 对已退出的进程静默成功，天然幂等。
 */
/**
 * 是否运行在 Electron 桌面壳的宿主子进程里（桌面主进程以 stdio ipc 拉起宿主）。
 * 桌面下宿主退出会被主进程判定为异常（无论退出码）并弹崩溃恢复框，
 * 所以桌面版的重启必须换成「先结束主进程」的交接方式，见 restartHost。
 */
export function isDesktopShell(environment = process.env, ipcConnected = process.connected, send = process.send) {
  return environment.ELECTRON_RUN_AS_NODE === '1' && ipcConnected === true && typeof send === 'function'
}

/**
 * Windows 桌面版交接脚本：**只负责把旧实例收干净，然后无参数重开应用**。
 *
 * 为什么不往主进程窗口发 WM_QUERYENDSESSION / WM_ENDSESSION 了（2026-11-17 改）：
 * 那个「伪造系统会话结束」的做法**根本达不到目的**。平台主进程里只有
 * `finishQuit()` 会执行 `tray.dispose()`（把托盘图标摘掉），而走到 finishQuit
 * 的前提是 `sessionEnding` 已被置位 —— 它只由 Electron 的 `session-end` 事件
 * （Windows 上仅在真正注销/会话结束时才触发）或 `powerMonitor` 的 shutdown
 * 事件置位，伪造 WM_ENDSESSION 两个都触发不了。窗口于是走 `close` 的
 * preventDefault 分支缩进托盘，进程不死，最后被强杀 → `tray.dispose()` 从没执行
 * → **托盘留下一枚 ghost 图标**（2026-11-15 用户反馈的「托盘图标残留」）。
 *
 * 现在的做法：宿主（插件所在的那个子进程）**自己优雅退出**
 * （Cordis 的 `cmdline.exit(0)` → desktop-host 的 shutdown 链 → 干净退出）。
 * 主进程看到宿主退出会判定为失败并弹「启动失败」原生对话框；用户点「重新启动」
 * 时主进程走 `app.relaunch()` + `quitWithoutConfirmation()` → `finishQuit()` →
 * `tray.dispose()` —— **托盘干净**。代价是弹一次对话框，这是平台当前唯一的
 * 恢复路径（平台没有给插件「让主进程重启自己」的通道，见平台缺陷卡）。
 *
 * 脚本职责收窄成三件事：等宿主退场 → 兜底清掉残留进程 → 重开应用。
 * 旧实例的单实例锁可能还没释放，重开做 3 轮重试（每轮间隔 3 秒）。
 * 所有步骤写 %TEMP%\dsh-tweaks-restart.log，便于事后核验。
 */
export function windowsDesktopHandoffScript(hostPid, parentPid, executable, delayMs = 1000) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"
  const exeCmd = '"' + String(executable).replace(/"/g, '') + '"'
  const HP = Number(hostPid)
  const PP = Number(parentPid)
  // 注意：本模板里 PowerShell 变量一律写成裸 $var（JS 模板串只插值 ${...}，裸 $ 原样保留）；
  // 只有 ${HP}/${PP}/${delayMs}/${q(exeCmd)} 是有意注入的 JS 值。切勿用 PS 的 ${var} 写法。
  return (
    `$log = Join-Path $env:TEMP 'dsh-tweaks-restart.log'; ` +
    `function dtwlog($m) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format o), $m) -ErrorAction SilentlyContinue }; ` +
    `dtwlog 'start'; ` +
    // 用户要求：先启 helper，再延迟 1 秒（默认 delayMs=1000）开始交接。
    `Start-Sleep -Milliseconds ${Number(delayMs)}; dtwlog 'delay done'; ` +
    // 等宿主自己退场（宿主侧会调 cmdline.exit(0) 走干净退出链）。
    `Wait-Process -Id ${HP} -Timeout 30 -ErrorAction SilentlyContinue; ` +
    `if (Get-Process -Id ${HP} -ErrorAction SilentlyContinue) { dtwlog 'host still alive, forcing' } else { dtwlog 'host exited' }; ` +
    `Stop-Process -Id ${HP} -Force -ErrorAction SilentlyContinue; ` +
    // 主进程：宿主退出会让它弹「启动失败」恢复框，默认按钮(defaultId:1)就是「重新启动」，
    // 点它走 app.relaunch()+quitWithoutConfirmation()→finishQuit()→tray.dispose()→托盘干净。
    // 用户未必会去点那个原生框，所以 helper 主动找到恢复框里的「重新启动」按钮并按下（BM_CLICK）。
    // 只点**第一个**匹配「重启/重新启动/Restart」且**不含「禁用/Disable」**的 Button——
    // 「禁用第三方插件」按钮文案里也带「重启」二字，若不排除会被误点而把插件全禁掉。
    // 先枚举主进程的窗口/按钮并记日志（便于核验对话框结构），再点击；退不动才兜底强杀。
    `$cs = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DtwWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public static uint PidOf(IntPtr h){ uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static string ClassOf(IntPtr h){ var sb=new StringBuilder(256); GetClassName(h,sb,256); return sb.ToString(); }
  public static string TextOf(IntPtr h){ var sb=new StringBuilder(512); GetWindowText(h,sb,512); return sb.ToString(); }
}
'@; ` +
    `$dtwOk = $false; try { Add-Type -TypeDefinition $cs -Language CSharp -ErrorAction Stop; $dtwOk = $true } catch { dtwlog ("addtype: " + $_.Exception.Message) }; ` +
    `function Try-RestartDialog { ` +
    `if (-not $dtwOk) { return }; ` +
    `$clicked = $false; ` +
    `$wins = New-Object System.Collections.ArrayList; ` +
    `$cb = [DtwWin+EnumProc]{ param($h,$l) if ([DtwWin]::PidOf($h) -eq ${PP}) { [void]$wins.Add($h) }; return $true }; ` +
    `[DtwWin]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null; ` +
    `$fg = [DtwWin]::GetForegroundWindow(); dtwlog ("fg cls=" + [DtwWin]::ClassOf($fg) + " title=" + [DtwWin]::TextOf($fg)); ` +
    `foreach ($h in $wins) { ` +
    `$cls = [DtwWin]::ClassOf($h); $txt = [DtwWin]::TextOf($h); $vis = [DtwWin]::IsWindowVisible($h); ` +
    `dtwlog ("win cls=" + $cls + " vis=" + $vis + " title=" + $txt); ` +
    `if (-not $vis) { continue }; ` +
    `$kids = New-Object System.Collections.ArrayList; ` +
    `$ccb = [DtwWin+EnumProc]{ param($c,$l) [void]$kids.Add($c); return $true }; ` +
    `[DtwWin]::EnumChildWindows($h, $ccb, [IntPtr]::Zero) | Out-Null; ` +
    `$idx = 0; foreach ($c in $kids) { $cc = [DtwWin]::ClassOf($c); $ct = [DtwWin]::TextOf($c); if ($cc -eq 'Button') { dtwlog ("  child[" + $idx + "] cls=" + $cc + " text=" + $ct) }; ` +
    `if ((-not $clicked) -and $cc -eq 'Button' -and $ct -match 'Restart|重新启动|重启' -and $ct -notmatch '禁用|Disable') { dtwlog ("  clicking restart child[" + $idx + "]"); [DtwWin]::SendMessage($c, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null; $clicked = $true }; $idx++ } ` +
    `} }; ` +
    // 等主进程自退（最多 100×200ms=20s），期间每 2s 尝试按一次恢复框的「重新启动」。
    `$i = 0; while ($i -lt 100 -and (Get-Process -Id ${PP} -ErrorAction SilentlyContinue)) { ` +
    `if ($i % 10 -eq 0) { try { Try-RestartDialog } catch { dtwlog ("dialog: " + $_.Exception.Message) } }; ` +
    `Start-Sleep -Milliseconds 200; $i++ }; ` +
    `if (Get-Process -Id ${PP} -ErrorAction SilentlyContinue) { ` +
    `dtwlog 'main still alive, killing'; ` +
    `try { [System.Diagnostics.Process]::GetProcessById(${PP}).Kill() | Out-Null; dtwlog 'killed main' } catch { dtwlog ("kill main: " + $_.Exception.Message) } ` +
    `} else { dtwlog 'main already gone' }; ` +
    `Start-Sleep -Milliseconds 1200; ` +
    `for ($t = 0; $t -lt 3; $t++) { dtwlog ("relaunch try " + $t); ` +
    `try { $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${q(exeCmd)} }; dtwlog ("wmi rc=" + $r.ReturnValue + " pid=" + $r.ProcessId) } catch { dtwlog ("wmi error: " + $_.Exception.Message) }; ` +
    `Start-Sleep -Seconds 3; if (@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -gt 0) { dtwlog 'app alive'; break } }; ` +
    `dtwlog 'done'`
  )
}

/**
 * 经 WMI 独立拉起桌面交接 helper：进程父级是 WmiPrvSE，脱离 DSH 的进程树
 * （宿主/主进程退出或被 job 对象清树都不会带走它）。用同步 spawnSync 拉起，
 * 确保 WMI 创建已落定再返回，避免宿主抢在 helper 之前退出。
 */
export function desktopHandoffLauncherScript(scriptPath) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"
  const helper = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + String(scriptPath).replace(/"/g, '') + '"'
  return (
    `$log = Join-Path $env:TEMP 'dsh-tweaks-restart.log'; ` +
    `try { $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${q(helper)} }; ` +
    `Add-Content -Path $log -Value ("{0} launcher wmi rc={1} pid={2}" -f (Get-Date -Format o), $r.ReturnValue, $r.ProcessId) -ErrorAction SilentlyContinue } ` +
    `catch { Add-Content -Path $log -Value ("{0} launcher error: {1}" -f (Get-Date -Format o), $_.Exception.Message) -ErrorAction SilentlyContinue; exit 1 }`
  )
}

/** POSIX 桌面版交接脚本：同语义（延迟 → 杀主进程 → 等宿主退场 → 兜底强杀 → 延时后重开应用）。 */
export function posixDesktopHandoffScript(hostPid, parentPid, executable, delayMs = 1000) {
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
  const sleepSec = Math.max(0, Number(delayMs) || 0) / 1000
  return (
    `sleep ${sleepSec}; ` +
    `kill -9 ${Number(parentPid)} 2>/dev/null; ` +
    `i=0; while kill -0 ${Number(hostPid)} 2>/dev/null && [ $i -lt 50 ]; do sleep 0.2; i=$((i+1)); done; ` +
    `kill -9 ${Number(hostPid)} 2>/dev/null; ` +
    `sleep 2; exec ${q(executable)}`
  )
}

export function windowsHandoffScript(pid, executable, argv) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`
  const args = argv.map(q).join(' ')
  return (
    `Wait-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; ` +
    `Start-Process -FilePath ${q(executable)}${args ? ` -ArgumentList ${args}` : ''}`
  )
}

/** POSIX 交接脚本：同语义（sh 轮询 kill -0，最后 exec 换身）。 */
export function posixHandoffScript(pid, executable, argv) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
  const args = argv.map(q).join(' ')
  return `while kill -0 ${Number(pid)} 2>/dev/null; do sleep 0.2; done; exec ${q(executable)}${args ? ` ${args}` : ''}`
}

/**
 * 退出并（经由 helper）重新拉起宿主。返回 `{ ok, executable, delayMs, error }`。
 * 先把 HTTP 响应冲出去（调用方负责先 response.end），再延迟交接，
 * 否则浏览器会先看到连接被掐断而不是「正在重启」。
 * spawnHost/exit/pid 可注入，供测试在不动真进程的前提下验证交接形态。
 */
/**
 * 让本进程（宿主）优雅退出。
 *
 * 首选 Cordis 的 `cmdline` 服务：平台在 runProfile 里 provide 了
 * `cmdline.exit(code)`，它会走 desktop-host 的 shutdown 链（dispose → 退出码 0），
 * 是**干净**的退出。拿不到就退回 process.exit(0)。
 *
 * 为什么不自己去杀主进程：桌面版的托盘图标只有主进程走 finishQuit() 才会被摘掉，
 * 而那条路必须由主进程自己发起（app.relaunch / quitWithoutConfirmation）。
 * 插件能触发的只有「宿主退出」这一条，而它正好会让主进程进入平台自己的恢复流程
 * —— 那是平台当前唯一能走到 finishQuit() 的入口。
 *
 * @param gracefulExit - 可注入的退出动作（单测用）。
 */
export function requestGracefulExit(gracefulExit = null) {
  const fallback = () => {
    try { process.exit(0) } catch {}
  }
  if (typeof gracefulExit === 'function') {
    try { gracefulExit(0) } catch { fallback() }
    return
  }
  try {
    const cmdline = globalThis.__DSH_TWEAKS_CMDLINE__
    if (cmdline && typeof cmdline.exit === 'function') {
      cmdline.exit(0)
      return
    }
  } catch {}
  fallback()
}

export async function restartHost({
  delayMs = 1000,
  spawnHost = spawn,
  spawnSyncHost = spawnSync,
  writeScript = writeFileSync,
  pid = process.pid,
  exit = process.exit,
  desktop = isDesktopShell(),
  parentPid = process.ppid,
  /**
   * 桌面版：让**本进程**（宿主）优雅退出的动作。
   *
   * 为什么需要它：桌面版的托盘图标只有主进程走 `finishQuit()` 才会被摘掉，
   * 而主进程只有「宿主退出被判定为失败 → 弹恢复框 → 用户点重新启动」这条路上
   * 才会走 finishQuit。所以本插件在桌面版**不杀主进程**，而是让宿主自己干净退出，
   * 把主进程交给平台的恢复流程去处理（托盘因此干净，见 windowsDesktopHandoffScript
   * 的长注释）。默认取 Cordis 的 cmdline 服务；拿不到就退回 process.exit(0)。
   */
  gracefulExit = null,
} = {}) {
  const executable = hostExecutable()
  if (!executable) {
    return { ok: false, error: '取不到宿主可执行文件路径（process.execPath 不可用）' }
  }
  const argv = process.argv.slice(1)
  // 桌面版：不能自己 exit（主进程会把宿主退出当崩溃并弹框），改为先结束主进程再重开应用。
  const handoffToDesktop = desktop && Number.isSafeInteger(parentPid) && parentPid > 0 && parentPid !== pid
  // 桌面版：helper 先启、退出命令延迟 delayMs（由脚本内 sleep 完成），这里不再额外等；
  // 网页版：helper 先启，delayMs 后 exit(0)（setTimeout 由调用方/本函数统一承担）。
  const preDelayMs = handoffToDesktop ? 0 : delayMs
  return new Promise((resolve) => {
    setTimeout(() => {
      try {
        if (handoffToDesktop && process.platform === 'win32') {
          // 桌面版：先把交接脚本落成临时 .ps1，再由 WMI 以独立进程拉起它
          // （父进程 WmiPrvSE，脱离 DSH 进程树，主进程退出不会带走 helper）。
          const scriptPath = join(tmpdir(), `dsh-tweaks-handoff-${pid}-${Date.now()}.ps1`)
          const script = windowsDesktopHandoffScript(pid, parentPid, executable, delayMs)
          writeScript(scriptPath, '\ufeff' + script.replace(/\n/g, '\r\n'), 'utf8')
          const launch = desktopHandoffLauncherScript(scriptPath)
          const result = spawnSyncHost(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(launch, 'utf16le').toString('base64')],
            { stdio: 'ignore', windowsHide: true },
          )
          if (!result || result.status !== 0) {
            resolve({ ok: false, executable, delayMs, error: '启动桌面交接 helper 失败（WMI 拉起未成功）' })
            return
          }
          resolve({ ok: true, desktop: true, executable, delayMs })
          // helper 已就位，本进程现在优雅退出（桌面版：主进程会看到宿主退出，
          // 弹「启动失败」恢复框；用户点「重新启动」时主进程走 app.relaunch()
          // → finishQuit() → tray.dispose()，托盘图标干净）。
          requestGracefulExit(gracefulExit)
          return
        }
        let child
        if (process.platform === 'win32') {
          const script = handoffToDesktop
            ? windowsDesktopHandoffScript(pid, parentPid, executable, delayMs)
            : windowsHandoffScript(pid, executable, argv)
          child = spawnHost(
            'powershell.exe',
            [
              '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
              '-EncodedCommand',
              Buffer.from(script, 'utf16le').toString('base64'),
            ],
            { stdio: 'ignore', windowsHide: true },
          )
        } else {
          const script = handoffToDesktop
            ? posixDesktopHandoffScript(pid, parentPid, executable, delayMs)
            : posixHandoffScript(pid, executable, argv)
          child = spawnHost('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' })
        }
        if (child && typeof child.unref === 'function') child.unref()
      } catch (error) {
        resolve({ ok: false, executable, delayMs, error: `启动交接 helper 失败：${String((error && error.message) || error)}` })
        return
      }
      if (handoffToDesktop) {
        // 桌面版（POSIX 分支）：主进程马上会被 helper 结束；本进程随 IPC 断开
        // 由主进程 stop() 优雅停机。这里同样让本进程优雅退出。
        resolve({ ok: true, desktop: true, executable, delayMs })
        requestGracefulExit(gracefulExit)
        return
      }
      // 网页版：helper 已在等本进程退场；现在退掉旧的（退出码 0 = 干净关机）。
      exit(0)
      resolve({ ok: true, executable, delayMs })
    }, preDelayMs)
  })
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => resolve(body))
    req.on('error', () => resolve(''))
  })
}

/** 在 Loader 的条目树里按 id 找条目（含 group 里的嵌套条目）。 */
export function findEntry(loader, id) {
  if (!loader || !id) return undefined
  const direct = loader.store && loader.store[id]
  if (direct) return direct
  if (typeof loader.entries === 'function') {
    for (const entry of loader.entries()) {
      if (entry && entry.options && entry.options.id === id) return entry
    }
  }
  return undefined
}

/**
 * 仅读取两个宿主 fiber 已解析的配置值，绝不返回其它配置字段。
 * ACTIVE=2 是当前 Cordis FiberState 的值；effectiveConfig 在卸载后仍可读，
 * 因此必须同时检查 state 和 inertia。这里不证明 mux timer 或手机 Controller。
 */
export function observeSlowLinkValues(loader) {
  const limitation = '仅为宿主 fiber 已解析配置，不代表实际网关 mux 定时器或 Android Controller 的运行值，也不能作为连接状态判据。'
  const unavailable = (status) => ({ status, fiberState: null, pending: false, value: null })
  // local id 可能在不同 subtree 内重复；不可枚举时不能仅凭 store 的首项猜唯一。
  function select(target, expectedName) {
    if (!loader || typeof loader.entries !== 'function') return { status: 'unverifiable' }
    let matches
    try {
      matches = new Set()
      for (const entry of loader.entries()) {
        if (entry?.options?.id === target) matches.add(entry)
      }
    } catch {
      return { status: 'unverifiable' }
    }
    if (matches.size === 0) return { status: 'entry_missing' }
    if (matches.size !== 1) return { status: 'ambiguous' }
    const entry = matches.values().next().value
    if (entry.options?.name !== expectedName) return { status: 'identity_unverified' }
    return { entry }
  }
  function observe(target, path, expectedName) {
    try {
      const first = select(target, expectedName)
      if (first.status) return unavailable(first.status)
      const entry = first.entry
      const fiber = entry.fiber
      if (!fiber) return unavailable('fiber_missing')
      const state = fiber.state
      const fiberState = Number.isInteger(state) && state >= 0 && state <= 5 ? state : null
      const pending = fiber.inertia != null
      if (pending) return { status: 'transitioning', fiberState, pending: true, value: null }
      if (state !== 2) return { status: 'inactive', fiberState, pending: false, value: null }
      const value = getConfigPath(fiber.effectiveConfig, path)
      // 取值后重新枚举并确认唯一身份，以及同一 fiber 的生命周期。
      const last = select(target, expectedName)
      if (last.status) return unavailable(last.status)
      if (last.entry !== entry || entry.fiber !== fiber) return unavailable('fiber_changed')
      const finalState = fiber.state
      const finalStateValue = Number.isInteger(finalState) && finalState >= 0 && finalState <= 5 ? finalState : null
      if (fiber.inertia != null) return { status: 'transitioning', fiberState: finalStateValue, pending: true, value: null }
      if (finalState !== 2) return { status: 'inactive', fiberState: finalStateValue, pending: false, value: null }
      if (value === undefined || value === null) return { status: 'value_missing', fiberState, pending: false, value: null }
      if (typeof value !== 'number' || !Number.isFinite(value)) return { status: 'value_invalid', fiberState, pending: false, value: null }
      return { status: 'observed', fiberState, pending: false, value }
    } catch {
      return { status: 'error', fiberState: null, pending: false, value: null, error: '读取宿主配置失败。' }
    }
  }
  return {
    heartbeat: observe('typert-gateway', 'websocketHeartbeatIntervalMs', '@deepseek-ai/dsh-api-gateway'),
    ready: observe('connection', 'recovery.generationReadyTimeoutMs', '@deepseek-ai/dsh-client-connection'),
    limitation,
  }
}

/**
 * 把条目收敛到「禁用」。返回 `{ before, changed }` 供回滚。
 * 已经禁用时不动它，避免每次启动都重复 update。
 */
export function disableEntry(entry) {
  const before = entry?.options ? entry.options.disabled : undefined
  if (!entry || entry.disabled === true) return { before, changed: false }
  const task = entry.update({ ...entry.options, disabled: true })
  if (task && typeof task.catch === 'function') task.catch(() => {})
  return { before, changed: true }
}

/** 回滚 `disableEntry`：把 `disabled` 还原成应用前的值。 */
export function restoreEntry(entry, before) {
  if (!entry || !entry.options || entry.options.disabled !== true) return
  const next = { ...entry.options }
  if (before === undefined) delete next.disabled
  else next.disabled = before
  const task = entry.update(next)
  if (task && typeof task.catch === 'function') task.catch(() => {})
}

/** 取嵌套配置值：`'a.b.c'` 逐段下钻；任意一段缺失即 undefined。 */
export function getConfigPath(obj, path) {
  if (!obj || typeof path !== 'string' || !path) return undefined
  let cur = obj
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur
}

/**
 * 以不可变方式写嵌套配置值：`'a.b.c'` 逐段浅拷贝，不改动入参。
 * `value === undefined` 表示删除该叶键（回滚「原本没这个键」时用）。
 */
export function setConfigPath(obj, path, value) {
  const segs = String(path).split('.').filter(Boolean)
  if (!segs.length) return obj
  const root = { ...(obj || {}) }
  let cur = root
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]
    const child = cur[seg]
    if (child == null || typeof child !== 'object') {
      if (value === undefined) return root
      cur[seg] = {}
    } else {
      cur[seg] = { ...child }
    }
    cur = cur[seg]
  }
  const leaf = segs[segs.length - 1]
  if (value === undefined) delete cur[leaf]
  else cur[leaf] = value
  return root
}

/**
 * 「配置值类」改动的收敛：把 `items`（[{ target, path, value }]）逐条写进目标条目的
 * config。已经等于目标值的不动；返回 `{ before, changed, errors }`，`before` 记下
 * 被改之前的值，供 `restoreConfigPatch` 回滚。
 */
export function applyConfigPatch(loader, items) {
  const before = []
  const errors = []
  let changed = false
  for (const item of items || []) {
    const entry = findEntry(loader, item.target)
    if (!entry || !entry.options) {
      errors.push(`target ${item.target} is not in the loader tree`)
      continue
    }
    const config = entry.options.config || {}
    const current = getConfigPath(config, item.path)
    if (Object.is(current, item.value)) continue
    before.push({ target: item.target, path: item.path, value: current })
    const nextConfig = setConfigPath(config, item.path, item.value)
    const task = entry.update({ ...entry.options, config: nextConfig })
    if (task && typeof task.catch === 'function') task.catch(() => {})
    changed = true
  }
  return { before, changed, errors }
}

/** 回滚 `applyConfigPatch`：把记下的原值逐条写回（原值缺失则删除叶键）。 */
export function restoreConfigPatch(loader, before) {
  if (!Array.isArray(before)) return
  for (const item of before) {
    const entry = findEntry(loader, item.target)
    if (!entry || !entry.options) continue
    const config = entry.options.config || {}
    const current = getConfigPath(config, item.path)
    if (Object.is(current, item.value)) continue
    const nextConfig = setConfigPath(config, item.path, item.value)
    const task = entry.update({ ...entry.options, config: nextConfig })
    if (task && typeof task.catch === 'function') task.catch(() => {})
  }
}

/** 取一个「正整数」配置值；非法或缺失时回退到 fallback。 */
function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/** 取一个「非负整数」配置值；非法或缺失时回退到 fallback（0 = 关闭该定时器）。 */
function nonNegativeInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

/**
 * 发现由其它设备同步过来的持久会话，并通过官方事件把新摘要推给客户端。
 * 不恢复 Agent、不写会话日志；只维护派生投影缓存与本机 workspace 归属。
 */
export function createSessionDiscovery(ctx, intervalMs = 15000) {
  const delay = nonNegativeInt(intervalMs, 15000)
  const persistence = ctx?.sessionPersistence
  const registry = ctx?.workspaceRegistry
  const controller = ctx?.sessionController
  const query = ctx?.sessionQuery
  const projectionCache = ctx?.sessionProjectionCache
  const sessions = ctx?.sessions
  if (
    delay === 0 || !persistence || typeof persistence.list !== 'function' ||
    !registry || typeof registry.resolveByPath !== 'function' ||
    !controller || typeof controller.list !== 'function' ||
    !query || typeof query.readSession !== 'function' ||
    !projectionCache || typeof projectionCache.coldSnapshot !== 'function'
  ) return () => {}

  const startedAt = Date.now()
  const startupGraceMs = Math.max(delay * 2, 300000)
  const revisions = new Map()
  const eligible = new Set()
  const handled = new Map()
  const errors = new Map()
  /**
   * 本插件**亲自推给客户端**的会话 id（api-session/added 的收件人）。
   *
   * 为什么只对这些 id 补发 removed：宿主自己的 `session/disposed` 会为
   * 本进程的会话发 removed，原生路径不需要我们插手；而「同步过来的会话」
   * 在宿主眼里从来没有过生命周期事件（对端删除时本机什么也不知道），
   * 列表里的那一行就永远挂着。所以只有我们推上去的行，才由我们撤下来。
   */
  const advertised = new Set()
  /** 已推送但本轮缺席的轮数：连续两轮缺席才认定「真的没了」，挡掉同步中途的抖动。 */
  const absent = new Map()
  /** 缺席确认轮数（一次扫盘 = 一轮）。 */
  const REMOVAL_CONFIRM_ROUNDS = 2
  const abort = new AbortController()
  let initialized = false
  let stopped = false
  let activeScan

  function warnOnce(key, revision, error) {
    const message = String(error?.message ?? error)
    const previous = errors.get(key)
    if (previous && Object.is(previous.revision, revision) && previous.message === message) return
    errors.set(key, { revision, message })
    try { ctx.logger?.warn?.(`dsh-tweaks session discovery: ${key}: ${message}`) } catch {}
  }

  /** 本轮要补发 api-session/removed 的 id。 */
  const removals = []

  async function handle(snapshot) {
    const header = snapshot?.header
    const id = header?.id
    const revision = snapshot?.revision
    if (!id || header.origin === 'subagent' || header.cwd === undefined || sessions?.get?.(id)) {
      handled.set(id, revision)
      eligible.delete(id)
      return
    }

    try {
      const restored = await query.readSession(id)
      if (stopped) return
      const fullHeader = restored?.session || header
      if (fullHeader.origin === 'subagent' || fullHeader.cwd === undefined) {
        handled.set(id, revision)
        eligible.delete(id)
        return
      }

      const restoredProjections = projectionCache.coldSnapshot(fullHeader, restored.inheritedEventCount, restored.events)

      try {
        const workspace = await registry.resolveByPath(fullHeader.cwd)
        if (workspace && !workspace.sessionIds.includes(id)) await workspace.attachSession(id)
      } catch (error) {
        // 归属失败不阻止冷会话作为 ungrouped 项显示。
        warnOnce(`${id} workspace`, revision, error)
      }
      if (stopped) return

      const value = await controller.list({}, abort.signal)
      const summary = value?.items?.find((item) => item.sessionId === id)
      if (!summary) throw new Error('session summary is not available yet')

      if (summary.blank === true) {
        // coldSnapshot queues an asynchronous durable table write; the immediately
        // following list may still see the previous blank row. Retry this revision
        // on the next scan only when the freshly restored log proves it is nonblank.
        if (restoredProjections?.values?.sessionListMetadata?.blank === false) return
        handled.set(id, revision)
        eligible.delete(id)
        errors.delete(id)
        return
      }

      handled.set(id, revision)
      eligible.delete(id)
      errors.delete(id)
      if (summary.origin !== 'subagent') {
        advertised.add(id)
        ctx.emit('api-session/added', summary)
      }
    } catch (error) {
      // 读到同步中的半文件时保留候选；下一轮仍会重试同一 revision。
      warnOnce(id, revision, error)
    }
  }

  async function scanOnce() {
    const snapshots = await persistence.list({ signal: abort.signal })
    if (stopped) return
    const currentIds = new Set()
    const removals = []

    if (!initialized) {
      const value = await controller.list({}, abort.signal)
      if (stopped) return
      const summaries = new Map((value?.items || []).map((item) => [item.sessionId, item]))
      for (const snapshot of snapshots) {
        const header = snapshot?.header
        const id = header?.id
        if (!id) continue
        currentIds.add(id)
        revisions.set(id, snapshot.revision)
        if (header.origin === 'subagent') continue
        const recent = Number.isFinite(header.createdAt) && header.createdAt >= startedAt - startupGraceMs
        // 列表里 blank 的会话就是被藏起来的那些：日志多旧、快照里有没有 eventCount 都不能当依据。
        // 否则「同步在 DSH 关着时到手、之后再没被写过」的会话会永远不出现（实测踩过）。
        const hiddenBlank = summaries.get(id)?.blank === true
        if (recent || hiddenBlank) eligible.add(id)
      }
      initialized = true
    } else {
      for (const snapshot of snapshots) {
        const header = snapshot?.header
        const id = header?.id
        if (!id) continue
        currentIds.add(id)
        const wasSeen = revisions.has(id)
        const previous = revisions.get(id)
        revisions.set(id, snapshot.revision)
        if (header.origin !== 'subagent' && (!wasSeen || !Object.is(previous, snapshot.revision))) eligible.add(id)
      }
    }

    // 消失的会话：只补「我们自己推上去过」的那些（见 advertised 注释）。
    // 连续两轮都不在持久化列表里才撤行 —— 对端删除/迁移后同步有延迟，
    // 单轮缺席可能只是半份文件还没收完，撤早了会让行闪烁。
    for (const id of advertised) {
      if (currentIds.has(id)) {
        absent.delete(id)
        continue
      }
      const misses = (absent.get(id) || 0) + 1
      if (misses < REMOVAL_CONFIRM_ROUNDS) {
        absent.set(id, misses)
        continue
      }
      absent.delete(id)
      advertised.delete(id)
      removals.push(id)
    }

    for (const id of revisions.keys()) {
      if (!currentIds.has(id)) {
        revisions.delete(id)
        eligible.delete(id)
        handled.delete(id)
        errors.delete(id)
      }
    }

    for (const snapshot of snapshots) {
      if (stopped) return
      const id = snapshot?.header?.id
      if (!id || !eligible.has(id) || Object.is(handled.get(id), snapshot.revision)) continue
      await handle(snapshot)
    }

    // 撤行的推送放在最后：本轮先把新增/更新的推完，再让客户端删掉消失的行，
    // 免得同一条会话在同一轮里先撤后加。
    while (removals.length > 0) {
      const id = removals.shift()
      if (stopped) return
      ctx.emit('api-session/removed', id)
    }
  }

  function scan() {
    if (stopped) return Promise.resolve()
    if (activeScan) return activeScan
    activeScan = scanOnce()
      .catch((error) => warnOnce('list', null, error))
      .finally(() => { activeScan = undefined })
    return activeScan
  }

  const timer = setInterval(() => { void scan() }, delay)
  void scan()

  function dispose() {
    if (stopped) return
    stopped = true
    abort.abort()
    clearInterval(timer)
  }
  // Exposed only to the standalone test harness; Cordis uses the disposer itself.
  dispose.scan = scan
  return dispose
}

/**
 * 「对象状态」：这个改动赖以生效的对象此刻是什么状况。
 *
 * 返回 `{ status, label }`，status ∈
 *   `idle`       开关没开（谈不上生效对象的状态）
 *   `disabled`   条目在位且已被本开关禁用（条目类改动的稳态）
 *   `pending`    条目在位，但尚未禁用
 *   `missing`    条目不在 Loader 树里
 *   `mismatch`   条目在，但状态异常
 *
 * 注意：它只看「此刻的事实」，不猜。拿不准就报 missing 并把原因写进 label。
 */
export function describeSubject(tweak, entry, enabled, state) {
  if (!enabled) return { status: 'idle', label: '未启用' }

  // 「配置值类」改动：生效对象是多条目标条目的 config 值，报告的是「值写对了没有」，
  // 而不是「条目禁用了没有」。目标缺失 → missing；值没写上 → mismatch；否则就绪。
  if (Array.isArray(tweak?.configPatch) && tweak.configPatch.length) {
    if (state && state.error) {
      return /not in the loader tree/.test(state.error)
        ? { status: 'missing', label: `目标条目不在当前 Loader 树里：${state.error}` }
        : { status: 'mismatch', label: `配置值未写入：${state.error}` }
    }
    return { status: 'ready', label: '配置值已写入生效' }
  }

  if (state && state.error) return { status: 'mismatch', label: `对象在，但状态异常：${state.error}` }

  // 浏览器半类改动（没有 Loader 条目可收敛）：只要开关开着、本插件在跑，
  // 它依赖的样式/界面就在。别拿「条目不在 Loader 树」去误报一个本就
  // 没有条目的改动。
  if (!tweak?.target) return { status: 'ready', label: '随本插件生效（由浏览器半渲染）' }

  if (!entry) return { status: 'missing', label: '条目不在当前 Loader 树里（插件可能被移除或改名）' }
  return entry.disabled === true
    ? { status: 'disabled', label: '条目在位，已被本开关禁用' }
    : { status: 'pending', label: '条目在位，但尚未禁用' }
}

export function apply(ctx, config = {}) {
  /** 改动 id -> { ok, error }。`applied` 表示「enable 跑过且没抛错」。 */
  const applied = new Map()

  /**
   * 开关状态（活值）。从自己的状态文件读，切换时**原地改这个对象**，
   * 不碰 Config / profile patch —— 因此不会触发本插件条目热重载，
   * 客户端注册的 slot 也不会被销毁重建。
   */
  let switches = readState()
  /** 每个 tweak 已注册的 effect 的 disposer（切换时先撤销再按新状态重建）。 */
  const disposers = new Map()

  /**
   * 配置值兜底：schema 已经给了默认值，但 `apply` 也可能被裸调用（单测 /
   * 旧宿主），所以这里再兜一层，保证下面的算术不会拿到 undefined。
   */
  const reassertLimit = positiveInt(config?.reassertLimit, 10)
  const fallbackMs = nonNegativeInt(config?.fallbackReconcileMs, 0)
  const statusRefreshMs = positiveInt(config?.statusRefreshMs, 600000)
  /**
   * 重启参数（活值）：来自状态文件而不是 Config —— 见 TUNING。/toggle 改完会调
   * reconcileAll()，那里重新读一次，所以界面上一改立刻生效，不需要改 patch 重启。
   */
  let allowRestart = false
  let restartDelayMs = 1000
  let restartTokenMs = 30000
  let restartToolCountdownMs = 10000
  /** 按 id 取一个可调参数的当前值（未知 id 返回 undefined）。 */
  function tuning(id) {
    const spec = TUNING.find((t) => t.id === id)
    return spec ? tuningValue(switches, spec) : undefined
  }
  function readTunables() {
    allowRestart = tuning('allowRestart') === true
    restartDelayMs = tuning('restartDelayMs')
    restartTokenMs = tuning('restartTokenMs')
    restartToolCountdownMs = tuning('restartToolCountdownMs')
  }
  readTunables()
  /**
   * 「客户端自报健康」路由的开关（默认开）。
   *
   * 这是插件里**唯一一条接收浏览器写入**的路由，收的是诊断快照，不参与业务。
   */
  const clientHealthRoute = config?.clientHealthRoute !== false
  /** 浏览器半上报的最后一份健康快照（诊断用；只存最后一份）。 */
  const clientHealth = { snapshot: null, receivedAt: 0 }

  /**
   * 工具入口的重启倒计时（restart_dsh）：工具被调用时先登记「待重启」，
   * 客户端轮询到后弹窗显示秒数并允许取消；倒计时结束才走与按钮相同的交接重启。
   */
  let pendingRestart = null
  let pendingTimer = null
  let pendingWaiters = []
  function pendingPayload() {
    if (!pendingRestart) return null
    return {
      reason: pendingRestart.reason,
      startedAt: pendingRestart.startedAt,
      countdownMs: pendingRestart.countdownMs,
      until: pendingRestart.until,
    }
  }
  function wakePendingWaiters() {
    const list = pendingWaiters
    pendingWaiters = []
    for (const fn of list) { try { fn() } catch {} }
  }
  function scheduleToolRestart(reason) {
    if (pendingRestart) return pendingRestart
    const countdownMs = restartToolCountdownMs
    const startedAt = Date.now()
    pendingRestart = { reason: reason || '', startedAt, countdownMs, until: startedAt + countdownMs }
    try {
      appendFileSync(join(tmpdir(), 'dsh-tweaks-restart.log'), new Date().toISOString() + ' tool countdown started reason=' + (pendingRestart.reason || '-') + '\n')
    } catch {}
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      if (!pendingRestart) return
      pendingRestart = null
      wakePendingWaiters()
      try {
        appendFileSync(join(tmpdir(), 'dsh-tweaks-restart.log'), new Date().toISOString() + ' tool countdown done, restarting\n')
      } catch {}
      void restartHost({ delayMs: restartDelayMs })
    }, countdownMs)
    wakePendingWaiters()
    return pendingRestart
  }
  function cancelPendingRestart() {
    if (!pendingRestart) return false
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
    pendingRestart = null
    try {
      appendFileSync(join(tmpdir(), 'dsh-tweaks-restart.log'), new Date().toISOString() + ' tool countdown cancelled\n')
    } catch {}
    wakePendingWaiters()
    return true
  }
  function waitForPendingRestart(timeoutMs) {
    const ms = nonNegativeInt(timeoutMs, 0)
    if (pendingRestart || ms <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        pendingWaiters = pendingWaiters.filter((fn) => fn !== finish)
        try { clearTimeout(timer) } catch {}
        resolve()
      }
      const timer = setTimeout(finish, ms)
      pendingWaiters.push(finish)
    })
  }

  /** 撤掉某个 tweak 已注册的副作用（若在），供就地重跑前清理。 */
  function disposeTweak(id) {
    const off = disposers.get(id)
    disposers.delete(id)
    if (typeof off === 'function') {
      try { off() } catch {}
    }
  }

  /**
   * 「配置值类」改动的运行：把 configPatch 里的值写进各目标条目的 config。
   * 与条目类（disableEntry）同一套可逆副作用骨架：启动跑一次、配置热应用/插件
   * 变化时重断言、切换时先撤销再按新状态重建。值来自 `tuning`（TUNING 参数）或
   * 字面 `value`。
   */
  function runConfigPatchTweak(tweak) {
    // 把 configPatch 里每一项解析成 { target, path, value }：有 tuning 取 TUNING 活值，
    // 否则用字面 value。
    const resolveItems = () =>
      (tweak.configPatch || []).map((p) => ({
        target: p.target,
        path: p.path,
        value: p.value !== undefined ? p.value : tuning(p.tuning),
      }))
    try {
      const off = ctx.effect(() => {
        let cancelled = false
        let reasserts = 0
        let before = []
        const tick = () => {
          if (cancelled) return
          const loader = loaderOf(ctx)
          const items = resolveItems()
          const missing = items.filter((it) => !findEntry(loader, it.target))
          if (missing.length) {
            applied.set(tweak.id, {
              ok: false,
              error: `target ${missing[0].target} is not in the loader tree`,
              reasserts,
            })
            return
          }
          const result = applyConfigPatch(loader, items)
          if (!before.length && result.before.length) before = result.before
          if (result.changed) reasserts += 1
          if (result.errors.length && reasserts >= reassertLimit) {
            applied.set(tweak.id, { ok: false, error: result.errors[0], reasserts })
            return
          }
          applied.set(tweak.id, { ok: true, error: result.errors[0] || null, reasserts })
        }
        const first = setTimeout(tick, 0)
        const reload = ctx.on('app-boot/config-reload', () => { tick() })
        const plugins = ctx.on('plugin-manager/changed', () => { tick() })
        const interval = fallbackMs > 0 ? setInterval(tick, fallbackMs) : null
        return () => {
          cancelled = true
          clearTimeout(first)
          reload()
          plugins()
          if (interval) clearInterval(interval)
          if (before.length) restoreConfigPatch(loaderOf(ctx), before)
        }
      }, `dsh-tweaks:${tweak.id}`)
      if (typeof off === 'function') disposers.set(tweak.id, off)
      applied.set(tweak.id, { ok: true, error: null })
    } catch (error) {
      applied.set(tweak.id, { ok: false, error: String(error?.message ?? error) })
    }
  }

  function runTweak(tweak) {
    const enabled = isEnabled(switches, tweak.id)
    if (!enabled) {
      applied.delete(tweak.id)
      return
    }
    // 「配置值类」改动：往目标条目的 config 写值（可逆），不是禁用条目。
    if (Array.isArray(tweak.configPatch) && tweak.configPatch.length) {
      runConfigPatchTweak(tweak)
      return
    }
    // 浏览器半类改动（无 target）：宿主侧没有条目可收敛，效果由客户端按
    // 状态路由下发的 enabled 自行渲染。标记为已应用即可，别去 Loader 树里
    // 找一个不存在的目标。
    if (!tweak.target) {
      applied.set(tweak.id, { ok: true, error: null })
      return
    }
    try {
      // ctx.effect 注册的是可逆副作用：cordis 在卸载/禁用时会调用清理回调，
      // 这正是它能在运行时安全开关的原因。disposer 存进 disposers，
      // 供 /toggle 就地重跑时先撤销。
      const off = ctx.effect(() => {
        let cancelled = false
        let reasserts = 0
        let touched = false
        const tick = () => {
          if (cancelled) return
          const live = findEntry(loaderOf(ctx), tweak.target)
          if (!live) {
            applied.set(tweak.id, { ok: false, error: `target ${tweak.target} is not in the loader tree`, reasserts })
            return
          }
          if (live.disabled === true) {
            applied.set(tweak.id, { ok: true, error: null, reasserts })
            return
          }
          if (reasserts >= reassertLimit) {
            applied.set(tweak.id, { ok: false, error: 'target flips back after disable', reasserts })
            return
          }
          // 防 remount 优化：disableEntry 内部有幂等保护（已 disabled 则 changed=false），
          // 但 Loader 重建条目时会把 disabled 重置为 false，此时 tick 会再次 disable → remount。
          // 修复：记录「已收敛过」的状态，只在首次或显式回滚后才真的 update。
          if (touched) {
            applied.set(tweak.id, { ok: true, error: null, reasserts })
            return
          }
          const result = disableEntry(live)
          if (result.changed) {
            reasserts += 1
            touched = true
          }
          applied.set(tweak.id, { ok: true, error: null, reasserts })
        }
        /**
         * 对账时机（事件驱动，不轮询）：
         *   · 启动一次——先让 Loader 跑完这一轮，再动兄弟条目；
         *   · `app-boot/config-reload`——配置热应用后条目被重建，正是需要重新
         *     收敛的时候（原来靠 3 秒定时器补，现在由事件精确通知）；
         *   · `plugin-manager/changed`——插件/组合变化同样会重建条目。
         * `fallbackReconcileMs > 0` 时才额外挂一个兜底间隔（默认关闭）。
         */
        const first = setTimeout(tick, 0)
        const reload = ctx.on('app-boot/config-reload', () => { tick() })
        const plugins = ctx.on('plugin-manager/changed', () => { tick() })
        const interval = fallbackMs > 0 ? setInterval(tick, fallbackMs) : null
        return () => {
          cancelled = true
          clearTimeout(first)
          reload()
          plugins()
          if (interval) clearInterval(interval)
          if (touched) restoreEntry(findEntry(loaderOf(ctx), tweak.target), undefined)
        }
      }, `dsh-tweaks:${tweak.id}`)
      if (typeof off === 'function') disposers.set(tweak.id, off)
      applied.set(tweak.id, { ok: true, error: null })
    } catch (error) {
      // 规则 4：绝不阻塞启动。记录下来继续。
      applied.set(tweak.id, { ok: false, error: String(error?.message ?? error) })
    }
  }

  /**
   * 智能体工具：把「重启宿主」注册成 DSH 原生工具 restart_dsh。
   * 注册形态对齐 dsh-xlock：ctx.inject(['tools'], …) + tools.register(definition)。
   * 2026-11-16 起它不再是独立补丁行，而是 restartButton 的位置选项
   * `restartAgentTool`（默认关，单独点开）；闸门与 /restart 路由共用。
   */
  let restartToolOff = null
  let restartToolPending = false
  function restartToolWanted() {
    return allowRestart && isEnabled(switches, 'restartButton') && isEnabled(switches, 'restartAgentTool')
  }
  function defineRestartTool() {
    return {
      name: 'restart_dsh',
      description:
        '重启 DeepSeek Harness 宿主进程（与设置页「重启宿主」按钮同一套机制：桌面版由独立 helper ' +
        '先点恢复框「重启」按钮让主进程干净退出（清托盘）、退不动再强杀并重开；网页版交接式重启）。仅在用户明确要求重启时调用；' +
        '调用会中断当前会话，重启后由 dsh-client-auto-continue 的启动恢复续跑。',
      parameters: {
        reason: { type: 'string', description: '可选：一句话原因（写入重启日志，便于事后核对）' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        if (exec && exec.signal && typeof exec.signal.throwIfAborted === 'function') exec.signal.throwIfAborted()
        if (!allowRestart) return 'ERROR: 「允许重启宿主」总闸未打开（设置 › 增强补丁 › 重启宿主）'
        if (!isEnabled(switches, 'restartButton')) return 'ERROR: 「重启宿主」总开关未打开'
        if (!isEnabled(switches, 'restartAgentTool')) return 'ERROR: 「智能体工具 restart_dsh」选项未打开'
        const executable = hostExecutable()
        if (!executable) return 'ERROR: 取不到宿主可执行文件路径，无法重启'
        try {
          appendFileSync(
            join(tmpdir(), 'dsh-tweaks-restart.log'),
            new Date().toISOString() + ' tool restart reason=' + String((args && args.reason) || '-').slice(0, 200) + '\n',
          )
        } catch {}
        // 工具入口：先登记「待重启」让客户端弹倒计时（可取消），倒计时结束才
        // 真的走交接重启；与按钮共用同一套 restartHost。
        const pending = scheduleToolRestart(String((args && args.reason) || '').slice(0, 200))
        const seconds = Math.max(1, Math.round((pending.until - Date.now()) / 1000))
        return '已弹出重启倒计时：' + seconds + ' 秒后重启 DeepSeek Harness（可在弹窗里点「取消重启」）。会话会中断，重启后由 dsh-client-auto-continue 续跑。'
      },
    }
  }
  function syncRestartTool() {
    if (restartToolWanted()) {
      if (restartToolOff || restartToolPending) return
      restartToolPending = true
      try {
        ctx.inject(['tools'], (toolCtx) => {
          restartToolPending = false
          const tools = toolCtx && toolCtx.tools
          if (!tools || typeof tools.register !== 'function') return
          let off = null
          try {
            const disposer = toolCtx.effect(() => {
              const unregister = tools.register(defineRestartTool())
              return () => { if (typeof unregister === 'function') { try { unregister() } catch {} } }
            }, 'dsh-tweaks:restart-tool')
            off = typeof disposer === 'function' ? disposer : null
          } catch {
            off = null
          }
          restartToolOff = function () {
            if (typeof off === 'function') { try { off() } catch {} }
            off = null
            restartToolOff = null
          }
          // 注册与开关切换之间的竞态：若此刻已不需要，立即收回。
          if (!restartToolWanted()) { try { restartToolOff() } catch {} }
        })
      } catch {
        restartToolPending = false
      }
      return
    }
    if (restartToolOff) {
      try { restartToolOff() } catch {}
      restartToolOff = null
    }
  }

  function applyAll() {
    for (const tweak of TWEAKS) runTweak(tweak)
  }

  /**
   * 就地重跑全部 tweak：先撤销已注册的副作用，再按当前 `switches` 重建。
   *
   * /toggle 走这里而不是 `settings.update` —— 后者会写 profile patch 并触发
   * 本插件条目热重载（客户端 slot 随之闪断/消失）。这里只动进程内副作用，
   * 客户端完全感知不到界面被重建。
   */
  function reconcileAll() {
    // 先重读可调参数：界面刚刚可能改了「允许重启」或某个毫秒值。
    readTunables()
    for (const tweak of TWEAKS) disposeTweak(tweak.id)
    applied.clear()
    applyAll()
    syncRestartTool()
  }

  /**
   * 重启的闸门现状。两道闸门现在**都在界面里**：`allowRestart`（TUNING，允许重启
   * 的总闸）与 `restartButton`（本行的开关）。所以没有「必须去改配置文件」的死路，
   * 返回的 message 是要**直接显示给用户**的整句操作指引。
   */
  function restartGate() {
    if (!allowRestart) {
      return { reason: 'tuning', message: '总闸未打开：把本卡片里的「允许重启宿主」勾上，勾完即可用。' }
    }
    if (!isEnabled(switches, 'restartButton')) {
      return { reason: 'switch', message: '总开关未打开：把「重启宿主」这一行的勾选打开。' }
    }
    return { reason: null, message: '' }
  }

  /** 每个改动：配置值 / 是否应用成功 / 目标条目此刻是否真的禁用。 */
  function status() {
    const loader = loaderOf(ctx)
    const gate = restartGate()
    return {
      plugin: name,
      routePrefix: ROUTE_PREFIX,
      tweaks: TWEAKS.map((tweak) => {
        const isConfigPatch = Array.isArray(tweak.configPatch) && tweak.configPatch.length > 0
        const entry = tweak.target ? findEntry(loader, tweak.target) : undefined
        const configPresent = isConfigPatch
          ? tweak.configPatch.every((p) => findEntry(loader, p.target))
          : undefined
        const state = applied.get(tweak.id)
        const enabled = isEnabled(switches, tweak.id)
        // 「对象状态」：这个改动赖以生效的对象此刻是什么状况。
        const subject = describeSubject(tweak, entry, enabled, state)
        const isRestart = tweak.action === 'restart'
        const ready = isRestart ? allowRestart && enabled : undefined
        return {
          id: tweak.id,
          title: tweak.title,
          what: tweak.what || null,
          why: tweak.why || '',
          target: tweak.target ?? null,
          action: tweak.action ?? null,
          // 入口按钮的闸门（restartButton）：政策闸与主开关要同时打开；位置由子选项多选。
          actionReady: ready,
          actionBlockedBy: isRestart && !ready ? gate.message : undefined,
          // 菜单里要不要给这一行：带 target 的改动天然有行；数据类改动显式声明。
          menu: tweak.menu === true || Boolean(tweak.target) || tweak.action === 'restart',
          // 多层级子选项（restartButton 的两个位置）；其它条目为 undefined（JSON 不输出）。
          options: tweak.options
            ? tweak.options.map((o) => ({
                id: o.id,
                label: o.label,
                note: o.note || null,
                enabled: isEnabled(switches, o.id),
              }))
            : undefined,
          enabled,
          applied: Boolean(state && state.ok),
          present: isConfigPatch ? configPresent : Boolean(entry),
          effective: isConfigPatch ? subject.status === 'ready' : (entry ? entry.disabled === true : null),
          reasserts: (state && state.reasserts) || 0,
          note: (state && state.note) || null,
          error: (state && state.error) || null,
          // 生效对象与它的状态（界面卡片直接渲染这几项）。
          subject: tweak.subject || null,
          subjectKind: (tweak.subject && tweak.subject.kind) || null,
          subjectLabel: (tweak.subject && tweak.subject.label) || null,
          // 归属（分组用）：标识这条补丁属于哪个组件。
          owner: tweak.owner || null,
          ownerName: (tweak.owner && tweak.owner.name) || null,
          ownerLabel: (tweak.owner && tweak.owner.label) || null,
          ownerKind: (tweak.owner && tweak.owner.kind) || null,
          group: tweak.group ?? null,
          subjectStatus: subject.status,
          subjectStatusLabel: subject.label,
          effect: tweak.effect || null,
          appliesWhen: tweak.appliesWhen || null,
        }
      }),
      // 下发给浏览器半的配置（只给客户端真正用得上的值）。
      config: { statusRefreshMs, restartDelayMs, desktop: isDesktopShell(), configFile: configFilePath() },
      // 可调参数（TUNING）：界面上渲染成勾选框 / 数字输入，改动走同一条 /toggle。
      tuning: describeTuning(switches),
    }
  }

  const sessionDiscoveryMs = nonNegativeInt(config?.sessionDiscoveryMs, 15000)
  applyAll()
  syncRestartTool()
  if (sessionDiscoveryMs > 0) {
    try {
      ctx.inject(
        ['sessionPersistence', 'workspaceRegistry', 'sessionController', 'sessionQuery', 'sessionProjectionCache', 'sessions'],
        (discoveryCtx) => {
          discoveryCtx.effect(
            () => createSessionDiscovery(discoveryCtx, sessionDiscoveryMs),
            'dsh-tweaks:session-discovery',
          )
        },
      )
    } catch (error) {
      try { ctx.logger?.warn?.(`dsh-tweaks session discovery could not start: ${String(error?.message ?? error)}`) } catch {}
    }
  }

  /**
   * 记住平台的 `cmdline` 服务，供「让宿主优雅退出」用。
   *
   * 平台在 runProfile 里 provide 了 `cmdline.exit(code)`：它会走 desktop-host 的
   * shutdown 链（dispose → 退出码 0），是干净的退出方式。桌面版重启就靠它 ——
   * 见 windowsDesktopHandoffScript 的长注释（为什么不能由插件自己去杀主进程）。
   *
   * 拿不到也不影响别的功能：requestGracefulExit 会退回 process.exit(0)。
   */
  try {
    ctx.inject(['cmdline'], (cmdCtx) => {
      try { globalThis.__DSH_TWEAKS_CMDLINE__ = cmdCtx.cmdline } catch {}
      try { cmdCtx.effect(() => () => { try { globalThis.__DSH_TWEAKS_CMDLINE__ = undefined } catch {} }, 'dsh-tweaks:cmdline-ref') } catch {}
    })
  } catch {
    // cmdline 服务不存在（老宿主 / 单测）：requestGracefulExit 会走兜底。
  }

  if (config.statusRoute !== false) {
    ctx.inject(['webServer'], (wsctx) => {
      wsctx.effect(() => wsctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/status`,
        handler: async (_request, response) => {
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          response.end(JSON.stringify(status()))
        },
      }), 'dsh-tweaks:status-route')
      // 只读诊断：只返回两个目标数值和 fiber 生命周期，不接入实验控制器。
      wsctx.effect(() => wsctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/slow-link-observe`,
        handler: async (request, response) => {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET', 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify({ error: '只允许 GET。' }))
            return
          }
          // exact route 不自动继承 Connection 认证；先执行其 Host/Origin 与会话门禁。
          const reject = (code, message) => {
            response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify({ error: message }))
          }
          try {
            const connection = wsctx.get('connection')
            if (!connection || typeof connection.admit !== 'function') {
              reject(503, '认证服务不可用。')
              return
            }
            const admission = await connection.admit(request)
            if (!admission || typeof admission !== 'object') {
              reject(503, '认证服务不可用。')
              return
            }
            if ('rejection' in admission) {
              if (admission.rejection === 401) reject(401, '认证失败。')
              else if (admission.rejection === 403) reject(403, '访问被拒绝。')
              else reject(503, '认证服务不可用。')
              return
            }
            if (!admission.peer) {
              reject(503, '认证服务不可用。')
              return
            }
          } catch {
            reject(503, '认证服务不可用。')
            return
          }
          try {
            const observation = observeSlowLinkValues(loaderOf(ctx))
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify(observation))
          } catch {
            response.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify({ error: '读取宿主配置失败。' }))
          }
        },
      }), 'dsh-tweaks:slow-link-observe-route')
      /**
       * 客户端自报健康：浏览器半把自己看到的事实 POST 上来。
       *
       * 为什么要这条「写」路由：浏览器半没加载成功、槽没注册、动画被系统
       * 的「减少动态效果」关掉——这些全是**浏览器侧**的事实，宿主侧无从得知
       * （宿主只知道自己「已安装」）。所以这里反过来收一份快照，如实存着，
       * 供人用 curl 查看。它不参与任何业务逻辑，POST 失败也不影响插件。
       *
       * 存的是**最后一份**快照（诊断信息而已，要历史就得另加日志）。
       *
       * 读写**共用一条路由**，按 method 分流：webserver 的路由表以
       * (kind, path) 为键，同一路径注册两次会抛
       * `webserver: duplicate exact route "..."`，而那次抛错发生在同一个
       * effect 里 —— 整条插件条目随之 failed，所有 /dsh-tweaks/* 路由
       * 全都不存在（表现为整包 404，不是这一条 404）。所以这里只注册一次。
       */
      if (clientHealthRoute) {
        wsctx.effect(() => wsctx.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/client-health`,
          handler: async (request, response) => {
            if (request.method === 'GET' || request.method === 'HEAD') {
              response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              response.end(JSON.stringify({
                receivedAt: clientHealth.receivedAt,
                snapshot: clientHealth.snapshot,
              }))
              return
            }
            const body = await readRequestBody(request)
            if (body === null) {
              response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              response.end(JSON.stringify({ ok: false, error: 'invalid body' }))
              return
            }
            clientHealth.snapshot = body
            clientHealth.receivedAt = Date.now()
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify({ ok: true }))
          },
        }), 'dsh-tweaks:client-health-route')
      }
      /**
       * 开关切换：写插件自己的状态文件 + **就地重跑**，全程不碰 Config / patch 层。
       *
       * 为什么不用 settings.update：它写 profile patch，而 profile 是
       * `patchReload: live` —— 一次写入就让本插件条目热重载，客户端注册的
       * slot（设置窗口的「增强补丁」分区）随之销毁重建，表现就是「点一下开关，
       * 右边内容整个消失」。写自己的文件 + 进程内 reconcile 完全不触发那条链。
       */
      wsctx.effect(() => wsctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/toggle`,
        handler: async (request, response) => {
          try {
            const raw = await readRequestBody(request)
            const body = JSON.parse(raw || '{}')
            const tweakKnown = TWEAKS.some((t) => t.id === body.id || (t.options || []).some((o) => o.id === body.id))
            const spec = TUNING.find((t) => t.id === body.id)
            if (!tweakKnown && !spec) throw new Error('unknown tweak: ' + body.id)
            // 两种值：开关是 boolean；可调参数按 kind 归一（number 会被夹到下限，
            // 非法输入退回默认值）。body.value 与 body.enabled 都接受，界面自己选。
            const value = spec
              ? tuningValue({ [spec.id]: body.value ?? body.enabled }, spec)
              : body.enabled === true
            // 1) 落盘（原子写；失败要如实报，不能假装成功）
            const next = { ...switches, [body.id]: value }
            if (!writeState(undefined, next)) throw new Error('开关状态写入失败（检查 ~/.dsh/.cache 是否可写）')
            // 2) 更新活值并就地重跑（不触发条目重载）
            switches = next
            reconcileAll()
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify({ ok: true, id: body.id, value, enabled: value === true }))
          } catch (error) {
            response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }))
          }
        },
      }), 'dsh-tweaks:toggle-route')

      /**
       * 重启宿主（开关 restartButton；位置多选只是 UI 选项）。两段式：
       *   ① POST { }        → 返回一次性 token（不重启）
       *   ② POST { token }  → 校验通过才真的退进程 + 经 helper 拉起新进程
       * 两道闸门：allowRestart（TUNING，状态文件里的总闸）与 restartButton 开关
       * 都要开 —— 两者都能在设置窗口的「增强补丁」页直接改，不必手写 patch。
       * 令牌一次性、过期作废，插件卸载时随 effect 清理。
       */
      const restartTokens = new Map()
      wsctx.effect(() => {
        const grant = () => {
          const token = randomBytes(18).toString('base64url')
          restartTokens.set(token, Date.now() + restartTokenMs)
          // 只留最近的几枚，避免无限增长（用户狂点也不会涨）。
          if (restartTokens.size > 8) {
            const oldest = [...restartTokens.entries()].sort((a, b) => a[1] - b[1])[0]
            if (oldest) restartTokens.delete(oldest[0])
          }
          return token
        }
        return wsctx.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/restart`,
          handler: async (request, response) => {
            const fail = (code, error) => {
              response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              response.end(JSON.stringify({ ok: false, error }))
            }
            // 闸门 1：allowRestart（TUNING，状态文件）。闸门 2：restartButton 开关（同一文件）。
            if (!allowRestart) return fail(403, '「允许重启宿主」总闸未打开（设置 › 增强补丁 › 重启宿主）')
            if (!isEnabled(switches, 'restartButton')) return fail(403, '重启按钮开关未打开')

            let body = {}
            try {
              body = JSON.parse((await readRequestBody(request)) || '{}')
            } catch {
              return fail(400, '请求体不是 JSON')
            }
            try {
              appendFileSync(join(tmpdir(), 'dsh-tweaks-restart.log'), new Date().toISOString() + ' restart route token=' + (body.token ? 'yes' : 'no') + '\n')
            } catch {}

            // 第一步：给令牌。
            if (!body.token) {
              response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              response.end(JSON.stringify({
                ok: true,
                stage: 'confirm',
                token: grant(),
                expiresInMs: restartTokenMs,
                message: '重启会中断进行中的会话（重启后由 dsh-client-auto-continue 的启动恢复续跑）。再点一次确认。',
              }))
              return undefined
            }

            // 第二步：校验令牌（一次性 + 过期）。
            const expiry = restartTokens.get(body.token)
            restartTokens.delete(body.token)
            if (expiry === undefined) return fail(400, '令牌无效或已被用过，请重新确认')
            if (Date.now() > expiry) return fail(400, '令牌已过期，请重新确认')

            const executable = hostExecutable()
            if (!executable) return fail(500, '取不到宿主可执行文件路径，无法重启')

            // 先把响应冲出去，再延迟交接——否则浏览器看到的是连接被掐断。
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify({
              ok: true,
              stage: 'restarting',
              executable,
              delayMs: restartDelayMs,
              message: '正在重启 DeepSeek Harness……',
            }))
            void restartHost({ delayMs: restartDelayMs })
            return undefined
          },
        })
      }, 'dsh-tweaks:restart-route')

      /**
       * 打开配置文件：设置窗口里「未开放」那段提示旁边的按钮走这里。
       *
       * 只打开 configFilePath() 算出来的那一个文件 —— 不接受请求体里的路径，
       * 免得变成「任何页面请求都能让宿主打开任意文件」。
       */
      wsctx.effect(() => wsctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/open-config`,
        handler: async (request, response) => {
          let body = {}
          try { body = JSON.parse((await readRequestBody(request)) || '{}') } catch {}
          // 显式拒绝带路径的调用：这个路由只认「打开我的配置文件」这一件事。
          if (body && typeof body.file === 'string' && body.file) {
            response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify({ ok: false, error: '这个路由只打开 dsh-tweaks 的配置文件，不接受指定路径' }))
            return undefined
          }
          const target = configFilePath()
          const result = openConfigFile({ file: target })
          response.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          response.end(JSON.stringify({ ...result, path: target }))
          return undefined
        },
      }), 'dsh-tweaks:open-config-route')

      /**
       * 工具入口重启倒计时（restart_dsh）：客户端长轮询等「待重启」出现，
       * 拿到后弹窗显示秒数并轮询取消结果；waitMs 为最长等待（默认 20 秒）。
       */
      wsctx.effect(() => wsctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/restart/pending`,
        handler: async (request, response) => {
          const send = (pending) => {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify({ ok: true, pending }))
          }
          if (!allowRestart || !isEnabled(switches, 'restartAgentTool')) return send(null)
          let body = {}
          try { body = JSON.parse((await readRequestBody(request)) || '{}') } catch {}
          await waitForPendingRestart(body && body.waitMs)
          return send(pendingPayload())
        },
      }), 'dsh-tweaks:restart-pending-route')
      wsctx.effect(() => wsctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/restart/cancel`,
        handler: async (request, response) => {
          const send = (code, doc) => {
            response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify(doc))
          }
          if (!allowRestart) return send(403, { ok: false, error: '「允许重启宿主」总闸未打开' })
          try { await readRequestBody(request) } catch {}
          const cancelled = cancelPendingRestart()
          return send(200, { ok: true, cancelled })
        },
      }), 'dsh-tweaks:restart-cancel-route')

    })
  }
}
