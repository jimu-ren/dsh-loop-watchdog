/**
 * dsh-loop-watchdog — DeepSeek Harness host plugin.
 *
 * Detects TRUE dead loops and breaks them so the agent keeps working until
 * the task is done.
 *
 * Stall signals (two timers):
 * - TOTAL SILENCE: no stream frame of any kind while running for `stallMs`
 *   (default 30s) -> the turn is stuck -> break + wake.
 * - REPETITIVE THINKING: after `thinkingStallMs` (default 45s) with no
 *   visible body text, the CONTENT of the recent reasoning is judged. A high
 *   sentence-duplicate rate ("车轱辘话": the same "让我继续分析…" restatements
 *   cycling) is a dead loop -> break immediately. Genuinely NEW, changing
 *   reasoning is never treated as stuck: it gets further grace windows until
 *   the `maxSilentThinkingMs` (default 600s) safety ceiling is spent, then
 *   breaks only if it still has no visible output.
 *
 * Legitimate pauses that NEVER count as a stall (watchdog frozen):
 * - A tool call in flight (tools/pre-execute -> tools/result). Asking the
 *   user a question or waiting on an approval is exactly this case: those
 *   complete only when the user answers, so the whole wait sits inside one
 *   in-flight tool call. No dialog interception is required.
 * - The agent waiting on approval (approval/request) is additionally frozen
 *   by a waterfall guard, which is kept for safety.
 *
 * Break = cancel the stuck turn + a followup telling the agent to stop
 * spinning and act. Attempts are unlimited by default (maxRecoveries = 0);
 * any visible progress resets the consecutive-break counter.
 *
 * Hard rules learned from earlier incidents:
 * - Waterfall listeners MUST return `next()` verbatim. Returning undefined
 *   corrupts the decision chain and the loop later throws
 *   "Cannot read properties of undefined (reading 'kind')".
 * - Listener bookkeeping is wrapped so the plugin never throws into the
 *   dispatcher.
 * - `tools/*` events are service-scoped: register on root, match by
 *   `exec.agent`.
 * - No bare `@deepseek-ai/*` imports: the linked bundle resolves from its real
 *   directory and would fail with ERR_MODULE_NOT_FOUND. The follow-up message
 *   is a plain object matching the durable user-message shape exactly, with a
 *   load-bearing `source.kind`.
 */

import { randomUUID } from 'node:crypto'

const DEFAULTS = Object.freeze({
  enabled: true,
  /** ms with no stream frames at all before the turn is judged stuck. */
  stallMs: 30000,
  /** evaluation window: ms of no visible output before reasoning is judged. */
  thinkingStallMs: 45000,
  /** safety ceiling of outputless thinking for NEW (non-repeated) reasoning. */
  maxSilentThinkingMs: 600000,
  /** how many recent reasoning sentence units to compare for repetition. */
  repeatWindowSentences: 14,
  /** duplicate fraction of the window that declares a thinking loop. */
  repeatThreshold: 0.34,
  /** minimum sentence units in the window before repetition is judged. */
  repeatMinSamples: 8,
  /** consecutive breaks before standing down; 0 = unlimited. */
  maxRecoveries: 0,
  recoveryPrompt:
    '检测到当前回合陷入死循环：要么长时间没有任何输出，要么内部思考在反复重复相同内容（车轱辘话），没有产生任何新的进展。本回合已自动中断。请立即停止重复原来的分析路径，换一个本质不同的做法：直接调用工具执行一个具体动作、写出阶段性正文结论、或把任务拆小后先完成一小块；若确实需要用户决策，请明确提出问题。继续完成任务。',
})

function resolveConfig(input) {
  const out = {}
  for (const key of Object.keys(DEFAULTS)) {
    out[key] = input?.[key] ?? DEFAULTS[key]
  }
  return out
}

