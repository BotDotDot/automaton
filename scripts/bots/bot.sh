#!/usr/bin/env bash
# Bot container control and kill switch.
#
#   bot.sh build                 build the bot and ollama-gw images
#   bot.sh up                    create the uplink network and start ollama-gw
#   bot.sh operator <name>       create the bot's operator file from the template
#   bot.sh start <name> [cmd..]  start a bot in its own network (cmd overrides --run)
#   bot.sh stop <name>           stop a bot and remove its network (keeps its data volume)
#   bot.sh status                list bot and gateway containers
#   bot.sh kill-all              KILL SWITCH: kill every bot and ollama-gw, block restarts
#   bot.sh unkill                clear the kill switch (Halco only)
#
# Settings come from deploy/bots.conf (or $BOTS_CONF).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=../../deploy/bots.conf
source "${BOTS_CONF:-$REPO_ROOT/deploy/bots.conf}"

P="$ECONOMY_PREFIX"
UPLINK_NET="$P-ollama-uplink"
GW="$P-ollama-gw"
KILL_FLAG="$STATE_DIR/KILLED"
OPERATOR_DIR="$STATE_DIR/operator"
OPERATOR_TEMPLATE="$REPO_ROOT/deploy/operator.example.json"

die() { echo "bot.sh: $*" >&2; exit 1; }
bot_container() { echo "$P-bot-$1"; }
bot_net() { echo "$P-net-$1"; }
bot_volume() { echo "$P-data-$1"; }
operator_file() { echo "$OPERATOR_DIR/$1.json"; }

valid_name() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || die "invalid bot name '$1' (lowercase letters, digits, dashes; max 31)"
}

refuse_if_killed() {
  [[ ! -e "$KILL_FLAG" ]] || die "kill switch is set ($KILL_FLAG). Run 'bot.sh unkill' to clear it."
}

