# dsh-loop-watchdog

DeepSeek Harness 宿主插件：检测 agent 的"死循环"回合——长时间没有可见输出、
只有内部思考在空转——自动打断并唤醒 agent 换方案继续，直到任务真正完成。
等待用户回答提问/审批的时间不会被误判。

A DeepSeek Harness host plugin that detects dead-loop turns — long stretches
with no visible output, or reasoning that spins without producing anything —
breaks them automatically, wakes the agent with a change-of-strategy follow-up,
and keeps doing this until the task is done. Time spent waiting on the user
never counts as a stall.

## 功能 / Features

### 分级检测（两档计时）

- **可见进展**：正文流式输出（text-delta）、工具调用与结果、新步骤被准入
  → 重置全部计时器与打断计数。
- **只有内部思考在动**（reasoning-delta 持续、没有正文/工具活动）
  → 只重置较短的 `thinkingStallMs`（默认 45 秒）计时器；长时间纯空转照样判定卡死并打断。
- **完全静默**（思考带正文都没有）→ `stallMs`（默认 30 秒）后打断。

### 打断与唤醒

超时判定为死循环后：

1. 记录一条 warning 日志（logger 名 `loop-watchdog`）；
2. `agent.cancel({ kind: 'hook', reason: 'loop-watchdog' })` 中断卡死回合；
3. `agent.followup(...)` 注入一条提示，要求 agent 停止原地打转、直接动手执行
   下一步（调用工具 / 给出正文结论 / 拆分任务），并继续完成任务。

### 等待用户时完全冻结（v1.0.3）

agent 提出选择题（`ask_user_question`）或弹出权限审批（`approval/request`）时，
看门狗冻结全部计时——用户想多久答都行，这段等待**不计入**卡顿判定。收到回答后
自动恢复检测。支持提问与审批叠加（引用计数）。

### 不限次数，直到完成

打断次数默认**不限**（`maxRecoveries = 0`）。只要出现可见进展，计数即清零；
若你希望恢复"连续 N 次无进展就停手"的保护，把 `maxRecoveries` 配成正整数即可。

## 配置 / Config

通过 bundle 行的 `config` 传入（`cordis.patch.yml`）：

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关，设为 `false` 即完全停用。 |
| `stallMs` | number | `30000` | 完全无任何活动多久（毫秒）判定为死循环。 |
| `thinkingStallMs` | number | `45000` | 只有内部思考而无正文/工具活动时，多久判定为空转。 |
| `maxRecoveries` | number | `0`（不限） | 连续打断上限；出现可见进展即清零。`0` = 不限次数。 |
| `recoveryPrompt` | string | 见 `index.js` | 唤醒时注入的提示语。 |

示例：

```yaml
- insert:
    - id: loop-watchdog
      name: 'dsh-loop-watchdog'
      config:
        stallMs: 60000
        thinkingStallMs: 90000
```

## 安装 / Install

**方式一（推荐）：通过 DSH 插件管理器。**
在 DSH 的插件管理界面安装 `dsh-loop-watchdog`（发布到 registry 后可直接搜索）。
本插件不声明 `engines.dsh`、也不声明 `@deepseek-ai/dsh` peerDependencies，
不会被判定 `incompatible-version`，可以正常打开。

**方式二（本地目录，免打包）：**

1. 把本仓库克隆到本地，在 profile 的 `package.json` 中加依赖：

   ```json
   { "dependencies": { "dsh-loop-watchdog": "link:<本仓库绝对路径>" } }
   ```

2. 在 profile 的 `cordis.patch.yml` 中插入包内自带的行（或直接引用
   `cordis.patch.yml` 内容）：

   ```yaml
   - insert:
       - id: loop-watchdog
         name: 'dsh-loop-watchdog'
         config: {}
   ```

3. 重启 DSH 或通过 HMR 生效。

## 工作原理 / How it works

Host-only bundle：`cordis.patch.yml` 插入一行，`apply(ctx, config)` 监听
`agent/created`，为每个 agent 在 `agent.ctx` 上注册活动/进展监听器，并在 root
context 上按 `exec.agent` 匹配注册 `tools/*` 事件。所有定时器 `unref()`，
不会拖住进程。

## 重要提示 / Important

本插件会**主动中断** agent 的当前回合再注入唤醒消息，属于干预式工具。默认阈值
（30s / 45s）偏激进，适合"宁可错杀"的场景；关键任务中可把 `stallMs` /
`thinkingStallMs` 调大，或直接 `enabled: false` 关闭。等待用户回答期间插件
保证不打扰。

## 变更记录 / Changelog

- **v1.0.4** — 死循环判定改为**思考内容重复检测**：只有内部思考、无正文时，检查近期
  句子的重复率，"车轱辘话"（同一结论反复说）才判定死循环并打断；内容在推陈出新
  则视为正常深度思考，只受 `maxSilentThinkingMs`（默认 10 分钟）安全上限约束。
  同时：长时间工具执行（含等待用户回答的工具）期间冻结看门狗，不再把"正在跑的重活"
  误判为卡顿。彻底修复"正常长思考被反复误打断"。
- **v1.0.3** — 向用户提问 / 权限审批等待期间冻结看门狗，该时间不计入卡顿判定。
- **v1.0.2** — 分级检测：只有思考输出、无正文的空转同样打断（`thinkingStallMs`）；
  `stallMs` 默认从 90s 降到 30s；打断次数默认改为不限（进展即清零）。
- **v1.0.1** — 修复关键 bug：waterfall 监听器未返回 `next()` 导致对话报错
  `Cannot read properties of undefined (reading 'kind')`；`tools/*` 事件改注册到
  root context；唤醒消息补全 `source.kind`。
- **v1.0.0** — 首个版本：静默检测 + 打断 + 唤醒继续。

## 许可证 / License

[MIT](./LICENSE)
