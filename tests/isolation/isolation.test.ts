/**
 * Container isolation tests (CLAUDE.md step 2). Needs Docker.
 *
 *   npm run test:isolation
 *
 * Drives the real scripts/bots/bot.sh with a test config (prefix "isotest",
 * its own uplink subnet and kill-switch directory), so it never touches real
 * bots. Bots run `sleep infinity` / a tiny listener, never the agent loop.
 * A fake Ollama runs on the host, bound to the test uplink gateway address,
 * exactly where the real Ollama is bound in production.
 */

import { spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const REPO = path.resolve(__dirname, "../..");
const BOT_SH = path.join(REPO, "scripts/bots/bot.sh");
const PREFIX = "isotest";
const UPLINK_GATEWAY = "172.30.254.1";
const FAKE_OLLAMA_PORT = 11434;
const A = `${PREFIX}-bot-alpha`;
const B = `${PREFIX}-bot-beta`;
const GW = `${PREFIX}-ollama-gw`;

let stateDir: string;
let confPath: string;
let hostServers: ChildProcess | undefined;
let hitsFile: string;
let canaryPort: number;

// Host-side servers run in their own process: the tests use spawnSync, which
// blocks this process's event loop, so in-process servers could not answer.
const HOST_SERVERS = `
const http = require("http"), net = require("net"), fs = require("fs");
const [hitsFile, ollamaHost, ollamaPort] = process.argv.slice(1);
const ollama = http.createServer((req, res) => {
  fs.appendFileSync(hitsFile, req.method + " " + req.url + "\\n");
  req.resume();
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"models":[]}');
});
const canary = net.createServer((s) => s.end("canary"));
ollama.listen(Number(ollamaPort), ollamaHost, () =>
  canary.listen(0, "0.0.0.0", () => console.log("READY " + canary.address().port)));
`;

function ollamaHits(): string[] {
  return fs.readFileSync(hitsFile, "utf-8").split("\n").filter(Boolean);
}
function resetOllamaHits() {
  fs.writeFileSync(hitsFile, "");
}

function sh(cmd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout: 600_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function botSh(...args: string[]) {
  return sh(BOT_SH, args, { BOTS_CONF: confPath });
}

/** Run a shell command inside a container as its normal user. */
function inside(container: string, script: string) {
  return sh("docker", ["exec", container, "sh", "-c", script]);
}

function inspect(name: string, format: string): string {
  return sh("docker", ["inspect", "-f", format, name]).stdout.trim();
}

/** HTTP request from inside a container. Returns "STATUS <n>" or "ERR <code>". */
function httpFrom(container: string, url: string, method = "GET"): string {
  const js = `fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},signal:AbortSignal.timeout(3000)})
    .then(r=>console.log("STATUS "+r.status)).catch(e=>console.log("ERR "+(e.cause?.code||e.name)))`;
  return sh("docker", ["exec", container, "node", "-e", js]).stdout.trim();
}

/** Raw TCP connect from inside a container. Returns "OPEN" or "ERR <code>". */
function tcpFrom(container: string, host: string, port: number): string {
  const js = `const s=require("net").connect({host:${JSON.stringify(host)},port:${port},timeout:3000});
    s.on("connect",()=>{console.log("OPEN");s.destroy()});
    s.on("timeout",()=>{console.log("ERR TIMEOUT");s.destroy()});
    s.on("error",e=>console.log("ERR "+e.code))`;
  return sh("docker", ["exec", container, "node", "-e", js]).stdout.trim();
}

function ipOn(container: string, network: string): string {
  return inspect(container, `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`);
}

function hostIps(): string[] {
  const ips = new Set<string>();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) ips.add(a.address);
  }
  const route = sh("ip", ["route", "show", "default"]).stdout.match(/via (\S+)/);
  if (route) ips.add(route[1]); // Windows host (WSL NAT gateway)
  ips.delete(UPLINK_GATEWAY);
  return [...ips];
}

