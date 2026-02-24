import fs from 'fs';
const API_KEY = process.env.CONWAY_API_KEY;
const API_URL = process.env.CONWAY_API_URL || 'https://api.conway.tech/v1';

async function main() {
    if (!API_KEY) {
        console.error("Error: CONWAY_API_KEY environment variable is required.");
        process.exit(1);
    }

    const res = await fetch(`${API_URL}/sandboxes`, {
        headers: { 'Authorization': API_KEY.startsWith('Bearer ') ? API_KEY : `Bearer ${API_KEY}` }
    });
    const data = await res.json();
    const sandbox = data.sandboxes?.find(s => s.name === 'HyperScalperX-Cloud');

    if (!sandbox) {
        console.error("No 'HypeScalperX-Cloud' sandbox found.");
        process.exit(1);
    }

    // Get Native Port URL
    const portRes = await fetch(`${API_URL}/sandboxes/${sandbox.id}/ports`, {
        headers: { 'Authorization': API_KEY.startsWith('Bearer ') ? API_KEY : `Bearer ${API_KEY}` }
    });
    const portData = await portRes.json();
    const dashPort = portData.find?.(p => p.port === 3000) || portData[0];

    console.log(`\n=== CLOUD AGENT STATUS ===`);
    console.log(`Sandbox: ${sandbox.id}`);
    if (dashPort?.public_url) {
        console.log(`\x1b[32mDashboard: ${dashPort.public_url}\x1b[0m`);
    }

    console.log(`\nFetching logs...`);
    const execRes = await fetch(`${API_URL}/sandboxes/${sandbox.id}/exec`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': API_KEY.startsWith('Bearer ') ? API_KEY : `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
            command: 'tail -n 50 /root/.automaton/logs/agent.log 2>/dev/null || echo \"[System] Waiting for logs to initialize...\"',
            timeout: 10000
        })
    });

    const execData = await execRes.json();
    console.log("\n=== LOGS ===");
    console.log(execData.stdout || execData.stderr || "No output.");
}

main().catch(console.error);
