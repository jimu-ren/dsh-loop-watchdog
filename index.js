/**
 * dsh-loop-watchdog — DeepSeek Harness host plugin.
 *
 * Detects dead loops: a running agent whose turn makes no real progress.
 * Three activity tiers drive two timers:
 * - VISIBLE progress (正文 text-delta, tool execution/results, new admitted
 *   steps) resets the stall timer AND the recovery counter — the task moved.
 * - REASONING output (chain-of-thought text with no visible body) resets only
 *   the shorter `thinkingStallMs` timer: pure silent thinking is kept alive
 *   briefly, but a long reasoning-only stretch counts as stuck and is broken.
 * - Nothing at all for `stallMs` is definitely stuck.
 * On a stall the plugin cancels the turn and wakes the agent with a recovery
 * follow-up. Recovery attempts are UNLIMITED (maxRecoveries=0 means no cap):
 * the watchdog keeps breaking loops until the task actually finishes or the
 * agent goes idle.
 *
 * Event-mode contract (this is what broke the first release):
 * - WATERFALL listeners (`agent/pre-step`, `agent/request-error`,
 *   `tools/pre-execute`, `tools/post-execute`) MUST return `next()`.
 * - `tools/*` events are scoped to the tools service, not to the agent: they
 *   are registered on the root context and matched through `exec.agent`.
 *
 * This bundle is linked outside the profile node_modules, so it must not
 * import bare `@deepseek-ai/*` specifiers; the follow-up message is built
 * from its plain durable shape directly (source.kind is load-bearing).
 */

import { randomUUID } from 'node:crypto'

const DEFAULTS = Object.freeze({
  enabled: true,
  /** Milliseconds with no activity of any kind before the turn is broken. */
  stallMs: 30000,
  /** Milliseconds of reasoning-only output before the turn is broken. */
  thinkingStallMs: 45000,
  /** Consecutive breaks per agent before standing down; 0 means unlimited. */
  maxRecoveries: 0,
  /** The follow-up text injected to make the agent change strategy and continue. */
  recoveryPrompt:
    '检测到当前回合长时间没有产生有效的可见进展（只有内部思考在空转或完全静默），已自动中断这次循环。请停止原地打转，立即换一个不同的思路或方案：直接动手执行下一步（调用工具、给出正文结论），或把问题拆小后先完成其中一小块；若确实需要用户决策，请明确提出问题。继续完成任务，不要只停留在思考里。',
})

function resolveConfig(input) {
  return {
    enabled: input?.enabled ?? DEFAULTS.enabled,
    stallMs: input?.stallMs ?? DEFAULTS.stallMs,
    thinkingStallMs: input?.thinkingStallMs ?? DEFAULTS.thinkingStallMs,
    maxRecoveries: input?.maxRecoveries ?? DEFAULTS.maxRecoveries,
    recoveryPrompt: input?.recoveryPrompt ?? DEFAULTS.recoveryPrompt,
  }
}

