import fs from 'fs';

const id = 'd2d07903f3caa0fdc68eef1acdbc4a9a';
const API_KEY = 'cnwy_k_r_JKLuqBsl6weHtPmbEjPMWHKzFJVI8A';

async function main() {
    const res = await fetch(`https://api.conway.tech/v1/sandboxes/${id}/exec`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            command: 'grep -iE "Authorization|Status|Position|Trade|Error" /root/.automaton/logs/agent.log | tail -n 50',
            timeout: 10000
        })
    });
    const data = await res.json();
    fs.writeFileSync('identity_check.txt', data.stdout || data.stderr || 'No output');
    console.log("Output saved to identity_check.txt");

    // Also check for wallet.json
    const res2 = await fetch(`https://api.conway.tech/v1/sandboxes/${id}/exec`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            command: 'ls /root/.automaton/wallet.json && cat /root/.automaton/wallet.json',
            timeout: 10000
        })
    });
    const data2 = await res2.json();
    fs.appendFileSync('identity_check.txt', '\n\nWALLET CHECK:\n' + (data2.stdout || data2.stderr || 'No wallet.json'));
}

main().catch(console.error);