/** Split text into sentence units (CJK + Latin punctuation, newlines). */
function splitSentences(text) {
  return text
    .split(/[。！？；\n\r.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1)
}

/** Normalize for comparison: lowercase, keep only letters/digits/CJK. */
function normalizeSentence(sentence) {
  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
}

/**
 * Repetition verdict over the LAST `windowSentences` units.
 * loop = window has >= minSamples units and duplicates/window >= threshold.
 */
function analyzeRepetition(text, windowSentences, threshold, minSamples) {
  const units = splitSentences(text)
    .slice(-windowSentences)
    .map(normalizeSentence)
    .filter((s) => s.length > 0)
  if (units.length < minSamples) {
    return { loop: false, unique: units.length, total: units.length }
  }
  const unique = new Set(units).size
  const duplicateRate = (units.length - unique) / units.length
  return { loop: duplicateRate >= threshold, unique, total: units.length }
}

/** Durable user-message shape (plain JSON; source.kind is load-bearing). */
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
    `loop-watchdog v1.0.4 enabled: stallMs=${config.stallMs} thinkingStallMs=${config.thinkingStallMs}`
    + ` maxSilentThinkingMs=${config.maxSilentThinkingMs} repeatThreshold=${config.repeatThreshold}`
    + ` maxRecoveries=${config.maxRecoveries === 0 ? 'unlimited' : config.maxRecoveries}`,
  )

  /** Per-agent watchdog bookkeeping, keyed by agent id. */
  const entries = new Map()

  /** A tool call is in flight (this includes any wait on the user's answer
   * or approval inside a tool): a legitimate pause, never a stall. */
  function paused(entry) {
    return entry.waiting > 0 || entry.pendingTools > 0
  }

  function clearSilence(entry) {
    if (entry.silenceTimer !== null) {
      clearTimeout(entry.silenceTimer)
      entry.silenceTimer = null
    }
  }

  function clearThink(entry) {
    if (entry.thinkTimer !== null) {
      clearTimeout(entry.thinkTimer)
      entry.thinkTimer = null
    }
  }

  function clearTimers(entry) {
    clearSilence(entry)
    clearThink(entry)
  }

  function armSilence(entry) {
    clearSilence(entry)
    if (entry.disposed || entry.disabled || paused(entry)) return
    entry.silenceTimer = setTimeout(() => {
      entry.silenceTimer = null
      if (entry.disposed || entry.disabled || paused(entry)) return
      if (entry.agent.status !== 'running') return
      fire(entry, 'no activity of any kind')
    }, config.stallMs)
    entry.silenceTimer.unref?.()
  }

  function armThink(entry) {
    clearThink(entry)
    if (entry.disposed || entry.disabled || paused(entry)) return
    entry.thinkTimer = setTimeout(() => {
      entry.thinkTimer = null
      if (entry.disposed || entry.disabled || paused(entry)) return
      if (entry.agent.status !== 'running') return
      evaluateThinking(entry)
    }, config.thinkingStallMs)
    entry.thinkTimer.unref?.()
  }

  /**
   * No visible output for a full window: judge the CONTENT of the reasoning.
   * Repeated sentences -> dead loop (break). NEW content -> grace, re-armed,
   * until the maxSilentThinkingMs safety ceiling is spent.
   */
  function evaluateThinking(entry) {
    const verdict = analyzeRepetition(
      entry.reasonBuf,
      config.repeatWindowSentences,
      config.repeatThreshold,
      config.repeatMinSamples,
    )
    if (verdict.loop) {
      fire(
        entry,
        `repetitive thinking (${verdict.total - verdict.unique}/${verdict.total} sentences are duplicates)`,
      )
      return
    }
    if (entry.reasonBuf.length === 0) return // silence timer owns that case
    entry.silentThinkingBudget -= config.thinkingStallMs
    if (entry.silentThinkingBudget <= 0) {
      fire(entry, 'long thinking with no visible output')
      return
    }
    log.info(
      `agent ${String(entry.agent.id)} reasoning is novel; granting another ${config.thinkingStallMs}ms`,
    )
    armThink(entry)
  }

  /** Visible progress: streamed body text, a finished tool, an admitted
   * step. Resets timers, the reasoning buffer, and the break counter. */
  function progress(agent) {
    const entry = entries.get(agent?.id)
    if (!entry || entry.disposed) return
    entry.reasonBuf = ''
    entry.silentThinkingBudget = config.maxSilentThinkingMs
    if (entry.recoveries !== 0) {
      log.info(`agent ${String(agent.id)} produced visible output; recovery counter reset`)
      entry.recoveries = 0
    }
    if (entry.agent.status === 'running' && !paused(entry)) {
      armSilence(entry)
      armThink(entry)
    }
  }

  /** Any stream frame is activity; body text is progress; reasoning fills
   * the repetition buffer (but does NOT reset the think timer, so the content
   * is judged after thinkingStallMs). */
  function onStream(agent, frame) {
    const entry = entries.get(agent?.id)
    if (!entry || entry.disposed) return
    armSilence(entry)
    if (entry.reasonBuf.length === 0) {
      entry.silentThinkingBudget = config.maxSilentThinkingMs
    }
    const chunk = frame?.chunk
    if (chunk?.type === 'text-delta') {
      progress(agent)
      return
    }
    if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      entry.reasonBuf = (entry.reasonBuf + chunk.text).slice(-4000)
    }
  }

  function dispose(agent) {
    const entry = entries.get(agent.id)
    if (!entry) return
    entry.disposed = true
    clearTimers(entry)
    entries.delete(agent.id)
  }

  /** Break a stuck turn: cancel it, then wake the driver with a recovery
   * follow-up. */
  function fire(entry, reason) {
    const { agent } = entry
    if (entry.disposed || entry.disabled) return
    if (paused(entry) || agent.status !== 'running') return
    if (config.maxRecoveries > 0 && entry.recoveries >= config.maxRecoveries) {
      log.warn(`agent ${String(agent.id)} still looping after ${entry.recoveries} breaks; standing down`)
      entry.disabled = true
      return
    }
    entry.recoveries += 1
    entry.reasonBuf = ''
    entry.silentThinkingBudget = config.maxSilentThinkingMs
    log.warn(
      `agent ${String(agent.id)} dead loop detected (${reason}); breaking turn (break #${entry.recoveries})`,
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

  /**
   * Freeze the watchdog for the whole user-decision window (approval /
   * question waterfall). Waterfall-safe: always delegates and returns the
   * downstream promise so the chain is never broken.
   */
  function userWaitListener(entry) {
    return (_payload, next) => {
      entry.waiting += 1
      clearTimers(entry)
      const resume = () => {
        entry.waiting = Math.max(0, entry.waiting - 1)
        if (
          !entry.disposed &&
          !entry.disabled &&
          entry.agent.status === 'running' &&
          !paused(entry)
        ) {
          armSilence(entry)
          armThink(entry)
        }
      }
      let result
      try {
        result = next()
      } catch (error) {
        resume()
        throw error
      }
      if (result && typeof result.then === 'function') {
        return result.then(
          (value) => { resume(); return value },
          (error) => { resume(); throw error },
        )
      }
      resume()
      return result
    }
  }

  // ── per-agent lifecycle ────────────────────────────────────────────────
  ctx.on('agent/created', ({ agent }) => {
    const entry = {
      agent,
      silenceTimer: null,
      thinkTimer: null,
      reasonBuf: '',
      silentThinkingBudget: config.maxSilentThinkingMs,
      waiting: 0,
      pendingTools: 0,
      recoveries: 0,
      disabled: false,
      disposed: false,
    }
    entries.set(agent.id, entry)

    // Emit listeners: returning nothing is fine.
    agent.ctx.on('agent/status', ({ status }) => {
      if (status === 'running') {
        entry.pendingTools = 0
        entry.silentThinkingBudget = config.maxSilentThinkingMs
        armSilence(entry)
        armThink(entry)
      } else {
        clearTimers(entry)
      }
    })
    agent.ctx.on('agent/assistant-stream', ({ frame }) => onStream(agent, frame))
    agent.ctx.on('agent/inbox/claimed', () => progress(agent))

    // Waterfall listeners: MUST return next() verbatim.
    agent.ctx.on('agent/pre-step', (_payload, next) => {
      // A new step only begins after the previous step's tools settled, so
      // no tool can still be in flight; this also recovers from a missed
      // tools/result.
      entry.pendingTools = 0
      progress(agent)
      return next()
    })

    // User-wait windows (question dialogs / approval prompts): freeze the
    // watchdog for the whole wait.
    agent.ctx.on('user-questions/request', userWaitListener(entry))
    agent.ctx.on('approval/request', userWaitListener(entry))
  })

  ctx.on('agent/disposed', ({ agent }) => dispose(agent))

  // ── tools events: service-scoped, registered on root, matched via exec.agent ─
  // Waterfall listener: mark in flight, freeze timers, ALWAYS return next().
  ctx.on('tools/pre-execute', (exec, next) => {
    const entry = entries.get(exec?.agent?.id)
    if (entry && !entry.disposed) {
      entry.pendingTools += 1
      clearTimers(entry)
    }
    return next()
  })

  // Emit listener: the tool finished -> real progress.
  ctx.on('tools/result', (exec) => {
    const entry = entries.get(exec?.agent?.id)
    if (!entry || entry.disposed) return
    entry.pendingTools = Math.max(0, entry.pendingTools - 1)
    progress(exec.agent)
  })
}
