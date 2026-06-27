# claude-tmux-dog (`cdog`)

<p align="center"><img src="assets/avator_dog_500.png" width="500" alt="cdog"></p>

> [English](README.md) | 中文版

**7×24 无人值守的 Claude agent + tmux 原生消息总线。**

cdog 只做两件事:

1. **7×24 自动运转** —— Hook 事件驱动 + 双层上下文防御,让 Claude agent 在无人值守的情况下持续工作数天甚至数周
2. **tmux 消息总线** —— 每个 agent 一个 tmux session,`cdog message send` 往 pane 注入文本,天然的跨 agent 通信

不需要消息中间件,不需要额外的 daemon 框架——tmux 就是总线。

---

## 为什么用 cdog

### 支柱一 —— 7×24 无人值守运转

cdog 把 Claude Code 变成一个能连续跑几天的自主 agent:

- **自动续推** —— 每次 Claude 停下(触发 `Stop` hook),cdog 自动发送"继续"(或你自定义的 prompt),让它持续干活
- **自动恢复** —— 遇到可恢复的 API 错误(限流、超时、过载),cdog 退到 shell,检查 token 用量,然后 `/compact` 或续推
- **主动压缩** —— Pane watcher 监控 TUI 里的 `↑ tokens`,在 80% 时*提前*压缩,避免错误发生
- **配额感知** —— 检测到带重置时间的 `AccountQuotaExceeded`,退到 shell,在重置后定时续推
- **自动关闭** —— 设置 `per_watch_duration: "7d"`,7 天后 cdog 把 agent 标记为 `completed`,杀掉 watcher,但保留 tmux 会话(上下文不丢)
- **熔断器** —— 5 分钟内 3 次失败触发熔断,agent 标记为 `failed`,需要手动重启

**工作原理:** Claude Code 的 hook(`Stop` / `StopFailure` / `SessionStart` / `SessionEnd`)把事件推给 cdog。没有轮询、没有定时器、没有文件监听——纯事件驱动的生命周期管理。

### 支柱二 —— tmux 原生消息总线

每个 agent 跑在独立的 tmux session 里。`cdog message send` 把文本直接注入 pane——跨 agent 通信只需要这一个:

```bash
# agent snow 问 agent hermes 进度
cdog message send --to hermes --message "port-map 的进度怎么样" --from "snow-agent"

# agent hermes 回复
cdog message send --to snow-agent --message "已完成后端3个文件" --from "hermes"
```

hermes 的 pane 里显示:

```
snow-agent: port-map 的进度怎么样
```

**回复链** —— 用 `--reply-method` 告诉接收方怎么回复:

```bash
cdog message send --to hermes \
  --message "查一下还有哪些 bug" \
  --from "snow-agent" \
  --reply-method "cdog message send --to snow-agent --message '找到 N 个' --from hermes"
```

输出:

```
snow-agent: 查一下还有哪些 bug
Reply Method: cdog message send --to snow-agent --message '找到 N 个' --from hermes
```

不需要消息中间件,不需要额外 daemon。tmux 就是总线。

---

## 快速开始

```bash
# 安装
npm install claude-tmux-dog -g

# 一次性初始化(把 hook 写入 ~/.claude/settings.json)
cdog init

# 创建配置
cat > cdog.json << 'EOF'
{
  "name": "my-agent",
  "cwd": "/path/to/project",
  "md": "task.md",
  "watchdog": {
    "auto_nudge_stop": true,
    "per_watch_duration": "7d",
    "max_tokens": "1m"
  }
}
EOF

# 启动
cdog start

# 查看状态
cdog status

# 查看日志
cdog log
```

搞定——你的 agent 现在在 tmux 会话里 7×24 运行,停下就自动续推,出错就自动恢复,上下文满了就提前压缩。

---

## 工作原理

