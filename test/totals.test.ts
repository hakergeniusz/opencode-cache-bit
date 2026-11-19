/**
 * Hermetic tests for the pure core — no OpenCode runtime, no network.
 * Run with `bun test`.
 */
import { describe, expect, test } from "bun:test"

import {
  cacheHitRate,
  scanEntries,
  sumCalls,
  toUsage,
  totalsFromUsage,
  zeroTotals,
  type Totals,
} from "../src/totals"
import { buildReport, cacheHitLine, formatCost, formatInt, totalsLine } from "../src/report"

describe("cacheHitRate math", () => {
  test("cacheRead / (input + cacheRead + cacheWrite)", () => {
    // 1000 cached of 4000 prompt (3000 input + 1000 cacheRead + 0 cacheWrite)
    expect(cacheHitRate({ input: 3000, cacheRead: 1000, cacheWrite: 0 } as Totals)?.rate).toBe(25)
  })

  test("37.5% with cacheWrite present", () => {
    const r = cacheHitRate({ input: 3000, cacheRead: 3000, cacheWrite: 2000 } as Totals)
    expect(r?.rate).toBe(37.5)
    expect(r?.promptTokens).toBe(8000)
  })

  test("zero totals -> no rate", () => {
    expect(cacheHitRate(zeroTotals())).toBeNull()
  })

  test("cacheWrite only -> 0% hit", () => {
    const r = cacheHitRate({ ...zeroTotals(), input: 0, cacheRead: 0, cacheWrite: 5 } as Totals)
    expect(r?.rate).toBe(0)
    expect(r?.cacheRead).toBe(0)
  })
})

describe("scanEntries + sumCalls", () => {
  const usage = {
    input: 3000,
    output: 1000,
    cacheRead: 3000,
    cacheWrite: 0,
    totalTokens: 7000,
    cost: { total: 0.07 },
  }
  const piMessage = (role: string, u: unknown, provider?: string, model?: string) => ({
    type: "message",
    message: { role, provider, model, timestamp: 1000, usage: u },
  })

  const entries = [
    piMessage("user", {}),
    piMessage("assistant", usage, "anthropic", "claude-3"),
    piMessage(
      "assistant",
      { input: 2000, output: 500, cacheRead: 0, cacheWrite: 2000, totalTokens: 4500, cost: { total: 0.02 } },
      "anthropic",
      "claude-3",
    ),
    {
      type: "compaction",
      timestamp: 2000,
      usage: { input: 0, output: 100, cacheRead: 50, cacheWrite: 0, totalTokens: 150, cost: { total: 0.001 } },
    },
    { type: "branch_summary", timestamp: 2000, usage: { input: 0, output: 40, totalTokens: 40 } },
  ]

  test("finds 3 calls (2 assistant + 1 compaction; branch_summary skipped)", () => {
    expect(scanEntries(entries).length).toBe(3)
  })

  test("aggregates into totals", () => {
    const sums = sumCalls(scanEntries(entries))
    expect(sums.input).toBe(5000)
    expect(sums.cacheRead).toBe(3050)
    expect(sums.cacheWrite).toBe(2000)
    expect(sums.requests).toBe(3)
    // 3050 / (5000 + 3050 + 2000) = 30.348...%
    const rate = cacheHitRate(sums)
    expect(rate).not.toBeNull()
    expect(Math.abs((rate?.rate ?? 0) - 30.348)).toBeLessThan(0.01)
  })

  test("reads OpenCode-shaped messages with nested cache and numeric cost", () => {
    const oc = [
      {
        info: {
          role: "assistant",
          providerID: "anthropic",
          modelID: "claude-sonnet",
          tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 800, write: 100 } },
          cost: 0.0123,
        },
        parts: [],
      },
      { info: { role: "compaction", tokens: { input: 0, output: 5, cache: { read: 20, write: 0 } }, cost: 0.001 } },
      { info: { role: "user" }, parts: [] },
    ]
    const calls = scanEntries(oc)
    expect(calls.length).toBe(2)
    expect(calls[0].modelKey).toBe("anthropic/claude-sonnet")
    const totals = sumCalls(calls)
    expect(totals.input).toBe(100)
    expect(totals.output).toBe(55) // 40 output + 10 reasoning + 5 compaction
    expect(totals.cacheRead).toBe(820)
    expect(totals.cacheWrite).toBe(100)
    expect(totals.cost).toBeCloseTo(0.0133, 4)
  })

  test("toUsage returns null when there are no token fields", () => {
    expect(toUsage({ role: "user", parts: [] })).toBeNull()
  })

  test("totalsFromUsage uses totalTokens when present", () => {
    expect(totalsFromUsage({ input: 2, output: 3, totalTokens: 99 }).total).toBe(99)
    expect(totalsFromUsage({ input: 2, output: 3 }).total).toBe(5)
  })
})

describe("report rendering", () => {
  const sessionTotals = sumCalls(scanEntries([
    {
      info: {
        role: "assistant",
        tokens: { input: 3000, output: 1000, cache: { read: 3000, write: 0 } },
        cost: 0.07,
      },
    },
  ]))
  const globalTotals = {
    total: totalsFromUsage({ input: 100, output: 10, cacheRead: 1900, cacheWrite: 0, totalTokens: 2010, cost: 0.5 }),
    sessionCount: 2,
    updatedAt: 1_000_000,
    source: "ledger" as const,
  }

  test("default report has both sections and the global rate", () => {
    const report = buildReport({
      sessionTotals,
      global: globalTotals,
      sessionOnly: false,
      globalOnly: false,
      rebuild: false,
      ledgerLabel: "storage",
    })
    const joined = report.lines.join("\n")
    expect(report.title).toBe("Cache hit rate")
    expect(joined).toMatch(/cache-hit\s+\(this session\)/)
    expect(joined).toMatch(/cache-hit\s+\(global, ledger\)/)
    expect(joined).toMatch(/50\.0% cache-hit\s+\(this session\)/)
    expect(joined).toMatch(/95\.0% cache-hit\s+\(global/)
    expect(joined).toMatch(/across 2 sessions/)
  })

  test("session-only omits global and global-only omits session", () => {
    const session = buildReport({
      sessionTotals,
      global: globalTotals,
      sessionOnly: true,
      globalOnly: false,
      rebuild: false,
      ledgerLabel: "storage",
    })
    expect(session.lines.join("\n")).not.toMatch(/global/)
    const global = buildReport({
      sessionTotals,
      global: globalTotals,
      sessionOnly: false,
      globalOnly: true,
      rebuild: false,
      ledgerLabel: "storage",
    })
    expect(global.lines.join("\n")).not.toMatch(/this session/)
  })

  test("missing ledger explains how to rebuild", () => {
    const report = buildReport({
      sessionTotals,
      global: null,
      sessionOnly: false,
      globalOnly: false,
      rebuild: false,
      ledgerLabel: "storage key",
    })
    expect(report.lines.join("\n")).toMatch(/cache-bit --rebuild/)
  })

  test("formatting helpers", () => {
    expect(formatInt(12345.6)).toBe("12,346")
    expect(formatCost(0.5)).toBe("$0.5000")
    expect(formatCost(2)).toBe("$2.00")
    expect(totalsLine(zeroTotals())).toContain("0 req")
    expect(cacheHitLine(zeroTotals())).toBe("no cache usage recorded")
  })
})
