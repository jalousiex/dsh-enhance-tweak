# 平台缺口问题卡：桌面主进程缺「插件请求干净重启」通道

> 指针式登记（per `platform-issue-card` skill）：本卡只登记事实、不写本地兜底映射；
> 现行本地兜底（helper 点恢复框按钮）见 `README.md`「重启宿主（优雅交接）」与 `index.js`
> `windowsDesktopHandoffScript`，不在本卡重复展开。卡内容遵循 skill 的六段版式与六项硬判据。

## 1. 标题

桌面版主进程（Electron）**不提供**「请求重启并干净退出」的插件接口，也**不消费**宿主侧已有的
干净退出信号（`child.once('close')` 无论退出码都按崩溃处理）——插件只能借恢复对话框的
「重启」按钮（UI 自动化 `BM_CLICK`）间接触发 `app.relaunch()`，且不点按钮就走不到唯一清托盘的
`finishQuit()`，导致托盘图标残留。

## 2. 环境

- 平台：DeepSeek Harness 桌面版 `dsh-desktop/0.2.2-rc.3`（Electron/44.7.0），Windows 10
- 主进程源码：从 `app.asar` 抽取的 `lib__main.js`（对照用，见 skill「可还原」）
- 租户 / SDK：不适用（本地桌面应用）
- 沙箱对象：一个真实运行的 dsh-desktop 实例 + 其宿主进程
- 还原状态：探针只读（抽 asar、读 `%TEMP%\dsh-tweaks-restart.log`、查路由）；唯一写操作是插件
  自身的重启流程，可在 GUI 内点「重新启动」回基线

## 3. 现象（含对照实验）

### 3.1 现象 A：宿主任何退出码都触发「启动失败」恢复框

- **机制**：`child.once('close')` 处理器无条件 `this.fail()`（不看退出码）→ 弹恢复框。
- **对照实验**：
  | 入参 | 结果 | 判定层 |
  |---|---|---|
  | 宿主 `cmdline.exit(0)`（优雅退） | 弹「DeepSeek Harness 无法使用」恢复框 | 连接生命周期层 |
  | 宿主 `process.exit(非0)` | 同上，**无差别** | 同上 |
  两条结果相同 → 未区分退出码，判定在生命周期层而非业务层。

### 3.2 现象 B：恢复框按钮是插件唯一的重启入口（且需靠文案匹配）

恢复框按钮：退出 / **重启**（defaultId=1）/ **禁用第三方插件和 profile patch 之后重启** / 取消报告。
「禁用…之后重启」文案含「重启」二字。**对照实验**（同一 helper，两种匹配规则）：
| 匹配规则 | 重启按钮 | 禁用按钮 | 主进程退场 | 托盘 |
|---|---|---|---|---|
| 宽松（只匹配「重启」） | 点 | **也点了** | 0.5s 干净 | 干净，但险些误禁插件 |
| 收紧（只点第一个 + 排除「禁用」） | 点一次 | 不点 | 0.4s 干净 | 干净 ✅ |
说明修复只能靠本地启发式补丁，平台无可靠重启入口。

### 3.3 现象 C：托盘图标残留

`finishQuit()` 是唯一执行 `tray.dispose()` 的路径；触发它需 `sessionEnding`（win32 **仅系统真注销**
触发，伪造 `WM_ENDSESSION`/`WM_QUERYENDSESSION` 无效）或 `quitWithoutConfirmation`（恢复框「重启」
按钮才置位）。不点按钮 → 不走 `finishQuit` → 托盘 ghost 残留。
**对照实验**：
| 做法 | 是否走 finishQuit | 托盘 |
|---|---|---|
| helper 强杀主进程 | 否 | ghost 残留 |
| helper 点恢复框「重启」按钮 | 是 | 干净 ✅ |

## 4. 缺口与影响

**缺口**：DESKTOP_IPC **没有 `restart` 通道**（已核对处理器清单；`plugin-operation` 只做诊断）。
提供重启意图的是插件（宿主侧 `/dsh-tweaks/restart` + 智能体工具 `restart_dsh`），消费重启意图的
只有恢复框「重启」按钮（UI 事件）——两族接口标识/意图不匹配，平台无「插件→主进程」的重启意图
映射入口。

**影响**：① 插件无法可靠触发重启，只能 UI 自动化（脆弱）；② 唯一清托盘路径不可达，托盘残留；
③ 靠文案匹配按钮会误点「禁用第三方插件」，需本地启发式兜底。

## 5. 诉求

1. **（首选）** DESKTOP_IPC 暴露 `restart`：主进程收到后 `app.relaunch()+quitWithoutConfirmation()`
   （走 `finishQuit` 清托盘），无需弹恢复框。
2. **（次选）** 恢复框「重启」按钮提供稳定程序化标识（controlId / 固定 HWND 名）。
3. **（底线）** 文档明确插件请求重启的官方方式；`child.once('close')` 区分退出码（exit(0) 不按崩溃
   弹框，直接干净退出）。

请平台确认：① 无条件弹恢复框是设计还是缺陷；② `restart` 通道补上前的短期对接口径；③ 修复版本。

## 6. 复现

宿主侧 `requestGracefulExit` → `cmdline.exit(0)`，触发 `/dsh-tweaks/restart`（两段式令牌确认）或
智能体工具 `restart_dsh`。日志 `%TEMP%\dsh-tweaks-restart.log` 关键行：
```
host exited
fg cls=#32770 title=DeepSeek Harness 无法使用
  clicking restart child[16]        ← 收紧后只点一次
  child[18] cls=Button text=禁用第三方插件和 profile patch 之后重启
main already gone                    ← finishQuit 干净退，托盘干净
relaunch try 0
done
```
时间 2026-11-17 18:04（+08:00）；机器名与 machineId 已略（不影响复现，属本机环境标识）。
凭据、令牌不进卡。
