/**
 * Local mode exposes only the offline tool allowlist.
 */

import { describe, it, expect } from "vitest";
import { createBuiltinTools, LOCAL_MODE_TOOLS, SELF_UPDATE_TOOLS } from "../agent/tools.js";

describe("local tool allowlist", () => {
  const local = createBuiltinTools("", { localMode: true });
  const names = local.map((t) => t.name);

  it("exposes exactly the allowlist", () => {
    expect([...names].sort()).toEqual([...LOCAL_MODE_TOOLS].sort());
  });

  it("every allowlisted name is a real tool", () => {
    const all = new Set(createBuiltinTools("").map((t) => t.name));
    for (const name of LOCAL_MODE_TOOLS) expect(all.has(name), name).toBe(true);
  });

  it("has no Conway, financial, replication, registry or orchestration tools", () => {
    const banned = new Set(["conway", "financial", "replication", "registry", "orchestration"]);
    // check_credits is categorised "conway" but in local mode reads the
    // operator's placeholder balance through the local Conway client.
    for (const t of local.filter((x) => x.name !== "check_credits")) {
      expect(banned.has(t.category), `${t.name} (${t.category})`).toBe(false);
    }
  });

  it("excludes operator-owned and self-update tools", () => {
    for (const name of [
      "update_genesis_prompt", "modify_heartbeat", "switch_model", "edit_own_file",
      "install_npm_package", "install_mcp_server", "install_skill", "create_skill",
      "transfer_credits", "x402_fetch", "spawn_child", "git_push", "git_clone",
      ...SELF_UPDATE_TOOLS,
    ]) {
      expect(names, name).not.toContain(name);
    }
  });

  it("non-local tool list is unchanged apart from the self-update filter", () => {
    expect(createBuiltinTools("").length).toBeGreaterThan(local.length);
    expect(createBuiltinTools("").map((t) => t.name)).toContain("transfer_credits");
  });
});
