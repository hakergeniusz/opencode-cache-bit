/**
 * Report rendering for opencode-cache-bit. Pure: no runtime SDK calls.
 */

import { cacheHitRate, type Totals } from "./totals"

export interface GlobalTotals {
  total: Totals
  sessionCount: number
  updatedAt: number | null
  source: "ledger" | "scan"
}

export interface CacheReport {
  title: string
  lines: string[]
  timestamp: number
}

export interface ReportInput {
  sessionTotals: Totals
  sessionModelKey?: string
  global?: GlobalTotals | null
  sessionOnly: boolean
  globalOnly: boolean
  rebuild: boolean
  /** Human-readable label for where the cached global aggregate lives. */
  ledgerLabel: string
}

export function formatInt(n: number): string {
  return Math.round(n).toLocaleString("en-US")
}

export function formatCost(cost: number): string {
  if (!Number.isFinite(cost)) return "$0.0000"
  return `$${cost > 0.5 ? cost.toFixed(2) : cost.toFixed(4)}`
}

export function totalsLine(t: Totals): string {
  const parts = [`↑${formatInt(t.input)} in`, `↓${formatInt(t.output)} out`]
  if (t.cacheRead > 0 || t.cacheWrite > 0) {
    parts.push(`${formatInt(t.cacheRead)} cache-read`, `${formatInt(t.cacheWrite)} cache-write`)
  }
  parts.push(`${formatInt(t.total)} total`, formatCost(t.cost), `${t.requests} req`)
  return parts.join(" · ")
}

/** `12.3% cache-hit  (3,000 cache-read of 24,200 prompt)` */
export function cacheHitLine(t: Totals): string {
  const rate = cacheHitRate(t)
  if (!rate) return "no cache usage recorded"
  return `${rate.rate.toFixed(1)}% cache-hit  (${formatInt(rate.cacheRead)} cache-read of ${formatInt(rate.promptTokens)} prompt tokens)`
}

/**
 * Build the same two-section report as the original pi extension: live
 * this-session tally plus a global tally from the stored/fresh aggregate.
 */
export function buildReport(input: ReportInput): CacheReport {
  const lines: string[] = []
  const title = "Cache hit rate"

  if (!input.globalOnly) {
    const sessionRate = cacheHitRate(input.sessionTotals)
    if (sessionRate) {
      lines.push(`${sessionRate.rate.toFixed(1)}% cache-hit  (this session)`)
      lines.push(`  ${cacheHitLine(input.sessionTotals)}`)
      lines.push(
        `  ${totalsLine(input.sessionTotals)}${input.sessionModelKey ? ` · ${input.sessionModelKey}` : ""}`,
      )
    } else {
      lines.push("this session: no cache usage recorded")
    }
  }

  if (!input.sessionOnly) {
    const g = input.global
    if (g) {
      const rate = cacheHitRate(g.total)
      const src = g.source === "ledger" ? "ledger" : "recount"
      if (rate) {
        lines.push(`${rate.rate.toFixed(1)}% cache-hit  (global, ${src})`)
        lines.push(
          `  ${formatInt(rate.cacheRead)} cache-read of ${formatInt(rate.promptTokens)} prompt tokens`,
        )
        lines.push(`  across ${formatInt(g.sessionCount)} sessions`)
        if (g.source === "ledger" && g.updatedAt) {
          lines.push(`  ledger updated ${new Date(g.updatedAt).toLocaleString()}`)
        }
      } else {
        lines.push(`global (${src}): no cache usage recorded`)
      }
    } else if (input.rebuild) {
      lines.push("global: recount scanned every session — none had usage")
    } else {
      lines.push(
        `global: no cached aggregate at ${input.ledgerLabel} — run \`/cache-bit --rebuild\` to scan all sessions`,
      )
    }
  }

  return { title, lines, timestamp: Date.now() }
}

/** Plain-text form used for the transcript message / tool result. */
export function formatReportText(report: CacheReport): string {
  return `\n${report.title}\n${report.lines.map((line) => `  ${line}`).join("\n")}\n`
}