exists() { docker "$1" inspect "$2" >/dev/null 2>&1; }
running() { [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" == "true" ]]; }

cmd_build() {
  docker build -f "$REPO_ROOT/deploy/bot/Dockerfile" -t "$BOT_IMAGE" "$REPO_ROOT"
  docker build -t "$GW_IMAGE" "$REPO_ROOT/deploy/gateway"
}

cmd_up() {
  refuse_if_killed
  if ! exists network "$UPLINK_NET"; then
    # internal: the gateway gets no internet. Default gateway mode keeps the
    # host address on the bridge, which is where Ollama listens.
    docker network create --internal \
      --subnet "$UPLINK_SUBNET" --gateway "$UPLINK_GATEWAY" \
      -o com.docker.network.bridge.name="$UPLINK_BRIDGE" \
      --label economy.prefix="$P" --label economy.role=uplink \
      "$UPLINK_NET" >/dev/null
  fi

  if exists container "$GW" && ! running "$GW"; then
    docker rm "$GW" >/dev/null
  fi
  if ! exists container "$GW"; then
    docker run -d --name "$GW" \
      --network "$UPLINK_NET" \
      --read-only \
      --user 10002:10002 \
      --cap-drop ALL \
      --security-opt no-new-privileges \
      --cpus "$GW_CPUS" --memory "$GW_MEMORY" --memory-swap "$GW_MEMORY" \
      --pids-limit "$GW_PIDS" \
      --restart no \
      --label economy.prefix="$P" --label economy.role=gateway \
      -e OLLAMA_UPSTREAM="$OLLAMA_UPSTREAM" \
      -e GW_MAX_BODY_BYTES="$GW_MAX_BODY_BYTES" \
      "$GW_IMAGE" >/dev/null
  fi
  echo "ollama-gw up ($GW -> $OLLAMA_UPSTREAM)"
}

cmd_operator() {
  local name="${1:-}"; [[ -n "$name" ]] || die "usage: bot.sh operator <name>"
  valid_name "$name"
  local f; f="$(operator_file "$name")"
  [[ -e "$f" ]] && die "$f already exists (edit it by hand)"
  mkdir -p "$OPERATOR_DIR"
  chmod 755 "$STATE_DIR" "$OPERATOR_DIR"
  # Placeholder identity derived from the name. Not a wallet: no key exists.
  local addr
  addr="0x$(printf '%s' "economy-bot:$name" | sha256sum | cut -c1-40)"
  sed -e "s/__BOT_ID__/$name/" -e "s/__IDENTITY_ADDRESS__/$addr/" "$OPERATOR_TEMPLATE" > "$f"
  chmod 644 "$f"
  echo "wrote $f"
}

cmd_start() {
  local name="${1:-}"; [[ -n "$name" ]] || die "usage: bot.sh start <name> [cmd...]"
  shift
  valid_name "$name"
  refuse_if_killed

  local c net vol
  c="$(bot_container "$name")"; net="$(bot_net "$name")"; vol="$(bot_volume "$name")"
  exists container "$c" && die "$c already exists"
  local op; op="$(operator_file "$name")"
  [[ -f "$op" ]] || die "no operator file $op (run 'bot.sh operator $name' first)"

  local alive
  alive="$(docker ps -q --filter label=economy.prefix="$P" --filter label=economy.role=bot | wc -l)"
  (( alive < MAX_BOTS )) || die "population ceiling reached ($alive/$MAX_BOTS)"

  cmd_up >/dev/null

  if ! exists network "$net"; then
    # One private network per bot. internal = no route out; isolated gateway
    # mode = no host address on the bridge, so host services are unreachable.
    docker network create --internal \
      -o com.docker.network.bridge.gateway_mode_ipv4=isolated \
      -o com.docker.network.bridge.gateway_mode_ipv6=isolated \
      --label economy.prefix="$P" --label economy.role=botnet --label economy.bot="$name" \
      "$net" >/dev/null
  fi
  if ! docker inspect -f '{{json .NetworkSettings.Networks}}' "$GW" | grep -q "\"$net\""; then
    docker network connect --alias ollama-gw "$net" "$GW"
  fi

  exists volume "$vol" || docker volume create \
    --label economy.prefix="$P" --label economy.bot="$name" "$vol" >/dev/null

  docker run -d --name "$c" --hostname "bot-$name" \
    --network "$net" \
    --read-only \
    --tmpfs "/tmp:rw,noexec,nosuid,nodev,size=$BOT_TMP_SIZE" \
    --mount "type=volume,src=$vol,dst=/home/bot" \
    --mount "type=bind,src=$op,dst=/etc/automaton/operator.json,readonly" \
    --user 10001:10001 \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --ipc private \
    --cpus "$BOT_CPUS" --memory "$BOT_MEMORY" --memory-swap "$BOT_MEMORY" \
    --pids-limit "$BOT_PIDS" \
    --ulimit "nofile=$BOT_NOFILE:$BOT_NOFILE" \
    --restart no \
    --label economy.prefix="$P" --label economy.role=bot --label economy.bot="$name" \
    -e AUTOMATON_MODE=local \
    -e LEDGER_MODE=sim \
    "$BOT_IMAGE" "$@" >/dev/null
  echo "started $c"
}

cmd_stop() {
  local name="${1:-}"; [[ -n "$name" ]] || die "usage: bot.sh stop <name>"
  valid_name "$name"
  local c net
  c="$(bot_container "$name")"; net="$(bot_net "$name")"
  exists container "$c" && docker rm -f "$c" >/dev/null
  if exists network "$net"; then
    exists container "$GW" && docker network disconnect -f "$net" "$GW" 2>/dev/null || true
    docker network rm "$net" >/dev/null
  fi
  echo "stopped $c (data volume $(bot_volume "$name") kept)"
}

cmd_status() {
  [[ -e "$KILL_FLAG" ]] && echo "KILL SWITCH SET ($KILL_FLAG)"
  docker ps -a --filter label=economy.prefix="$P" \
    --format 'table {{.Names}}\t{{.Label "economy.role"}}\t{{.Status}}'
}

cmd_kill_all() {
  # Flag first, so nothing can be (re)started while we kill.
  mkdir -p "$STATE_DIR"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$KILL_FLAG"

  local filters=()
  if [[ "$P" == "economy" ]]; then
    # Real kill switch: every bot and gateway container, whatever its prefix.
    # Image labels mean this also catches containers started by hand.
    filters=(role=bot role=gateway)
  else
    filters=(prefix="$P")
  fi

  local ids=""
  for f in "${filters[@]}"; do
    ids+="$(docker ps -q --filter "label=economy.$f")"$'\n'
  done
  ids="$(echo "$ids" | sort -u | sed '/^$/d')"
  if [[ -n "$ids" ]]; then
    # shellcheck disable=SC2086
    docker kill $ids >/dev/null
  fi
  echo "KILL SWITCH: killed $(echo -n "$ids" | grep -c . || true) container(s); starts blocked until 'bot.sh unkill'"
}

cmd_unkill() {
  rm -f "$KILL_FLAG"
  echo "kill switch cleared"
}

case "${1:-}" in
  build) cmd_build ;;
  up) cmd_up ;;
  operator) shift; cmd_operator "$@" ;;
  start) shift; cmd_start "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  status) cmd_status ;;
  kill-all) cmd_kill_all ;;
  unkill) cmd_unkill ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
