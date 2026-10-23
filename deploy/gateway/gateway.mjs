/**
 * ollama-gw: the only thing a bot can talk to (until the bank exists).
 *
 * Sits on every bot's private network plus the ollama-uplink network and
 * forwards a small allowlist of inference endpoints to one fixed Ollama
 * upstream. The upstream comes from config (OLLAMA_UPSTREAM) at startup and
 * is never taken from the request. Model management endpoints (pull, push,
 * create, copy, delete) are refused, so a bot can't delete models or make
 * Ollama download anything. Request bodies are capped.
 *
 * No dependencies: Node built-ins only.
 */

import http from "node:http";

// method + exact path. Anything else gets 403.
export const ALLOWED_ROUTES = new Set([
  "GET /api/tags",
  "GET /api/version",
  "GET /api/ps",
  "POST /api/show",
  "POST /api/chat",
  "POST /api/generate",
  "POST /api/embed",
  "POST /api/embeddings",
  "GET /v1/models",
  "POST /v1/chat/completions",
  "POST /v1/completions",
  "POST /v1/embeddings",
]);

// Only these request headers are passed upstream.
const FORWARDED_HEADERS = ["content-type", "accept", "content-length"];

export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

export function parseUpstream(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`OLLAMA_UPSTREAM is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:") throw new Error("OLLAMA_UPSTREAM must be http://");
  if (url.username || url.password) throw new Error("OLLAMA_UPSTREAM must not contain credentials");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("OLLAMA_UPSTREAM must be scheme://host:port only");
  }
  return { hostname: url.hostname, port: Number(url.port || 80) };
}

function send(res, status, message) {
  const body = JSON.stringify(status < 400 ? { status: message } : { error: message });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/**
 * @param {{ upstream: string, maxBodyBytes?: number, log?: (line: object) => void }} opts
 */
export function createGateway(opts) {
  const upstream = parseUpstream(opts.upstream);
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const log = opts.log ?? ((line) => console.log(JSON.stringify(line)));

  const server = http.createServer((req, res) => {
    const started = Date.now();
    let path;
    try {
      path = new URL(req.url ?? "", "http://gw").pathname;
    } catch {
      path = "";
    }
    const route = `${req.method} ${path}`;
    const done = (status, bytes = 0) =>
      log({ t: new Date().toISOString(), from: req.socket.remoteAddress, route, status, bytes, ms: Date.now() - started });

    if (path === "/healthz" && req.method === "GET") {
      send(res, 200, "ok");
      return done(200);
    }
    if (!ALLOWED_ROUTES.has(route)) {
      send(res, 403, "endpoint not allowed");
      req.resume();
      return done(403);
    }

    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > maxBodyBytes) {
      send(res, 413, `request body over ${maxBodyBytes} bytes`);
      req.destroy();
      return done(413);
    }

    const headers = {};
    for (const name of FORWARDED_HEADERS) {
      if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    }
    headers.host = `${upstream.hostname}:${upstream.port}`;

    // Path comes from the allowlist match, never the raw request string.
    const upReq = http.request({
      hostname: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path,
      headers,
      timeout: UPSTREAM_TIMEOUT_MS,
    });

    let received = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxBodyBytes && !aborted) {
        aborted = true;
        upReq.destroy();
        send(res, 413, `request body over ${maxBodyBytes} bytes`);
        req.destroy();
        done(413, received);
        return;
      }
      if (!aborted) upReq.write(chunk);
    });
    req.on("end", () => {
      if (!aborted) upReq.end();
    });
    req.on("error", () => upReq.destroy());

    upReq.on("response", (upRes) => {
      const out = {};
      for (const name of ["content-type", "content-length", "transfer-encoding"]) {
        if (upRes.headers[name] !== undefined) out[name] = upRes.headers[name];
      }
      res.writeHead(upRes.statusCode ?? 502, out);
      let bytes = 0;
      upRes.on("data", (chunk) => (bytes += chunk.length));
      upRes.pipe(res);
      upRes.on("end", () => done(upRes.statusCode ?? 502, bytes));
    });
    upReq.on("timeout", () => upReq.destroy(new Error("upstream timeout")));
    upReq.on("error", (err) => {
      if (aborted || res.headersSent) {
        res.destroy();
        return;
      }
      send(res, 502, "upstream unavailable");
      done(502);
      log({ t: new Date().toISOString(), error: err.message });
    });
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 0; // generations can stream for minutes
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const upstream = process.env.OLLAMA_UPSTREAM;
  if (!upstream) {
    console.error("OLLAMA_UPSTREAM is required");
    process.exit(1);
  }
  const maxBodyBytes = Number(process.env.GW_MAX_BODY_BYTES || DEFAULT_MAX_BODY_BYTES);
  const port = Number(process.env.GW_PORT || 11434);
  const server = createGateway({ upstream, maxBodyBytes });
  server.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ t: new Date().toISOString(), msg: "ollama-gw listening", port, upstream, maxBodyBytes }));
  });
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
}
