/**
 * ollama-gw: allowlist, fixed upstream, body cap, header filtering.
 * Runs the gateway in-process against a fake upstream that records requests.
 */

import http from "http";
import type { AddressInfo } from "net";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
// @ts-expect-error plain .mjs without type declarations
import { createGateway, parseUpstream } from "../../deploy/gateway/gateway.mjs";

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const MAX_BODY = 1024;
let upstream: http.Server;
let gateway: http.Server;
let gwPort: number;
let seen: Seen[] = [];

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}

function request(
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: gwPort, method, path, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json", "x-upstream-secret": "nope" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  const upPort = await listen(upstream);
  gateway = createGateway({
    upstream: `http://127.0.0.1:${upPort}`,
    maxBodyBytes: MAX_BODY,
    log: () => {},
  });
  gwPort = await listen(gateway);
});

afterAll(async () => {
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => upstream.close(r));
});

beforeEach(() => {
  seen = [];
});

describe("ollama-gw", () => {
  it("forwards allowlisted inference endpoints", async () => {
    for (const [method, path] of [
      ["GET", "/api/tags"],
      ["POST", "/api/chat"],
      ["POST", "/api/generate"],
      ["POST", "/v1/chat/completions"],
    ]) {
      const res = await request(method, path, method === "POST" ? "{}" : undefined);
      expect(res.status, `${method} ${path}`).toBe(200);
    }
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET /api/tags",
      "POST /api/chat",
      "POST /api/generate",
      "POST /v1/chat/completions",
    ]);
  });

  it("refuses model management endpoints without contacting upstream", async () => {
    for (const [method, path] of [
      ["POST", "/api/pull"],
      ["POST", "/api/push"],
      ["POST", "/api/create"],
      ["POST", "/api/copy"],
      ["DELETE", "/api/delete"],
      ["POST", "/api/blobs/sha256:abc"],
    ]) {
      const res = await request(method, path, "{}");
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(seen).toHaveLength(0);
  });

  it("refuses allowlisted paths with the wrong method", async () => {
    expect((await request("DELETE", "/api/tags")).status).toBe(403);
    expect((await request("GET", "/api/chat")).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("does not let path tricks reach other endpoints", async () => {
    for (const path of ["/api/chat/../pull", "/api/%70ull", "//api/pull", "/api/chat/", "/API/CHAT"]) {
      const res = await request("POST", path, "{}");
      expect(res.status, path).toBe(403);
    }
    expect(seen).toHaveLength(0);
  });

  it("drops the query string and keeps the fixed upstream", async () => {
    const res = await request("GET", "/api/tags?target=http://evil.example", undefined, {
      host: "evil.example:80",
    });
    expect(res.status).toBe(200);
    expect(seen[0].url).toBe("/api/tags");
    expect(seen[0].headers.host).toMatch(/^127\.0\.0\.1:\d+$/);
  });

  it("forwards only allowlisted request headers", async () => {
    await request("POST", "/api/chat", "{}", {
      "content-type": "application/json",
      authorization: "Bearer leak",
      cookie: "a=b",
      "x-forwarded-for": "1.2.3.4",
    });
    expect(seen[0].headers["content-type"]).toBe("application/json");
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].headers.cookie).toBeUndefined();
    expect(seen[0].headers["x-forwarded-for"]).toBeUndefined();
  });

  it("returns only safe response headers", async () => {
    const res = await new Promise<http.IncomingMessage>((resolve) =>
      http.get({ hostname: "127.0.0.1", port: gwPort, path: "/api/tags" }, (r) => {
        r.resume();
        resolve(r);
      }),
    );
    expect(res.headers["x-upstream-secret"]).toBeUndefined();
    expect(res.headers["content-type"]).toBe("application/json");
  });

  it("rejects a declared body over the limit", async () => {
    const res = await request("POST", "/api/chat", "x".repeat(MAX_BODY + 1));
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("rejects a chunked body that grows over the limit", async () => {
    const status = await new Promise<number>((resolve) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: gwPort, method: "POST", path: "/api/chat" },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", () => resolve(-1));
      for (let i = 0; i < 4; i++) req.write("y".repeat(MAX_BODY / 2));
      req.end();
    });
    expect(status === 413 || status === -1).toBe(true);
    expect(seen.every((s) => s.body.length <= MAX_BODY)).toBe(true);
  });

  it("accepts a body at the limit", async () => {
    const res = await request("POST", "/api/chat", "z".repeat(MAX_BODY));
    expect(res.status).toBe(200);
  });

  it("answers its own health check", async () => {
    const res = await request("GET", "/healthz");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
    expect(seen).toHaveLength(0);
  });

  describe("upstream config", () => {
    it("accepts a plain http host:port", () => {
      expect(parseUpstream("http://172.30.255.1:11434")).toEqual({
        hostname: "172.30.255.1",
        port: 11434,
      });
    });

    it.each([
      "https://example.com",
      "http://user:pw@host:1",
      "http://host:1/some/path",
      "http://host:1/?x=1",
      "not a url",
    ])("rejects %s", (raw) => {
      expect(() => parseUpstream(raw)).toThrow();
    });
  });
});
