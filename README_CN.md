# claude-tmux-dog (`cdog`)

<p align="center"><img src="assets/avator_dog_500.png" width="500" alt="cdog"></p>

> [English](README.md) | 中文版

Claude Code 进程管理器 & 跨 Agent 消息总线。通过 tmux + Claude Code **Hook 机制**管理长期运行的 Agent，事件驱动生命周期。后台**守护进程级 watcher** 自动处理上下文防御和 API 错误恢复。内置**消息中继**让 Agent 跨会话互通——不需要消息中间件，不需要额外的 daemon 框架。支持无人值守 7×24 运行（auto-nudge + auto-recovery + 双层上下文压缩）。

## 核心优势

| # | 优势 | 说明 |
|---|------|------|
| 1 | **零轮询** | Claude Code Hook（`Stop` / `StopFailure` / `SessionStart` / `SessionEnd`）推送事件给 cdog，无需循环、定时器或文件监听 |
| 2 | **状态双轨制** | Claude 进程状态（hook 驱动：`running` / `waiting` / `failed` / `completed`）与 cdog 监控状态（命令驱动：`watching` / `detached`）相互独立。`cdog stop` 不杀进程 |
| 3 | **自动续推** | 每次 Stop hook 触发时自动发送可配置的 prompt（如"继续"），让 Agent 持续自主运行 |
| 4 | **自动恢复** | 遇到可恢复的 StopFailure（限流、过载、超时、服务端错误），执行 cdog-recover 流程：Ctrl-C + `/new` + `--resume`。5 分钟内 ≥3 次失败触发熔断 |
| 5 | **双层上下文防御** | **Pane watcher**（主动）：通过 `pipe-pane` 监控 tmux 面板的 `↑ tokens`，在 80% 时提前压缩，避免错误发生。**Log watcher**（被动）：tail claude 调试日志，按类型分类 API 错误，达到阈值触发 compact-or-nudge。压缩完成通过 `PostCompact` hook 检测——无硬编码延迟 |
| 6 | **API 错误分类** | 错误分为 `timeout` / `provider` / `rate_limit` / `unknown`，每种有不同阈值。`overloaded_error` → provider（不是上下文满）。provider/rate_limit 错误不压缩——让 claude 自行重试 |
| 7 | **状态共享** | Pane watcher 将 `last_up_tokens` 记录到 state；log watcher 在首次 API 错误时读取它实现快速路径（tokens ≥ 70% 时阈值降为 1） |
| 8 | **消息转发** | `cdog message send` 向运行中的 Agent tmux 面板发送任意文本，支持 `--from` 署名和 `--reply-method` 构建回复链 |
| 9 | **自动关闭** | `max_run` 存储截止时间戳；在 `SessionEnd` 时检查是否到期，到期则标记 `completed` 并杀掉 tmux 会话。无需 cron——hook 事件时被动检查 |
| 10 | **自动初始化** | `cdog start` 发现 `~/.claude/settings.json` 中缺少 hook 时自动执行 `cdog init`（hook 可能被 claude 更新重置） |
| 11 | **隔离的 tmux 会话** | 每个 Agent 拥有独立 tmux 会话，完全隔离。tmux 自带守护能力，父进程退出后依然存活 |
| 12 | **内置日志** | 可选的 Agent 操作日志和 Claude 调试日志，通过 `cdog log` 支持 follow/按名过滤/全量/claude-log 多种模式 |
| 13 | **批量操作** | `cdog start/stop/restart/delete all`——一条命令作用于所有已注册 Agent。单个失败不影响其余 |
|14 | **桌面通知** | 可选的 macOS 通知中心提醒 + 音效（中/英文），覆盖启动、失败、恢复、API 错误、熔断、到期、续推、任务完成等事件 |

## 工作原理

