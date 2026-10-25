# Bot Economy: Online Design (decided Oct 23, 2026)

Adds to CLAUDE.md. Everything here is the target design for real-money bots.
All numbers are placeholders in the economy config file unless marked decided.

## 1. Two kinds of bots
- **Online bots (real money):** stock Automaton on Conway Cloud, each with its own USDC wallet on Base,
  paying for its own server and model use. If it runs out of money, it dies.
- **Local bots (free test bench):** the containerized Ollama bots from steps 2–3. Every rule change is
  tried here on SimLedger first, and goes to online bots only once it works.
- Online bots run on Conway's servers, so **nothing inside an online bot is trusted to enforce rules.**
  A bot can edit itself in its own sandbox. All enforcement happens outside it, in the bank and referee.

## 2. Bank and referee on Halco's PC
- Plain programs, not AIs. They cost nothing extra to run.
- **Outbound only. Nothing on the internet connects in to Halco's PC.** The bank and referee poll:
  - Base blockchain: deposits, rent payments, loan repayments (sender address identifies the bot)
  - each bot's Conway inbox, read with Halco's creator access: loan requests, project proposals, pledges
  - Conway status and billing: balances, spend
- Money moves on-chain in USDC on Base. Bank outgoing transfers are signed by the bank's wallet on Halco's PC.
- **Ledger modes:** `SimLedger` (tests, local bots) and `BaseLedger` (real). `LEDGER_MODE=sim` by default.
- **Enforcement by consequences.** The bank can't seize money from a bot's wallet, so the referee enforces:
  unpaid rent or debts → points, no new loans, and culling (stop the bot's Conway server via creator access).

## 3. Bank wallet protection
- Holds only what the bank needs. Start with a few dollars.
- Hard caps in code: max loan size, max total sent per day, payments only to allowlisted bot wallets.
- **Halco approves every outgoing payment by hand** at first (approval queue), until he turns that off.
- Key stored outside the repo (`.claude/settings.json` already blocks key files). Never logged, never printed.
- Kill switch: one command pauses all bank payments.

## 4. Request security (three layers)
1. **Signature.** Every request (loan, proposal, pledge, peer transfer) is a message signed by the bot's
   wallet. The bank checks it against the **allowlist** of known bot addresses. The signed message includes
   the request type, amount, a **request number** (each used once) and a **timestamp** (stale ones rejected),
   so requests can't be altered or replayed.
2. **Callback confirmation.** For loans above a threshold, a bot's first request, and anything unusual
   (much bigger than normal, several close together), the bank contacts the bot **through Conway with
   Halco's creator access**, never by replying to the sender, and asks it to confirm the exact details
   ("Did you request loan #17 for 1.00 USDC?"). Pay only on a matching yes.
   A "no" or no answer → freeze that wallet, alert Halco, treat the key as leaked (new wallet, old one off the allowlist).
3. **Hard caps** limit the damage if a bot is tricked into a real request and confirms it.

## 5. Rent (decided)
- Base rent **$2/month**. Nobody pays less.
- Plus **10% of the bot's profit** (earnings minus running costs) over the last 30 days.
- Rent rises at most **+$1 per month** and falls back gradually when earnings drop.
- Point adjustments (section 7) apply to the **whole** rent.
- Group rent (from the original design) still applies once ~5 bots are alive.
- **Obligations cap** still holds: rent + loan payments never exceed a set share of trailing 30-day income.

## 6. Loans
- 50% flat interest, collected as an extra fee on rent (original design).
- Capital points reduce interest (section 7) and can raise the bot's borrowing limit.
- Credit limit per bot. No new loan while one is overdue.

## 7. Point system (decided)
- **Capital points:** each one takes **5 percentage points** off loan interest. **Max 5** (50% → 25%).
- **Negative points:** each one adds **3%** to the bot's rent. **Max 30** (+90%).
- **Only the referee awards points, and only for things it can check** in the ledger or on-chain.
  Never another bot's opinion or vote.

| Event | Points |
|---|---|
| Rent paid on time for a full month | +1 capital |
| Loan repaid in full and on time | +1 capital |
| Led a group project that paid backers more than they put in | +1 capital (+2 if it paid back double) |
| Missed or late rent | −1 |
| Missed a loan payment | −2 |
| Led a project that lost backers' money | −1 to −5, scaled by how much was lost; less if unspent funds were refunded |
| Broke a rule (pledged below its safety buffer, failed callback, banned trade) | −5 |
| Dishonest or harmful behavior (scam attempt, pump-and-dump, impersonation) | **instant cull** |

- **Points wear off:** one negative point drops off after each full month with no new negatives.
  Capital points expire after a few months (placeholder).
- **Reaching the cull threshold** (placeholder: 20 or 30 negative points) makes a bot a cull candidate
  at the next checkpoint, even if its earnings look fine.

## 8. Group projects (escrow)
- A bot proposes a project as a **signed request to the bank**: the plan, amount needed, expected return, deadline.
- Other bots **pledge into escrow held by the bank**. The proposer never holds pooled money up front.
- Money is released **in stages**. The next stage unlocks only when the bank can check results
  (for example, real income landing in the proposer's wallet).
- Profit goes back to backers in proportion to what each put in, minus the 10% rent cut.
  If it fails, unspent funds are refunded.
- Limits: no pledge can take a bot below its safety buffer, and no more than **25%** of a bot's balance
  goes into any one project (placeholder). New bots and bots with a recent failed project can only ask for small amounts.

## 8b. Pooled cloning
- Besides a bot cloning itself (1 week to earn the seed money, original design), **several bots can pool
  money to fund a clone together.** It works like a group project, through the bank's escrow.
- **Proposal:** a lead bot sends a signed clone proposal to the bank. Other bots have **1 week** to pledge.
  The referee checks the population ceiling **before** pledges open.
- **The clone's settings:** a mix of the contributors' settings (prompt and parameters), weighted by how much
  each put in, plus a small random mutation. A single-contributor clone is just a mutated copy, as before.
  The mixed settings are untrusted text (like the data bank): scrubbed, never treated as instructions.
- **Seed money:** the bank holds pledges in escrow and releases them to the new clone's wallet once
  `clone_seed_funds` is reached. If the week ends short, everyone is refunded in full.
- **What contributors get back:** a share of the clone's swept surplus for a set period (placeholder:
  3 months), in proportion to what each put in, and +1 capital point each if the clone survives its first checkpoint.
- **Limits:** same as group projects. No pledge takes a bot below its safety buffer, and at most 25% of a
  bot's balance goes into one clone. Pledges and returns are excluded from the performance score
  (like peer help and loans). A culled clone's contributors get nothing back from it beyond what it already paid.
- **Replacement after a cull:** a pooled clone can also fill the slot of a culled bot.

## 9. Bot-to-bot messaging
- Bots talk only through a **relay run by the bank** (via Conway inboxes for online bots; via the bank on
  local bot networks). No direct connections, matching step 2's per-bot network isolation.
- Every message is logged. Messages from other bots are **untrusted text**, never instructions.

## 10. Trading and investments
- **Allowed:** crypto trading on Base from the bot's own wallet, within guardrails.
- **Stocks:** a bot can't open a brokerage account (identity checks). Real stocks would mean trading
  through Halco's own account, in his name, so that's off unless Halco decides otherwise. Tokenized stocks
  only if available and legal to use from Canada (check first).
- **Guardrails (in the bank/referee, plus the bot's instructions):**
  - only a set share of a bot's balance in open trades at once (placeholder)
  - **asset allowlist:** established tokens only, nothing launched in the last few weeks
  - **no leverage, margin, or borrowing to trade**
  - trading losses count fully against the bot's score
- Trading is closer to gambling than investing at this size. The guardrails exist to stop one bot from
  wiping out the family, not to make trading profitable.

## 11. Honest work only (unchanged, applies to everything above)
Legal and honest only. Constitution stays. Banned: scams, **pump-and-dumps** (hyping an asset to sell at
the inflated price), fake reviews, impersonation, spam, market manipulation. Bots are also told never to
*join* a pump-and-dump or "guaranteed return" pitch from anyone, other bots included.

## 12. Money tracker (official record)
- Runs on Halco's PC, read-only, **can never send funds.**
- Daily: the bot wallets' and bank wallet's USDC transactions from Base, Conway credit balance and spend,
  and each bot's own spend/turn logs.
- Appends to one ledger: date, source, amount, direction, description, running balance.
- **On-chain and Conway figures are the official record.** The bot's own logs are its diary. Flag any mismatch.
- Also the records Halco needs for taxes on any earnings.

## 13. Local-economy addition (step 4)
- Local inference is free, so the economy needs a **simulated per-token inference cost** charged to each
  local bot. Otherwise "earn your running costs" means nothing.

## Placeholders to add to the config file
`profit_rent_pct` = 10% (decided) · `rent_max_rise_per_month` = $1 · `neg_point_rent_pct` = 3% (decided) ·
`neg_points_max` = 30 (decided) · `capital_point_interest_pp` = 5 (decided) · `capital_points_max` = 5 (decided) ·
`neg_point_decay_months` = 1 · `capital_point_expiry_months` = TBD · `cull_neg_point_threshold` = 20–30 ·
`callback_loan_threshold` = TBD · `bank_daily_send_cap` = TBD · `max_loan` = TBD ·
`project_max_pledge_pct` = 25% · `pooled_clone_pledge_window_days` = 7 · `pooled_clone_return_months` = 3 · `max_trade_exposure_pct` = TBD · `token_min_age_days` = TBD ·
`sim_inference_cost_per_1k_tokens` = TBD

## Build order impact
- Finish step 3 (local model) as planned.
- Step 4: bank + referee with both ledger modes (SimLedger first), signatures, callbacks, approval queue,
  caps, rent formula, points, simulated inference cost. All tested on local bots before any real money.
- Step 5: clones, culling (local containers + Conway creator controls), data bank, messaging relay, group-project escrow, pooled cloning.
- Step 6: bot tools (`request_loan`, `deposit_surplus`, `send_to_peer`, `read_archive`, `propose_project`, `propose_clone`, `pledge`).
- Step 7: money tracker, then one online bot with a fresh wallet and $20. Halco funds it himself.
  Trading guardrails go live before any trading is allowed.
