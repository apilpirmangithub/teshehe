const API_KEY = "cnwy_k_VAtDbvoZhj9Be7PyXbKa0freskxvAFYN";
const API_URL = 'https://api.conway.tech/v1';

async function main() {
    const res = await fetch(`${API_URL}/sandboxes`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` }
    });
    const data = await res.json();
    const sandbox = data.sandboxes?.find(s => s.name === 'HyperScalperX-Cloud');

    if (!sandbox) {
        console.error("No 'HypeScalperX-Cloud' sandbox found.");
        process.exit(1);
    }

    const auditCmd = "bash -c 'echo \"--- START AUDIT ---\"; [ -f /root/.automaton/SOUL.md ] && echo \"✅ SOUL.md: Found\" || echo \"❌ SOUL.md: Missing\"; [ -d /root/.automaton/.git ] && echo \"✅ Git State Repo: Found\" || echo \"❌ Git State Repo: Missing\"; grep -q \"CONSTITUTION\" /root/automaton/src/agent/system-prompt.ts && echo \"✅ Constitution: Active in Prompt\" || echo \"❌ Constitution: Missing in Prompt\"; [ -f /root/automaton/src/registry/erc8004.ts ] && echo \"✅ ERC-8004: Identity Module Exists\" || echo \"❌ ERC-8004: Missing Module\"; [ -f /root/.automaton/config.json ] && echo \"✅ Config: Exists\" || echo \"❌ Config: Missing\"; echo \"--- END AUDIT ---\"'";

    console.log(`Auditing sandbox ${sandbox.id}...`);
    const execRes = await fetch(`${API_URL}/sandboxes/${sandbox.id}/exec`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
            command: auditCmd,
            timeout: 20000
        })
    });

    const execData = await execRes.json();
    console.log("\n=== AUDIT RESULTS ===");
    console.log(execData.stdout || execData.stderr || "No output.");
}

main().catch(console.error);
