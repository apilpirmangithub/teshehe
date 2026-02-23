import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';

/**
 * HypeScalperX Cloud Deployer (V7 - Final Edition)
 * 
 * This script automates:
 * 1. Building and Packaging
 * 2. Creating/Verifying Sandbox
 * 3. System Dependency Sync (cloudflared)
 * 4. Identity Sync (automaton.json, wallet.json)
 * 5. Multi-Command Launch & URL Discovery
 */

// --- Argument Parsing ---
const args = process.argv.slice(2);
const getArg = (name) => {
    const idx = args.indexOf(name);
    return (idx !== -1 && args[idx + 1]) ? args[idx + 1] : null;
};

const API_KEY = getArg('--api-key') || process.env.CONWAY_API_KEY;
const API_URL = process.env.CONWAY_API_URL || 'https://api.conway.tech/v1';
let SANDBOX_ID = getArg('--sandbox-id') || process.env.SANDBOX_ID;

if (!API_KEY) {
    console.error("\x1b[31mError: Conway API Key is required.\x1b[0m");
    console.error("Pass it via command line argument: npm run deploy -- --api-key 'xxx'");
    process.exit(1);
}

// ─── Helpers ───────────────────────────────────────────────────

async function conwayFetch(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${API_URL}${endpoint}`;
    const authHeader = API_KEY.startsWith('Bearer ') ? API_KEY : `Bearer ${API_KEY}`;

    const res = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader,
            ...options.headers
        }
    });

    if (!res.ok) {
        const text = await res.text();
        console.error(`\x1b[31m[API Error] ${res.status} ${res.statusText} for ${endpoint}\x1b[0m`);
        console.error(`Response: ${text}`);
        throw new Error(`API Request failed: ${res.status}`);
    }

    return res;
}

async function waitForSandboxReady(id, retries = 30) {
    process.stdout.write("[Deploy] Polling sandbox readiness");
    for (let i = 0; i < retries; i++) {
        try {
            const res = await conwayFetch(`/sandboxes/${id}/exec`, {
                method: 'POST',
                body: JSON.stringify({ command: 'uptime', timeout: 5000 })
            });
            if (res.ok) {
                console.log("\n✅ Sandbox is ready!");
                return true;
            }
        } catch (e) { }
        process.stdout.write(".");
        await new Promise(r => setTimeout(r, 4000));
    }
    throw new Error("\nSandbox failed to become ready.");
}

async function uploadFile(remotePath, localPath, isRaw = false) {
    const fileName = path.basename(localPath);
    let content;
    let body;

    if (isRaw) {
        content = fs.readFileSync(localPath).toString('base64');
        body = JSON.stringify({ path: remotePath, content, encoding: 'base64' });
    } else {
        content = fs.readFileSync(localPath, 'utf8');
        body = JSON.stringify({ path: remotePath, content });
    }

    await conwayFetch(`/sandboxes/${SANDBOX_ID}/files/upload/json`, {
        method: 'POST',
        body
    });
}

async function runExec(command, timeout = 30000) {
    const res = await conwayFetch(`/sandboxes/${SANDBOX_ID}/exec`, {
        method: 'POST',
        body: JSON.stringify({ command, timeout })
    });
    return await res.json();
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
    console.log("\x1b[36m=== HyperScalperX Cloud Ready Deployment ===\x1b[0m");

    // 1. Build
    console.log("[1/7] Building project locally...");
    execSync('npm run build', { stdio: 'inherit' });

    // 2. Archive
    console.log("[2/7] Packaging deployment artifact...");
    execSync('tar -cf dist.tar dist', { stdio: 'inherit' });

    // 3. Sandbox
    if (!SANDBOX_ID) {
        console.log("[3/7] Finding/Creating HyperScalperX-Cloud sandbox...");
        const listRes = await conwayFetch('/sandboxes');
        const listData = await listRes.json();
        const existing = listData.sandboxes?.find(s => s.name === 'HyperScalperX-Cloud');

        if (existing) {
            SANDBOX_ID = existing.id;
        } else {
            const createRes = await conwayFetch('/sandboxes', {
                method: 'POST',
                body: JSON.stringify({ name: 'HyperScalperX-Cloud' })
            });
            const data = await createRes.json();
            SANDBOX_ID = data.id;
        }
    }
    console.log(`✅ Target Sandbox: ${SANDBOX_ID}`);
    await waitForSandboxReady(SANDBOX_ID);

    // 4. Dependencies
    console.log("[4/7] Verifying cloudflared in sandbox...");
    const checkCf = await runExec('which cloudflared');
    if (checkCf.exitCode !== 0) {
        console.log("[Deploy] Installing cloudflared into sandbox...");
        const installCmd = 'wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared';
        await runExec(installCmd, 60000);
    }

    // 5. Sync
    console.log("[5/7] Syncing project files & identity...");
    await runExec('mkdir -p /root/automaton && mkdir -p /root/.automaton/logs');
    await uploadFile('/root/automaton/package.json', './package.json');
    await uploadFile('/root/automaton/dist.tar', './dist.tar', true);

    // Identity Files
    const home = os.homedir();
    const dots = path.join(home, '.automaton');
    const identityFiles = ['automaton.json', 'SOUL.md', 'constitution.md'];

    for (const f of identityFiles) {
        const local = path.join(dots, f);
        if (fs.existsSync(local)) {
            console.log(`[Deploy] Syncing ${f}...`);
            if (f === 'automaton.json') {
                const config = JSON.parse(fs.readFileSync(local, 'utf-8'));
                config.sandboxId = SANDBOX_ID;
                if (API_KEY) config.conwayApiKey = API_KEY;
                const encoded = Buffer.from(JSON.stringify(config, null, 2)).toString('base64');
                await conwayFetch(`/sandboxes/${SANDBOX_ID}/files/upload/json`, {
                    method: 'POST',
                    body: JSON.stringify({
                        path: `/root/.automaton/${f}`,
                        content: encoded,
                        encoding: 'base64'
                    })
                });
            } else {
                await uploadFile(`/root/.automaton/${f}`, local);
            }
        } else if (f === 'automaton.json') {
            // Create default automaton.json if missing
            console.log(`[Deploy] Creating default ${f} in sandbox...`);
            const config = {
                name: "HyperScalperX",
                sandboxId: SANDBOX_ID,
                conwayApiKey: API_KEY,
                conwayApiUrl: "https://api.conway.tech",
                inferenceModel: "gpt-4o",
                maxTokensPerTurn: 4096,
                dbPath: "~/.automaton/state.db",
                logLevel: "info",
                version: "0.1.0"
            };
            const encoded = Buffer.from(JSON.stringify(config, null, 2)).toString('base64');
            await conwayFetch(`/sandboxes/${SANDBOX_ID}/files/upload/json`, {
                method: 'POST',
                body: JSON.stringify({
                    path: `/root/.automaton/${f}`,
                    content: encoded,
                    encoding: 'base64'
                })
            });
        } else {
            console.log(`[Deploy] Optional file ${f} not found locally, skipping sync.`);
        }
    }

    // 6. Launch
    console.log("[6/7] Launching Agent with Auto-Tunneling...");
    const cmd = [
        'cd /root/automaton',
        'tar -xf dist.tar',
        'npm install --omit=dev',
        // Aggressive cleanup
        'PID=$(ss -tulnp | grep :3001 | awk \'{print $7}\' | cut -d, -f2 | cut -d= -f2); [ -n "$PID" ] && kill -9 $PID || true',
        'rm -f /root/.automaton/logs/agent.log /root/test_start.log /root/test_dashboard.log',
        'sleep 1',
        `export CONWAY_API_KEY="${API_KEY}"; nohup node dist/index.js --run --auto-tunnel > /root/.automaton/logs/agent.log 2>&1 &`
    ].join('; ');

    await runExec(cmd, 300000);

    // 7. Discovery
    console.log("[7/7] Waiting for Public Dashboard URL...");
    let publicUrl = null;
    for (let i = 0; i < 15; i++) {
        process.stdout.write(".");
        await new Promise(r => setTimeout(r, 4000));
        const logs = await runExec('cat /root/.automaton/logs/agent.log 2>/dev/null || echo ""');
        const match = logs.stdout.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) {
            publicUrl = match[0];
            break;
        }
    }

    console.log("\n\n\x1b[32m🚀 HypeScalperX IS LIVE IN THE CLOUD!\x1b[0m");
    if (publicUrl) {
        console.log(`\x1b[32m[!] PUBLIC DASHBOARD: ${publicUrl}\x1b[0m`);
    } else {
        console.log("\x1b[33m[!] Status: Agent launched. Check logs in Conway Portal for URL.\x1b[0m");
    }
    console.log(`Sandbox: https://app.conway.tech/sandboxes/${SANDBOX_ID}`);

    if (fs.existsSync('dist.tar')) fs.unlinkSync('dist.tar');
}

main().catch(err => {
    console.error("\n\x1b[31m❌ DEPLOYMENT FAILED\x1b[0m");
    console.error(err.message);
    process.exit(1);
});
