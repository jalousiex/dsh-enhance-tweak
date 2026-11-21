/**
 * dsh-tweaks —— 浏览器半。
 *
 * 贡献三处 UI，全部读 `GET /dsh-tweaks/status`：
 *
 *  1. **设置窗口的一级分区「增强补丁」**（官方 slot `settings.section`）——
 *     具体补丁开关的**权威入口**，可交互 checkbox，按归属对象分组。
 *     为什么放这里而不是插件详情页：开关一改就写配置 → 插件条目热重载 →
 *     详情页重建 → 界面跳回"只有插件信息"（用户痛点）。settings.section 是设置
 *     窗口自己的导航分区，不挂在插件条目下，不受这条重载链影响。
 *  2. **设置 › 插件 › dsh-tweaks 详情页**（slot `plugins.bundle.config`）——
 *     **只读说明**：一句指路 + 启用计数。不放开关，理由同上。
 *  3. **侧边栏底部重启按钮**（官方 slot `sidebar.footer.action`，id
 *     `restart-footer`，order 40，开关 `restartFooter`）——宽展开时 28px
 *     图标钮绝对定位叠在「设置」行右端（不占新行），收窄轨时 36×36 静态。
 *  4. **会话标签栏右上角的重启按钮**（官方 slot
 *     `conversation.session.header.utilities`，id `restart-header`，order 31，开关
 *     `restartHeader`）——与 dsh-unlag 同排，随会话标签栏出现。
 *
 * 设置卡片本身不再放重启按钮（2026-11-15 用户拍板：「那么深，还不如直接退出
 * 再启动」）；入口位置是开关内的多选（底部 / 右上角），勾哪里出现哪里。
 * 顶部折叠按钮旁的 DOM 注入入口已按用户要求移除（会被标题行挤压）。
 *
 * 头像菜单（`AccountMenu`，`settings.launcher` 的 single 占用者）没有任何菜单项 slot
 * 可扩展（88 个 slot 里没有「头像菜单项」这种槽），所以没有往菜单里放。
 *
 * 加载器契约（dsh 硬规则）：本文件**必须**是
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 * 旧的 `{ id, exports: fn }` 形态会让宿主抛
 * `registered.factory is not a function`，直接崩掉整个 web boot。
 *
 * DOM 纪律：本插件只用 slot 贡献 UI，不读他人 DOM / 样式。
 * （2026-11-15：原「侧栏顶部折叠按钮旁 DOM 注入」入口已被用户移除——它在
 * 标题行里会被挤压，改为官方 slot `conversation.session.header.utilities`。）
 */

