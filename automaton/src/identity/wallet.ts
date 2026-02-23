/**
 * Automaton Wallet Management
 *
 * Creates and manages an EVM wallet for the automaton's identity and payments.
 * The private key is the automaton's sovereign identity.
 * Adapted from conway-mcp/src/wallet.ts
 */

import type { PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";
import { createHash } from "node:crypto";
import type { WalletData } from "../types.js";

let cachedAccount: PrivateKeyAccount | null = null;

const AUTOMATON_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH || "/root",
  ".automaton",
);
const WALLET_FILE = path.join(AUTOMATON_DIR, "wallet.json");

export function getAutomatonDir(): string {
  return AUTOMATON_DIR;
}

export function getWalletPath(): string {
  return WALLET_FILE;
}

/**
 * Get or create the automaton's wallet.
 * The private key IS the automaton's identity -- protect it.
 */
export async function getWallet(): Promise<{
  account: PrivateKeyAccount;
  isNew: boolean;
}> {
  if (cachedAccount) return { account: cachedAccount, isNew: false };
  if (!fs.existsSync(AUTOMATON_DIR)) {
    fs.mkdirSync(AUTOMATON_DIR, { recursive: true, mode: 0o700 });
  }

  // 1. Priority: Environment Variable (Explicit Private Key)
  const envKey = process.env.CONWAY_WALLET_PRIVATE_KEY;
  if (envKey) {
    const account = privateKeyToAccount(envKey as `0x${string}`);
    cachedAccount = account;
    return { account, isNew: false };
  }

  // 2. Priority: API-Powered Identity (Zero-Config)
  const apiKey = process.env.CONWAY_API_KEY;
  if (apiKey) {
    // 1. Seed deterministic private key from API key
    const seed = createHash("sha256").update(apiKey).digest("hex");
    const privateKey = `0x${seed}` as `0x${string}`;
    const account = privateKeyToAccount(privateKey);

    // 2. Fetch canonical address from Conway API
    try {
      const url = process.env.CONWAY_API_URL || "https://api.conway.tech";
      const resp = await fetch(`${url}/v1/auth/me`, {
        headers: { Authorization: apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        const canonicalAddress = data.user?.wallet_address;

        console.log(`[Wallet] Identity: Signer ${account.address} -> Canonical ${canonicalAddress || "Not Found"}`);

        if (canonicalAddress) {
          (account as any).address = canonicalAddress;
        }
      }
    } catch (err: any) {
      console.warn(`[Wallet] Failed to fetch identity from API: ${err.message}. Using deterministic address.`);
    }

    cachedAccount = account;
    return { account, isNew: false };
  }

  // 3. Priority: Local File
  if (fs.existsSync(WALLET_FILE)) {
    const walletData: WalletData = JSON.parse(
      fs.readFileSync(WALLET_FILE, "utf-8"),
    );
    const account = privateKeyToAccount(walletData.privateKey);
    cachedAccount = account;
    return { account, isNew: false };
  }

  // 4. Last Resort: Generate New
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const walletData: WalletData = {
    privateKey,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2), {
    mode: 0o600,
  });

  cachedAccount = account;
  return { account, isNew: true };
}

/**
 * Get the wallet address without loading the full account.
 */
export function getWalletAddress(): string | null {
  if (cachedAccount) return cachedAccount.address;

  // Sync fallback for startup/sync checks
  const envKey = process.env.CONWAY_WALLET_PRIVATE_KEY;
  if (envKey) return privateKeyToAccount(envKey as `0x${string}`).address;

  if (fs.existsSync(WALLET_FILE)) {
    const walletData: WalletData = JSON.parse(fs.readFileSync(WALLET_FILE, "utf-8"));
    return privateKeyToAccount(walletData.privateKey).address;
  }

  // Note: API Key address retrieval requires async getWallet() call
  return null;
}

export function loadWalletAccount(): PrivateKeyAccount | null {
  if (cachedAccount) return cachedAccount;

  const envKey = process.env.CONWAY_WALLET_PRIVATE_KEY;
  if (envKey) return privateKeyToAccount(envKey as `0x${string}`);

  if (fs.existsSync(WALLET_FILE)) {
    const walletData: WalletData = JSON.parse(fs.readFileSync(WALLET_FILE, "utf-8"));
    return privateKeyToAccount(walletData.privateKey);
  }

  return null;
}

/**
 * Get the actual signing address (the agent's address), 
 * distinct from the canonical user address it might be representing.
 */
export function getSigningAddress(): string | null {
  const pk = getWalletPrivateKey();
  if (!pk) return null;
  try {
    return privateKeyToAccount(pk as `0x${string}`).address;
  } catch {
    return null;
  }
}

export function walletExists(): boolean {
  return cachedAccount !== null || fs.existsSync(WALLET_FILE) || !!process.env.CONWAY_API_KEY || !!process.env.CONWAY_WALLET_PRIVATE_KEY;
}

export function getWalletPrivateKey(): string | null {
  const envKey = process.env.CONWAY_WALLET_PRIVATE_KEY;
  if (envKey) return envKey;

  if (fs.existsSync(WALLET_FILE)) {
    const walletData: WalletData = JSON.parse(fs.readFileSync(WALLET_FILE, "utf-8"));
    return walletData.privateKey;
  }

  const apiKey = process.env.CONWAY_API_KEY;
  if (apiKey) {
    const seed = createHash("sha256").update(apiKey).digest("hex");
    return `0x${seed}`;
  }

  return null;
}