1. **`cdog start`** 读取 `cdog.json`,在 detached tmux 会话里启动 `claude`(带 UUID `--session-id`),并启动两个 watcher 子进程(pane + log)
2. **Hook 推送事件** —— `Stop` / `StopFailure` / `SessionStart` / `SessionEnd` hook 调用 `cdog notify <json>`
3. **cdog 分发**:
   - `Stop` → 自动续推(如启用)
   - `StopFailure` → 分类错误 → 自动恢复(可恢复)或停止(致命)
   - `SessionStart` → 标记 `running`
   - `SessionEnd` → 标记 `stopped`/`failed`
4. **双层 watcher**:
   - **Pane watcher**(主动):监控 `↑ tokens`,80% 时压缩
   - **Log watcher**(被动):tail 调试日志,API 错误达阈值时触发恢复
5. **`cdog stop`** 不杀 claude——它把 cdog 切换为 `detached`(忽略 hook)。只有 **`cdog delete`** 才杀 tmux 会话

---

## cdog 替你自动化了什么

| 功能 | 做什么 | 为什么重要 |
|------|--------|-----------|
| **自动续推** | 每次 Stop hook 发送 prompt | agent 不用人盯着就能持续工作 |
| **自动恢复** | API 错误 → 退 shell + compact-or-nudge | 自动从瞬态故障中恢复 |
| **主动压缩** | 监控 token,80% 时压缩 | 在错误发生前预防 |
| **配额调度** | 检测重置时间,额度恢复后定时续推 | 配额为零时不浪费重试 |
| **卡死检测** | 5 分钟无活动 → 续推 | 打破卡死的循环 |
| **自动关闭** | N 天后标记 `completed`,杀 watcher,留 tmux | 长任务最终会停止续推 |
| **消息总线** | 向任意 agent 的 pane 发文本 | 无需基础设施的跨 agent 协作 |

---

## 配置

### 最小 `cdog.json`

```json
{
  "name": "my-agent",
  "cwd": "/path/to/project"
}
```

### 完整 `cdog.json`

```json
{
  "name": "snow-agent",
  "cwd": "/path/to/projects/snow-agent",
  "md": "snow-agent.md",
  "args": ["--dangerously-skip-permissions"],
  "log": "./logs/claude-debug.log",
  "log_file": "./logs/cdog.log",
  "model": "glm-5.2",
  "timeformat": "YYYY-MM-DD HH:mm:ss",
  "timeout": 10000,
  "watchdog": {
    "prompt": "继续",
    "per_watch_duration": "7d",
    "max_tokens": "1m",
    "auto_nudge_stop": true,
    "auto_restart": true,
    "stall_timeout": "5m",
    "api_error_auto_compact": {
      "threshold": 3,
      "rate_limit_confirm_minutes": 10
    },
    "pane_watcher": {
      "compact_ratio": 0.8,
      "interval": 30
    }
  },
  "notify": {
    "enabled": true,
    "lang": "zh",
    "sound": true,
    "open_on_click": true,
    "terminal": "Terminal",
    "on": {
      "agent-failed": true,
      "task-completed": true
    }
  }
}
```

### 关键字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✓ | agent 名称(唯一,不能是 `all`) |
| `cwd` | ✓ | 工作目录(tmux 会话在此创建) |
| `md` | | 启动时传给 claude 的任务 markdown |
| `args` | | claude 的附加 CLI 参数 |
| `env` | | 注入到启动的 claude 进程的环境变量,如 `{"DISABLE_TELEMETRY": "1", "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY": "1"}`。以 `K=V` 前缀加在 `claude` 前(只对 claude 生效)。 |
| `log` | | claude 调试日志路径(默认:`<cwd>/logs/claude-debug.log`) |
| `log_file` | | cdog 操作日志路径 |
| `watchdog` | | 自动管理策略 |
| `notify` | | 桌面通知设置 |
| `stop` | | `cdog stop` 行为 |

### 停止配置

