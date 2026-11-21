# dsh-enhance-tweak — 增强补丁

DeepSeek Harness 的可单独开关的增强补丁集合：隐藏内置供应商、修复侧边栏布局、一键重启宿主、放宽慢链路超时、跨机冷会话发现。开关在设置窗口「增强补丁」分区里改，切换即时生效、界面不跳转。

**与 dsh-xlock 的分工**：会话锁、创建归属、跨机归档等写入门禁归 dsh-xlock；本插件只管「补丁开关」和「同步来的新会话挂进列表」。

## 现有开关

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| `hideBuiltinDeepseek` | 关 | 隐藏内置供应商，模型列表只留「DeepSeek 账号」 |
| `sidebarFooterLayout` | 关 | 修复侧边栏底部入口错位（上游插件 CSS 冲突） |
| `restartButton` | 关 | 重启宿主：侧栏底部 / 右上角标签栏 / 智能体工具三个入口可选 |
| `slowLinkTimeouts` | 开 | 慢链路下放宽网关心跳与就绪超时（2000/15000 → 30000/120000ms） |

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

本仓库是开发用源码目录，不直接发布到 npm。profile 的 `dependencies` 写 `file:` 相对路径指向本目录：

```yaml
dsh-enhance-tweak: "file:../path/to/dsh-plugins/dsh-enhance-tweak"
```

`pnpm install` 后应为真实目录（`Get-Item node_modules\dsh-enhance-tweak` 的 `LinkType` 为空），不能是 Junction/符号链接——否则依赖解析基准会落到源码目录，`@deepseek-ai/schemastery` 找不到。装后重启 DSH。

## Dev

```bash
node test/run.mjs
```

## License

MIT
