/**
 * deploy/ollama/override.conf must match deploy/bots.conf and keep the
 * boot-order guarantees: start after Docker, wait for the uplink bridge,
 * retry forever.
 */

import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

const REPO = path.resolve(__dirname, "../..");
const override = fs.readFileSync(path.join(REPO, "deploy/ollama/override.conf"), "utf-8");
const botsConf = fs.readFileSync(path.join(REPO, "deploy/bots.conf"), "utf-8");

function confValue(key: string): string {
  const m = botsConf.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!m) throw new Error(`${key} missing from bots.conf`);
  return m[1].trim();
}

const directives = override
  .split("\n")
  .filter((l) => l && !l.startsWith("#") && l.includes("="));

describe("ollama systemd override", () => {
  const gateway = confValue("UPLINK_GATEWAY");
  const bridge = confValue("UPLINK_BRIDGE");

  it("binds Ollama to the uplink gateway from bots.conf", () => {
    expect(directives).toContain(`Environment="OLLAMA_HOST=${gateway}:11434"`);
    expect(confValue("OLLAMA_UPSTREAM")).toBe(`http://${gateway}:11434`);
  });

  it("never binds to all interfaces", () => {
    expect(override).not.toMatch(/OLLAMA_HOST=(0\.0\.0\.0|\[?::\]?)/);
  });

  it("starts after Docker", () => {
    expect(directives).toContain("After=docker.service");
    expect(directives).toContain("Wants=docker.service");
  });

  it("waits for the uplink bridge address before starting", () => {
    const pre = directives.find((d) => d.startsWith("ExecStartPre="));
    expect(pre).toBeDefined();
    expect(pre).toContain(`dev ${bridge}`);
    expect(pre).toContain(` ${gateway}/`);
  });

  it("sets the VRAM settings for an 8 GB card", () => {
    expect(directives).toContain('Environment="OLLAMA_FLASH_ATTENTION=1"');
    expect(directives).toContain('Environment="OLLAMA_KV_CACHE_TYPE=q8_0"');
    expect(directives).toContain('Environment="OLLAMA_MAX_LOADED_MODELS=1"');
  });

  it("retries forever", () => {
    expect(directives).toContain("Restart=always");
    expect(directives).toContain("StartLimitIntervalSec=0");
  });
});
