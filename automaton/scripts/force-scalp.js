import Database from 'better-sqlite3';
import path from 'path';

const dbPath = 'C:/Users/apilp/.automaton/state.db';
console.log(`Updating database at: ${dbPath}`);

try {
    const db = new Database(dbPath);
    db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))").run('next_best_opportunity', 'scalp');
    console.log('Successfully set next_best_opportunity to scalp');

    // Also set agent_state to setup to force a fresh wakeup with the new prompt
    db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))").run('agent_state', 'setup');
    console.log('Successfully set agent_state to setup');

    db.close();
} catch (err) {
    console.error('Failed to update database:', err.message);
    process.exit(1);
}
