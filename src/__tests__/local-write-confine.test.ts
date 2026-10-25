/**
 * write_file confinement in local mode: writes go to the bot's own HOME
 * (/home/bot in the container), not the Conway sandbox's /root. Found in the
 * first real run: every write to ~/.automaton/WORKLOG.md was blocked.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { VALID_OPERATOR } from "./fixtures/operator.js";

describe("write_file confinement", () => {
  const savedEnv = { ...process.env };
  let home: string;
  let written: string[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "confine-"));
    process.env.HOME = home;
    written = [];
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    fs.rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  async function writeFile(localMode: boolean, p: string): Promise<string> {
    if (localMode) {
      const op = path.join(home, "operator.json");
      fs.writeFileSync(op, JSON.stringify(VALID_OPERATOR));
      process.env.AUTOMATON_OPERATOR_CONFIG = op;
    } else {
      process.env.AUTOMATON_OPERATOR_CONFIG = path.join(home, "missing.json");
      delete process.env.AUTOMATON_MODE;
    }
    const { createBuiltinTools } = await import("../agent/tools.js");
    const tool = createBuiltinTools("", { localMode }).find((t) => t.name === "write_file")!;
    const ctx = { conway: { writeFile: async (f: string) => void written.push(f) } } as any;
    return tool.execute({ path: p, content: "x" }, ctx);
  }

  it("local mode: ~ and relative paths resolve to HOME", async () => {
    expect(await writeFile(true, "~/.automaton/WORKLOG.md")).toBe(`File written: ${home}/.automaton/WORKLOG.md`);
    expect(await writeFile(true, `${home}/notes.txt`)).toBe(`File written: ${home}/notes.txt`);
    expect(await writeFile(true, "notes.txt")).toBe(`File written: ${home}/notes.txt`);
  });

  it("local mode: paths outside HOME are blocked", async () => {
    for (const p of ["/root/x", "/app/dist/index.js", "/etc/automaton/operator.json", `${home}/../x`, "/tmp/x"]) {
      expect(await writeFile(true, p)).toMatch(/^Blocked/);
    }
    expect(written).toEqual([]);
  });

  it("hosted mode keeps /root", async () => {
    expect(await writeFile(false, "~/.automaton/WORKLOG.md")).toBe("File written: /root/.automaton/WORKLOG.md");
    expect(await writeFile(false, `${home}/x`)).toMatch(/^Blocked/);
  });
});