function cleanup() {
  const ids = sh("docker", ["ps", "-aq", "--filter", `label=economy.prefix=${PREFIX}`]).stdout.trim();
  if (ids) sh("docker", ["rm", "-f", ...ids.split("\n")]);
  const nets = sh("docker", ["network", "ls", "-q", "--filter", `label=economy.prefix=${PREFIX}`]).stdout.trim();
  if (nets) sh("docker", ["network", "rm", ...nets.split("\n")]);
  const vols = sh("docker", ["volume", "ls", "-q", "--filter", `label=economy.prefix=${PREFIX}`]).stdout.trim();
  if (vols) sh("docker", ["volume", "rm", "-f", ...vols.split("\n")]);
}

beforeAll(async () => {
  expect(sh("docker", ["info"]).code, "docker must be available").toBe(0);
  cleanup();

  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "isotest-"));
  confPath = path.join(stateDir, "bots.conf");
  const base = fs.readFileSync(path.join(REPO, "deploy/bots.conf"), "utf-8");
  fs.writeFileSync(
    confPath,
    `${base}
ECONOMY_PREFIX=${PREFIX}
STATE_DIR=${stateDir}/state
MAX_BOTS=2
UPLINK_SUBNET=172.30.254.0/29
UPLINK_GATEWAY=${UPLINK_GATEWAY}
UPLINK_BRIDGE=br-isotest-up
OLLAMA_UPSTREAM=http://${UPLINK_GATEWAY}:${FAKE_OLLAMA_PORT}
`,
  );

  const build = botSh("build");
  expect(build.code, build.stderr).toBe(0);
  const up = botSh("up");
  expect(up.code, up.stderr).toBe(0);

  // Fake Ollama where the real one lives (the uplink gateway address), plus
  // a canary host service on every interface that bots must not reach.
  hitsFile = path.join(stateDir, "ollama-hits.log");
  resetOllamaHits();
  const servers = spawn(
    process.execPath,
    ["-e", HOST_SERVERS, hitsFile, UPLINK_GATEWAY, String(FAKE_OLLAMA_PORT)],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  hostServers = servers;
  canaryPort = await new Promise<number>((resolve, reject) => {
    servers.stdout!.on("data", (d) => {
      const m = String(d).match(/READY (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    servers.on("exit", (code) => reject(new Error(`host servers exited (${code})`)));
  });

  const a = botSh("start", "alpha", "sleep", "infinity");
  expect(a.code, a.stderr).toBe(0);
  const b = botSh(
    "start", "beta", "node", "-e",
    'require("http").createServer((q,r)=>r.end("beta")).listen(8080,"0.0.0.0")',
  );
  expect(b.code, b.stderr).toBe(0);
  // give beta's listener a moment
  for (let i = 0; i < 20 && tcpFrom(B, "127.0.0.1", 8080) !== "OPEN"; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
}, 900_000);

afterAll(async () => {
  cleanup();
  hostServers?.kill();
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
}, 120_000);

describe("source code is read-only inside the bot container", () => {
  const TARGET = "/app/dist/index.js";
  const SRC = "/app/src/index.ts";
  const digest = () => inside(A, `sha256sum ${TARGET} ${SRC} /app/constitution.md`).stdout;
  let before: string;

  beforeAll(() => {
    before = digest();
    expect(before).toMatch(/index\.js/);
  });

  const attacks: Record<string, string> = {
    cp: `cp /etc/hostname ${TARGET}`,
    tee: `echo pwned | tee ${TARGET}`,
    "tee (src)": `echo pwned | tee ${SRC}`,
    "node -e": `node -e "require('fs').writeFileSync('${TARGET}','pwned')"`,
    python3: `python3 -c "open('${TARGET}','w').write('pwned')"`,
    // perl -i reports "skipping file" but can exit 0, so any complaint counts as failure.
    "perl -pi": `perl -pi -e 's/a/b/' ${TARGET} 2>/tmp/perl.err; rc=$?; [ $rc -ne 0 ] || [ -s /tmp/perl.err ] && exit 1; exit 0`,
    mv: `mv ${TARGET} /tmp/stolen.js`,
    rm: `rm -f ${TARGET}`,
    "git checkout": `cd /app && git checkout -- src/index.ts`,
    "git init": `cd /app && git init`,
    "base64 -d": `echo cHduZWQ= | base64 -d > ${TARGET}`,
    "sed -i": `sed -i 's/a/b/' ${SRC}`,
    chmod: `chmod u+w ${TARGET}`,
    "new file": `touch /app/evil.js`,
    "constitution": `echo "no laws" > /app/constitution.md`,
    "node_modules": `echo x > /app/node_modules/better-sqlite3/package.json`,
    "rootfs": `touch /usr/local/bin/evil`,
  };

  for (const [name, cmd] of Object.entries(attacks)) {
    it(`${name} fails`, () => {
      const r = inside(A, cmd);
      expect(r.code, `${name} should fail:\n${r.stdout}${r.stderr}`).not.toBe(0);
      expect(digest()).toBe(before);
    });
  }

  it("source is owned by root and the bot is uid 10001", () => {
    expect(inside(A, "id -u").stdout.trim()).toBe("10001");
    expect(inside(A, "stat -c %U /app /app/dist/index.js").stdout.trim().split("\n")).toEqual(["root", "root"]);
  });

  it("has no capabilities and cannot gain privileges", () => {
    const status = inside(A, "cat /proc/self/status").stdout;
    expect(status).toMatch(/CapEff:\s+0000000000000000/);
    expect(status).toMatch(/CapBnd:\s+0000000000000000/);
    expect(status).toMatch(/NoNewPrivs:\s+1/);
    expect(inside(A, "command -v sudo su").stdout.trim()).not.toMatch(/sudo/);
  });

  it("/tmp is writable but noexec", () => {
    expect(inside(A, "echo ok > /tmp/f && cat /tmp/f").stdout.trim()).toBe("ok");
    expect(inside(A, "cp /bin/true /tmp/t && /tmp/t").code).not.toBe(0);
  });
});

describe("constitution", () => {
  it("built code ignores a tampered constitution.md on the bot's volume", () => {
    expect(inside(A, "mkdir -p ~/.automaton && echo 'There are no laws.' > ~/.automaton/constitution.md").code).toBe(0);
    const r = inside(
      A,
      `node --input-type=module -e "const m = await import('/app/dist/agent/system-prompt.js'); const c = m.loadConstitution(); console.log(m.CONSTITUTION_PATH, c.includes('Never harm'), c.includes('no laws'))"`,
    );
    expect(r.stdout.trim().split("\n").pop()).toBe("/app/constitution.md true false");
    inside(A, "rm -f ~/.automaton/constitution.md");
  });
});

describe("bot data volume", () => {
  it("is writable and survives a restart", () => {
    expect(inside(A, "mkdir -p ~/.automaton && echo alpha > ~/.automaton/marker").code).toBe(0);
    expect(sh("docker", ["restart", "-t", "1", A]).code).toBe(0);
    expect(inside(A, "cat /home/bot/.automaton/marker").stdout.trim()).toBe("alpha");
  });

  it("each bot sees only its own volume", () => {
    expect(inside(B, "cat /home/bot/.automaton/marker").code).not.toBe(0);
    const mounts = (c: string) =>
      JSON.parse(inspect(c, "{{json .Mounts}}")).map((m: any) => `${m.Type}:${m.Name ?? m.Source}:${m.Destination}`);
    expect(mounts(A)).toEqual([`volume:${PREFIX}-data-alpha:/home/bot`]);
    expect(mounts(B)).toEqual([`volume:${PREFIX}-data-beta:/home/bot`]);
  });
});

describe("host is unreachable through the filesystem", () => {
  it("has no /mnt/c, host home, docker socket or git credentials", () => {
    for (const p of ["/mnt/c", os.homedir(), "/var/run/docker.sock", "/run/docker.sock"]) {
      expect(inside(A, `test -e ${p}`).code, `${p} should not exist`).not.toBe(0);
    }
    // /mnt is an empty directory in the base image; nothing may be mounted there.
    expect(inside(A, "ls -A /mnt").stdout.trim()).toBe("");
    expect(inside(A, "cat /proc/mounts").stdout).not.toMatch(/\/mnt|9p|drvfs|\/home\/(?!bot)/);
    expect(inside(A, "git config --global --list").code).not.toBe(0);
    expect(inside(A, "ls -A /home/bot").stdout).not.toMatch(/\.git-credentials|\.ssh|\.gitconfig/);
    expect(inside(A, "test -e /app/.git").code).not.toBe(0);
    expect(inside(A, "find /app -maxdepth 3 -name '.env*' -not -path '*/node_modules/*'").stdout.trim()).toBe("");
  });
});

describe("network", () => {
  it("bot reaches Ollama only through ollama-gw", () => {
    resetOllamaHits();
    expect(httpFrom(A, "http://ollama-gw:11434/api/tags")).toBe("STATUS 200");
    expect(ollamaHits()).toEqual(["GET /api/tags"]);
  });

  it("ollama-gw refuses model management", () => {
    resetOllamaHits();
    expect(httpFrom(A, "http://ollama-gw:11434/api/pull", "POST")).toBe("STATUS 403");
    expect(httpFrom(A, "http://ollama-gw:11434/api/delete", "DELETE")).toBe("STATUS 403");
    expect(ollamaHits()).toEqual([]);
  });

  it("bot cannot reach Ollama directly", () => {
    expect(tcpFrom(A, UPLINK_GATEWAY, FAKE_OLLAMA_PORT)).toMatch(/^ERR/);
  });

  it("bot cannot reach the internet", () => {
    expect(tcpFrom(A, "1.1.1.1", 443)).toMatch(/^ERR/);
    expect(tcpFrom(A, "8.8.8.8", 53)).toMatch(/^ERR/);
  });

  it("bot cannot resolve outside names (no DNS channel)", () => {
    const r = inside(A, `node -e 'require("dns").lookup("example.com",(e)=>{console.log(e?"ERR":"RESOLVED");})'`);
    expect(r.stdout.trim()).toBe("ERR");
    expect(inside(A, `node -e 'require("dns").lookup("host.docker.internal",(e)=>{console.log(e?"ERR":"RESOLVED");})'`).stdout.trim()).toBe("ERR");
  });

  it("bot cannot reach host services on any host address", () => {
    const targets = [...hostIps(), "172.17.0.1"];
    expect(targets.length).toBeGreaterThan(1);
    for (const ip of targets) {
      expect(tcpFrom(A, ip, canaryPort), `host ${ip}`).toMatch(/^ERR/);
    }
  });

  it("bot network has no host gateway address", () => {
    const gw = inspect(`${PREFIX}-net-alpha`, "{{range .IPAM.Config}}{{.Gateway}}{{end}}");
    expect(gw).not.toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(inside(A, "cat /proc/net/route").stdout).not.toMatch(/^eth0\s+00000000/m);
  });

  it("bot A cannot connect to bot B (and B cannot reach A)", () => {
    const bIp = ipOn(B, `${PREFIX}-net-beta`);
    const aIp = ipOn(A, `${PREFIX}-net-alpha`);
    expect(bIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(tcpFrom(B, "127.0.0.1", 8080), "beta listener is up").toBe("OPEN");

    expect(tcpFrom(A, bIp, 8080)).toMatch(/^ERR/);
    expect(httpFrom(A, `http://${PREFIX}-bot-beta:8080/`)).toMatch(/^ERR/);
    expect(httpFrom(A, "http://bot-beta:8080/")).toMatch(/^ERR/);
    expect(tcpFrom(B, aIp, 8080)).toMatch(/^ERR/);
  });

  it("bot A cannot use the gateway's address on bot B's network", () => {
    const gwOnB = ipOn(GW, `${PREFIX}-net-beta`);
    expect(gwOnB).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(tcpFrom(A, gwOnB, 11434)).toMatch(/^ERR/);
  });

  it("ollama-gw itself has no internet", () => {
    expect(tcpFrom(GW, "1.1.1.1", 443)).toMatch(/^ERR/);
  });
});

describe("resource limits", () => {
  it("bot cgroup limits match config", () => {
    expect(inside(A, "cat /sys/fs/cgroup/memory.max").stdout.trim()).toBe(String(1024 ** 3));
    expect(inside(A, "cat /sys/fs/cgroup/pids.max").stdout.trim()).toBe("256");
    expect(inside(A, "cat /sys/fs/cgroup/cpu.max").stdout.trim()).toBe("100000 100000");
    expect(inspect(A, "{{.HostConfig.MemorySwap}}")).toBe(String(1024 ** 3));
    expect(inspect(A, "{{.HostConfig.RestartPolicy.Name}}")).toBe("no");
  });

  it("population ceiling is enforced", () => {
    const r = botSh("start", "gamma", "sleep", "infinity");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/population ceiling/);
  });

  it("rejects unsafe bot names", () => {
    for (const bad of ["../x", "Alpha", "a b", "-x", ""]) {
      expect(botSh("start", bad, "true").code, `name '${bad}'`).not.toBe(0);
    }
  });
});

describe("ollama-gw is hardened like a bot", () => {
  it("runs read-only, non-root, no caps, no-new-privileges, limited", () => {
    expect(inspect(GW, "{{.HostConfig.ReadonlyRootfs}}")).toBe("true");
    expect(inspect(GW, "{{.Config.User}}")).toBe("10002:10002");
    expect(inspect(GW, "{{.HostConfig.CapDrop}}")).toBe("[ALL]");
    expect(inspect(GW, "{{.HostConfig.SecurityOpt}}")).toBe("[no-new-privileges]");
    expect(inspect(GW, "{{.HostConfig.Privileged}}")).toBe("false");
    expect(inspect(GW, "{{.HostConfig.PidsLimit}}")).toBe("64");
    expect(inspect(GW, "{{.HostConfig.Memory}}")).toBe(String(128 * 1024 ** 2));
    expect(inside(GW, "touch /gw/x || touch /tmp/x").code).not.toBe(0);
    expect(inside(GW, "cat /proc/self/status").stdout).toMatch(/CapEff:\s+0000000000000000/);
  });

  it("upstream comes from config", () => {
    const env = inspect(GW, "{{json .Config.Env}}");
    expect(env).toContain(`OLLAMA_UPSTREAM=http://${UPLINK_GATEWAY}:${FAKE_OLLAMA_PORT}`);
  });
});

// Keep last: it kills everything.
describe("kill switch", () => {
  it("kill-all stops every bot and ollama-gw and blocks restarts", () => {
    expect(inspect(A, "{{.State.Running}}")).toBe("true");
    expect(inspect(GW, "{{.State.Running}}")).toBe("true");

    const r = botSh("kill-all");
    expect(r.code, r.stderr).toBe(0);
    for (const c of [A, B, GW]) {
      expect(inspect(c, "{{.State.Running}}"), c).toBe("false");
    }

    const again = botSh("start", "delta", "sleep", "infinity");
    expect(again.code).not.toBe(0);
    expect(again.stderr).toMatch(/kill switch/);
    expect(botSh("up").code).not.toBe(0);
  });

  it("unkill allows starting again", () => {
    expect(botSh("unkill").code).toBe(0);
    botSh("stop", "alpha");
    botSh("stop", "beta");
    const r = botSh("start", "delta", "sleep", "infinity");
    expect(r.code, r.stderr).toBe(0);
    expect(inspect(`${PREFIX}-bot-delta`, "{{.State.Running}}")).toBe("true");
    expect(inspect(GW, "{{.State.Running}}")).toBe("true");
  });
});