| 字段 | 默认值 | 说明 |
|-------|---------|-------------|
| `abort_work` | `true` | `cdog stop` 时,若 claude 正在干活(running/pending),发送一次 **Esc** 中断当前那轮工作并把状态置为 `waiting`——claude **进程保持存活**(挂起,不退出)。用 Esc 而非 `Ctrl+C`,避免误退出进程;`Ctrl+C` 留给恢复流程。claude 空闲或 tmux 会话已消失时不做任何事。默认 `true`(`stop` 即停下);设为 `false` 则只脱管、不打断当前那轮。 |

```json
{
  "name": "my-agent",
  "cwd": ".",
  "stop": { "abort_work": true }
}
```

### 看门狗配置

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `prompt` | `"continue"` | 每次续推发送的文本 |
| `per_watch_duration` | | 监控时长(如 `"7d"`、`"4h"`)。到期后标记 `completed`,杀 watcher,保留 tmux |
| `max_tokens` | `200000` | 最大上下文 token(`200000`、`"200k"`、`"1m"`) |
| `auto_nudge_stop` | `false` | Stop hook 时自动发送 prompt |
| `auto_restart` | `true` | StopFailure 时自动恢复 |
| `stall_timeout` | `"5m"` | 无活动超过此时长 → 续推 |
| `stall_cooldown` | `"10m"` | 卡死续推后的冷却时间 |
| `api_error_auto_compact` | | log watcher 配置(始终启用) |
| `pane_watcher` | | pane watcher 配置(始终启用) |

### 日志保留 & 更新检查

| 字段 / 环境变量 | 默认 | 说明 |
|-------|---------|-------------|
| `log_retention` (config) | `"7d"` | cdog 在 `cdog start` 和 `cdog prune` 时按行时间戳裁剪**自己的** op-log 到该窗口。claude 的 debug log 不动(归 claude 自己管)。`"0"`/`"off"` 关闭。 |
| `CDOG_NO_UPDATE_CHECK=1` (env) | 关 | cdog 每天最多查一次 npm registry 是否有新版(缓存在 `~/.cdog/update-check.json`),有则向 stderr 提示一行。设此环境变量静默。绝不自动安装。 |

---

## 恢复细节

cdog 有三条恢复路径,都共享 `breakToShell` + `compactOrNudge` 逻辑:

### 1. Hook 驱动(StopFailure)

当 Claude Code 遇到 API 错误,触发 `StopFailure` hook → cdog:

1. 分类错误:`fatal` / `timeout` / `provider` / `rate_limit` / `unknown`
2. 如果可恢复:输入 `cdog-recover` 标记,发送 Ctrl-C,检查标记是否存活,然后执行 `compactOrNudge`
3. 压缩决策:从 state 读 `last_up_tokens` → ≥ 80% 则 `/compact`,否则续推

### 2. Log watcher 驱动(API 错误阈值)

Log watcher tail 调试日志,按类型计数连续 `[ERROR] API error` 行:

| 类型 | 阈值 | 动作 |
|------|------|------|
| `fatal` | 立即 | 停止 agent(认证失败、模型不存在) |
| `timeout` | 6 | compact-or-nudge |
| `provider` | 从不 | 让 claude 重试(模型过载、503) |
| `rate_limit` | 从不 | 退 shell + 有重置时间则定时续推 |
| `unknown` | 3 | compact-or-nudge |

**快速路径:** 如果 pane watcher 记录了 `last_up_tokens ≥ 70%`,阈值降为 1。

### 3. Pane watcher 驱动(主动压缩)

监控 TUI 里的 `↑ tokens`。当 token 达到 `max_tokens` 的 80%:

```
↑ 165k tokens (82% of 200k)
↓
发送 /compact
↓ (等待 PostCompact hook)
PostCompact 触发 → 发送 prompt 续推
```

### 标记安全

三条路径都用 `cdog-recover` 标记技术:

