/**
 * Safety heartbeat tasks can't be switched off by the bot, and Conway-only
 * tasks never run in local mode.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, createTestConfig, createTestIdentity, MockConwayClient } from "./mocks.js";
import { enforceSafetySchedule, SAFETY_TASKS, LOCAL_DISABLED_TASKS } from "../heartbeat/policy.js";
import { DurableScheduler } from "../heartbeat/scheduler.js";
import { getHeartbeatSchedule, upsertHeartbeatSchedule } from "../state/database.js";
import { VALID_OPERATOR } from "./fixtures/operator.js";
import type { AutomatonDatabase, HeartbeatScheduleRow, TickContext } from "../types.js";

function row(taskName: string, over: Partial<HeartbeatScheduleRow> = {}): HeartbeatScheduleRow {
  return {
    taskName, cronExpression: "* * * * *", intervalMs: null, enabled: 1, priority: 0,
    timeoutMs: 30_000, maxRetries: 1, tierMinimum: "dead", lastRunAt: null, nextRunAt: null,
    lastResult: null, lastError: null, runCount: 0, failCount: 0, leaseOwner: null, leaseExpiresAt: null,
    ...over,
  };
}

const tick = (tier = "high"): TickContext =>
  ({ tickId: "t", startedAt: new Date(), creditBalance: 2000, usdcBalance: 0, survivalTier: tier, lowComputeMultiplier: 4, config: {} as any, db: {} as any }) as TickContext;

describe("safety schedule enforcement", () => {
  let db: AutomatonDatabase;
  beforeEach(() => (db = createTestDb()));
  afterEach(() => db.close());

  it("restores disabled, rescheduled, tier-raised and deleted safety tasks", () => {
    upsertHeartbeatSchedule(db.raw, row("heartbeat_ping", { enabled: 0, cronExpression: SAFETY_TASKS.heartbeat_ping, lastRunAt: "2026-10-23T00:00:00Z", runCount: 7 }));
    upsertHeartbeatSchedule(db.raw, row("check_credits", { cronExpression: "0 0 31 2 *" }));
    upsertHeartbeatSchedule(db.raw, row("other_task", { enabled: 0 }));
    // health_check missing entirely

    const fixed = enforceSafetySchedule(db.raw);
    expect(fixed.sort()).toEqual(["check_credits", "health_check", "heartbeat_ping"]);

    const rows = new Map(getHeartbeatSchedule(db.raw).map((r) => [r.taskName, r]));
    for (const [name, cron] of Object.entries(SAFETY_TASKS)) {
      expect(rows.get(name)?.enabled, name).toBeTruthy();
      expect(rows.get(name)?.cronExpression, name).toBe(cron);
      expect(rows.get(name)?.tierMinimum, name).toBe("dead");
    }
    // run history kept
    expect(rows.get("heartbeat_ping")?.lastRunAt).toBe("2026-10-23T00:00:00Z");
    expect(rows.get("heartbeat_ping")?.runCount).toBe(7);
    // non-safety tasks untouched
    expect(rows.get("other_task")?.enabled).toBeFalsy();
    // idempotent
    expect(enforceSafetySchedule(db.raw)).toEqual([]);
  });

  it("restores a safety task whose tier minimum was raised", () => {
    enforceSafetySchedule(db.raw);
    const r = getHeartbeatSchedule(db.raw).find((x) => x.taskName === "check_credits")!;
    upsertHeartbeatSchedule(db.raw, { ...r, tierMinimum: "high" });
    expect(enforceSafetySchedule(db.raw)).toEqual(["check_credits"]);
  });
});

describe("scheduler in local mode", () => {
  let db: AutomatonDatabase;
  beforeEach(() => (db = createTestDb()));
  afterEach(() => db.close());

  function scheduler(localMode: boolean, tasks: Record<string, () => Promise<any>>) {
    return new DurableScheduler(
      db.raw,
      { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 },
      new Map(Object.entries(tasks)),
      {
        identity: createTestIdentity(),
        config: createTestConfig({ localMode }),
        db,
        conway: new MockConwayClient(),
      },
    );
  }

  it("never schedules Conway-only tasks in local mode, even if enabled in the DB", () => {
    for (const name of LOCAL_DISABLED_TASKS) upsertHeartbeatSchedule(db.raw, row(name));
    upsertHeartbeatSchedule(db.raw, row("health_check"));
    const local = scheduler(true, {}).getDueTasks(tick()).map((r) => r.taskName);
    expect(local).toEqual(["health_check"]);
    const conwayMode = scheduler(false, {}).getDueTasks(tick()).map((r) => r.taskName).sort();
    expect(conwayMode).toEqual([...LOCAL_DISABLED_TASKS, "health_check"].sort());
  });

  it("refuses to execute a Conway-only task directly in local mode", async () => {
    const ran: string[] = [];
    const s = scheduler(true, {
      check_social_inbox: async () => { ran.push("social"); return { shouldWake: false }; },
      health_check: async () => { ran.push("health"); return { shouldWake: false }; },
    });
    upsertHeartbeatSchedule(db.raw, row("check_social_inbox"));
    upsertHeartbeatSchedule(db.raw, row("health_check"));
    await s.executeTask("check_social_inbox", tick());
    await s.executeTask("health_check", tick());
    expect(ran).toEqual(["health"]);
  });
});

describe("heartbeat config file", () => {
  let home: string;
  const saved = { ...process.env };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "hb-policy-"));
    process.env.HOME = home;
    vi.resetModules();
  });
  afterEach(() => {
    process.env = { ...saved };
    fs.rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  it("forces safety tasks on and Conway tasks off in local mode", async () => {
    const op = path.join(home, "operator.json");
    fs.writeFileSync(op, JSON.stringify(VALID_OPERATOR));
    process.env.AUTOMATON_OPERATOR_CONFIG = op;
    const yml = path.join(home, "heartbeat.yml");
    fs.writeFileSync(yml, [
      "entries:",
      "  - { name: check_credits, schedule: '0 0 31 2 *', task: check_credits, enabled: false }",
      "  - { name: health_check, schedule: '*/30 * * * *', task: health_check, enabled: false }",
      "  - { name: check_social_inbox, schedule: '*/2 * * * *', task: check_social_inbox, enabled: true }",
    ].join("\n"));
    const { loadHeartbeatConfig } = await import("../heartbeat/config.js");
    const entries = new Map(loadHeartbeatConfig(yml).entries.map((e) => [e.name, e]));
    expect(entries.get("check_credits")).toMatchObject({ enabled: true, schedule: SAFETY_TASKS.check_credits });
    expect(entries.get("health_check")?.enabled).toBe(true);
    expect(entries.get("heartbeat_ping")?.enabled).toBe(true);
    expect(entries.get("check_social_inbox")?.enabled).toBe(false);
    expect(entries.get("check_usdc_balance")?.enabled).toBe(false);
  });

  it("also forces safety tasks on outside local mode", async () => {
    process.env.AUTOMATON_OPERATOR_CONFIG = path.join(home, "none.json");
    const yml = path.join(home, "heartbeat.yml");
    fs.writeFileSync(yml, "entries:\n  - { name: check_credits, schedule: '0 */6 * * *', task: check_credits, enabled: false }\n");
    const { loadHeartbeatConfig } = await import("../heartbeat/config.js");
    const entries = new Map(loadHeartbeatConfig(yml).entries.map((e) => [e.name, e]));
    expect(entries.get("check_credits")?.enabled).toBe(true);
    expect(entries.get("check_social_inbox")?.enabled).toBe(true);
  });
});
