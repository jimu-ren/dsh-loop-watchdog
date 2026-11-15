/**
 * @local/loop-watchdog — DeepSeek Harness host plugin.
 *
 * Problem: an agent can get stuck in a long turn where it keeps "thinking"
 * without producing any new visible output (a dead loop), burning tokens until
 * it either never finishes or the user has to interrupt manually.
 *
 * Behaviour: while an agent is running, every durable activity signal resets a
 * stall timer (assistant stream frames, tool executions, step/turn boundaries,
 * errors, status changes). If no activity arrives for `stallMs`, the plugin
 * cancels the stuck turn and wakes the agent with a user follow-up that tells
 * it to stop spinning, switch strategy, and keep working. It repeats this up to
 * `maxRecoveries` times per agent, then stops and logs so it cannot itself loop
 * forever.
 *
 * This is a Host-only bundle: the row is inserted by cordis.patch.yml and this
 * module only registers lifecycle hooks.
 *
 * NOTE: this bundle is linked to a real directory outside the profile's
 * node_modules, so Node cannot resolve bare `@deepseek-ai/*` specifiers from
 * here. The plugin therefore uses no bare runtime imports and builds the
 * follow-up message from its plain object shape directly.
 */

import { randomUUID } from 'node:crypto'

/** Default configuration; merged with whatever the patch row supplies. */
const DEFAULTS = Object.freeze({
  enabled: true,
  /** Milliseconds of complete silence before a turn is treated as a dead loop. */
  stallMs: 90000,
  /** Hard cap of auto-breaks per agent. After this the plugin logs and stops. */
  maxRecoveries: 3,
  /** The follow-up text injected to make the agent change strategy and continue. */
  recoveryPrompt:
    '检测到当前回合已经长时间没有产生任何新的输出，已经自动中断这次循环。请立即停止原地打转，换一个与之前不同的思路或方案继续推进任务；如果需要用户决策，就明确提问，不要再重复此前无效的路径。继续完成任务，不要结束回合。',
})

/** Normalize the row config over the defaults. */
function resolveConfig(input) {
  return {
    enabled: input?.enabled ?? DEFAULTS.enabled,
    stallMs: input?.stallMs ?? DEFAULTS.stallMs,
    maxRecoveries: input?.maxRecoveries ?? DEFAULTS.maxRecoveries,
    recoveryPrompt: input?.recoveryPrompt ?? DEFAULTS.recoveryPrompt,
  }
}

/** Per-agent watchdog bookkeeping. */
const entries = new Map()

function clearTimer(entry) {
  if (entry.timer !== null) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
}

/** Re-arm the stall timer for a running agent. */
function armTimer(entry, config) {
  clearTimer(entry)
  if (entry.disposed) return
  entry.timer = setTimeout(() => {
    entry.timer = null
    fire(entry, config)
  }, config.stallMs)
  // Never hold the process open just for the watchdog.
  entry.timer.unref?.()
}

/** Record activity and (while running) keep the timer armed. */
function touch(entry, config) {
  if (entry.disposed) return
  entry.lastActivity = Date.now()
  if (entry.agent.status === 'running') armTimer(entry, config)
}

/**
 * Real progress means the agent is not stuck. Reset the consecutive-stall
 * count so a later stall episode can be recovered again — the watchdog keeps
 * working until the task actually finishes, and only stops when the agent is
 * repeatedly stuck back-to-back.
 */
function markProgress(entry) {
  if (entry.disposed || entry.recoveries === 0) return
  entry.logger.info(`agent ${String(entry.agent.id)} made progress; reset recovery counter`)
  entry.recoveries = 0
}

/** Break a stuck turn: cancel, then wake with a strategy-changing follow-up. */
function fire(entry, config) {
  const { agent } = entry
  if (entry.disposed || entry.disabled) return
  if (agent.status !== 'running') return
  if (entry.recoveries >= config.maxRecoveries) {
    entry.logger.warn(
      `agent ${String(agent.id)} still silent after ${entry.recoveries} recoveries; giving up on this agent`,
    )
    entry.disabled = true
    return
  }
  entry.recoveries += 1
  const seq = entry.recoveries
  entry.logger.warn(
    `agent ${String(agent.id)} produced no output for ${config.stallMs}ms; breaking the loop (recovery ${seq}/${config.maxRecoveries})`,
  )

  try {
    // Abort the stuck turn first so the agent actually exits the loop.
    agent.cancel({ kind: 'hook', reason: 'loop-watchdog' })
  } catch (error) {
    entry.logger.warn(`agent ${String(agent.id)} cancel failed: ${String(error?.message ?? error)}`)
  }

  // Wake the driver on the next turn with the recovery instruction.
  const wake = setTimeout(() => {
    if (entry.disposed || entry.disabled) return
    try {
      entry.agent.followup(makeUserMessage(config.recoveryPrompt))
    } catch (error) {
      entry.logger.warn(`agent ${String(agent.id)} followup failed: ${String(error?.message ?? error)}`)
    }
  }, 100)
  wake.unref?.()
}

/** Build a valid user message from its plain object shape (no bare imports). */
function makeUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const log = ctx.logger('loop-watchdog')
  if (!config.enabled) {
    log.info('loop-watchdog disabled by configuration')
    return
  }
  log.info(`loop-watchdog enabled: stallMs=${config.stallMs} maxRecoveries=${config.maxRecoveries}`)

  ctx.on('agent/created', ({ agent }) => {
    const entry = {
      agent,
      config,
      logger: log,
      timer: null,
      lastActivity: Date.now(),
      recoveries: 0,
      disabled: false,
      disposed: false,
    }
    entries.set(agent.id, entry)

    const onActivity = () => touch(entry, config)
    const onProgress = () => {
      touch(entry, config)
      markProgress(entry)
    }
    const onStatus = ({ status }) => {
      if (status === 'running') {
        touch(entry, config)
      } else {
        clearTimer(entry)
      }
    }
    const onDisposed = ({ agent: disposedAgent }) => {
      if (disposedAgent.id !== agent.id) return
      entry.disposed = true
      clearTimer(entry)
      entries.delete(agent.id)
    }

    agent.ctx.on('agent/status', onStatus)
    agent.ctx.on('agent/assistant-stream', onProgress)
    agent.ctx.on('agent/pre-step', onProgress)
    agent.ctx.on('agent/turn-ending', onProgress)
    agent.ctx.on('agent/turn-stopping', onActivity)
    agent.ctx.on('agent/error', onActivity)
    agent.ctx.on('agent/request-error', onActivity)
    agent.ctx.on('tools/execute', onActivity)
    agent.ctx.on('tools/result', onProgress)
    agent.ctx.on('tools/post-execute', onActivity)
    agent.ctx.on('agent/disposed', onDisposed)

    // If the agent is already running when it appears, arm immediately.
    if (agent.status === 'running') touch(entry, config)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const entry = entries.get(agent.id)
    if (entry) {
      entry.disposed = true
      clearTimer(entry)
      entries.delete(agent.id)
    }
  })
}
