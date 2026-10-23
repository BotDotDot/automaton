/**
 * Bots don't update themselves (CLAUDE.md rule 7).
 *
 * The upstream self-update tools must never reach the agent, and the
 * check_for_updates heartbeat task must never wake it or touch git.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, afterEach } from "vitest";
import { createBuiltinTools, SELF_UPDATE_TOOLS } from "../agent/tools.js";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import { loadHeartbeatConfig } from "../heartbeat/config.js";
import { createTestDb } from "./mocks.js";
import type { HeartbeatLegacyContext, TickContext } from "../types.js";

describe("self-update is disabled for bots", () => {
  it("does not expose any upstream update tool", () => {
    const names = createBuiltinTools("test-sandbox-id").map((t) => t.name);
    for (const name of ["pull_upstream", "reset_to_upstream", "review_upstream_changes"]) {
      expect(SELF_UPDATE_TOOLS.has(name)).toBe(true);
      expect(names).not.toContain(name);
    }
  });

  it("still exposes ordinary tools", () => {
    const names = createBuiltinTools("test-sandbox-id").map((t) => t.name);
    expect(names).toContain("exec");
    expect(names).toContain("read_file");
  });

  it("check_for_updates never wakes the agent and records nothing", async () => {
    const db = createTestDb();
    try {
      const taskCtx = { db } as unknown as HeartbeatLegacyContext;
      const result = await BUILTIN_TASKS.check_for_updates({} as TickContext, taskCtx);
      expect(result.shouldWake).toBe(false);
      expect(db.getKV("upstream_status")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  describe("heartbeat config", () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    it("has check_for_updates disabled by default", () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-"));
      const config = loadHeartbeatConfig(path.join(dir, "missing.yml"));
      const entry = config.entries.find((e) => e.name === "check_for_updates");
      expect(entry?.enabled).toBe(false);
    });
  });

  it("system prompt no longer tells the bot to pull upstream", async () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../agent/system-prompt.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/pull_upstream|review_upstream_changes/);
    expect(source).toContain("updated by your operator only");
  });
});