1. **cdog start** 读取 `cdog.json`，在 detached tmux 会话中启动 `claude`，注入 UUID `--session-id`。如果 `~/.claude/settings.json` 中缺少 hook，会先自动执行 `cdog init`
2. **Hook 推送事件**——每次 Claude 触发 `Stop`、`StopFailure`、`SessionStart` 或 `SessionEnd`，hook 脚本调用 `cdog notify <json>`
3. **cdog 分发处理**——`Stop` → 自动续推（如启用）；`StopFailure` → 自动恢复（如启用）；`SessionStart` → 标记 `running`；`SessionEnd` → 标记 `stopped`/`failed`
4. **双层 watcher**——`cdog start` 同时启动两个 detached watcher 子进程：
   - **Pane watcher**（主动）：使用 `tmux pipe-pane` 流式读取面板输出，解析 claude TUI 状态栏的 `↑ X.Yk tokens`，在 `max_tokens` 的 80% 时提前压缩。如果 `pipe-pane` 不可用，降级为每 15s `capture-pane` 轮询
   - **Log watcher**（被动）：`tail -f` claude 调试日志，按类型分类 `[ERROR] API error` 行，达到阈值时触发 compact-or-nudge
5. **命令分离**——`cdog stop` 不杀 Claude，仅将 cdog 切换为 `detached`，忽略所有 hook。`cdog restart` 切回 `watching`。只有 `cdog delete` 才真正杀掉 tmux 会话
6. **恢复流程**——遇到可恢复错误，cdog 先输入 `cdog-recover` 标记、发送 Ctrl-C、检查标记是否存活，然后执行 `compactOrNudge`（读取 state 中的 `last_up_tokens` → ≥ 80% 则 `/compact`，否则发送 prompt 续推）

## 安装

```bash
# 从 npm 安装
npm install claude-tmux-dog -g
# 或
pnpm install claude-tmux-dog -g
# 或
yarn global add claude-tmux-dog

# 一次性安装：创建 ~/.cdog/ 并配置 ~/.claude/settings.json 的 hook
cdog init
```

`cdog init` 将 hook 脚本复制到 `~/.cdog/hooks/`，并将 `Stop` / `StopFailure` / `SessionStart` / `SessionEnd` / `PreCompact` / `PostCompact` hook 配置写入 `~/.claude/settings.json`（会先备份为 `.cdog.bak`）。

## 项目配置（`cdog.json`）

在项目根目录创建：

```json
{
  "name": "snow-agent",
  "cwd": "/Users/linquan/works/snow-agent",
  "md": "snow-agent.md",
  "args": ["--dangerously-skip-permissions"],
  "log": "./logs/claude-debug.log",
  "log_file": "./logs/cdog.log",
  "model": "glm-5.2",
  "timeformat": "YYYY-MM-DD HH:mm:ss",
  "timeout": 10000,
  "watchdog": {
    "prompt": "继续",
    "max_run": "7d",
    "max_tokens": "1m",
    "auto_nudge_stop": true,
    "auto_restart": true,
    "api_error_auto_compact": {
      "threshold": 3
    },
    "pane_watcher": {
      "compact_ratio": 0.8,
      "interval": 30
    }
  }
}
```

| 配置项 | 必填 | 说明 |
|--------|------|------|
| `name` | ✓ | Agent 名称，唯一标识。不能为 `all` |
| `cwd` | ✓ | 工作目录，tmux 会话在此创建 |
| `md` | | 任务 markdown 文件。支持字符串、逗号分隔字符串、数组。相对 `cwd` 或绝对路径。cdog 执行 `cat <md...> \| claude` |
| `args` | | 附加 CLI 参数，追加到 claude 命令后面 |
| `log` | | Claude 调试日志路径（相对 `cwd`），追加 `--debug-file <path>` |
| `log_file` | | cdog 自身操作日志路径。不配置则不写操作日志 |
| `model` | | 模型标签，仅用于 `cdog status` 展示 |
| `timeformat` | | 显示时间格式（dayjs 令牌）。默认 `YYYY-MM-DD HH:mm:ss` |
| `timeout` | | 停止/重启等待超时（毫秒） |
| `watchdog` | | 自动管理策略（见下方） |
| `notify` | | 桌面通知配置（见下方） |

### 看门狗配置

