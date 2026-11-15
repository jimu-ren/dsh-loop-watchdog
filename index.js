/**
 * dsh-loop-watchdog — DeepSeek Harness host plugin.
 *
 * Detects dead loops: a running agent with a long turn producing no output at
 * all. Every durable activity signal resets a stall timer; if the timer
 * expires, the plugin cancels the stuck turn and wakes the agent with a
 * follow-up telling it to change strategy and continue. Repeats while the
 * agent stays stuck (the counter resets on real progress), and gives up per
 * agent after `maxRecoveries` consecutive stalls so the plugin itself cannot
 * loop forever.
 *
 * Event-mode contract (this is what broke the first release):
 * - WATERFALL listeners (`agent/pre-step`, `agent/request-error`,
 *   `tools/pre-execute`, `tools/post-execute`, `tools/execute`) MUST return
 *   `next()`; returning undefined breaks the decision chain and the loop
 *   later reads `.kind` on undefined.
 * - Emit/serial listeners may return nothing.
 * - `tools/*` events are scoped to the tools service, not to the agent, so
 *   they are registered on the root context and matched through
 *   `exec.agent`; agent-scoped events are registered on `agent.ctx`.
 *
 * This bundle is linked outside the profile node_modules, so it must not
 * import bare `@deepseek-ai/*` specifiers; the follow-up message is built
 * from its plain durable shape directly (source.kind is required by the
 * inbox validation).
 */

import { randomUUID } from 'node:crypto'

const DEFAULTS = Object.freeze({
  enabled: true,
  /** Milliseconds of complete silence before a turn is treated as a dead loop. */
  stallMs: 90000,
  /** Consecutive stall breaks per agent; real progress resets the counter. */
  maxRecoveries: 3,
  /** The follow-up text injected to make the agent change strategy and continue. */
  recoveryPrompt:
    '检测到当前回合已经长时间没有产生任何新的输出，已自动中断这次循环。请停止原地打转，换一个不同的思路或方案继续推进任务；若需要用户决策，请明确提出问题；继续完成任务。',
})

function resolveConfig(input) {
  return {
    enabled: input?.enabled ?? DEFAULTS.enabled,
    stallMs: input?.stallMs ?? DEFAULTS.stallMs,
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
  log.info(`loop-watchdog v1.0.1 enabled: stallMs=${config.stallMs} maxRecoveries=${config.maxRecoveries}`)

  /** Per-agent watchdog bookkeeping, keyed by agent id. */
  const entries = new Map()

  function clearTimer(entry) {
    if (entry?.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
  }

  function armTimer(entry) {
    clearTimer(entry)
    if (entry.disposed || entry.disabled) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      try {
        fire(entry)
      } catch (error) {
        log.warn(`fire failed: ${String(error?.message ?? error)}`)
      }
    }, config.stallMs)
    entry.timer.unref?.()
  }

  function touch(entry) {
    if (!entry || entry.disposed) return
    entry.lastActivity = Date.now()
    if (entry.agent.status === 'running') armTimer(entry)
  }

  /** Any observable activity: re-arm the stall timer. */
  function activity(agent) {
    touch(entries.get(agent?.id))
  }

  /** Real progress (streamed text, admitted step, tool result): also reset the stall counter. */
  function progress(agent) {
    const entry = entries.get(agent?.id)
    if (!entry || entry.disposed) return
    touch(entry)
    if (entry.recoveries !== 0) {
      log.info(`agent ${String(agent.id)} made progress; recovery counter reset`)
      entry.recoveries = 0
    }
  }

  function dispose(agent) {
    const entry = entries.get(agent?.id)
    if (!entry) return
    entry.disposed = true
    clearTimer(entry)
    entries.delete(agent.id)
  }

  /** Break a stuck turn: cancel it, then wake the driver with the recovery follow-up. */
  function fire(entry) {
    const { agent } = entry
    if (entry.disposed || entry.disabled) return
    if (agent.status !== 'running') return
    if (entry.recoveries >= config.maxRecoveries) {
      log.warn(
        `agent ${String(agent.id)} still silent after ${entry.recoveries} recoveries; watchdog stands down for this agent`,
      )
      entry.disabled = true
      return
    }
    entry.recoveries += 1
    log.warn(
      `agent ${String(agent.id)} produced no output for ${config.stallMs}ms; breaking the loop (recovery ${entry.recoveries}/${config.maxRecoveries})`,
    )

    try {
      agent.cancel({ kind: 'hook', reason: 'loop-watchdog' })
    } catch (error) {
      log.warn(`agent ${String(agent.id)} cancel failed: ${String(error?.message ?? error)}`)
      return
    }

    const wake = setTimeout(() => {
      if (entry.disposed || entry.disabled) return
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
      lastActivity: Date.now(),
      recoveries: 0,
      disabled: false,
      disposed: false,
    }
    entries.set(agent.id, entry)

    // Scoped<Agent> emit/serial listeners: returning nothing is fine.
    agent.ctx.on('agent/status', ({ status }) => {
      if (status === 'running') touch(entry)
      else clearTimer(entry)
    })
    agent.ctx.on('agent/assistant-stream', () => progress(agent))
    agent.ctx.on('agent/error', () => activity(agent))
    agent.ctx.on('agent/inbox/claimed', () => activity(agent))

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
    if (exec?.agent) activity(exec.agent)
    return next()
  })
  // emit: observe the frozen result; this is real progress.
  ctx.on('tools/result', (exec) => {
    if (exec?.agent) progress(exec.agent)
  })
}
