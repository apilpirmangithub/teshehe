# 🖥️ Menjalankan Automaton di Lokal (Windows)

## Kenapa Pindah ke Lokal?

Codespaces GitHub berada di **Singapore (Azure)** yang di-**geoblock** oleh Polymarket.
Dari Indonesia, koneksi langsung ke Polymarket **TIDAK diblokir** — jadi agen bisa trading tanpa proxy.

---

## Persyaratan

- **Node.js** v20+ (disarankan v22 LTS)
  - Download: https://nodejs.org/en/download
- **pnpm** (package manager)
  - Install setelah Node.js: `npm install -g pnpm`
- **Git** untuk clone repo
  - Download: https://git-scm.com/download/win

---

## Step-by-Step Setup

### 1. Install Node.js

Download dan install dari https://nodejs.org (pilih LTS).
Buka **PowerShell** atau **Command Prompt**, pastikan:

```powershell
node -v     # harus >= v20.0.0
npm -v      # harus ada
```

### 2. Install pnpm

```powershell
npm install -g pnpm
```

### 3. Clone Repository

```powershell
cd C:\Users\NAMAMU
git clone https://github.com/apilpirmangithub/teshehe.git
cd teshehe\automaton
```

### 4. Install Dependencies

```powershell
pnpm install
```

### 5. Build Project

```powershell
pnpm run build
```

### 6. Copy Data dari Codespaces

**PENTING:** Kamu perlu menyalin folder `~/.automaton/` dari Codespaces ke PC lokal.

Jalankan di **Codespaces** untuk membuat backup:

```bash
cd /workspaces/teshehe/automaton
node scripts/export-local.js
```

Ini akan membuat file `automaton-backup.tar.gz`. Download file ini ke PC kamu.

Kemudian di **PowerShell** di PC lokal:

```powershell
# Buat folder .automaton di home directory
mkdir $env:USERPROFILE\.automaton

# Extract backup (pakai Git Bash atau 7-Zip)
# Atau salin manual file-file berikut ke C:\Users\NAMAMU\.automaton\:
#   - automaton.json   (config utama)
#   - wallet.json      (⚠️ PRIVATE KEY - jaga kerahasiaannya!)
#   - state.db         (database state)
#   - heartbeat.yml    (heartbeat config)
```

### 7. Jalankan Agen!

```powershell
cd C:\Users\NAMAMU\teshehe\automaton
node dist\index.js --run
```

---

## Verifikasi Tidak Kena Geoblock

Sebelum menjalankan agen, test dulu apakah PC kamu bisa akses Polymarket:

```powershell
node -e "const axios=require('axios'); axios.post('https://clob.polymarket.com/order',{},{timeout:10000}).then(()=>console.log('OK')).catch(e=>{const m=e.response?.data?.error||e.message;console.log(m.includes('geoblock')||m.includes('restricted')?'❌ GEOBLOCKED':'✅ TIDAK DIBLOKIR (error: '+m+')');})"
```

Kalau hasilnya `✅ TIDAK DIBLOKIR` — agen bisa trading langsung!

---

## Environment Variables (Opsional)

Jika ingin override config:

```powershell
$env:CONWAY_API_KEY = "cnwy_k_..."     # Conway API key
$env:OPENAI_API_KEY = "sk-..."          # OpenAI key (jika pakai GPT)
$env:ANTHROPIC_API_KEY = "sk-ant-..."   # Anthropic key (jika pakai Claude)
```

---

## Troubleshooting

### Error: "Cannot find module"
→ Pastikan `pnpm install` dan `pnpm run build` berhasil.

### Error: "No wallet private key configured"
→ Pastikan file `wallet.json` ada di `C:\Users\NAMAMU\.automaton\wallet.json`

### Error: "GEOBLOCKED"
→ ISP Indonesia tertentu mungkin routing lewat Singapore. Coba:
  1. Ganti DNS ke 1.1.1.1 atau 8.8.8.8
  2. Pakai VPN ke Eropa (UK, Germany, Netherlands)
  3. Set `POLYMARKET_PROXY_URL` environment variable

### Mau auto-start saat Windows boot?
Buat file `start-automaton.bat`:
```batch
@echo off
cd C:\Users\NAMAMU\teshehe\automaton
node dist\index.js --run
```
Taruh di `shell:startup` (Win+R → `shell:startup`)