window.__ModuleLoader__.load({
	id: "dsh-enhance-tweak",
	factory: function (require) {
		"use strict";
		var React = require("react");
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var STATUS = "/dsh-tweaks/status";
		var TOGGLE = "/dsh-tweaks/toggle";
		var RESTART = "/dsh-tweaks/restart";
		/** 用系统编辑器打开本插件的配置文件（闸门是 Config 时给用户的出路）。 */
		var OPEN_CONFIG = "/dsh-tweaks/open-config";
		/** 工具入口的重启倒计时：客户端长轮询等宿主登记「待重启」。 */
		var RESTART_PENDING = "/dsh-tweaks/restart/pending";
		/** 取消正在倒计时的重启（不重启）。 */
		var RESTART_CANCEL = "/dsh-tweaks/restart/cancel";
		/**
		 * 客户端「自报健康」用的上报路由（症状1 的实机定位手段）。
		 *
		 * 为什么需要它：插件的浏览器半一旦没加载成功（bundle 挂了 / factory 抛错 /
		 * 槽没注册 / 动画被 prefers-reduced-motion 关掉），宿主侧**完全看不出来** ——
		 * 宿主只知道自己「已安装」，不知道浏览器半到底跑没跑。宿主侧路由全是只读
		 * 拉取（浏览器 → 宿主），所以这里必须反过来：浏览器主动 POST 一份快照，
		 * 宿主如实存下来，供人用 curl 查看。
		 */
		var HEALTH_REPORT = "/dsh-tweaks/client-health";
		var MARK = "data-dsh-tweaks";
		// 兜底刷新间隔的兜底值（毫秒）：正常由宿主 GET /dsh-tweaks/status 的
		// config.statusRefreshMs 下发，这里只是它也拿不到时的最后默认值。
		var DEFAULT_REFRESH_MS = 600000;
		var BUNDLE_KEY = "dsh-tweaks";
		/** 设置窗口一级分区 id（settings.section）：具体补丁开关的入口。
		 *  惯例参考 dshmarket 的 `id: 'market'`、github-copilot 的 `id: 'github-copilot'`
		 *  ——短 slug，与插件条目 id 分属不同命名空间，同名也不冲突。 */
		var SECTION_ID = "tweaks";

		// 开关列表：每条一个卡片，含「启用状态 / 描述 / 生效对象 / 对象状态 / 生效条件」。
		var CSS_TEXT = [
			'.dtw-pagehint{margin:0 0 4px;opacity:.65;font-size:12px}',
			'.dtw-pagehint-warn{color:#d29922;opacity:.95}',
			'.dtw-pagehint-error{color:#f85149;opacity:.95}',
			'.dtw-section{margin-top:10px}',
			'.dtw-section:first-of-type{margin-top:4px}',
			'.dtw-group{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:4px 0 2px;border-bottom:1px solid var(--dsw-alias-stroke-subtle,rgba(128,128,128,.2));margin-bottom:2px}',
			'.dtw-groupname{font-size:12px;font-weight:600;opacity:.9;letter-spacing:.02em}',
			'.dtw-groupmeta{font-size:11px;opacity:.55;white-space:nowrap}',
			'.dtw-card{display:flex;flex-direction:column;gap:6px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-stroke-subtle,rgba(128,128,128,.2))}',
			'.dtw-card:last-child{border-bottom:0}',
			'.dtw-head{display:flex;align-items:flex-start;gap:10px}',
			'.dtw-headcheck{flex:0 0 auto;margin-top:2px}',
			'.dtw-headtext{flex:1;min-width:0}',
			'.dtw-title{display:block;font-weight:600}',
			'.dtw-what{display:block;opacity:.75;font-size:12px;margin-top:2px;white-space:normal}',
			'.dtw-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;padding-left:24px}',
			'.dtw-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:18px;padding:0 6px;border-radius:9px;border:1px solid var(--dsw-alias-stroke-subtle,rgba(128,128,128,.25));opacity:.85;white-space:normal}',
			'.dtw-chip-key{opacity:.6}',
			'.dtw-chip-ready{color:#3fb950;border-color:#3fb95055}',
			'.dtw-chip-disabled{color:#58a6ff;border-color:#58a6ff55}',
			'.dtw-chip-pending{color:#d29922;border-color:#d2992255}',
			'.dtw-chip-missing,.dtw-chip-mismatch{color:#f85149;border-color:#f8514955}',
			'.dtw-chip-idle{opacity:.55}',
			'.dtw-note{margin-left:24px;font-size:11px;opacity:.6;white-space:normal}',
			'.dtw-note-error{color:#f85149;opacity:.9}',
			// 闸门说明直接放在动作行里（不再缩进成独立一行），旁边挂「打开配置文件」按钮。
			'.dtw-note-inline{margin-left:0;flex:1;min-width:0}',
			'.dtw-actions .dtw-btn{flex:none}',
			// 多层级子选项（restartButton 的位置多选）：缩进一行、横排短标签，
			// 窄屏（移动端）自动换行。
			'.dtw-options{margin-left:24px;display:flex;flex-wrap:wrap;gap:4px 16px}',
			'.dtw-opt{display:flex;align-items:center;gap:6px;font-size:12px;opacity:.85;cursor:pointer}',
			'.dtw-opt-off{opacity:.45;cursor:default}',
		// TUNING 可调参数：一个参数一行，控件统一在最左侧那一列（数字框等宽、数字右对齐
		// 便于扫读），标签紧随其后，说明**另起一行占满整行**——长句不再被挤成窄条、
		// 也不会绕到标签旁边把两列文字混在一起。行间只用极淡的分隔线区分条目，
		// 整块用底色而不是边框框住，减轻「表单」视觉重量；左侧缩进 24px 与卡片里
		// 其它次级内容（chips / 位置多选 / 闸门说明）对齐，不再比它们更靠左。
		'.dtw-tune{display:flex;flex-direction:column;margin:8px 0 0 24px;padding:4px 10px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.07))}',
		'.dtw-tune-row{display:grid;grid-template-columns:92px minmax(0,1fr);align-items:center;column-gap:10px;row-gap:2px;font-size:12px;padding:5px 0}',
		'.dtw-tune-row + .dtw-tune-row{border-top:1px solid var(--dsw-alias-stroke-subtle,rgba(128,128,128,.12))}',
		// 布尔参数没有数字框，但**沿用同一列宽**：勾选框贴着控件列左边缘站，
		// 标签仍从第二列起 —— 一行布尔 + 五行数字时，六行标签左边缘齐平。
		// justify-self:start 是必需的：栅格默认 stretch，勾选框会被拉成 92px 宽、
		// 勾形居中画在中间，看着像缩进了一格；margin:0 抹掉 Chromium 给
		// input[type=checkbox] 的 UA 默认外边距（3px 3px 3px 4px），否则它比
		// 上面的数字框往右偏 4px，一列控件对不齐。
		'.dtw-tune-row-bool{grid-template-columns:92px minmax(0,1fr)}',
		'.dtw-tune-row-bool > input[type="checkbox"]{justify-self:start;margin:0}',
		'.dtw-tune-label{grid-column:2}',
		'.dtw-tune-note{grid-column:1 / -1;opacity:.6;font-size:11px;line-height:1.5;white-space:normal}',
		'.dtw-num{grid-column:1;box-sizing:border-box;width:100%;font:inherit;font-size:12px;font-variant-numeric:tabular-nums;text-align:right;padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-stroke-subtle,rgba(128,128,128,.35));background:transparent;color:inherit}',
			'.dtw-actions{margin-left:24px;margin-top:6px;display:flex;align-items:center;gap:8px}',
			'.dtw-btn{font:inherit;font-size:12px;padding:2px 10px;border-radius:6px;border:1px solid var(--dsw-alias-stroke-subtle,rgba(128,128,128,.35));background:transparent;color:inherit;cursor:pointer}',
			'.dtw-btn:hover:not(:disabled){border-color:var(--dsw-alias-stroke-strong,rgba(128,128,128,.6))}',
			'.dtw-btn:disabled{opacity:.45;cursor:not-allowed}',
			'.dtw-btn-danger{border-color:#f8514966;color:#f85149}',
			// ── 重启按钮的两个入口（footer slot 叠设置行右端 + 会话标签栏右上角 slot）──
			// footer 槽容器被 dsh-m 用 !important 改成 column，整行按钮会占新行；
			// 这里给槽位容器只加 position:relative（不动他人布局），宽展开时把
			// 28px 图标钮绝对定位叠到「设置」行右端；收窄轨时留在 footer 行里
			// 静态 36×36。两个入口都用自绘图标，不引宿主 icon 原语。
			'[data-slot="sidebar.footer.action"]{position:relative}',
			'.dtw-footerBtns{position:absolute;top:100%;margin-top:2px;right:8px;z-index:2;display:inline-flex;gap:4px}',
			'.dtw-footerBtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;cursor:pointer;opacity:.72}',
			'.dtw-footerBtn:hover:not(:disabled){opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}',
			'.dtw-footerBtn:disabled{opacity:.32;cursor:not-allowed;background:transparent}',
			'.dtw-footerBtn-rail{width:36px;height:36px}',
			'.dtw-footerBtn-confirm{width:auto;padding:0 8px;gap:4px;font-size:12px;white-space:nowrap}',
			'.dtw-footerBtn-label{font-size:12px;line-height:1}',
			'.dtw-footerBtn-confirm{color:#f85149;border-color:#f8514966;background:rgba(248,81,73,.08)}',
			'.dtw-footerBtn-confirm:hover:not(:disabled){background:rgba(248,81,73,.16)}',
			// ── 右上角「会话标签栏」入口（conversation.session.header.utilities）──
			// 与 unlag 图标同排；比侧栏入口更紧凑，确认态左侧出现「一键重启」文字钮。
			'.dtw-headerBtns{display:inline-flex;gap:4px;align-items:center}',
			'.dtw-headerBtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:inherit;cursor:pointer;opacity:.72}',
			'.dtw-headerBtn:hover:not(:disabled){opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}',
			'.dtw-headerBtn:disabled{opacity:.32;cursor:not-allowed;background:transparent}',
			'.dtw-headerBtn-text{width:auto;padding:0 8px;gap:4px;font-size:12px;white-space:nowrap;color:#f85149;border-color:#f8514966;background:rgba(248,81,73,.08);opacity:1}',
			'.dtw-headerBtn-text:hover:not(:disabled){background:rgba(248,81,73,.16)}',
			// ── 工具重启倒计时弹窗（restart_dsh）：fixed 全屏遮罩，不占布局 ──
			'.dtw-modal-backdrop{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}',
			'.dtw-modal{min-width:320px;max-width:440px;padding:18px 20px;border-radius:12px;border:1px solid var(--dsw-alias-border-subtle,#444);background:var(--dsw-alias-bg-elevated,#252526);color:var(--dsw-alias-text-primary,#ddd);box-shadow:0 16px 48px rgba(0,0,0,.45);font-size:13px;line-height:1.6}',
			'.dtw-modal-title{font-size:15px;font-weight:600;margin-bottom:8px;color:#f85149}',
			'.dtw-modal-text{opacity:.9}',
			'.dtw-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}',
		].join("\n");

		/**
		 * 「修复侧边栏底部入口错位」这条开关的样式（宿主 TWEAKS 里 id 同名）。
		 *
		 * dsh-m 用 !important 把 sidebar.footer.action 改成 flex-direction:column，
		 * 但只给自己的 .dshm-entry 子项加了 flex:none。dsh-session-manager 的
		 * .sm-footerBtn-wide 带着原本为 row 布局设计的 flex:1 1 100% /
		 * width:calc(100% + 8px) / 负 margin 进入 column 容器，结果按钮被拉高、
		 * 偏右几乎看不到。只给该按钮补 flex:none + align-self:stretch + 归零水平
		 * 负 margin，让它在 column 里像 dshm-entry 一样正常堆叠；选择器不命中
		 * dsh-mobile 等同槽其它条目。
		 *
		 * 它与上一段常驻样式分开：**按开关状态**注入 / 摘除，关掉即恢复原样，
		 * 不在 CSS_TEXT 里（那是本插件自己 UI 用的、无条件生效的样式）。
		 */
		var SIDEBAR_FOOTER_FIX_ID = "sidebarFooterLayout";
		var SIDEBAR_FOOTER_FIX_CSS = '[data-slot="sidebar.footer.action"] .sm-footerBtn-wide{flex:none!important;align-self:stretch;width:auto;min-width:0;margin-left:0!important;margin-right:0!important;box-sizing:border-box}';
		var SIDEBAR_FOOTER_FIX_SEL = 'style[data-plugin-css="dsh-tweaks-sidebar-footer"]';

		/**
		 * 按当前状态同步「侧边栏底部修复」样式标签：开 → 确保注入，关 → 摘除。
		 *
		 * 幂等（标签在就不重建）。状态还没落地（首帧 /status 未回）时不动，
		 * 避免把上一份正确状态推断成「关」而闪一下。
		 */
		function syncSidebarFooterFix() {
			if (typeof document === "undefined") return;
			if (!state || state.loaded !== true) return;
			var rows = state.rows || [];
			var enabled = false;
			for (var i = 0; i < rows.length; i++) {
				if (rows[i] && rows[i].id === SIDEBAR_FOOTER_FIX_ID) {
					enabled = rows[i].enabled === true;
					break;
				}
			}
			var existing = document.querySelector(SIDEBAR_FOOTER_FIX_SEL);
			if (enabled) {
				if (existing) return;
				var el = document.createElement("style");
				el.setAttribute("data-plugin", "dsh-tweaks");
				el.setAttribute("data-plugin-css", "dsh-tweaks-sidebar-footer");
				el.textContent = SIDEBAR_FOOTER_FIX_CSS;
				document.head.appendChild(el);
				return;
			}
			if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
		}

		function ensureStyles() {
			if (typeof document === "undefined") return;
			var tag = 'style[data-plugin-css="dsh-tweaks"]';
			var existing = document.querySelector(tag);
			if (existing) return;
			var el = document.createElement("style");
			el.setAttribute("data-plugin", "dsh-tweaks");
			el.setAttribute("data-plugin-css", "dsh-tweaks");
			el.textContent = CSS_TEXT;
			document.head.appendChild(el);
		}

		// ------------------------------------------------------------------
		// 客户端自报健康（症状1 的实机定位手段）。
		//
		// 为什么必须由浏览器半主动上报：宿主只知道自己「已安装」，不知道浏览器半
		// 到底跑没跑、槽注册了没有、动画是不是被系统的「减少动态效果」关掉了。
		// 这些全是浏览器侧的事实，只有浏览器半能回答。这里把答案如实 POST 给
		// 宿主的一个只读查看路由（人用 curl 看），不让任何界面依赖它。
		// ------------------------------------------------------------------
		var healthState = { reported: false, lastError: "", slots: {}, reducedMotion: false };

		function detectReducedMotion() {
			try {
				if (typeof window === "undefined" || !window.matchMedia) return false;
				return window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
			} catch (e) {
				return false;
			}
		}

		function detectSlots() {
			var slots = {};
			try {
				if (typeof document === "undefined") return slots;
				var nodes = document.querySelectorAll("[data-slot]");
				for (var i = 0; i < nodes.length; i++) {
					var name = nodes[i].getAttribute("data-slot");
					if (typeof name !== "string" || !name) continue;
					slots[name] = (slots[name] || 0) + 1;
				}
			} catch (e) {}
			return slots;
		}

		/**
		 * 把当前浏览器半的快照交给宿主。
		 *
		 * 失败不重试也不报错：这份数据只是给人看的诊断信息，绝不能因为它
		 * 影响插件自己的正常工作（宁可宿主那边少一条快照，也不能拖垮侧栏）。
		 */
		function reportHealth(reason) {
			if (typeof fetch === "undefined") return Promise.resolve(null);
			var payload = {
				reason: reason || "unknown",
				at: Date.now(),
				userAgent: (typeof navigator !== "undefined" && navigator.userAgent) ? String(navigator.userAgent).slice(0, 200) : "",
				reducedMotion: detectReducedMotion(),
				stylePresent: (function () {
					try {
						return !!(typeof document !== "undefined" && document.querySelector('style[data-plugin-css="dsh-tweaks"]'));
					} catch (e) { return false; }
				})(),
				slots: detectSlots(),
			};
			return fetch(HEALTH_REPORT, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			}).then(function (r) {
				healthState.reported = true;
				healthState.lastError = "";
				return r;
			}).catch(function (error) {
				healthState.reported = false;
				healthState.lastError = String((error && error.message) || error);
				return null;
			});
		}

		// ------------------------------------------------------------------
		// State: rows = 参与开关列表的 tweak（menu 声明或带 target）。
		// ------------------------------------------------------------------
		var state = { rows: [], loaded: false, refreshMs: DEFAULT_REFRESH_MS, tuning: [], configFile: "" };
		var listeners = [];

		function readTweaks(doc) {
			var list = doc && Array.isArray(doc.tweaks) ? doc.tweaks : [];
			var rows = [];
			for (var i = 0; i < list.length; i++) {
				var t = list[i];
				if (!t || typeof t.id !== "string") continue;
				if (!(t.menu === true || t.target || t.action)) continue;
				rows.push({
					id: t.id,
					title: t.title || t.id,
					// 一句话「它改什么」——比 why 更适合放在卡片正文里。
					what: typeof t.what === "string" ? t.what : "",
					why: typeof t.why === "string" ? t.why : "",
					note: typeof t.note === "string" ? t.note : "",
					error: typeof t.error === "string" ? t.error : "",
					enabled: t.enabled === true,
					applied: t.applied === true,
					effective: t.effective === true,
					present: t.present === true,
					// 生效对象：{ kind, label }（kind ∈ entry / plugin / file / host）
					subjectKind: typeof t.subjectKind === "string" ? t.subjectKind : "",
					subjectLabel: typeof t.subjectLabel === "string" ? t.subjectLabel : "",
					// 对象状态：idle / ready / pending / disabled / missing / mismatch
					subjectStatus: typeof t.subjectStatus === "string" ? t.subjectStatus : "unknown",
					subjectStatusLabel: typeof t.subjectStatusLabel === "string" ? t.subjectStatusLabel : "",
					effect: typeof t.effect === "string" ? t.effect : "",
					appliesWhen: typeof t.appliesWhen === "string" ? t.appliesWhen : "",
					// 归属（分组用）：标识这条补丁属于哪个组件。
					ownerName: typeof t.ownerName === "string" ? t.ownerName : "",
					ownerLabel: typeof t.ownerLabel === "string" ? t.ownerLabel : "",
					ownerKind: typeof t.ownerKind === "string" ? t.ownerKind : "",
					group: typeof t.group === "string" ? t.group : "",
					// 有 action 的条目对应重启入口（restartButton：底部/右上角/智能体工具由 options 决定）。
					action: typeof t.action === "string" ? t.action : null,
					actionReady: t.actionReady === true,
					actionBlockedBy: typeof t.actionBlockedBy === "string" ? t.actionBlockedBy : "",
					// 位置多选（restartButton）：主开关只控「是否启用」，勾选的位置才出现入口。
					options: Array.isArray(t.options) ? t.options.map(function (o) {
						o = o || {};
						return {
							id: typeof o.id === "string" ? o.id : "",
							label: typeof o.label === "string" ? o.label : String(o.id || ""),
							note: typeof o.note === "string" ? o.note : "",
							enabled: o.enabled === true,
						};
					}) : null,
				});
			}
			var refreshMs = DEFAULT_REFRESH_MS;
			var cfg = doc && doc.config;
			if (cfg && typeof cfg.statusRefreshMs === "number" && cfg.statusRefreshMs > 0) {
				refreshMs = cfg.statusRefreshMs;
			}
			// 可调参数（TUNING）：每个参数带 tweakId 归属，渲染到对应开关卡片上。
			// 慢链路参数归「慢链路保活」，重启参数归「重启宿主」，不再混在一张卡片里。
			var tuning = [];
			var tuned = doc && Array.isArray(doc.tuning) ? doc.tuning : [];
			for (var k = 0; k < tuned.length; k++) {
				var it = tuned[k];
				if (!it || typeof it.id !== "string") continue;
				tuning.push({
					id: it.id,
					tweakId: typeof it.tweakId === "string" ? it.tweakId : "",
					kind: it.kind === "number" ? "number" : "boolean",
					label: typeof it.label === "string" ? it.label : it.id,
					note: typeof it.note === "string" ? it.note : "",
					min: typeof it.min === "number" ? it.min : null,
					value: it.value,
				});
			}
			if (tuning.length) {
				for (var m = 0; m < rows.length; m++) {
					var mine = [];
					for (var n = 0; n < tuning.length; n++) {
						// 归属按 tweakId 匹配；无 tweakId 的老参数继续挂在重启卡片（兜底）。
						var owner = tuning[n].tweakId || "restartButton";
						if (owner === rows[m].id) mine.push(tuning[n]);
					}
					if (mine.length) rows[m].tuning = mine;
				}
			}
			var configFile = cfg && typeof cfg.configFile === "string" ? cfg.configFile : "";
			return { rows: rows, loaded: true, refreshMs: refreshMs, tuning: tuning, configFile: configFile };
		}

		function notify() {
			// ⚠ 必须把当前 state 传给 listener：React useState 的 setter 无参调用
			// 等价于 setState(undefined)，会把组件 state 置为 undefined，
			// 下一次渲染时 s.rows 抛错 → 整棵 React 树崩溃 → 界面白屏。
			for (var i = 0; i < listeners.length; i++) {
				try { listeners[i](state); } catch (e) {}
			}
		}

		// 状态落地后的钩子（install 用它按新间隔重排兜底刷新定时器）。
		var statusSink = null;
		var stopQuickRef = null;

		function fetchStatus() {
			return fetch(STATUS, { headers: { accept: "application/json" } })
				.then(function (r) {
					return r.text().then(function (text) {
						var doc = null;
						try {
							doc = JSON.parse(text);
						} catch (e) {
							doc = null;
						}
						state = readTweaks(doc);
						ensureStyles();
						syncSidebarFooterFix();
						if (statusSink) { try { statusSink(state); } catch (e) {} }
						notify();
						return state;
					});
				})
				.catch(function () {
					// ⚠ 关键：**不要**把 rows 清空。宿主写 ③ 后会重载插件、重放配置，
					// 这期间 /status 会短暂失败；若这里把 rows 置空，整张列表会瞬间消失
					// ——这正是「点一下开关，列表整个没了」的根因。
					// 正确做法：保留上一份好数据，只标一个 stale 标记。
					state = {
						rows: state.rows || [],
						loaded: state.loaded,
						refreshMs: state.refreshMs || DEFAULT_REFRESH_MS,
						tuning: state.tuning || [],
						configFile: state.configFile || "",
						stale: true,
					};
					if (statusSink) { try { statusSink(state); } catch (e) {} }
					notify();
					return state;
				});
		}

		/**

		/**
		 * 切一个开关。
		 *
		 * 宿主只写它自己的状态文件并就地重跑 apply，**不触发插件条目热重载**，
		 * 所以这次切换是即时的：请求回来后再取一次 /status 即可，不需要轮询等
		 * 「已经生效」。界面（分区、勾选框、滚动位置）全程不重建。
		 */
		/** 把一次勾选（主开关或子选项）乐观地映射到行/选项上。 */
		function applyToggle(rows, id, value) {
			return (rows || []).map(function (r) {
				if (r.id === id) return Object.assign({}, r, { enabled: value });
				if (r.options && r.options.length) {
					var hit = false;
					var opts = r.options.map(function (o) {
						if (o.id === id) { hit = true; return Object.assign({}, o, { enabled: value }); }
						return o;
					});
					if (hit) return Object.assign({}, r, { options: opts });
				}
				return r;
			});
		}

		function toggle(id, next) {
			// 乐观更新：先让勾选框立刻响应，失败再回滚（避免"点了没反应"的观感）。
			state = {
				rows: applyToggle(state.rows, id, next === true),
				loaded: state.loaded,
				refreshMs: state.refreshMs || DEFAULT_REFRESH_MS,
				tuning: state.tuning,
				configFile: state.configFile,
			};
			// 先按乐观状态同步一次，界面立刻变；请求回来后再由 fetchStatus 兜正。
			syncSidebarFooterFix();
			notify();
			return fetch(TOGGLE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: id, enabled: next }),
			}).then(function (r) {
				return r.text().then(function (text) {
					var doc = null;
					try { doc = JSON.parse(text); } catch (e) { doc = null; }
					if (!doc || doc.ok === false) {
						throw new Error((doc && doc.error) || ("写入失败（HTTP " + r.status + "）"));
					}
					return doc;
				});
			}).then(fetchStatus).catch(function (error) {
				// 失败：回滚乐观更新并记错误，列表照旧保留。
				state = {
					rows: applyToggle(state.rows, id, next !== true),
					loaded: state.loaded,
					refreshMs: state.refreshMs || DEFAULT_REFRESH_MS,
					tuning: state.tuning,
					configFile: state.configFile,
					lastError: String((error && error.message) || error),
				};
				syncSidebarFooterFix();
				notify();
				return state;
			});
		}

		/**
		 * 改一个可调参数（TUNING）：与开关共用 /toggle 通道 —— 写状态文件 + 就地重跑，
		 * 不碰 profile patch，因此既不用手改文件，也不会让界面闪断重建。
		 * 失败只记 lastError（数值控件保持用户刚输入的值，便于改正）。
		 */
		function setTuning(id, value) {
			return fetch(TOGGLE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: id, value: value }),
			}).then(function (r) {
				return r.text().then(function (text) {
					var doc = null;
					try { doc = JSON.parse(text); } catch (e) { doc = null; }
					if (!doc || doc.ok === false) {
						throw new Error((doc && doc.error) || ("写入失败（HTTP " + r.status + "）"));
					}
					return doc;
				});
			}).then(fetchStatus).catch(function (error) {
				state = Object.assign({}, state, { lastError: String((error && error.message) || error) });
				notify();
				return state;
			});
		}

		/**
		 * 轮询 /status 直到某个条目的 enabled 等于期望值，或超时。
		 * 只读、不写，超时返回 false（调用方再取一次状态即可）。
		 */
		function waitForApplied(id, want, timeoutMs) {
			var deadline = Date.now() + timeoutMs;
			function poll() {
				if (Date.now() > deadline) return Promise.resolve(false);
				return fetch(STATUS, { headers: { accept: "application/json" } })
					.then(function (r) { return r.json(); })
					.then(function (doc) {
						var list = doc && Array.isArray(doc.tweaks) ? doc.tweaks : [];
						for (var i = 0; i < list.length; i++) {
							if (list[i] && list[i].id === id) {
								if ((list[i].enabled === true) === (want === true)) return true;
								break;
							}
						}
						return new Promise(function (resolve) { setTimeout(resolve, 250); }).then(poll);
					})
					.catch(function () {
						// 宿主正在重载：稍等再试，不要当失败。
						return new Promise(function (resolve) { setTimeout(resolve, 250); }).then(poll);
					});
			}
			return poll();
		}


		/**
		 * 调重启路由：不带 token = 要令牌（不重启）；带 token = 确认重启。
		 * 两段式编排放在 useRestart，这里只管一次 HTTP 往返。
		 */
		function restart(token) {
			return fetch(RESTART, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(token ? { token: token } : {}),
			}).then(function (r) {
				return r.text().then(function (text) {
					var doc = null;
					try { doc = JSON.parse(text); } catch (e) { doc = null; }
					return { status: r.status, doc: doc };
				});
			});
		}

		/**
		 * 让宿主用系统编辑器打开配置文件。只在闸门是 Config（政策闸）时才提供 ——
		 * 那种情况用户在界面里怎么点都改不了，必须去文件里改一行。
		 */
		function openConfigFile() {
			return fetch(OPEN_CONFIG, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			}).then(function (r) {
				return r.text().then(function (text) {
					var doc = null;
					try { doc = JSON.parse(text); } catch (e) { doc = null; }
					return { status: r.status, doc: doc };
				});
			});
		}

		// ------------------------------------------------------------------
		// 从 /status 行里找重启入口行（action === "restart"；id 缺省 = 任一）。
		// footer 入口用 restartFooter、右上角入口用 restartHeader，各取各的行，
		// 两处入口互不依赖（开关内多选，可只开一个）。
		// ------------------------------------------------------------------
		function findRestartRow(rows, id) {
			var list = Array.isArray(rows) ? rows : [];
			for (var i = 0; i < list.length; i++) {
				if (list[i] && list[i].action === "restart" && (!id || list[i].id === id)) return list[i];
			}
			return null;
		}

		function restartRow(id) {
			return findRestartRow(state.rows, id);
		}

		/**
		 * 位置子选项是否勾选（options 由 /status 下发，id 就是状态键）。
		 * 主开关只控「是否启用」，具体出现在哪由这里多选。
		 */
		function optionOn(row, id) {
			var list = row && row.options;
			if (!Array.isArray(list)) return false;
			for (var i = 0; i < list.length; i++) {
				if (list[i].id === id) return list[i].enabled === true;
			}
			return false;
		}

		// ------------------------------------------------------------------
		// React: 设置 › 插件 › dsh-tweaks 页的开关列表（plugins.bundle.config）。
		// ------------------------------------------------------------------
		function useTweaks() {
			var s = React.useState(function () { return state; });
			var set = s[1];
			React.useEffect(function () {
				listeners.push(set);
				return function () {
					var i = listeners.indexOf(set);
					if (i >= 0) listeners.splice(i, 1);
				};
			}, []);
			return s[0];
		}

		/**
		 * 重启按钮的状态机（所有 action === "restart" 的卡片共用）。
		 * 三态：idle →（点一下）confirm 拿一次性令牌 →（再点一下）restarting。
		 * 第二次点击才真的重启。连接被掐断（宿主已退场）按成功处理——
		 * 那正是重启正在发生的征兆，不是失败。
		 */
		function useRestart(row) {
			var s = React.useState(function () { return { phase: "idle", busy: false, message: "", token: null, countdown: 0 }; });
			var set = s[1];
			function settle(result) {
				var doc = result && result.doc;
				if (doc && doc.ok) {
					if (doc.stage === "confirm") {
						set({ phase: "confirm", busy: false, message: doc.message || "", token: doc.token, countdown: CONFIRM_SECONDS });
						return;
					}
					// stage === "restarting"：宿主马上退场，页面即将断开。
					set({ phase: "restarting", busy: true, message: doc.message || "正在重启 DeepSeek Harness……" });
					return;
				}
				var error = (doc && doc.error) || "HTTP " + ((result && result.status) || "?");
				set({ phase: "idle", busy: false, message: "", token: null, error: error });
			}
			function act() {
				if (s[0].busy) return;
				var token = s[0].phase === "confirm" ? s[0].token : undefined;
				set(Object.assign({}, s[0], { busy: true }));
				restart(token).then(settle).catch(function () {
					// fetch 只在网络层失败时拒绝：宿主退出把连接掐断正落在这里。
					set({ phase: "restarting", busy: true, message: "连接已断开，宿主正在重启。" });
				});
			}
			function reset() {
				set({ phase: "idle", busy: false, message: "", token: null, countdown: 0 });
			}
			// 确认态倒计时：10 秒内自动重启；点叉号 / 取消 = reset 会清掉 interval。
			React.useEffect(function () {
				if (s[0].phase !== "confirm") return undefined;
				var timer = setInterval(function () {
					set(function (prev) {
						if (prev.phase !== "confirm") return prev;
						if (prev.countdown > 1) return Object.assign({}, prev, { countdown: prev.countdown - 1 });
						return Object.assign({}, prev, { countdown: 0 });
					});
				}, 1000);
				return function () { clearInterval(timer); };
			}, [s[0].phase]);
			React.useEffect(function () {
				if (s[0].phase === "confirm" && s[0].countdown === 0 && !s[0].busy) act();
			}, [s[0].phase, s[0].countdown]);
						return { st: s[0], act: act, reset: reset };
		}

		/** 自绘「电源」小图标（不引宿主 icon 原语，保持零依赖）。 */
		function RestartIcon(props) {
			var size = props.size || 14;
			return React.createElement("svg", {
				viewBox: "0 0 16 16", width: size, height: size, fill: "none",
				stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round",
				"aria-hidden": "true", style: { display: "block" },
			},
				React.createElement("path", { d: "M8 1.75v5" }),
				React.createElement("path", { d: "M4.9 3.9a4.6 4.6 0 1 0 6.2 0" }));
		}

		/** 自绘「取消」小图标：确认态用同尺寸叉号替换原电源图标（不写「取消」文字）。 */
		function CancelIcon(props) {
			var size = props.size || 14;
			return React.createElement("svg", {
				viewBox: "0 0 16 16", width: size, height: size, fill: "none",
				stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round",
				"aria-hidden": "true", style: { display: "block" },
			},
				React.createElement("path", { d: "M4.5 4.5l7 7" }),
				React.createElement("path", { d: "M11.5 4.5l-7 7" }));
		}

		/**
		 * 侧栏底部（sidebar.footer.action）的重启入口 —— 主开关 + restartFooter 位置选项。
		 * 宽展开时 28px 图标钮绝对定位叠在「设置」行右端（不占新行）；收窄轨时
		 * 36×36 静态图标钮。状态机与两段式令牌确认同卡片共用 useRestart；
		 * 开关没开、位置未勾、闸门未开（actionReady=false）→ 都不渲染（不占位），
		 * 图标一旦出现就必然可点（用户 2026-11-16 拍板）。
		 * hooks 无条件调用（早退在 hooks 之后），避免 React hooks 顺序漂移。
		 */
		function RestartFooterButton(props) {
			var s = useTweaks();
			var row = findRestartRow(s.rows, "restartButton");
			var r = useRestart(row);
			if (!row || row.enabled !== true) return null;
			// 主开关控制总开关；位置由多选子选项决定。
			if (!optionOn(row, "restartFooter")) return null;
			// 图标出现 == 可以点（用户 2026-11-16 拍板）：闸门没开（allowRestart=false）
			// 时整枚图标都不渲染、不占位，而不是渲染一个点了没反应的灰图标。
			// 开启路径仍在设置卡片里的「允许重启宿主」勾选，勾上后这里立即出现。
			if (row.actionReady !== true) return null;
			var st = r.st;
			var wide = props.wide === true;
			var tip = st.phase === "restarting" ? "正在重启……" : "重启宿主（桌面版关闭并重新打开应用，网页版交接重启）";
			// 确认态：左侧出现真正的「一键重启」文字按钮，原图标换成同尺寸的叉号
			// （取消），不再往图标里塞「取消」字样（2026-11-15 用户要求）。
			var iconCls = "dtw-footerBtn" + (wide ? "" : " dtw-footerBtn-rail");
			var iconBtn = React.createElement("button", {
				className: iconCls, type: "button",
				disabled: st.busy,
				"aria-label": st.phase === "confirm" ? "取消重启" : tip,
				title: st.phase === "confirm" ? "取消重启" : tip,
				onClick: function () { if (st.phase === "confirm") { r.reset(); return; } r.act(); },
			}, st.phase === "confirm"
				? React.createElement(CancelIcon, { size: wide ? 15 : 16 })
				: React.createElement(RestartIcon, { size: wide ? 15 : 16 }));
			var confirmBtn = React.createElement("button", {
				className: "dtw-footerBtn dtw-footerBtn-confirm",
				type: "button", disabled: st.busy,
				"aria-label": "一键重启",
				title: "确认重启（会话会被中断）；倒计时结束自动重启，点叉号取消",
				onClick: function () { r.act(); },
			}, React.createElement("span", { className: "dtw-footerBtn-label" }, "一键重启（" + st.countdown + "s）"));
			var nodes = st.phase === "confirm" ? [confirmBtn, iconBtn] : [iconBtn];
			if (!wide) return React.createElement(React.Fragment, null, nodes);
			return React.createElement("span", { className: "dtw-footerBtns" }, nodes);
		}

		/**
		 * 右上角会话标签栏入口（conversation.session.header.utilities）：
		 * 与底部入口共用同一套 useRestart 状态机与倒计时，只是外观更小。
		 * restartHeader 位置选项由用户拍板加入（2026-11-15）。
		 */
		function RestartHeaderButton(props) {
			var s = useTweaks();
			var row = findRestartRow(s.rows, "restartButton");
			var r = useRestart(row);
			if (!row || row.enabled !== true) return null;
			if (!optionOn(row, "restartHeader")) return null;
			// 与底部入口同一约定（用户 2026-11-16 拍板）：闸门未开就不渲染，
			// 保证「图标出现」等价于「可以点」。
			if (row.actionReady !== true) return null;
			var st = r.st;
			var tip = st.phase === "restarting" ? "正在重启……" : "重启宿主（桌面版关闭并重新打开应用，网页版交接重启）";
			var iconBtn = React.createElement("button", {
				className: "dtw-headerBtn", type: "button",
				disabled: st.busy,
				"aria-label": st.phase === "confirm" ? "取消重启" : tip,
				title: st.phase === "confirm" ? "取消重启" : tip,
				onClick: function () { if (st.phase === "confirm") { r.reset(); return; } r.act(); },
			}, st.phase === "confirm"
				? React.createElement(CancelIcon, { size: 14 })
				: React.createElement(RestartIcon, { size: 14 }));
			var confirmBtn = React.createElement("button", {
				className: "dtw-headerBtn dtw-headerBtn-text",
				type: "button", disabled: st.busy,
				"aria-label": "一键重启",
				title: "确认重启（会话会被中断）；倒计时结束自动重启，点叉号取消",
				onClick: function () { r.act(); },
			}, "一键重启（" + st.countdown + "s）");
			var nodes = st.phase === "confirm" ? [confirmBtn, iconBtn] : [iconBtn];
			return React.createElement("span", { className: "dtw-headerBtns" }, nodes);
		}

		/**
		 * restart_dsh 工具被调用时的显眼弹窗：宿主登记「待重启」后，这里长轮询拿
		 * 到倒计时并弹窗显示秒数；点「取消重启」通知宿主撤销（不重启）。
		 * 用 fixed 定位叠全屏（slot 插在 footer 里，不占布局、不读他人 DOM）。
		 */
		function RestartOverlay(props) {
			var p = React.useState(null);
			var pending = p[0], setPending = p[1];
			var n = React.useState(0);
			var now = n[0], setNow = n[1];
			React.useEffect(function () {
				var alive = true;
				function poll() {
					fetch(RESTART_PENDING, {
						method: "POST",
						headers: { "content-type": "application/json", accept: "application/json" },
						body: JSON.stringify({ waitMs: 20000 }),
						cache: "no-store",
					})
						.then(function (r) { return r.json(); })
						.then(function (doc) {
							if (!alive) return;
							setPending(doc && doc.pending ? doc.pending : null);
							poll();
						})
						.catch(function () {
							if (!alive) return;
							setPending(null);
							setTimeout(function () { if (alive) poll(); }, 2000);
						});
				}
				poll();
				return function () { alive = false; };
			}, []);
			React.useEffect(function () {
				if (!pending) return undefined;
				setNow(Date.now());
				var tick = setInterval(function () { setNow(Date.now()); }, 250);
				return function () { clearInterval(tick); };
			}, [pending]);
			if (!pending) return null;
			var remaining = Math.max(0, Math.ceil((Number(pending.until) - now) / 1000));
			var cancel = function () {
				fetch(RESTART_CANCEL, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: "{}",
					cache: "no-store",
				})
					.then(function (r) { return r.json(); })
					.then(function (doc) { if (doc && doc.ok && doc.cancelled) setPending(null); })
					.catch(function () {});
			};
			var reason = typeof pending.reason === "string" && pending.reason ? ("原因：" + pending.reason + "。") : "";
			return React.createElement("div", { className: "dtw-modal-backdrop" },
				React.createElement("div", { className: "dtw-modal", role: "alertdialog" },
					React.createElement("div", { className: "dtw-modal-title" }, "重启 DeepSeek Harness"),
					React.createElement("div", { className: "dtw-modal-text" },
						"智能体工具 restart_dsh 已请求重启。" + reason + "宿主将在 " + remaining + " 秒后重启；当前会话会中断（重启后由 dsh-client-auto-continue 续跑）。"),
					React.createElement("div", { className: "dtw-modal-actions" },
						React.createElement("button", { className: "dtw-btn dtw-btn-danger", type: "button", onClick: cancel }, "取消重启"))));
		}

		var SUBJECT_KIND_LABEL = {
			entry: "Loader 条目",
			plugin: "插件",
			file: "磁盘文件",
			host: "宿主进程",
		};

		var STATUS_LABEL = {
			idle: "未启用",
			ready: "就绪",
			pending: "待生效",
			disabled: "已禁用",
			missing: "对象缺失",
			mismatch: "形态不匹配",
			unknown: "未知",
		};

		function Chip(props) {
			return React.createElement("span", {
				className: "dtw-chip dtw-chip-" + props.kind,
				title: props.title || undefined,
			}, React.createElement("span", { className: "dtw-chip-key" }, props.label), props.value);
		}

		/**
		 * 一条 tweak = 一张卡片。勾选框恢复可交互——它现在挂在**设置窗口的独立分区**
		 * （settings.section，「增强补丁」），不再是插件详情条目下的内容，
		 * 因此点开关触发的条目热重载不会把界面打回插件信息页。
		 *
		 * 卡片只留核心：勾选框 + 短标题 + 一句描述 + 生效对象 chip + 对象状态 chip。
		 * 详细依据（why / effect / appliesWhen）全部收进悬浮 title。
		 */
		function TweakCard(props) {
			var row = props.row;
			var hint = [
				row.enabled ? "当前：已启用" : "当前：未启用",
				row.what ? "作用：" + row.what : "",
				row.subjectLabel ? "生效对象：" + row.subjectLabel : "",
				row.subjectStatusLabel ? "对象状态：" + row.subjectStatusLabel : "",
				row.effect ? "生效方式：" + row.effect : "",
				row.appliesWhen ? "生效条件：" + row.appliesWhen : "",
				row.why ? "依据：" + row.why : "",
			].filter(Boolean).join("\n");
			var subjectKindText = row.subjectKind
				? (SUBJECT_KIND_LABEL[row.subjectKind] || row.subjectKind)
				: "";
			return React.createElement("div", { className: "dtw-card", title: hint || undefined },
				React.createElement("div", { className: "dtw-head" },
					React.createElement("input", {
						type: "checkbox",
						className: "dtw-headcheck",
						checked: row.enabled === true,
						onChange: function (e) { toggle(row.id, e.target.checked); },
					}),
					React.createElement("div", { className: "dtw-headtext" },
						React.createElement("span", { className: "dtw-title" }, row.title),
						row.what ? React.createElement("span", { className: "dtw-what" }, row.what) : null)),
				// 只留两个 chip：作用在谁身上 + 它现在什么状况。
				React.createElement("div", { className: "dtw-meta" },
					row.subjectLabel
						? React.createElement(Chip, {
							kind: row.enabled ? "disabled" : "idle",
							label: (subjectKindText ? subjectKindText + "：" : ""),
							value: row.subjectLabel,
						})
						: null,
					React.createElement(Chip, {
						kind: row.subjectStatus,
						label: "",
						value: STATUS_LABEL[row.subjectStatus] || row.subjectStatus,
						title: row.subjectStatusLabel || undefined,
					})),
				// 只在真出问题时才占行（正常状态不刷屏）。
				row.error ? React.createElement("div", { className: "dtw-note dtw-note-error" }, "错误：" + row.error) : null,
				row.note ? React.createElement("div", { className: "dtw-note" }, row.note) : null,
				// 多层级：主开关下面挂位置多选（勾哪个位置出现哪个入口）。
				row.options && row.options.length
					? React.createElement("div", { className: "dtw-options" },
						row.options.map(function (o) {
							return React.createElement("label", {
								key: o.id,
								className: "dtw-opt" + (row.enabled === true ? "" : " dtw-opt-off"),
								title: o.note || undefined,
							},
								React.createElement("input", {
									type: "checkbox",
									checked: o.enabled === true,
									disabled: row.enabled !== true,
									onChange: function (e) { toggle(o.id, e.target.checked); },
								}),
								React.createElement("span", null, o.label));
						})
					)
					: null,
				// 可调参数（TUNING）：参数落在状态文件里，界面直接给控件 ——
				// 数字用 defaultValue + onBlur/回车提交（typing 时不打断输入），提交后
				// fetchStatus 会把新值带回来；key 带旧值，值一变就重挂载，显示刷新。
				// 行布局是两列栅格（控件 | 标签），说明文字另起一行占满整行 —— 见
				// .dtw-tune-row 的注释；布尔参数没有数字框，只多一个 dtw-tune-row-bool
				// 让勾选框靠左站，列宽与标签起点仍与数字行一致。
				// 归属：慢链路参数挂在「慢链路保活」卡片，重启参数挂在「重启宿主」卡片。
				row.tuning && row.tuning.length
					? React.createElement("div", { className: "dtw-tune" },
						row.tuning.map(function (t) {
							return React.createElement("label", {
								key: t.id,
								className: "dtw-tune-row" + (t.kind === "number" ? "" : " dtw-tune-row-bool"),
								title: t.note || undefined,
							},
								t.kind === "number"
									? React.createElement("input", {
										type: "number",
										className: "dtw-num",
										key: t.id + ":" + String(t.value),
										defaultValue: t.value,
										min: t.min === null ? undefined : t.min,
										onBlur: function (e) { void setTuning(t.id, Number(e.target.value)); },
										onKeyDown: function (e) {
											if (e.key === "Enter") void setTuning(t.id, Number(e.target.value));
										},
									})
									: React.createElement("input", {
										type: "checkbox",
										checked: t.value === true,
										onChange: function (e) { void setTuning(t.id, e.target.checked); },
									}),
								React.createElement("span", { className: "dtw-tune-label" }, t.label),
								t.kind === "number" && t.note
									? React.createElement("span", { className: "dtw-tune-note" }, t.note)
									: null);
						}))
					: null,
				// 闸门提示 + 兜底出路：两道闸门现在都在上面那几个控件里，一句话说清要勾哪个；
				// 「打开配置文件」只作为逃生口保留（配置写坏了、控件改不动时用），
				// 宿主只认自己的配置文件路径，不接受任意路径。
				row.action === "restart"
					? React.createElement("div", { className: "dtw-actions" },
						React.createElement("span", { className: "dtw-note dtw-note-inline" },
							row.actionReady === true
								? "闸门已开；上面勾选的位置就是入口出现的地方。"
								: (row.actionBlockedBy || "闸门未开")),
						state.configFile
							? React.createElement("button", {
								className: "dtw-btn",
								type: "button",
								title: "用系统编辑器打开 " + state.configFile,
								onClick: function () { void openConfigFile(); },
							}, "打开配置文件")
							: null)
					: null);
		}

		/**
		 * 按**归属对象**（owner）分组。
		 *
		 * 顺序固定：DSH 自身 → 各插件 → 其他。
		 */
		var OWNER_ORDER = ["dsh"];

		function groupRows(rows) {
			var byOwner = {};
			var order = [];
			for (var i = 0; i < rows.length; i++) {
				var r = rows[i];
				var key = r.ownerName || "other";
				if (!byOwner[key]) { byOwner[key] = { name: key, label: r.ownerLabel || key, kind: r.ownerKind || "other", rows: [] }; order.push(key); }
				byOwner[key].rows.push(r);
			}
			// 固定顺序：OWNER_ORDER 里列出的优先，其余按首次出现顺序。
			var names = [];
			for (var o = 0; o < OWNER_ORDER.length; o++) {
				if (byOwner[OWNER_ORDER[o]]) names.push(OWNER_ORDER[o]);
			}
			for (var j = 0; j < order.length; j++) {
				if (names.indexOf(order[j]) < 0) names.push(order[j]);
			}
			var out = [];
			for (var n = 0; n < names.length; n++) {
				var g = byOwner[names[n]];
				out.push({
					name: g.name,
					label: g.label,
					kind: g.kind,
					rows: g.rows,
				});
			}
			return out;
		}

		/** 组标题：归属对象 + 这一组的整体状况（开几个 / 有没异常）。 */
		function GroupHeader(props) {
			var rows = props.rows;
			var on = 0;
			var bad = 0;
			for (var i = 0; i < rows.length; i++) {
				if (rows[i].enabled) on++;
				if (rows[i].subjectStatus === "missing" || rows[i].subjectStatus === "mismatch") bad++;
			}
			return React.createElement("div", { className: "dtw-group" },
				React.createElement("span", { className: "dtw-groupname" }, props.label),
				React.createElement("span", { className: "dtw-groupmeta" },
					on + "/" + rows.length + " 已启用" + (bad ? " · " + bad + " 项异常" : "")));
		}

		function TweaksPage() {
			var s = useTweaks();
			var rows = s.rows || [];
			var groups = groupRows(rows);
			var status = null;
			if (s.stale) {
				status = React.createElement("p", { className: "dtw-pagehint dtw-pagehint-warn" },
					"宿主正在重载，下面是上一次读到的状态（会自动刷新）。");
			} else if (s.lastError) {
				status = React.createElement("p", { className: "dtw-pagehint dtw-pagehint-error" },
					"上一次操作失败：" + s.lastError);
			}
			return React.createElement("div", null,
				React.createElement("p", { className: "dtw-pagehint" },
					"每条改动单独开关，按归属对象分组；开关写回 profile 配置，随 profile 跨机同步。"),
				status,
				groups.length
					? groups.map(function (grp) {
						return React.createElement("div", { key: grp.name, className: "dtw-section" },
							React.createElement(GroupHeader, { label: grp.label, rows: grp.rows }),
							grp.rows.map(function (row) {
								return React.createElement(TweakCard, { key: row.id, row: row });
							}));
					})
					: React.createElement("p", { style: { opacity: 0.6 } },
						s.loaded ? "宿主还没有登记任何开关。" : "正在读取开关状态……"));
		}

		/**
		 * 插件详情页（设置 › 插件 › dsh-tweaks）里那一块 ——**只读说明**。
		 *
		 * 为什么这里不放开关：开关一改就要写配置 → 插件条目热重载 → 本页重建，
		 * 界面会跳回"只有插件信息"的状态（用户明确反馈的痛点）。所以开关移到
		 * 设置窗口的一级分区（settings.section，「增强补丁」），那里不挂在插件条目下，
		 * 不受这条重载链影响。这里只留一句指路 + 状态摘要。
		 */
		function PluginInfo() {
			var s = useTweaks();
			var rows = s.rows || [];
			var on = 0;
			for (var i = 0; i < rows.length; i++) if (rows[i].enabled) on++;
			return React.createElement("div", null,
				React.createElement("p", { className: "dtw-pagehint" },
					"本插件登记了一组小改动开关。开关在设置窗口的「增强补丁」分区里改（左侧导航），不在本页——"
					+ "改开关会触发插件重载，放在本页会打断浏览。"),
				React.createElement("p", { className: "dtw-pagehint" },
					"当前：" + on + "/" + rows.length + " 项已启用。"));
		}

		// ------------------------------------------------------------------
		/** 确认态倒计时秒数（footer / 右上角两个入口共用）。 */
		var CONFIRM_SECONDS = 10;

		function install() {
			if (typeof document === "undefined") return function () {};
			ensureStyles();
			// 首帧先清掉上一次（页面刷新前 / 插件重载前）可能残留的按开关样式，
			// 等 /status 回来再按真实开关状态决定是否注入。
			if (state.loaded !== true) {
				try {
					var stale = document.querySelector(SIDEBAR_FOOTER_FIX_SEL);
					if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
				} catch (e) {}
			}

			var timer = null;

			// 兜底刷新：间隔由宿主 /dsh-tweaks/status 的 config.statusRefreshMs 下发
			// （不写死在浏览器半），这里按当前值重排定时器。
			function armRefresh() {
				if (timer) clearInterval(timer);
				var ms = state.refreshMs > 0 ? state.refreshMs : DEFAULT_REFRESH_MS;
				timer = setInterval(function () {
					if (typeof document !== "undefined" && document.hidden) return;
					fetchStatus();
				}, ms);
			}

			armRefresh();

			// 每次状态落地（首帧 / 每次 toggle / 每次兜底刷新）都按服务端下发的
			// 间隔重排定时器，这样 statusRefreshMs 改一次就全局生效，不写死。
			statusSink = function () { armRefresh(); };
			fetchStatus();

			// 自报健康：首帧报一次、页面回到前台再报一次。
			// 这是给人看的诊断信息（浏览器半到底跑没跑、槽有没有注册），
			// 报失败也不影响插件自己的活。
			reportHealth("install");
			var onVisible = function () {
				if (typeof document !== "undefined" && !document.hidden) reportHealth("visible");
			};
			try {
				if (typeof document !== "undefined" && document.addEventListener) {
					document.addEventListener("visibilitychange", onVisible);
				}
			} catch (e) {}


			// 首帧没拿到内容时快速重试几次（宿主可能还没注册完路由 / 正忙）。
			// 只重试「真的空」，不重试「已经拿到但列表为空」——后者是宿主如实回答。
			var quick = 0;
			var quickTimer = setInterval(function () {
				if (quick++ >= 5) { clearInterval(quickTimer); return; }
				if (state.rows.length > 0) { clearInterval(quickTimer); return; }
				fetchStatus();
			}, 400);
			var stopQuick = function () {
				clearInterval(quickTimer);
				if (quickTimer) quickTimer = null;
			};
			stopQuickRef = stopQuick;

			return function dispose() {
				if (timer) clearInterval(timer);
				try {
					if (typeof document !== "undefined" && document.removeEventListener) {
						document.removeEventListener("visibilitychange", onVisible);
					}
				} catch (e) {}
				if (stopQuickRef) { stopQuickRef(); stopQuickRef = null; }
				// 按开关注入的样式随插件一起撤掉（常驻 CSS_TEXT 留给下次 install 重建）。
				try {
					var fix = document.querySelector(SIDEBAR_FOOTER_FIX_SEL);
					if (fix && fix.parentNode) fix.parentNode.removeChild(fix);
				} catch (e) {}
				statusSink = null;
				listeners = [];
			};
		}

		var inject = ["slots"];

		function apply(ctx) {
			ctx.effect(function () {
				return install();
			}, "dsh-tweaks: status polling and styles");

			// ── 具体补丁开关：设置窗口的**一级分区**（settings.section，「增强补丁」）──
			// 这是开关的权威入口。为什么不用 plugins.bundle.config（插件详情页）：
			// 开关一改 → 写配置 → 插件条目热重载 → 详情页重建 → 界面跳回"只有插件信息"
			// （用户明确反馈的痛点）。settings.section 是设置窗口自己的导航分区，
			// 不挂在插件条目下，不受这条重载链影响，所以 checkbox 可以放心交互。
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: SECTION_ID,
					order: 45,
					label: function () { return "增强补丁"; },
				}, TweaksPage);
			});
			// ── 插件本身的配置：设置 › 插件列表 › dsh-tweaks 详情页（只读说明）──
			// 只留一句指路 + 启用计数，不放开关（理由见 PluginInfo / 上面）。
			ctx.slots.inject("plugins.bundle.config", function () {
				return ctx.slots.register({
					name: "plugins.bundle.config",
					key: BUNDLE_KEY,
				}, PluginInfo);
			});
			// ── 侧栏底部重启按钮（sidebar.footer.action，id restart-footer，order 40）──
			// restartFooter 开关的入口：宽展开时叠在「设置」行右端（28px 图标），
			// 收窄轨时 36×36 静态；排在 dsh-m（市场入口，order 9）与
			// dsh-session-manager（order 30）之后，不与它们争语义位。
			ctx.slots.inject("sidebar.footer.action", function () {
				return ctx.slots.register({
					name: "sidebar.footer.action",
					id: "restart-footer",
					order: 40,
					label: function () { return "重启宿主"; },
				}, RestartFooterButton);
			});
			// ── 右上角会话标签栏入口（conversation.session.header.utilities，id restart-header，order 31）──
			// restartHeader 开关的入口；和底部同一套 useRestart 状态机。用户最早指的
			// 就是 dsh-unlag 所在的这个工具区（2026-11-15 反馈）。
			ctx.slots.inject("conversation.session.header.utilities", function () {
				return ctx.slots.register({
					name: "conversation.session.header.utilities",
					id: "restart-header",
					order: 31,
					label: function () { return "重启宿主"; },
				}, RestartHeaderButton);
			});
			// ── 重启工具倒计时弹窗（sidebar.footer.action 里的零尺寸占位）──
			// 平时不渲染任何东西；restart_dsh 被调用后全屏 fixed 弹窗显示倒计时并可取消。
			ctx.slots.inject("sidebar.footer.action", function () {
				return ctx.slots.register({
					name: "sidebar.footer.action",
					id: "restart-overlay",
					order: 50,
					label: function () { return "重启倒计时"; },
				}, RestartOverlay);
			});
			// 两处重启入口都走官方 slot（footer + 会话标签栏），不再有任何 DOM 注入。
			// 头像菜单（AccountMenu）依旧没有菜单项 slot 可扩展。
		}

		exports.STATUS = STATUS;
		exports.RESTART = RESTART;
		exports.apply = apply;
		exports.inject = inject;
		exports.__internals = {
			readTweaks: readTweaks,
			toggle: toggle,
			restart: restart,
			syncSidebarFooterFix: syncSidebarFooterFix,
			SIDEBAR_FOOTER_FIX_ID: SIDEBAR_FOOTER_FIX_ID,
			SIDEBAR_FOOTER_FIX_CSS: SIDEBAR_FOOTER_FIX_CSS,
			findRestartRow: findRestartRow,
			optionOn: optionOn,
			restartRow: restartRow,
		};
		return module.exports;
	},
});