```
1. 输入 "cdog-recover"(不回车——留在输入行)
2. 发送 C-c
3. 检查标记是否在面板捕获中存活
   ├─ 标记还在 → C-c 生效,C-u 清除
   └─ 标记消失 → C-c 清空了输入行,安全继续
```

这能防止 C-c 误杀进程。

---

## 命令

| 命令 | 说明 |
|------|------|
| `cdog start [config\|all]` | 启动 agent。缺少 hook 时自动 `cdog init` |
| `cdog stop <name\|all>` | 分离 cdog(claude 继续运行)。杀 watcher |
| `cdog restart <name\|all>` | 恢复监控已分离的 agent。重启 watcher |
| `cdog delete <name\|all>` | 杀 tmux 会话 + 从 state 移除 |
| `cdog status [name]` | pm2 风格表格或详情 |
| `cdog log [name] [--all\|--cdog\|--claude] [--err]` | 查看日志 |
| `cdog message send --to <name> --message <text> [--from F] [--reply-method R]` | 向 agent 发消息 |
| `cdog nudge <name\|all> [text]` | 发送 prompt + Enter |
| `cdog compact <name>` | 手动触发 compact-or-nudge |
| `cdog auto-nudge <enable\|disable> <name\|all>` | 开关自动续推(持久化) |
| `cdog init` | 把 hook 写入 `~/.claude/settings.json` |

### 状态双轨制

cdog 跟踪两种独立状态:

- **claude**(hook 驱动):`running` / `waiting` / `pending` / `failed` / `completed` / `stopped`
- **cdog**(命令驱动):`watching` / `detached`

`cdog stop` 切换为 `detached`(忽略 hook)。`cdog delete` 杀 tmux。

---

## 消息转发

```bash
# 简单消息
cdog message send --to snow-agent --message "继续" --from "大哥"
# 输出: 大哥: 继续

# 带回复方法
cdog message send --to hermes --message "进度如何" --from "snow-agent" \
  --reply-method "cdog message send --to snow-agent --message '完成了 50%' --from hermes"
# 输出:
# snow-agent: 进度如何
# Reply Method: cdog message send --to snow-agent --message '完成了 50%' --from hermes
```

格式纯拼接——cdog 不修改文本。

---

## 桌面通知

可选的 macOS 通知中心提醒:

```json
"notify": {
  "enabled": true,
  "lang": "zh",
  "sound": true,
  "open_on_click": true,
  "terminal": "Terminal",
  "on": {
    "agent-failed": true,
    "task-completed": true
  }
}
```

- `open_on_click`:点击通知 → 打开/聚焦 tmux 会话
- `lang`:`"default"`(英文)或 `"zh"`(中文)
- `terminal`:点击打开的终端 app(macOS:`"Terminal"`、`"iTerm2"`、`"Ghostty"` 等;Linux:`"gnome-terminal"`、`"konsole"` 等)

---

## 注意事项

- **需要 tmux** —— cdog 在 tmux 里管理会话
- **macOS 通知** —— 交互式通知用 macOS 通知中心。Linux 降级为普通 notify-send
- **依赖 Hook** —— hook 必须通过 `cdog init` 安装。没有 hook,自动续推/恢复不可用
- **Watcher 子进程** —— `cdog start` 把 pane watcher + log watcher 作为 detached 子进程启动。stop/delete/restart 通过进程组信号清理
- **熔断器** —— 5 分钟内 3 次失败触发熔断,agent 需要手动重启

---

## 从源码构建

```bash
npm install
npm run build      # tsc -> dist/
npm run dev        # 通过 tsx 运行,无需构建
```

---

## Skill 集成

本仓库内置 skill,位于 `skills/cdog/`。全局安装 `claude-tmux-dog` 后,任何 AI agent 都能加载此 skill,在对话中直接管理 cdog agent。

---

## 作者

[SnowAIGirl](https://github.com/SnowAIGirl) & [LinQuan](https://github.com/mlinquan)

## 许可证

[MIT](LICENSE)
