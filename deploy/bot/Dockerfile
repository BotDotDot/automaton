# Bot image: one Automaton agent, sandboxed.
#
# The source is baked in and owned by root with write bits removed, and the
# container runs with --read-only, so nothing the bot does can change its own
# code. The only writable places are /home/bot (the bot's own data volume)
# and a noexec /tmp. Run it through scripts/bots/bot.sh, which applies the
# network, user, capability and resource settings.
#
# Build from the repo root:  scripts/bots/bot.sh build

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build && CI=true pnpm prune --prod

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
# git: the bot versions its own state directory (~/.automaton) with it.
# python3: kept so the isolation tests show permissions block it, not absence.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --user-group --create-home --home-dir /home/bot --shell /bin/sh bot
COPY --from=build /src /app
RUN chown -R root:root /app && chmod -R a-w /app
LABEL economy.role=bot
USER 10001:10001
WORKDIR /app
ENV HOME=/home/bot NODE_ENV=production
CMD ["node", "dist/index.js", "--run"]
