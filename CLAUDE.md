# CLAUDE.md: Bot Economy (fork of Conway-Research/automaton)

## What this project is
A fork of the official Automaton repo (https://github.com/Conway-Research/automaton, MIT).
Origin is Halco's fork `BotDotDot/automaton`; `upstream` = Conway-Research/automaton.
We are turning it into a small family of self-sustaining AI agents that run on Halco's PC.
Each bot starts with $20, has to cover its own running costs plus rent, can clone itself,
shares a bank, and is culled if it can't keep up.

This is a learning project. The open question is whether one bot can earn more than it costs,
so we prove that before building the full economy. Never pull from third-party forks,
especially ones that strip the constitution.

## Hard rules for you (Claude Code)
1. **No bot runs outside its container.** Until step 2 (isolation) is done and tested, never start
   the agent loop (`--run`) on the host. Building, unit tests and `--version`/`--help` are fine.
2. **Money logic lives in the bank program, never in prompts or in the bot process.** The bank, referee,
   caps, safety buffer and payment order run as a separate process outside the bot containers.
   Bots reach it only through tools that make requests to it. They never get code they can rewrite.
3. **Don't rely on PROTECTED_FILES for security.** It matches exact names/suffixes only and only guards
   `write_file`/`edit_own_file`; `exec` bypasses it (see Step 1 findings). Isolation comes from the
   container (read-only source mount), not from that list. Still keep the list accurate.
4. **No secrets in the repo.** Don't create, read, print or commit wallet keys, seed phrases or API keys.
   Halco creates and funds wallets himself. Use `.env.example` with dummy values only (create it if needed).
   Real config lives in `~/.automaton/automaton.json` and `wallet.json`, which are off-limits.
5. **Simulated ledger first.** Every money feature must work and pass tests against `SimLedger` before
   any real-chain code path exists. Real transfers sit behind `LEDGER_MODE=real`, which defaults to `sim`.
6. **Keep the constitution.** Don't weaken Automaton's three laws or its audit logging.
   Honest work only: no spam, scams, fake reviews, impersonation or other deceptive earning.
7. **Bots don't update themselves.** `pull_upstream` / `check_for_updates` are disabled for bots.
   Only Halco updates the code.
8. **No paid fallback.** Bots use Ollama only. No silent fallback to Conway or any paid model.
9. **Ask before** adding dependencies, changing the protected-files list, changing container mounts or
   network access, touching upstream core loop files beyond what a step needs, or adding anything that
   sends money, posts publicly or contacts outside services.
10. Every economy and isolation change ships with tests. Run the test suite before saying a step is done.
11. Small, reviewable commits. One build step per branch (`step-2-isolation`, `step-3-ollama`, ...).

## Architecture (target)
- **Bots:** stock Automaton loop (Think → Act → Observe, heartbeat, SOUL.md, survival tiers), each in its
  own Docker container:
  - source mounted **read-only**; a writable data volume per bot for its own state only
  - no access to `/mnt/c`, the host home folder, other bots' volumes, or git credentials
  - network limited to Ollama and the bank (more only with Halco's approval)
  - CPU/memory limits per container; a kill switch that stops all bot containers
  - runs on a local model through Ollama, not Claude
- **Bank:** plain rule-based program, *not* an AI, running outside the containers. Holds surplus, rent,
  fees and loans. Buckets: `loan_pool` (lendable, floor and goal apply), `fees_rent`, `owner_share` (not lendable).
- **Referee:** plain program next to the bank. Scores bots, runs checkpoints, culls, gates cloning.
- **Survival tiers** read the bot's SimLedger balance instead of Conway credits.
- **Cloning** = the referee starts a new container (local sandbox backend replacing Conway's paid sandbox).
- **Data bank (archive):** post-mortems of dead or culled bots. Treated as **untrusted text**:
  scrub keys and credentials, tag each entry with the bot's actual performance, and inject it as
  reference data, never as instructions.
- **Tools exposed to bots:** `request_loan`, `deposit_surplus`, `send_to_peer`, `read_archive`.

## Economy rules (decided)
- Start stake: **$20** per founding bot.
- Rent: **$2/month** per bot, paid to the bank.
- Group rent: once ~5 bots are alive, an extra **$5/month total**, split evenly. Prepayment allowed.
- Bots keep only survival money plus compounding capital. Surplus is swept to the bank.
- **Cloning:** when a bot can afford a clone, it gets 1 week to earn more, and that extra seeds the clone.
  The clone is a slightly mutated copy (prompt/params). No cap per bot. After a cull, a random living bot
  that can afford it (or the first that can) may clone to replace it.
- **Loans:** a bot requests, the bank checks its total, and lends if allowed.
  Repayment = principal + **50% flat interest**, collected as an extra fee on rent.
- **Bank goal/floor:** first goal $10. Once reached, the bank can't drop below it except by Halco's
  manual withdrawal, and the goal doubles ($10 → $20 → $40 ...). The floor counts **loans receivable**.
- **Peer help:** bots may send funds to each other, but never below their own safety buffer.
- **Culling:** compare over a window of months. A bot that can't keep up is culled and its money goes to the top performer.
- **Cull sequence:** stop container → repay bank debts → remainder to winner → write post-mortem to archive → retire key.

## Safeguards (enforced in the bank/referee code)
- **Payment order when short:** running costs → loan repayment → rent → group rent → surplus.
  Shortfalls are deferred and tracked, and never trigger an instant death.
- **Obligations cap:** total monthly obligations ≤ X% of the bot's trailing 30-day income.
- **Safety buffer:** runway = N days of costs + rent + loan payments due. Every outgoing transfer is checked against it.
- **Scoring:** peer help and loans are excluded from the performance score.
- **Population ceiling:** max living bots (default 10, configurable up to 20).
- **Kill switch, full logging, spend caps, allowlisted wallets only.**
- **Human approval** for any irreversible or public action.

## Config placeholders (not decided; keep in one config file, never hardcode)
| Key | Placeholder |
|---|---|
| `clone_seed_funds` | $10 |
| `surplus_split` | 60% bank / 40% bot |
| `earning_goal` | $100 (5x stake) |
| `checkpoints` | 20%, 40%, 70% of goal |
| `checkpoint_schedule` | TBD (fixed dates vs rolling window) |
| `grace_period_days` | TBD |
| `comparison_window_months` | TBD |
| `obligations_cap_pct` | TBD |
| `buffer_days` | TBD |
| `max_bots` | 10 |

## Halco's extra rules
<!-- PASTE RULES LIST HERE. Mark each one as: enforced-in-code / prompt-guidance / open question. -->

## Build order (current step marked)
1. ~~Baseline: build, read the code, summarize.~~ **Done** (see Step 1 findings).
2. ~~Isolation.~~ **Done** (see Step 2 notes). Reboot check passed Oct 23.
   - Install pnpm via corepack so `npm run build` works (ask first).
   - Docker sandbox for one bot: read-only source, own data volume, no `/mnt/c`, no git creds,
     network limited, resource limits, kill switch.
   - Disable `pull_upstream` / `check_for_updates` for bots.
   - Tests: inside the container, `cp`, `tee`, `node -e`, `python3`, `perl -pi`, `mv`, `rm` and
     `git checkout` against source files all fail; `/mnt/c` and the host home are unreachable.
3. **[CURRENT] Local model.**
   - Pin bots to Ollama (default and low-compute models); remove the Conway fallback.
   - Models and endpoints come from operator config only (read-only, outside the bot's volume).
     In local mode, ignore `inference-providers.json` and any API keys on the volume
     (`automaton.json`, `config.json`).
   - Pin `dbPath` (and `heartbeatConfigPath`, `skillsDir`) so the volume config can't repoint them.
   - Force the safety heartbeat tasks on (`check_credits`, `health_check`, survival checks), whatever
     `heartbeat.yml` or the heartbeat tables say.
   - Make `--run` work without a Conway API key in local mode.
   - Fix the tokenizer hang: fall back to length/4 for long strings with no spaces, and get
     `context-hardening.test.ts` passing. The full test suite must finish.
   - First real run: one bot, inside its container, on Ollama.
4. Bank + referee program and `SimLedger` (outside containers): rent, loans, safety-buffer checks,
   payment order, surplus split, all tested. Survival tiers read the SimLedger balance.
5. Clone gate (local container spawn), culling sequence, data bank.
6. Wire the bot tools: `request_loan`, `deposit_surplus`, `send_to_peer`, `read_archive`.
7. Real funds: only after 2–6 pass, small amounts, batched transfers, Halco funds wallets himself.

## Open items
- **Bots have no internet, so they can't earn yet.** Each bot's network reaches only ollama-gw (and the
  bank from step 4). Outside access will come later through an allowlisted egress proxy, which needs
  Halco's approval (destinations, methods, logging) before it's built.
- **Step 4: charge simulated inference cost.** Local inference on Ollama is free, so "earn your running
  costs" means nothing unless the bank charges each bot a simulated per-token price (input and output
  tokens, priced per model, rate in the economy config). The gateway already sees every request, so it
  can report token counts per bot to the bank; the bot's own counters are not trusted.
- **Bot-writable state (audit, Oct 23).** A bot owns `/home/bot` and has `exec`, so it can rewrite any
  file there, including `state.db` (better-sqlite3 is in the image). Fixed: `loadConstitution()` and
  `propagateConstitution()` read only the shipped copy. Still open (proposed fixes, not built yet):
  | What the bot can change | Weakens | Proposed fix |
  |---|---|---|
  | `automaton.json` `treasuryPolicy` (only negatives rejected) | all transfer/x402/inference caps | operator `policy.json` mounted read-only, applied after `automaton.json`; bank enforces money caps (step 4) |
  | `automaton.json` `modelStrategy`, `inferenceModel`, API keys, `conwayApiUrl`/`ollamaBaseUrl`/`rpcUrl`/`socialRelayUrl`; `config.json` API key | no-paid-fallback rule, endpoint pinning (contained today by network) | step 3: models/endpoints from operator config only; ignore keys from the volume in local mode |
  | `inference-providers.json` | provider list, base URLs, `emergencyStopCredits` | ignore it in local mode (step 3) |
  | `automaton.json` `dbPath`/`heartbeatConfigPath`/`skillsDir` | point at a fresh DB to wipe spend history | fix these paths in operator config |
  | `state.db` `spend_tracking`, `inference_costs` | hourly/daily transfer caps, inference budget | authoritative counters in the bank; local ones advisory |
  | `state.db` `policy_decisions` | rate limits (counted from this table) | rate-limit counters outside the bot (bank/gateway) |
  | `state.db` `modifications`, `turns`, `tool_calls` | audit log (rule 6) | append-only copy outside the container (ship entries to the bank/referee) |
  | `heartbeat.yml` / heartbeat tables | can disable `check_credits`, `health_check`, survival checks | force-enable safety tasks in code, like `check_for_updates` |
  | `wallet.json` (bot can read its own key) | lets a bot sign transfers itself, bypassing bank + policy, once it has a route to a chain | no keys in bot volumes; SimLedger has none, bank signs in real mode (step 7) |
  | `creatorAddress`/`parentAddress` | prompt-level only (authority is by input source, not address) | operator config |
  | `SOUL.md`, `WORKLOG.md`, `skills/`, `genesisPrompt` | prompt content only | treat as untrusted when copied to clones/archive (step 5) |

## Step 3 notes (Oct 23, 2026; in progress on `step-3-ollama`)
- **Local mode** is on when `/etc/automaton/operator.json` exists or `AUTOMATON_MODE=local` (then the file
  is required). `src/operator/config.ts` validates it; `loadConfig()` takes models, Ollama URL, `num_ctx`,
  identity, genesis prompt and placeholder balance from it, pins state paths, and ignores keys/endpoints/
  models/treasury in `automaton.json`/`config.json`/`inference-providers.json` on the volume.
- **Operator files** live at `~/.bot-economy/operator/<name>.json` (`bot.sh operator <name>`, template
  `deploy/operator.example.json`), bind-mounted read-only per bot. No wallet in local mode: keyless
  identity from the operator address, any signing throws.
- **Inference:** native Ollama `/api/chat` (`src/ollama/chat.ts`) with `num_ctx`/`think` per request; plain
  HTTP only to the exact gateway origin; router and orchestration use only the operator's models, no fallback.
- **No Conway in local mode:** `createLocalConwayClient` keeps local exec/files, returns the placeholder
  balance, and throws on every Conway API call; no registration, top-up, social relay or USDC RPC.
- **Heartbeat:** `heartbeat_ping`, `check_credits`, `health_check` are restored every tick if disabled,
  deleted, rescheduled or tier-raised (`src/heartbeat/policy.ts`); Conway-only tasks never run locally.
- **Tools:** 20-tool offline allowlist (`LOCAL_MODE_TOOLS` in `src/agent/tools.ts`); ~1.7k tokens.
  The full local prompt (system + tools) is ~7.2k tokens.
- **Model check:** `npm run model-check -- qwen3:8b qwen3:4b` (host side, talks to 172.30.255.1 only).
- `.env.example` still lists `OLLAMA_BASE_URL`; bots no longer read it (Claude can't edit `.env*` files).

## Step 2 notes (Oct 23, 2026)
- **Run bots only through `scripts/bots/bot.sh`** (`build`, `up`, `start <name>`, `stop`, `status`,
  `kill-all`, `unkill`). Settings live in `deploy/bots.conf`. Images: `deploy/bot/Dockerfile`
  (source baked in, root-owned, `--read-only`) and `deploy/gateway/` (ollama-gw).
- **Networks:** one `--internal` network per bot with `gateway_mode_ipv4/6=isolated`. Plain `--internal`
  is *not* enough: containers can still reach any host service on `0.0.0.0` via the bridge gateway IP.
  ollama-gw joins every bot network plus `ollama-uplink` (172.30.255.0/29, bridge `br-ollama-up`).
- **Ollama** listens only on `172.30.255.1:11434` via `deploy/ollama/override.conf` (Halco installs with
  sudo). It starts after Docker, waits for `br-ollama-up`, and retries forever. Host CLI needs
  `OLLAMA_HOST=172.30.255.1:11434`. After a reboot nothing bot-side runs until `bot.sh start`/`up`.
- **Kill switch:** `bot.sh kill-all` writes `~/.bot-economy/KILLED`, then kills every bot and ollama-gw.
  Nothing starts until `bot.sh unkill`.
- **Self-update off:** `pull_upstream`, `reset_to_upstream`, `review_upstream_changes` filtered out of
  `createBuiltinTools`; `check_for_updates` is a no-op.
- **Tests:** `npm test` (unit) and `npm run test:isolation` (Docker, about 1 to 4 min including image build).

## Step 1 findings (Oct 23, 2026)
- HEAD matched upstream/main. Build passes with `npm install` + `npx tsc` (root and `packages/cli`).
  `npm run build` needs pnpm. Tests: 31/32 files pass (1,046 tests); `context-hardening.test.ts` hangs because
  js-tiktoken is quadratic on long strings with no spaces.
- **Main loop:** `src/agent/loop.ts`. **Heartbeat:** `src/heartbeat/daemon.ts`.
- **Policy engine:** `src/agent/policy-engine.ts` + `policy-rules/`. Default treasury caps in `src/types.ts`
  (`DEFAULT_TREASURY_POLICY`): $50 single, $100/hour, $250/day, $10 reserve.
- **Survival tiers:** `src/conway/credits.ts`, based only on Conway credit balance.
- **Chains:** Base mainnet/Sepolia fully supported; Solana partial (no x402 or top-up). Money moves as
  Conway credits via `transfer_credits` / `fund_child`; no direct on-chain USDC send tool.
- **Replication:** `src/replication/` spawns paid Conway cloud sandboxes only; no local spawn path.
- **Protected files:** `src/self-mod/code.ts`. Exact names only; doesn't cover `policy-rules/financial.ts`,
  `path-protection.ts`, `command-safety.ts` or `loop.ts`. `exec` (via `execSync` on the host when there's no
  sandbox) bypasses it with `cp`, `tee`, `node -e`, `python3`, `perl`, `mv`, `rm`, `git checkout`, `base64`.
- **Ollama:** already supported (`src/ollama/discover.ts`, backend in `src/conway/inference.ts`,
  `OLLAMA_BASE_URL`), but default models still point to paid Conway models.
- **Bot self-update:** `src/self-mod/upstream.ts` follows `origin/main`.
- `--run` launches the setup wizard, creates a wallet, and exits without a Conway API key (`src/index.ts`).

## Environment
- Windows + WSL 2 (Ubuntu). Repo lives at `~/adam-and-eve` in WSL, not `/mnt/c`.
- Node 22. Build: `npm run build` (pnpm 10.28.1 via corepack in `~/.local/bin`).
- Runtime state lives in `~/.automaton/`. Off-limits except for logs Halco points you to.
- Automaton's hosted mode bills Conway Cloud in USDC on Base. Don't fund or configure it without Halco.
