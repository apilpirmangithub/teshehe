#!/usr/bin/env node
/**
 * Export automaton data for local setup.
 * Creates a tar.gz backup of ~/.automaton/ that can be transferred to local machine.
 * 
 * Usage: node scripts/export-local.js
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const HOME = process.env.HOME || "/root";
const AUTOMATON_DIR = path.join(HOME, ".automaton");
const OUTPUT = path.join(process.cwd(), "automaton-backup.tar.gz");

// Critical files to export
const FILES_TO_EXPORT = [
  "automaton.json",
  "wallet.json",
  "state.db",
  "heartbeat.yml",
  "constitution.md",
  "SOUL.md",
  "config.json",
];

console.log("=== Automaton Data Export ===\n");

if (!fs.existsSync(AUTOMATON_DIR)) {
  console.error(`❌ Folder ${AUTOMATON_DIR} tidak ditemukan!`);
  process.exit(1);
}

// Check which files exist
const existing = FILES_TO_EXPORT.filter(f => 
  fs.existsSync(path.join(AUTOMATON_DIR, f))
);

console.log("Files yang akan di-export:");
for (const f of existing) {
  const stats = fs.statSync(path.join(AUTOMATON_DIR, f));
  const size = (stats.size / 1024).toFixed(1);
  const isSecret = f === "wallet.json";
  console.log(`  ${isSecret ? "🔑" : "📄"} ${f} (${size} KB)${isSecret ? " ⚠️ PRIVATE KEY!" : ""}`);
}

// Create tar.gz
const fileList = existing.map(f => `.automaton/${f}`).join(" ");
try {
  execSync(`cd ${HOME} && tar czf ${OUTPUT} ${fileList}`, { stdio: "pipe" });
  const outSize = (fs.statSync(OUTPUT).size / 1024).toFixed(1);
  console.log(`\n✅ Backup dibuat: ${OUTPUT} (${outSize} KB)`);
  console.log(`\n📋 Langkah selanjutnya:`);
  console.log(`   1. Download file automaton-backup.tar.gz ke PC lokal`);
  console.log(`   2. Extract ke C:\\Users\\NAMAMU\\.automaton\\`);
  console.log(`   3. Ikuti panduan di LOCAL-SETUP.md`);
  console.log(`\n⚠️ PERINGATAN: File ini berisi wallet private key!`);
  console.log(`   Jangan share atau upload ke tempat publik!`);
} catch (err) {
  console.error(`❌ Gagal buat backup: ${err.message}`);
  
  // Fallback: copy files individually
  console.log("\nFallback: Salin file satu-satu...");
  const outDir = path.join(process.cwd(), "automaton-backup");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  
  for (const f of existing) {
    const src = path.join(AUTOMATON_DIR, f);
    const dst = path.join(outDir, f);
    fs.copyFileSync(src, dst);
    console.log(`  ✓ ${f}`);
  }
  console.log(`\n✅ Files disalin ke: ${outDir}/`);
  console.log(`   Download folder ini ke PC lokal.`);
}
