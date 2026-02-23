# ⚡ HyperScalperX: Perpetual Scalping AI Agent

## 🚀 Quick Deploy (Any User)

Anyone can deploy HyperScalperX to the Conway Cloud using only an API key:

1. **Get Conway API Key**: Register at [app.conway.tech](https://app.conway.tech).
2. **Clone & Deploy**:
   ```bash
   git clone https://github.com/apilpirmangithub/teshehe.git
   cd teshehe/automaton
   pnpm install
   pnpm run build
   
   # Quick Deploy: Just your Conway API Key
   pnpm run deploy -- --api-key 'your_api_key'
   ```

> [!NOTE]
> Saat `pnpm install`, kamu mungkin melihat warning `Failed to create bin... ENOENT`. Ini **normal** karena file binary baru akan terbuat setelah langkah `pnpm run build`. Kamu bisa abaikan warning tersebut.

## 🛠 Features
- **One-Command Cloud Transition**: Auto-provisions sandboxes and tunnels.
- **Universal Configuration**: Decoupled from local files; use environment variables for identity.
- **Real-Time Dashboard**: Monitor P&L and agent thinking in any browser.