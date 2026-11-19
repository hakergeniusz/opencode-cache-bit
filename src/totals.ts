/**
 * Pure token-usage math for opencode-cache-bit.
 *
 * No OpenCode / pi runtime imports here on purpose: this module is the
 * dependency-free core that can be unit-tested on its own.
 *
 * The cache-hit formula is the one from the original pi `cache-bit` extension
 * (and its sibling `pi-token-usage` ledger):
 *
 *   prompt tokens   = input + cacheRead + cacheWrite
 *   cache-hit rate  = cacheRead / promptTokens * 100
 *
 * `input` is uncached, `cacheRead` is the hit, `cacheWrite` primes the cache
 * for the next turn.
 */

/** Structural, defensive subset of a per-call usage record. */
export interface UsageLike {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  totalTokens?: number
  /** pi uses an object; OpenCode reports a plain number on messages. */
  cost?: number | { total?: number }
}

export interface Totals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  cost: number
  requests: number
}

/** A single LLM call pulled out of a session's messages/entries. */
export interface ScannedCall {
  usage: UsageLike
  modelKey?: string
  ts: number
}

export function zeroTotals(): Totals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, requests: 0 }
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function num(value: unknown): number {
  return finite(value) ?? 0
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Normalize the many shapes a usage record can take into `UsageLike`. */
export function toUsage(raw: unknown, costHint?: unknown): UsageLike | null {
  if (!isObject(raw)) return null

  // Walk a few known containers: OpenCode tokens, pi `usage`, direct object.
  const cache = isObject(raw.cache) ? raw.cache : undefined
  const containers: Record<string, unknown>[] = [raw]
  if (isObject(raw.usage)) containers.push(raw.usage)
  if (isObject(raw.tokens)) containers.push(raw.tokens)

  for (const container of containers) {
    const cCache = isObject(container.cache) ? container.cache : cache
    const hasTokens =
      finite(container.input) !== undefined ||
      finite(container.output) !== undefined ||
      finite(container.cacheRead) !== undefined ||
      finite(container.cacheWrite) !== undefined ||
      finite(cCache?.read) !== undefined ||
      finite(cCache?.write) !== undefined
    if (!hasTokens) continue

    // OpenCode keeps reasoning tokens separate; fold them into output so the
    // number stays comparable with pi's single `output` field.
    const output = num(container.output) + num(container.reasoning)
    const total = finite(container.totalTokens) ?? finite(container.total)

    let cost: UsageLike["cost"] | undefined = finite(container.cost)
    if (cost === undefined && isObject(container.cost)) {
      cost = finite(container.cost.total)
    }
    if (cost === undefined) cost = finite(costHint)
    if (cost === undefined && isObject(costHint)) cost = finite(costHint.total)

    const usage: UsageLike = {
      input: num(container.input),
      output,
      cacheRead: num(finite(container.cacheRead) ?? cCache?.read),
      cacheWrite: num(finite(container.cacheWrite) ?? cCache?.write),
      totalTokens: total,
    }
    if (cost !== undefined) usage.cost = cost
    return usage
  }
  return null
}

export function totalsFromUsage(usage: UsageLike): Totals {
  const input = num(usage.input)
  const output = num(usage.output)
  const cost = typeof usage.cost === "number" ? usage.cost : num(usage.cost?.total)
  return {
    input,
    output,
    cacheRead: num(usage.cacheRead),
    cacheWrite: num(usage.cacheWrite),
    total: num(usage.totalTokens) || input + output,
    cost,
    requests: 1,
  }
}

export function addInto(dst: Totals, src: Totals): void {
  dst.input += src.input
  dst.output += src.output
  dst.cacheRead += src.cacheRead
  dst.cacheWrite += src.cacheWrite
  dst.total += src.total
  dst.cost += src.cost
  dst.requests += src.requests
}

function modelKeyOf(info: Record<string, unknown>): string | undefined {
  const provider = (info.providerID ?? info.provider) as unknown
  const model = (info.modelID ?? info.model) as unknown
  if (typeof provider === "string" && typeof model === "string" && provider && model) {
    return `${provider}/${model}`
  }
  return undefined
}

function timestampOf(entry: Record<string, unknown>, info: Record<string, unknown>): number {
  const direct = finite(entry.timestamp) ?? finite(info.timestamp)
  if (direct !== undefined) return direct
  const time = isObject(info.time) ? finite(info.time.created) : undefined
  if (time !== undefined) return time
  const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN
  return Number.isFinite(parsed) ? parsed : Date.now()
}

/**
 * Extract every billable LLM call from a list of session messages/entries.
 *
 * Handles both:
 *  - pi-shaped entries: `{ type: "message", message: { role, usage } }` and
 *    `{ type: "compaction", usage }`
 *  - OpenCode projected messages:
 *    `{ info: { role: "assistant" | "compaction", tokens, cost }, parts: [...] }`
 *
 * OpenCode folds tool results into assistant-message parts, so only assistant
 * and compaction messages carry usage; counting those does not double count.
 */
export function scanEntries(entries: unknown[]): ScannedCall[] {
  const calls: ScannedCall[] = []
  for (const entry of entries) {
    if (!isObject(entry)) continue

    const info = isObject(entry.info)
      ? entry.info
      : isObject(entry.message)
        ? entry.message
        : entry

    const usage = toUsage(info, entry.cost ?? info.cost)
    if (!usage) continue

    const type = typeof entry.type === "string" ? entry.type : undefined
    const role = typeof info.role === "string" ? info.role : undefined
    const kind = type ?? role

    if (kind === "message") {
      if (role !== "assistant" && role !== "toolResult") continue
    } else if (kind === "assistant" || kind === "compaction") {
      // billable
    } else if (role === "toolResult") {
      // billable
    } else {
      continue
    }

    calls.push({
      usage,
      modelKey: modelKeyOf(info),
      ts: timestampOf(entry, info),
    })
  }
  return calls
}

export function sumCalls(calls: ScannedCall[]): Totals {
  const totals = zeroTotals()
  for (const call of calls) addInto(totals, totalsFromUsage(call.usage))
  return totals
}

/**
 * `cacheRead / (input + cacheRead + cacheWrite)`. Returns null when there is
 * no prompt usage to score.
 */
export function cacheHitRate(
  totals: Totals,
): { promptTokens: number; cacheRead: number; rate: number } | null {
  const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite
  if (promptTokens <= 0) return null
  return {
    promptTokens,
    cacheRead: totals.cacheRead,
    rate: (totals.cacheRead / promptTokens) * 100,
  }
}
