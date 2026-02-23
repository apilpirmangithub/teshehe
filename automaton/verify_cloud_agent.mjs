/**
 * Repair and Launch Cloud Agent
 */
async function repairAndLaunch() {
    const apiKey = 'cnwy_k_X8xLBZQSbL5T3hJeBZUKMWJpLVpauhm9';
    const sandboxId = 'bd03c75b244a05dd7284dd41fa03e0b5';
    const apiUrl = 'https://api.conway.tech';

    console.log(`🔧 Repairing agent in sandbox: ${sandboxId}...`);

    try {
        // 1. Force re-install and find path
        const setupResp = await fetch(`${apiUrl}/v1/sandboxes/${sandboxId}/exec`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
            body: JSON.stringify({
                command: 'npm install -g @conway/automaton@latest && which automaton || find / -name automaton 2>/dev/null',
                timeout: 120000
            })
        });

        const setupData = await setupResp.json();
        const binaryPath = setupData.stdout.trim().split('\n').filter(l => l.includes('bin/automaton'))[0] || 'automaton';
        console.log(`✅ Binary found at: ${binaryPath}`);

        // 2. Launch with full path
        console.log("🚀 Launching agent...");
        const launchResp = await fetch(`${apiUrl}/v1/sandboxes/${sandboxId}/exec`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
            body: JSON.stringify({
                command: `nohup ${binaryPath} --run > /root/.automaton/logs/cloud_output.log 2>&1 &`,
                timeout: 10000
            })
        });

        // 3. Wait and check logs
        console.log("⏳ Waiting for boot...");
        await new Promise(r => setTimeout(r, 5000));

        const logResp = await fetch(`${apiUrl}/v1/sandboxes/${sandboxId}/exec`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
            body: JSON.stringify({
                command: 'ls -lh /root/.automaton/state.db; tail -n 20 /root/.automaton/logs/cloud_output.log',
                timeout: 10000
            })
        });

        const logData = await logResp.json();
        console.log("📈 CLOUD OUTPUT:");
        console.log(logData.stdout || "Log is still empty. Agent might be initializing.");

    } catch (err) {
        console.error("❌ Repair failed:", err.message);
    }
}

repairAndLaunch();
