/**
 * opencode-cache-bit — native OpenCode V2 port of the pi `cache-bit` extension.
 *
 * Reports the cache-hit rate (cacheRead / (input + cacheRead + cacheWrite))
 * for the live session and globally. See README.md for the pi -> OpenCode
 * mapping and for the few behaviors that could not be preserved 1:1.
 *
 * Load in opencode.json(c):
 *   "plugins": ["opencode-cache-bit"]
 */

import { Plugin } from "@opencode/plugin"

import {
  addInto,
  scanEntries,
  sumCalls,
  zeroTotals,
  type Totals,
} from "./totals"
import {
  buildReport as renderReport,
  formatReportText,
  type CacheReport,
  type GlobalTotals,
} from "./report"

const STORAGE_KEY = "global-totals"

/**
 * Structural view of the plugin context. Keeping this local (instead of
 * deriving types from `Plugin.define`) makes the plugin resilient to small
 * SDK signature changes; the real context is cast to it once in `setup`.
 */
interface Registration {
  dispose(): Promise<void>
}
interface SessionLike {
  list(input: Record<string, unknown>): Promise<unknown>
  context(input: { sessionID: string }): Promise<unknown>
  get(input: { sessionID: string }): Promise<unknown>
  synthetic(input: Record<string, unknown>): Promise<unknown>
}
interface StorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}
interface EditorLike {
  add(definition: Record<string, unknown>): void
}
interface PluginCtx {
  options?: Record<string, unknown>
  session: SessionLike
  storage: StorageLike
  command: { transform(cb: (editor: EditorLike) => void): Promise<Registration> }
  tool: { transform(cb: (editor: EditorLike) => void): Promise<Registration> }
}

interface Options {
  /** "all" | "session" | "global" — which section to show by default. */
  defaultScope?: string
  /** How long a stored global aggregate is reused before rescanning (ms). */
  globalCacheTTLMs?: number
  /** Safety cap on how many sessions a global scan visits. */
  maxSessions?: number
}

interface ParseArgs {
  sessionOnly: boolean
  globalOnly: boolean
  rebuild: boolean
}

function parseArgs(raw: string, options: Options): ParseArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  const scope = tokens.find((t) => t === "session" || t === "global") ?? options.defaultScope
  return {
    rebuild: tokens.includes("--rebuild") || tokens.includes("rebuild"),
    sessionOnly: scope === "session",
    globalOnly: scope === "global",
  }
}

function toArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>
    for (const key of ["data", "messages", "sessions", "items"]) {
      if (Array.isArray(v[key])) return v[key] as T[]
    }
  }
  return []
}

function cursorNext(page: unknown): unknown {
  if (!page || typeof page !== "object") return undefined
  const p = page as Record<string, unknown>
  if (p.cursor && typeof p.cursor === "object") {
    return (p.cursor as Record<string, unknown>).next
  }
  return p.next
}

/** Fetch messages for a session using whichever session read API is present. */
async function fetchMessages(ctx: PluginCtx, sessionID: string): Promise<unknown[]> {
  const s = ctx.session as unknown as Record<string, unknown>

  // Preferred: full paginated message history (plugin contexts expose this on
  // some OpenCode builds as `messages` or `message.list`).
  const readers: ((args: Record<string, unknown>) => Promise<unknown>)[] = []
  if (typeof s.messages === "function") readers.push(s.messages as (a: Record<string, unknown>) => Promise<unknown>)
  const messageNs = s.message as Record<string, unknown> | undefined
  if (messageNs && typeof messageNs.list === "function") {
    readers.push(messageNs.list as (a: Record<string, unknown>) => Promise<unknown>)
  }

  for (const read of readers) {
    try {
      const collected: unknown[] = []
      let cursor: unknown
      for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
        const args: Record<string, unknown> = { sessionID, limit: 200 }
        if (cursor !== undefined) args.cursor = cursor
        const page = await read(args)
        collected.push(...toArray(page))
        const next = cursorNext(page)
        if (!next) return collected
        cursor = next
      }
      if (collected.length > 0) return collected
    } catch {
      // fall through to the next strategy
    }
  }

  // Fallback: plugin API documented `session.context` (active context, i.e.
  // all messages after the last compaction).
  try {
    return (await ctx.session.context({ sessionID })) as unknown[]
  } catch {
    return []
  }
}

async function listSessionIDs(ctx: PluginCtx, maxSessions: number): Promise<string[]> {
  const ids: string[] = []
  let cursor: unknown
  try {
    for (let pageIndex = 0; pageIndex < 20 && ids.length < maxSessions; pageIndex += 1) {
      const args: Record<string, unknown> = {
        limit: Math.min(100, maxSessions - ids.length),
      }
      if (cursor !== undefined) args.cursor = cursor
      const page = await ctx.session.list(args)
      for (const session of toArray<Record<string, unknown>>(page)) {
        if (typeof session?.id === "string") ids.push(session.id)
        if (ids.length >= maxSessions) break
      }
      const next = cursorNext(page)
      if (!next) break
      cursor = next
    }
  } catch {
    // an unavailable list API simply yields an empty recount
  }
  return ids
}

function totalsFromJson(value: unknown): Totals {
  const t = zeroTotals()
  if (!value || typeof value !== "object") return t
  const v = value as Record<string, unknown>
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total", "cost", "requests"] as const) {
    const n = v[key]
    if (typeof n === "number" && Number.isFinite(n)) t[key] = n
  }
  return t
}

async function persistGlobal(ctx: PluginCtx, value: GlobalTotals): Promise<void> {
  try {
    await ctx.storage.set(STORAGE_KEY, value)
  } catch {
    // caching is best-effort
  }
}

