#!/bin/bash
# Auto-setup script for Conway Automaton
# Runs automatically when codespace is created.
# Reads secrets from Codespaces Secrets to restore wallet & config.
set -e

echo "=== Conway Automaton Auto-Setup ==="

# 0. Install Tor (for geoblock bypass via EU exit nodes)
echo "Installing Tor..."
sudo apt-get update -qq && sudo apt-get install -y -qq tor netcat-openbsd > /dev/null 2>&1
# Configure Tor with EU exit nodes
sudo tee /etc/tor/torrc > /dev/null << 'TORRC'
SocksPort 9050
ExitNodes {de},{nl},{gb},{fr},{ch},{at},{be},{ie},{se},{no},{dk},{fi}
StrictNodes 1
CircuitBuildTimeout 30
LearnCircuitBuildTimeout 0
TORRC
# Start Tor in background
sudo tor &>/dev/null &
echo "✅ Tor installed & starting"

# 1. Install dependencies & build
cd /workspaces/teshehe/automaton
npm install -g pnpm
pnpm install
pnpm run build
echo "✅ Build complete"

# 2. Restore ~/.automaton/ from Codespaces Secrets
mkdir -p ~/.automaton

# Wallet (from AUTOMATON_WALLET secret — full wallet.json content)
if [ -n "$AUTOMATON_WALLET" ]; then
  echo "$AUTOMATON_WALLET" > ~/.automaton/wallet.json
  chmod 600 ~/.automaton/wallet.json
  echo "✅ Wallet restored"
elif [ -n "$AUTOMATON_WALLET_KEY" ]; then
  cat > ~/.automaton/wallet.json << WALLET_EOF
{
  "privateKey": "$AUTOMATON_WALLET_KEY",
  "createdAt": "2026-02-19T17:57:26.532Z"
}
WALLET_EOF
  chmod 600 ~/.automaton/wallet.json
  echo "✅ Wallet restored (from KEY)"
else
  echo "⚠️ AUTOMATON_WALLET secret not set — wallet not restored"
  echo "   Set it at: https://github.com/settings/codespaces"
fi

# Config (from AUTOMATON_CONFIG secret — plain JSON automaton.json)
if [ -n "$AUTOMATON_CONFIG" ]; then
  echo "$AUTOMATON_CONFIG" > ~/.automaton/automaton.json
  chmod 600 ~/.automaton/automaton.json
  echo "✅ Config restored"
else
  echo "⚠️ AUTOMATON_CONFIG secret not set — config not restored"
fi

# Heartbeat (from AUTOMATON_HEARTBEAT secret or default)
if [ -n "$AUTOMATON_HEARTBEAT" ]; then
  echo "$AUTOMATON_HEARTBEAT" > ~/.automaton/heartbeat.yml
  echo "✅ Heartbeat restored from secret"
else
  cat > ~/.automaton/heartbeat.yml << 'HB_EOF'
entries:
  - name: heartbeat_ping
    schedule: "*/15 * * * *"
    task: heartbeat_ping
    enabled: true
  - name: check_credits
    schedule: "0 */6 * * *"
    task: check_credits
    enabled: true
  - name: check_usdc_balance
    schedule: "*/30 * * * *"
    task: check_usdc_balance
    enabled: true
  - name: check_for_updates
    schedule: "0 */4 * * *"
    task: check_for_updates
    enabled: true
  - name: health_check
    schedule: "*/30 * * * *"
    task: health_check
    enabled: false
  - name: check_social_inbox
    schedule: "*/2 * * * *"
    task: check_social_inbox
    enabled: false
  - name: scout_aerodrome
    schedule: "*/3 * * * *"
    task: scout_aerodrome
    enabled: false
  - name: execute_trades
    schedule: "*/5 * * * *"
    task: execute_trades
    enabled: false
  - name: scan_polymarket
    schedule: "*/30 * * * *"
    task: scan_polymarket
    enabled: true
  - name: check_pm_positions
    schedule: "*/30 * * * *"
    task: check_pm_positions
    enabled: true
  - name: enforce_daily_stop
    schedule: "0 */1 * * *"
    task: enforce_daily_stop
    enabled: true
defaultIntervalMs: 60000
lowComputeMultiplier: 4
HB_EOF
  echo "✅ Heartbeat config written (default)"
fi

echo ""
echo "=== Setup Complete ==="
echo "Jalankan agent: cd automaton && node dist/index.js --run"
