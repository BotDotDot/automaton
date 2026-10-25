/**
 * Heartbeat policy the bot cannot change.
 *
 * Safety tasks always run on their default schedule at every tier, whatever
 * heartbeat.yml or the heartbeat_schedule table (both on the bot's writable
 * volume) say. A missing or tampered row is restored every tick and logged.
 * In local mode, Conway-only tasks never run.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { HeartbeatEntry, HeartbeatScheduleRow } from "../types.js";
import { getHeartbeatSchedule, upsertHeartbeatSchedule } from "../state/database.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("heartbeat.policy");

/** Safety tasks and their fixed schedules. */
export const SAFETY_TASKS: Readonly<Record<string, string>> = Object.freeze({
  heartbeat_ping: "*/15 * * * *",
  check_credits: "0 */6 * * *",
  health_check: "*/30 * * * *",
});

/** Tasks that need Conway, a wallet or the internet: never run in local mode. */
export const LOCAL_DISABLED_TASKS: ReadonlySet<string> = new Set([
  "check_usdc_balance",
  "check_social_inbox",
  "check_for_updates",
  "refresh_models",
]);

/** Force safety entries on in a loaded heartbeat config. */
export function enforceHeartbeatEntries(entries: HeartbeatEntry[], localMode: boolean): HeartbeatEntry[] {
  const out = entries.map((e) => {
    if (e.name in SAFETY_TASKS) return { ...e, task: e.name, schedule: SAFETY_TASKS[e.name], enabled: true };
    if (localMode && LOCAL_DISABLED_TASKS.has(e.name)) return { ...e, enabled: false };
    return e;
  });
  for (const [name, schedule] of Object.entries(SAFETY_TASKS)) {
    if (!out.some((e) => e.name === name)) out.push({ name, task: name, schedule, enabled: true });
  }
  return out;
}

function freshRow(taskName: string, cronExpression: string): HeartbeatScheduleRow {
  return {
    taskName,
    cronExpression,
    intervalMs: null,
    enabled: 1,
    priority: 0,
    timeoutMs: 30_000,
    maxRetries: 1,
    tierMinimum: "dead",
    lastRunAt: null,
    nextRunAt: null,
    lastResult: null,
    lastError: null,
    runCount: 0,
    failCount: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
  };
}

/**
 * Restore safety task rows (enabled, default schedule, any tier) and return
 * the names of rows that had to be fixed.
 */
export function enforceSafetySchedule(db: BetterSqlite3.Database): string[] {
  const rows = new Map(getHeartbeatSchedule(db).map((r) => [r.taskName, r]));
  const fixed: string[] = [];
  for (const [name, cron] of Object.entries(SAFETY_TASKS)) {
    const row = rows.get(name);
    if (!row) {
      upsertHeartbeatSchedule(db, freshRow(name, cron));
      fixed.push(name);
    } else if (!row.enabled || row.cronExpression !== cron || row.tierMinimum !== "dead" || row.intervalMs !== null) {
      upsertHeartbeatSchedule(db, { ...row, enabled: 1, cronExpression: cron, tierMinimum: "dead", intervalMs: null });
      fixed.push(name);
    }
  }
  if (fixed.length) {
    logger.warn(`Restored safety heartbeat task(s): ${fixed.join(", ")}`);
  }
  return fixed;
}

/** Whether a task may run at all under this policy. */
export function taskAllowed(taskName: string, localMode: boolean): boolean {
  return !(localMode && LOCAL_DISABLED_TASKS.has(taskName));
}
