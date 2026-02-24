import fs from 'fs';
import path from 'path';

const API_KEY = 'cnwy_k_r_JKLuqBsl6weHtPmbEjPMWHKzFJVI8A';
const API_URL = 'https://api.conway.tech/v1';

async function conwayFetch(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${API_URL}${endpoint}`;
    const authHeader = `Bearer ${API_KEY}`;

    const res = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader,
            ...options.headers
        }
    });

    if (!res.ok) {
        throw new Error(`API Request failed: ${res.status}`);
    }
    return res;
}

async function runExec(id, command) {
    const res = await conwayFetch(`/sandboxes/${id}/exec`, {
        method: 'POST',
        body: JSON.stringify({ command, timeout: 10000 })
    });
    return await res.json();
}

async function main() {
    const listRes = await conwayFetch('/sandboxes');
    const listData = await listRes.json();
    const sandbox = listData.sandboxes?.find(s => s.name === 'HyperScalperX-Cloud');

    if (!sandbox) {
        console.error("Sandbox not found");
        return;
    }

    console.log(`Checking Sandbox: ${sandbox.id}`);

    console.log("\n--- Checking Identity via Logs ---");
    const logGrep = await runExec(sandbox.id, 'grep "Identity:" /root/.automaton/logs/agent.log | tail -n 1');
    console.log("LOG ENTRY:", logGrep.stdout);

    console.log("\n--- Checking for wallet.json ---");
    const walletCheck = await runExec(sandbox.id, 'ls /root/.automaton/wallet.json');
    if (walletCheck.exitCode === 0) {
        console.log("wallet.json EXISTS in cloud.");
        const walletContent = await runExec(sandbox.id, 'cat /root/.automaton/wallet.json');
        console.log("CONTENT:", walletContent.stdout);
    } else {
        console.log("wallet.json DOES NOT EXIST in cloud.");
    }
}

main().catch(console.error);