```json
"watchdog": {
  "prompt": "继续",
  "max_run": "7d",
  "max_tokens": "1m",
  "auto_nudge_stop": true,
  "auto_restart": true,
  "api_error_auto_compact": {
      "threshold": 3,
      "prompt": "继续"
    },
  "pane_watcher": {
    "max_tokens": "1m",
    "compact_ratio": 0.8,
    "interval": 30,
    "prompt": "继续"
  }
}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `prompt` | `"continue"` | 每次续推时发送的文本（auto_nudge_stop + cdog nudge） |
| `max_run` | | 最大运行时长（如 `"7d"` / `"4h"` / `"1d4h"`）。到期自动停止 |
| `max_tokens` | `200000` | 模型最大上下文 token 数。接受数字或人类可读字符串：`200000`、`"200k"`、`"1m"`。由 pane_watcher（80% 压缩）和 api_error_auto_compact（70% 快速路径）共享 |
| `auto_nudge_stop` | `false` | Stop hook 时自动发送 prompt + Enter，保持 Agent 持续工作 |
| `auto_restart` | `true` | 可恢复的 StopFailure 时自动执行 cdog-recover 恢复流程 |
| `api_error_auto_compact` | | Log watcher 配置（见下方）。始终启用 |
| `pane_watcher` | | Pane watcher 配置（见下方）。始终启用 |

#### `api_error_auto_compact` — log watcher（被动）

tail claude 调试日志中的 `[ERROR] API error` 行，按类型分类，达到阈值时触发 compact-or-nudge。始终启用——cdog 总是传 `--debug-file` 给 claude，所以日志文件总是存在。

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `threshold` | `3` | 连续 `unknown` API 错误触发阈值。`timeout` 使用 `max(threshold * 2, 6)` |
| `prompt` | `watchdog.prompt` | 上下文健康（upTokens < 80% of max）时发送的文本 |

**压缩决策：** 从 state 读取 `last_up_tokens`（pane watcher 记录）。如果 `upTokens >= max_tokens * 0.8` → `/compact`。否则 → 续推。不需要 `/context` 命令——基于 token 数据瞬时决策。

**API 错误分类**（按类型阈值）：

| 类型 | 匹配 | 阈值 | 动作 |
|------|------|------|------|
| `fatal` | `model_not_found`、`authentication_failed`、`billing_error` | 立即 | **停止 Agent**——C-c（标识检测）→ 标记 `failed` → 杀 tmux → 杀 watchers → 通知 |
| `timeout` | `timed out`、`524`、`TTFB`、`no response headers` | `max(threshold * 2, 6)` | C-c → breakToShell → compact-or-nudge |
| `provider` | `503`、`upstream error`、`no available channel`、`overloaded_error`、`访问量过大`、`稍后再试` | 从不 | 让 claude 重试；每次错误都通知 |
| `rate_limit` | `rate_limit`、`公平使用`、`frequency`、`429` | 从不 | 让 claude 重试；每次错误都通知 |
| `unknown` | （未分类） | `threshold`（默认 3） | C-c → breakToShell → compact-or-nudge |

> **注意：** API 响应中的 `overloaded_error` 表示*模型*被过载（provider 端），**不是**上下文窗口满了。上下文窗口满了通常表现为 `unknown` + "Request timed out"，而不是 `overloaded_error`。

**快速路径：** 如果 pane watcher 记录了 `last_up_tokens ≥ 70% of max_tokens`，log watcher 将阈值降为 1——第一次 API 错误就触发，因为大上下文很可能是问题根源。

#### `pane_watcher` — 主动上下文压缩

监控 tmux 面板中 claude TUI 状态栏的 `↑ X.Yk tokens`，在上下文溢出导致 API 错误*之前*压缩。使用 `tmux pipe-pane` 实现事件驱动流式读取（即时更新）；如果 `pipe-pane` 不可用，降级为每 15s `capture-pane` 轮询。

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `max_tokens` | `watchdog.max_tokens` | 仅覆盖 pane watcher 的最大 token 数。通常直接设置 `watchdog.max_tokens` |
| `compact_ratio` | `0.8` | `↑ tokens >= max_tokens * compact_ratio` 时压缩（默认 80%） |
| `interval` | `30` | 轮询间隔秒数（仅降级模式；pipe-pane 是事件驱动的）。注意：降级模式当前硬编码为 15s |
| `prompt` | `watchdog.prompt` | `/compact` 完成后发送的文本（通过 `PostCompact` hook 检测——无硬编码延迟，无需 C-c——claude 处于空闲状态） |

Pane watcher 还会将 `last_up_tokens` 持久化到 state，log watcher 在首次 API 错误时读取它用于快速路径阈值。

### 通知配置

```json
"notify": {
  "enabled": true,
  "lang": "default",
  "sound": true,
  "interactive": false,
  "ask_timeout": 30,
  "open_on_click": true,
  "on": {
    "agent-started": true,
    "agent-failed": true,
    "agent-recovered": true,
    "api-error": true,
    "circuit-breaker": true,
    "max-run-reached": true,
    "nudge": false,
    "task-completed": true
  }
}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `enabled` | `false` | 总开关——需主动开启 |
| `lang` | `"default"` | 语音语言：`"default"`（英文）或 `"zh"`（中文） |
| `sound` | `false` | 通知时通过 afplay 播放自定义音效 |
| `interactive` | `false` | 自动操作为 OFF 时阻塞等待用户响应（仅 macOS） |
| `ask_timeout` | `30` | 交互通知等待用户操作的秒数。超时后自动执行默认动作（nudge/recover），而非跳过 |
| `open_on_click` | `true` | 点击通知体 → 在 Terminal.app 中打开对应 tmux 会话（仅 macOS） |
| `on` | 全部 true | 按事件开关。未列出的事件默认开启 |