/** Full recount of every session — the `--rebuild` path. */
async function scanGlobal(
  ctx: PluginCtx,
  maxSessions: number,
  signal?: AbortSignal,
): Promise<GlobalTotals> {
  const total = zeroTotals()
  let sessionCount = 0
  for (const id of await listSessionIDs(ctx, maxSessions)) {
    if (signal?.aborted) break
    try {
      const calls = scanEntries(await fetchMessages(ctx, id))
      if (calls.length === 0) continue
      sessionCount += 1
      addInto(total, sumCalls(calls))
    } catch {
      // a corrupt/unreadable session is skipped, not fatal
    }
  }
  const result: GlobalTotals = { total, sessionCount, updatedAt: Date.now(), source: "scan" }
  await persistGlobal(ctx, result)
  return result
}

/** Read the stored global aggregate (the OpenCode stand-in for pi's ledger). */
async function readGlobal(
  ctx: PluginCtx,
  maxSessions: number,
  ttlMs: number,
  signal?: AbortSignal,
): Promise<GlobalTotals | null> {
  try {
    const cached = await ctx.storage.get(STORAGE_KEY)
    if (cached && typeof cached === "object") {
      const c = cached as Record<string, unknown>
      const updatedAt = typeof c.updatedAt === "number" ? c.updatedAt : 0
      if (updatedAt > 0 && Date.now() - updatedAt < ttlMs) {
        return {
          total: totalsFromJson(c.total),
          sessionCount: typeof c.sessionCount === "number" ? c.sessionCount : 0,
          updatedAt,
          source: "ledger",
        }
      }
    }
  } catch {
    // storage unavailable — fall through to a fresh scan
  }

  return scanGlobal(ctx, maxSessions, signal)
}

async function sessionModelKey(ctx: PluginCtx, sessionID: string): Promise<string | undefined> {
  try {
    const info = (await ctx.session.get({ sessionID })) as Record<string, unknown> | null
    const data = (info?.data ?? info) as Record<string, unknown> | null
    const provider = data?.providerID ?? data?.provider
    const model = data?.modelID ?? data?.model
    if (typeof provider === "string" && typeof model === "string") return `${provider}/${model}`
  } catch {
    // optional detail only
  }
  return undefined
}

async function buildReport(
  ctx: PluginCtx,
  sessionID: string,
  args: ParseArgs,
  options: Options,
  signal?: AbortSignal,
): Promise<CacheReport> {
  const maxSessions = Math.max(1, options.maxSessions ?? 2000)
  const ttlMs = Math.max(0, options.globalCacheTTLMs ?? 5 * 60 * 1000)

  const sessionTotals = sumCalls(scanEntries(await fetchMessages(ctx, sessionID)))
  const modelKey = await sessionModelKey(ctx, sessionID)

  let global: GlobalTotals | null = null
  if (!args.sessionOnly) {
    global = args.rebuild
      ? await scanGlobal(ctx, maxSessions, signal)
      : await readGlobal(ctx, maxSessions, ttlMs, signal)
  }

  return renderReport({
    sessionTotals,
    sessionModelKey: modelKey,
    global,
    sessionOnly: args.sessionOnly,
    globalOnly: args.globalOnly,
    rebuild: args.rebuild,
    ledgerLabel: `plugin storage key "${STORAGE_KEY}"`,
  })
}

/** Emit a report into the transcript without triggering the agent loop. */
async function showReport(ctx: PluginCtx, sessionID: string, text: string): Promise<void> {
  const s = ctx.session as unknown as Record<string, unknown>
  if (typeof s.synthetic === "function") {
    const synthetic = s.synthetic as (a: Record<string, unknown>) => Promise<unknown>
    try {
      await synthetic({ sessionID, text, resume: false })
      return
    } catch {
      try {
        await synthetic({ sessionID, text })
        return
      } catch {
        // last resort below
      }
    }
  }
  // Server-side fallback: keep the report discoverable in the OpenCode log.
  console.log(text)
}

export default Plugin.define({
  id: "opencode-cache-bit",
  async setup(rawCtx) {
    const ctx = rawCtx as unknown as PluginCtx
    const options = (ctx.options ?? {}) as Options
    const registrations: Registration[] = []

    registrations.push(
      await ctx.command.transform((editor) => {
        editor.add({
          name: "cache-bit",
          description: "Show cache hit rate: globally (calculated with math) and in this session",
          execute: async (invocation: unknown) => {
            const { sessionID, prompt } = invocation as {
              sessionID: string
              prompt?: { text?: string }
            }
            const args = parseArgs(prompt?.text ?? "", options)
            const report = await buildReport(ctx, sessionID, args, options)
            await showReport(ctx, sessionID, formatReportText(report))
          },
        })
      }),
    )

    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "cache_bit",
          description:
            "Report the prompt-cache hit rate (cacheRead / (input + cacheRead + cacheWrite)) for this session and globally.",
          input: {
            type: "object",
            properties: {
              scope: {
                type: "string",
                enum: ["all", "session", "global"],
                description: "Which section to include (default: all)",
              },
              rebuild: {
                type: "boolean",
                description: "Force a fresh full recount of all sessions",
              },
            },
            additionalProperties: false,
          },
          options: { codemode: true },
          execute: async (input: unknown, toolContext: unknown) => {
            const parsed = input as { scope?: string; rebuild?: boolean }
            const tc = toolContext as { sessionID: string; signal?: AbortSignal }
            const args: ParseArgs = {
              rebuild: parsed.rebuild === true,
              sessionOnly: parsed.scope === "session",
              globalOnly: parsed.scope === "global",
            }
            const report = await buildReport(ctx, tc.sessionID, args, options, tc.signal)
            return { content: formatReportText(report) }
          },
        })
      }),
    )

    return () => {
      for (const registration of registrations) void registration.dispose()
    }
  },
})
