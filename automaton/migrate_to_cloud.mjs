import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Conway Cloud Migration Script
 * 
 * This script migrates your local agent state to a remote Conway Cloud sandbox.
 */

// 1. Configuration
const AUTOMATON_DIR = path.join(os.homedir(), '.automaton');
const LOCAL_CONFIG_PATH = path.join(AUTOMATON_DIR, 'config.json');

async function migrate() {
    console.log("🚀 Starting Conway Cloud Migration...");

    // 2. Validate Local State
    if (!fs.existsSync(LOCAL_CONFIG_PATH)) {
        console.error("❌ Local config not found at " + LOCAL_CONFIG_PATH);
        console.log("💡 Tip: Make sure you have run the agent at least once locally.");
        process.exit(1);
    }

    const localConfig = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf-8'));
    const apiKey = localConfig.apiKey || process.env.CONWAY_API_KEY;
    const apiUrl = localConfig.apiUrl || "https://api.conway.tech";

    if (!apiKey) {
        console.error("❌ No Conway API Key found in config or environment.");
        process.exit(1);
    }

    // 3. Create Cloud Sandbox
    console.log("🛠️  Checking for existing sandboxes...");
    const listResp = await fetch(`${apiUrl}/v1/sandboxes`, {
        headers: { 'Authorization': apiKey }
    });
    const { sandboxes } = await listResp.json();
    let sandboxId = sandboxes?.[0]?.id;

    if (!sandboxId) {
        console.log("🛠️  Provisioning new cloud sandbox...");
        const sandboxResp = await fetch(`${apiUrl}/v1/sandboxes`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': apiKey
            },
            body: JSON.stringify({
                name: `cloud-scalper-${localConfig.name || 'agent'}`,
                vcpu: 1,
                memory_mb: 512,
                disk_gb: 5
            })
        });

        if (!sandboxResp.ok) {
            console.error("❌ Failed to create sandbox:", await sandboxResp.text());
            process.exit(1);
        }

        const sandbox = await sandboxResp.json();
        sandboxId = sandbox.id;
        console.log(`✅ Sandbox created: ${sandboxId}`);
    } else {
        console.log(`✅ Using existing sandbox: ${sandboxId}`);
    }

    // 4. Upload State Files
    const filesToMigrate = [
        'config.json',
        'automaton.json',
        'wallet.json',
        'state.db',
        'constitution.md',
        'heartbeat.yml',
        'SOUL.md'
    ];

    console.log("📤 Uploading agent state...");
    // Ensure .automaton dir exists in cloud
    await fetch(`${apiUrl}/v1/sandboxes/${sandboxId}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
        body: JSON.stringify({ command: "mkdir -p /root/.automaton", timeout: 5000 })
    });

    for (const fileName of filesToMigrate) {
        const localPath = path.join(AUTOMATON_DIR, fileName);
        if (fs.existsSync(localPath)) {
            const isBinary = fileName.endsWith('.db');
            const content = isBinary
                ? fs.readFileSync(localPath).toString('base64')
                : fs.readFileSync(localPath, 'utf-8');

            const targetPath = isBinary ? `/root/.automaton/${fileName}.b64` : `/root/.automaton/${fileName}`;

            const uploadResp = await fetch(`${apiUrl}/v1/sandboxes/${sandboxId}/files/upload/json`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': apiKey
                },
                body: JSON.stringify({ path: targetPath, content })
            });

            if (uploadResp.ok) {
                console.log(`   - ${fileName} uploaded.`);
                if (isBinary) {
                    // Decode binary file in cloud
                    await fetch(`${apiUrl}/v1/sandboxes/${sandboxId}/exec`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
                        body: JSON.stringify({
                            command: `base64 -d /root/.automaton/${fileName}.b64 > /root/.automaton/${fileName} && rm /root/.automaton/${fileName}.b64`,
                            timeout: 10000
                        })
                    });
                }
            } else {
                console.warn(`   - Warning: Failed to upload ${fileName}: ${await uploadResp.text()}`);
            }
        }
    }

    // 5. Install Runtime & Start
    console.log("📥 Setting up Automaton repository in cloud...");
    const repoUrl = "https://ghp_P8xLBZQSbL5T3hJeBZUKMWJpLVpauhm9@github.com/apilpirmangithub/teshehe.git";

    const setupCommands = [
        "apt-get update -qq",
        "apt-get install -y -qq nodejs npm git",
        "rm -rf /root/teshehe",
        `git clone ${repoUrl} /root/teshehe`,
        "cd /root/teshehe/automaton && npm install",
        "cd /root/teshehe/automaton && npm run build",
        "mkdir -p /root/.automaton/logs"
    ];

    for (const cmd of setupCommands) {
        console.log(`\n🏃 Running: ${cmd}`);
        const setupResp = await fetch(`${apiUrl}/v1/sandboxes/${sandboxId}/exec`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
            body: JSON.stringify({ command: cmd, timeout: 300000 })
        });
        if (!setupResp.ok) {
            console.error(`❌ Command failed: ${cmd}`);
            console.error(await setupResp.text());
        }
    }
    console.log("\n✅ Repository setup complete.");

    // 6. Launch Agent
    console.log("🚀 Launching agent in cloud...");
    await fetch(`${apiUrl}/v1/sandboxes/${sandboxId}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
        body: JSON.stringify({
            command: "cd /root/teshehe/automaton && nohup node dist/index.js --run > /root/.automaton/logs/cloud_output.log 2>&1 &",
            timeout: 10000
        })
    });

    console.log("\n✨ MIGRATION COMPLETE! ✨");
    console.log(`Your agent is now running centrally in sandbox: ${sandboxId}`);
    console.log(`You can close this terminal and turn off your PC.`);
    console.log(`Monitor your agent at: https://app.conway.tech/sandboxes/${sandboxId}`);
}

migrate().catch(console.error);
