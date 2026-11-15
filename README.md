# dsh-loop-watchdog

DeepSeek Harness 宿主插件：检测"长时间没有输出"的死循环回合，自动打断并唤醒
agent 换方案继续思考，直到任务完成才停止。

A DeepSeek Harness host plugin that detects dead loops (long turns with no
output), auto-breaks them, and wakes the agent to continue with a different
strategy until the task is actually done.

## 功能 / Features

- 为每个处于 `running` 的 agent 维护一个静默看门狗。
- 任何真实活动（assistant 流式输出、工具执行与结果、步骤/回合边界、错误、
  状态变化）都会重置静默计时器。
- 超过 `stallMs` 仍无任何输出时：
  1. 记录一条 warning 日志；
  2. 调用 `agent.cancel({ kind: 'hook', reason: 'loop-watchdog' })` 退出卡死的回合；
  3. 调用 `agent.followup(...)` 注入一条"停止原地打转、换方案继续"的提示并唤醒。
- **连续**卡死达到 `maxRecoveries` 才停手；一旦出现真实进展，计数清零，因此会一直
  兜底到任务完成，同时不会让自己陷入死循环。
- 默认 90 秒静默判定、最多 3 次连续打断，可配置、可一键关闭。

## 工作原理 / How it works

插件是一个 Host-only bundle：`cordis.patch.yml` 插入一行，`apply(ctx, config)`
在 `agent/created` 时为该 agent 注册看门狗，并订阅其 `ctx` 上的活动事件。定时器使用
`unref()`，不会因为看门狗而让进程保持运行。

## 安装 / Install

**方式一（推荐）：通过 DSH 插件管理器。**
发布到 registry/npm 后，在 DSH 的插件管理界面搜索 `dsh-loop-watchdog` 安装即可。
本插件不声明 `engines.dsh`、也不声明 `@deepseek-ai/dsh` peerDependencies，因此不会
被判定 `incompatible-version`，可以正常打开。

**方式二（手动）：**

1. 把包放进 profile 依赖，例如在 profile 的 `package.json` 中加入：

   ```json
   {
     "dependencies": {
       "dsh-loop-watchdog": "1.0.0"
     }
   }
   ```

2. 在 profile 的 `cordis.patch.yml` 中插入一行（或依赖包内自带的
   `cordis.patch.yml`）：

   ```yaml
   - insert:
       - id: loop-watchdog
         name: 'dsh-loop-watchdog'
         config: {}
   ```

## 配置 / Config

通过 bundle 行的 `config` 传入：

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关，设为 `false` 即完全停用。 |
| `stallMs` | number | `30000` | 完全无任何活动多久（毫秒）判定为死循环。 |
| `thinkingStallMs` | number | `45000` | 只有内部思考（reasoning）而无正文/工具活动时，多久判定为空转。 |
| `maxRecoveries` | number | `0`（不限） | 连续打断次数上限；出现可见进展即清零。`0` 表示不限次数，直到任务完成。 |
| `recoveryPrompt` | string | 见 `index.js` | 唤醒时注入的提示语。 |

## 分级检测（v1.0.2）

- **可见进展**（正文流式输出、工具执行/结果、新步骤）→ 重置全部计时器与计数器。
- **只有思考输出**（reasoning-delta 持续、无正文）→ 仅重置 `thinkingStallMs` 短计时器；
  长时间纯思考同样会被判定空转并打断。
- **完全静默** → `stallMs` 后打断。
- 打断次数默认**不限**，只要任务还在跑且反复卡死，看门狗就持续介入，直到出现真实进展或回合自然结束。

## 重要提示 / Important

本插件会**主动中断** agent 的当前回合再注入唤醒消息，属于干预式工具。默认
`stallMs=90000`（90 秒）只针对"完全没有任何输出"的极端情况，误伤概率低，但请在
关键任务中按需调大 `stallMs` 或直接设置 `enabled: false` 关闭。

## 设计说明 / Implementation note

`index.js` **不导入任何裸的 `@deepseek-ai/*` 运行时包**，只使用 `node:crypto`，并
按 DSH 的公开消息结构手工构造 follow-up 消息。这样无论从本地 `link:` 安装还是从
registry 安装，都能被 Node 正常解析加载，避免 `ERR_MODULE_NOT_FOUND`。

## 许可证 / License

[MIT](./LICENSE)
