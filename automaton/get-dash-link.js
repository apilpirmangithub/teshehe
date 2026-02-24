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
            command: 'grep "trycloudflare.com" /root/.automaton/logs/agent.log | tail -n 1',
            timeout: 10000
        })
    });
    const data = await res.json();
    console.log("RESULT:", data.stdout);
}

main().catch(console.error);