> **免打扰模式**：macOS 勿扰模式会抑制通知显示，但不会丢失——关闭勿扰后排队通知会自动出现。cdog 无法从 Node.js 检测勿扰状态，通知始终会发送。

## 命令

`all` 是保留字——没有任何 Agent 可命名为 `all`。任何接受 `<name|all>` 参数的命令都可以按名称操作单个 Agent，或使用 `all` 操作所有 Agent。

| 命令 | 说明 |
|------|------|
| `cdog start [config_path\|all]` | 从配置路径启动 Agent（默认：`./cdog.json`）。缺少 hook 时自动执行 `cdog init` |
| `cdog stop <name\|all>` | **分离** cdog——停止监控，Claude 继续运行不受影响。杀掉两个 watcher |
| `cdog restart <name\|all>` | **恢复监控**已分离的 Agent。绝不杀 Claude 进程。重新启动 watcher |
| `cdog delete <name\|all>` | 杀掉 tmux 会话并从 state 中移除 Agent。杀掉两个 watcher |
| `cdog status [name]` | pm2 风格表格或单个 Agent 详情 |
| `cdog log [name] [--all] [--lines N] [--no-follow] [--claude-log]` | 查看 cdog/Claude 日志 |
| `cdog message send --to <name> --message <text> [--from F] [--reply-method R]` | 向运行中 Agent 的 tmux 面板发送文本 |
| `cdog nudge <name\|all> [text]` | 发送 prompt + Enter。递增 nudge_count |
| `cdog compact <name>` | 手动触发 compact-or-nudge：C-c → 读 tokens → /compact 或续推 |
| `cdog auto-nudge <enable\|disable> <name\|all>` | 开关 auto-nudge（持久化）。更新 cdog.json + state |
| `cdog notify [json]` | 内部命令——处理 hook 事件（stdin 或参数） |
| `cdog init` | 安装 `~/.cdog/` 并将 hook 写入 `~/.claude/settings.json` |

### 状态双轨制

cdog 对每个 Agent 跟踪两种独立状态：

- **claude**（hook 驱动）：`running`（运行中）/ `waiting`（等待中）/ `failed`（失败）/ `completed`（已完成）/ `stopped`（已停止）
- **cdog**（命令驱动）：`watching`（监控中，响应 hook）/ `detached`（已分离，忽略所有 hook）

`cdog stop` **不杀** claude——它将 cdog 切换为 `detached`，停止续推/恢复，但 Claude 继续运行。`cdog restart` 切回 `watching`，不碰进程。只有 `cdog delete` 才会杀掉 tmux/Claude 会话。

### 日志

两种独立的日志：

- **cdog 操作日志**（`cdog.json` 中的 `log_file`，可选）：格式为 `[name] | 2026-06-21 18:00:00 ✓ started, session=4191ab9d`。仅配置了 `log_file` 时写入。`cdog log` 查看（默认 `tail -f`，`--no-follow` 快照模式，`--all` 合并所有 Agent，`--claude-log` 查看 Claude 调试日志）
- **claude 调试日志**（`cdog.json` 中的 `log`，可选）：传给 claude 作为 `--debug-file <path>`。如果未配置，默认使用 `<cwd>/logs/claude-debug.log`（自动创建目录）。始终传递——log watcher 需要它。

### 会话 ID

`cdog start` 生成一个原始 UUID 并作为 `claude --session-id <uuid>` 传入。Hook 上报相同的 id，cdog 据此匹配 `state.json`。tmux 会话以 Agent 名称命名。