/** Build a valid durable user message (source.kind is load-bearing). */
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
  log.info(
    `loop-watchdog v1.0.2 enabled: stallMs=${config.stallMs} thinkingStallMs=${config.thinkingStallMs} `
    + `maxRecoveries=${config.maxRecoveries === 0 ? 'unlimited' : config.maxRecoveries}`,
  )

  /** Per-agent watchdog bookkeeping, keyed by agent id. */
  const entries = new Map()

  function clearTimers(entry) {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.thinkTimer) {
      clearTimeout(entry.thinkTimer)
      entry.thinkTimer = null
    }
  }

  function fireSoon(entry, reason) {
    entry.pendingReason = reason
    const wake = setTimeout(() => {
      try {
        fire(entry)
      } catch (error) {
        log.warn(`fire failed: ${String(error?.message ?? error)}`)
      }
    }, 0)
    wake.unref?.()
  }

  /** Arm both tier timers; each fires only while it is still expired first. */
  function armTimers(entry) {
    clearTimers(entry)
    if (entry.disposed) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      if (entry.thinkTimer !== null) { clearTimeout(entry.thinkTimer); entry.thinkTimer = null }
      fireSoon(entry, 'no activity at all')
    }, config.stallMs)
    entry.timer.unref?.()
    if (entry.reasoningOnly) {
      entry.thinkTimer = setTimeout(() => {
        entry.thinkTimer = null
        if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null }
        fireSoon(entry, 'reasoning only, no visible output')
      }, config.thinkingStallMs)
      entry.thinkTimer.unref?.()
    }
  }

  /** Visible progress: reset both timers and the consecutive-stall counter. */
  function progress(agent) {
    const entry = entries.get(agent?.id)
    if (!entry || entry.disposed) return
    entry.reasoningOnly = false
    if (entry.recoveries !== 0) {
      log.info(`agent ${String(agent.id)} made visible progress; recovery counter reset`)
      entry.recoveries = 0
    }
    if (entry.agent.status === 'running') armTimers(entry)
  }

  /**
   * Any stream frame. text-delta is progress; reasoning-delta and
   * tool-call-delta keep the turn alive on the short tier only — reasoning
   * with no body is exactly the spinning the watchdog must break.
   */
  function onStream(agent, frame) {
    const entry = entries.get(agent?.id)
    if (!entry || entry.disposed) return
    const chunk = frame?.chunk
    if (chunk?.type === 'text-delta') {
      progress(agent)
      return
    }
    if (chunk?.type === 'reasoning-delta') {
      entry.reasoningOnly = true
      if (entry.agent.status === 'running') armTimers(entry)
      return
    }
    if (chunk?.type === 'tool-call-delta') {
      // The call is being streamed; the eventual tools/result counts as progress.
      entry.reasoningOnly = false
      if (entry.agent.status === 'running') armTimers(entry)
      return
    }
    if (frame?.type === 'end') {
      // An attempt settled without visible text: keep the stall pressure on.
      if (entry.agent.status === 'running') armTimers(entry)
    }
  }

  /** Plain activity: keep the long timer alive without clearing the counter. */
  function activity(agent) {
    const entry = entries.get(agent?.id)
    if (!entry || entry.disposed) return
    if (entry.agent.status === 'running') armTimers(entry)
  }

  function dispose(agent) {
    const entry = entries.get(agent?.id)
    if (!entry) return
    entry.disposed = true
    clearTimers(entry)
    entries.delete(agent.id)
  }

  /** Break a stuck turn: cancel it, then wake the driver with the recovery follow-up. */
  function fire(entry) {
    const { agent } = entry
    if (entry.disposed) return
    if (agent.status !== 'running') return
    entry.reasoningOnly = false
    const reason = entry.pendingReason ?? 'stalled'
    entry.recoveries += 1
    log.warn(
      `agent ${String(agent.id)} loop detected (${reason}); breaking the turn (break #${entry.recoveries})`,
    )

    try {
      agent.cancel({ kind: 'hook', reason: 'loop-watchdog' })
    } catch (error) {
      log.warn(`agent ${String(agent.id)} cancel failed: ${String(error?.message ?? error)}`)
      return
    }

    const wake = setTimeout(() => {
      if (entry.disposed) return
      try {
        entry.agent.followup(makeUserMessage(config.recoveryPrompt))
      } catch (error) {
        log.warn(`agent ${String(agent.id)} followup failed: ${String(error?.message ?? error)}`)
      }
    }, 150)
    wake.unref?.()
  }

  // ── per-agent lifecycle ─────────────────────────────────────────────────
  ctx.on('agent/created', ({ agent }) => {
    const entry = {
      agent,
      timer: null,
      thinkTimer: null,
      reasoningOnly: false,
      pendingReason: null,
      recoveries: 0,
      disposed: false,
    }
    entries.set(agent.id, entry)

    // Scoped<Agent> emit/serial listeners: returning nothing is fine.
    agent.ctx.on('agent/status', ({ status }) => {
      if (status === 'running') {
        entry.reasoningOnly = false
        armTimers(entry)
      } else {
        clearTimers(entry)
      }
    })
    agent.ctx.on('agent/assistant-stream', ({ frame }) => onStream(agent, frame))
    agent.ctx.on('agent/error', () => activity(agent))
    agent.ctx.on('agent/inbox/claimed', () => progress(agent))

    // Scoped<Agent> WATERFALL listeners: must delegate and return next().
    agent.ctx.on('agent/pre-step', (_payload, next) => {
      progress(agent)
      return next()
    })
    agent.ctx.on('agent/request-error', (_payload, next) => {
      activity(agent)
      return next()
    })
  })

  ctx.on('agent/disposed', ({ agent }) => dispose(agent))

  // ── tools events are service-scoped: register on root, match by exec.agent ─
  // WATERFALL: return next() so the dispatch decision survives.
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec?.agent) progress(exec.agent)
    return next()
  })
  // emit: observe the frozen result; this is real progress.
  ctx.on('tools/result', (exec) => {
    if (exec?.agent) progress(exec.agent)
  })
}
