# dsh-enhance-tweak — 增强补丁

DeepSeek Harness 的可单独开关的增强补丁集合：隐藏内置供应商、修复侧边栏布局、一键重启宿主、放宽慢链路超时、跨机冷会话发现。开关在设置窗口「增强补丁」分区里改，切换即时生效、界面不跳转。

**与 dsh-xlock 的分工**：会话锁、创建归属、跨机归档等写入门禁归 dsh-xlock；本插件只管「补丁开关」和「同步来的新会话挂进列表」。

## 现有开关

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| `hideBuiltinDeepseek` | 关 | 隐藏内置供应商，模型列表只留「DeepSeek 账号」 |
| `sidebarFooterLayout` | 关 | 修复侧边栏底部入口错位（上游插件 CSS 冲突） |
| `restartButton` | 关 | 重启宿主：侧栏底部 / 右上角标签栏 / 智能体工具三个入口可选 |
| `slowLinkTimeouts` | 开 | 仅放宽连接就绪超时：`slowReadyTimeoutMs` 默认 120000ms（出厂 15000ms）；效果尚未证实 |

另有 `sessionDiscoveryMs`（默认 15s）：扫描同步盘上对端新建的会话并挂进列表，对端删掉的撤行；只发现、不恢复、不绕过 xlock 门禁。

## 设计思路

- **一处开关，随 profile 走**：开关状态存 `.cache/dsh-tweaks/state.json`，不写 Config/patch——避免 profile `patchReload: live` 下的热重载闪断；切换 = 写文件 + 进程内对账。
- **声明式补丁**：每个 tweak 在 `TWEAKS` 注册表里声明 `target`（Loader 条目类，置 disabled）或 `configPatch`（配置值类，写目标 config）或 `menu`（浏览器半，按状态注入样式）；对账事件驱动、可回滚。
- **每张卡片自我说明**：`what` / `why` / `appliesWhen` 写在开关声明里，卡片上直接展示。

## 配置（Config）

```yaml
- id: dsh-tweaks
  name: 'dsh-enhance-tweak'
  config:
    statusRoute: true        # 只读状态路由
    sessionDiscoveryMs: 15000 # 跨机冷会话发现间隔；0 关闭
```

重启位置、倒计时等毫秒参数在设置卡片上改（存状态文件），不进 Config。

## 安装

本仓库同时保留开发源码和 npm 发布包。本机开发 profile 的 `dependencies` 可写 `file:` 相对路径指向本目录；其他机器使用 npm 发布版：

```yaml
dsh-enhance-tweak: "file:../path/to/dsh-plugins/dsh-enhance-tweak"
```

`pnpm install` 后应为真实目录（`Get-Item node_modules\dsh-enhance-tweak` 的 `LinkType` 为空），不能是 Junction/符号链接——否则依赖解析基准会落到源码目录，`@deepseek-ai/schemastery` 找不到。装后重启 DSH。

## Dev

```bash
node test/run.mjs
node test/slow-link-test.mjs
```

`test/run.mjs` 会创建并递归删除固定的 `test/tmp-state-home`；运行前须检查该路径及本机删除规则。`slow-link-test.mjs` 使用内存假 Loader，不操作真实配置或重启服务。

慢链路单项测试控制器目前仅供隔离模拟，默认拒绝启动，未连接生产写入路由；它不能用于实机验证。总开关现在只调整连接就绪超时，不再调整网关心跳；旧状态中的 `slowHeartbeatMs` 会被忽略。其状态不能证明手机端实际使用的值或连接改善，关闭时会尝试恢复原值，但不能保证并发修改时完全恢复。

启用 `statusRoute` 时，`GET /dsh-tweaks/slow-link-observe` 使用 Connection 的现有认证与信任检查，只读报告两个目标 fiber 的已解析配置及生命周期；目标条目不唯一或配置中的模块名无法确认时不报告数值。配置值不等于网关 mux 定时器或手机连接控制器的实际运行值。源码修改须安装并重启宿主后才可能在运行版可用。

## License

MIT