## 自动恢复流程

cdog 有三条恢复路径，都共享 `recovery.ts` 中的 `breakToShell` + `compactOrNudge` 逻辑：

### 1. Hook 驱动恢复（StopFailure）

当 Claude Code 遇到 API 错误时触发 `StopFailure` hook → `cdog notify` → cdog：

1. 通过 `session_id` 找到对应的 Agent
2. 分类错误类型：
   - **致命**（`authentication_failed`、`billing_error`、`model_not_found`、`oauth_org_not_allowed`）→ 标记 `failed`，不恢复
   - **瞬态**（`rate_limit`、`overloaded`、`server_error`、`max_output_tokens`）→ `breakToShell` + `compactOrNudge`
   - **上下文疑似**（`invalid_request`、`unknown`）→ `breakToShell` + `compactOrNudge`，按失败次数升级
3. 如果可恢复且熔断器未触发：输入 `cdog-recover` 标记、发送 Ctrl-C、等待 shell 提示符、检查标记是否存活，然后执行 `compactOrNudge`（读取 state 中的 `last_up_tokens` → ≥ 80% 则 `/compact`，否则发送 prompt 续推）
4. 如果 tmux 会话已死：新建 tmux 会话执行 `claude --resume <session_id>`（如有 md 配则加 `cat <md>`）
5. 如果错误不可恢复或熔断器已触发（5 分钟内 ≥3 次失败），将 Agent 标记为 `failed` 并停止恢复

### 2. Log watcher 驱动恢复（API 错误阈值）

Log watcher tail claude 调试日志，按类型计数连续 `[ERROR] API error` 行。达到阈值时触发 `cdog __recover-from-errors <name>`：

```
[ERROR] API error (attempt 1/11)
↓ (count >= threshold)
breakToShell: 标记 → C-c → 检查标记 → C-u
↓
读 state.last_up_tokens（pane watcher 记录）
├─ upTokens >= maxTokens * 0.8 → /compact（上下文很可能满了）
├─ upTokens < 0.8 或未知       → 发送 prompt 续推（安全默认）
```

不需要 `/context` 命令——pane watcher 持续将 `↑ tokens` 记录到 state，决策是瞬时的。

**按类型阈值：**

| 类型 | 阈值 | 原因 |
|------|------|------|
| `unknown` | 3（默认） | 未分类——检查 tokens 后决定 |
| `timeout` | 6 | 偶尔超时是正常网络抖动；6 次以上很可能上下文满了 |
| `provider` | 从不 | `overloaded_error` = 模型忙，不是上下文满。让 claude 重试 |
| `rate_limit` | 从不 | 用户触发限流。压缩无济于事。让 claude 重试 |

**快速路径：** 如果 pane watcher 记录了 `last_up_tokens ≥ 70% of max_tokens`，阈值降为 1（第一次错误就行动）。

### 3. Pane watcher 驱动压缩（主动）

Pane watcher 监控 tmux 面板的 `↑ tokens`。当 token 达到 `max_tokens` 的 80% 时，直接发送 `/compact`（无需 C-c——claude 处于空闲状态）。压缩完成通过 `PostCompact` hook 检测——无硬编码延迟：

```
↑ 165k tokens (82% of 200k)
↓ (>= max_tokens * compact_ratio)
设置 compact_in_progress = true
发送 /compact
↓ (等待 PostCompact hook——可能 1 秒也可能 5 分钟)
PostCompact hook 触发 → 发送 prompt 续推
```

### 标记安全（C-c 不误杀进程）

三条路径都在 `breakToShell` 中使用 `cdog-recover` 标记技术：

```
1. 输入 "cdog-recover"（不回车——留在输入行）
2. 发送 C-c
3. 检查标记是否在面板捕获中存活
   ├─ 标记不在 → C-c 生效（杀掉了 claude 或中断了 shell 命令）
   │  → C-u 清除，继续恢复
   ├─ 标记还在 → C-c 没生效，重试一次
   │  └─ 两次 C-c 后标记仍在 → 中止（避免杀错进程）
   └─ shell 提示符出现 → 安全继续
```

这防止 C-c 杀掉无关的前台进程（例如 claude 已退出、shell 命令正在运行时）。

### 恢复流程详情（hook 驱动）

```
StopFailure
↓
分类错误 → 致命 / 瞬态 / 上下文疑似
↓
（如果可恢复且熔断器未触发）
tmux send-keys -l "cdog-recover"（不回车——标记留在输入行）
tmux send-keys C-c
↓
等待 shell 提示符（轮询面板查找 $, %, #）
↓
读取 tmux 面板内容
├─ 标记还在（C-c 仅清除了错误，shell 输入行完好）
│  → C-u 清除标记
│
├─ 标记没了（C-c 连 shell 输入行一起清了）
│  → C-u 清除残留输入
│
└─ tmux 会话已死
   → tmux new-session ... claude --resume <session_id>（+ cat <md>）
↓
compactOrNudge: 读 state.last_up_tokens
├─ upTokens >= maxTokens * 0.8 → /compact（上下文很可能满了）
├─ upTokens < 0.8 或未知       → 发送 prompt 续推（安全默认）
```

`SessionStart` 将 Agent 标记为 `running`；`SessionEnd` 标记为 `stopped`/`failed`（忽略 `compact`/`resume` 参数）。

Hook 是可选的——`start`/`stop`/`status` 无需 Hook 也能工作。`cdog start` 在缺少 Hook 时自动执行 `cdog init`。

## 消息转发

向运行中 Agent 的 tmux 面板发送任意文本：

```bash
cdog message send --to snow-agent --message "继续" --from "大哥"
cdog message send --to snow-agent --message "看看进度" --from "hermes" --reply-method "notify-hermes --from snow-agent --to snow --message \"收到\""
```

格式纯拼接，cdog 不做任何修改：

- 仅有 `--from`：`from: message`
- 有 `--reply-method`：追加 `\nReply Method: <reply-method>`
- 都没有：仅原始 `message`

输出示例：

```
大哥: 继续
```

```
hermes: port-map 的进度怎么样
Reply Method: cdog message send --to hermes --message "已完成后端3个文件" --from "snow-agent"
```

## 注意事项

- **需要 tmux**——cdog 在 tmux 中管理 Claude 会话。没有 tmux 就无法使用 cdog
- **仅 macOS 通知**——交互式通知和音效使用 macOS 通知中心。其他平台降级为普通通知
- **依赖 Hook**——必须通过 `cdog init` 安装 hook 脚本。缺少 Hook 时，自动续推和自动恢复不可用。`cdog start` 在缺少 Hook 时自动执行 `cdog init`
- **Watcher 子进程**——`cdog start` 会启动 pane watcher + log watcher 作为 detached 子进程。`cdog stop` / `cdog delete` 时杀掉，`cdog restart` 时重启。如果 cdog 崩溃，可能残留孤儿 watcher（用 `ps aux | grep cdog` 检查）
- **日志路径降级**——如果配置未指定 `log`，log watcher 降级使用 `<cwd>/logs/claude-debug.log`。有日志文件时两个 watcher 自动启用
- **Session ID 绑定**——cdog 通过 `session_id` 匹配 hook 事件到 Agent。如果手动传递了重复的 `--session-id`，hook 路由将出现歧义
- **熔断器**——5 分钟内 3 次失败触发熔断，Agent 被标记为 `failed` 并需要手动重启

## 从源码构建

```bash
npm install
npm run build      # tsc -> dist/
npm run dev        # 通过 tsx 直接运行，无需构建
```

## Skill 集成

本仓库内置 skill 定义，位于 `skills/cdog/`。任何 AI agent 都可以使用。全局安装 `claude-tmux-dog`（`npm install claude-tmux-dog -g`）并加载此 skill 后，agent 可在对话中直接管理后台 cdog 进程。skill 元数据：

```markdown
---
name: cdog
description: Manage Claude Code background agents with cdog (claude-tmux-dog). Start/stop/restart a cdog agent, check status, view logs, send messages, nudge agents to continue working, compact agent context. Dual-layer context defense (pane watcher + log watcher) auto-compacts before API errors. Use when user mentions "cdog", "claude-tmux-dog", "tmux agent", "background agent", or asks to start/stop/manage a long-running Claude Code session.
---
```

详见 [skills/cdog/](/skills/cdog/)。

## 作者

[SnowAIGirl](https://github.com/SnowAIGirl) & [LinQuan](https://github.com/mlinquan)

## 许可证

[MIT](LICENSE)