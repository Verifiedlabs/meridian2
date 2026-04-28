import fs from "fs";
import path from "path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "crypto";
import dotenv from "dotenv";

const DEFAULT_ENV_PATH = path.join(process.cwd(), ".env");
const DEFAULT_KEY_PATH = path.join(process.cwd(), ".envrypt");

// ── v2: AES-256-GCM with scrypt KDF ─────────────────────────────────
// Format: "v2:" || base64(salt[16] || iv[12] || tag[16] || ciphertext)
const V2_PREFIX = "v2:";
const V2_SALT_LEN = 16;
const V2_IV_LEN   = 12;
const V2_TAG_LEN  = 16;
const V2_KEY_LEN  = 32; // AES-256
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

function isEncryptedMarker(line) {
  return line.trim().toLowerCase() === "# encrypted";
}

function parseEncryptedKeys(filePath) {
  if (!fs.existsSync(filePath)) return new Set();

  const encrypted = new Set();
  let encryptedNext = false;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      encryptedNext = false;
      continue;
    }
    if (isEncryptedMarker(trimmed)) {
      encryptedNext = true;
      continue;
    }
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && encryptedNext) encrypted.add(match[1]);
    encryptedNext = false;
  }
  return encrypted;
}

function getEnvcryptKey(keyPath = DEFAULT_KEY_PATH) {
  const key =
    process.env.ENVRYPT_KEY ||
    process.env.ENVCRYPT_KEY ||
    (fs.existsSync(keyPath) ? fs.readFileSync(keyPath, "utf8").trim() : "");

  if (!key) return null;
  if (key.length < 8) {
    throw new Error("Envrypt encryption key must be at least 8 characters long.");
  }
  return key;
}

function shouldEncryptEnvKey(envKey) {
  return envKey.endsWith("_KEY") ||
    envKey.startsWith("ENVRIPT_") ||
    /(?:PRIVATE|SECRET|TOKEN|PASSPHRASE|PASSWORD|MNEMONIC)/i.test(envKey);
}

// ── v2 (current): AES-256-GCM ───────────────────────────────────────

function deriveKeyV2(passphrase, salt) {
  return scryptSync(passphrase, salt, V2_KEY_LEN, SCRYPT_OPTS);
}

function envryptEncryptV2(value, passphrase) {
  const salt = randomBytes(V2_SALT_LEN);
  const iv   = randomBytes(V2_IV_LEN);
  const key  = deriveKeyV2(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([salt, iv, tag, ct]).toString("base64");
  return `${V2_PREFIX}${blob}`;
}

function envryptDecryptV2(value, passphrase) {
  const blob = Buffer.from(String(value).slice(V2_PREFIX.length), "base64");
  if (blob.length < V2_SALT_LEN + V2_IV_LEN + V2_TAG_LEN) {
    throw new Error("Envrypt v2 ciphertext too short or malformed.");
  }
  const salt = blob.subarray(0, V2_SALT_LEN);
  const iv   = blob.subarray(V2_SALT_LEN, V2_SALT_LEN + V2_IV_LEN);
  const tag  = blob.subarray(V2_SALT_LEN + V2_IV_LEN, V2_SALT_LEN + V2_IV_LEN + V2_TAG_LEN);
  const ct   = blob.subarray(V2_SALT_LEN + V2_IV_LEN + V2_TAG_LEN);
  const key  = deriveKeyV2(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

// ── Legacy v1: XOR (kept for backward-compat decrypt only) ──────────
// Anyone with .env.raw should re-run `npm run env:encrypt` to upgrade.

function envryptDecryptLegacyXor(value, passphrase) {
  const encrypted = Buffer.from(String(value), "base64").toString("utf8");
  return Array.from(encrypted, (char, index) =>
    String.fromCharCode(char.charCodeAt(0) ^ passphrase.charCodeAt(index % passphrase.length))
  ).join("");
}

// ── Public API ──────────────────────────────────────────────────────

export function envryptEncrypt(value, passphrase) {
  return envryptEncryptV2(value, passphrase);
}

export function envryptDecrypt(value, passphrase) {
  const str = String(value);
  if (str.startsWith(V2_PREFIX)) {
    return envryptDecryptV2(str, passphrase);
  }
  // Legacy XOR — silently fall through. Authenticity not verified, format weak.
  return envryptDecryptLegacyXor(str, passphrase);
}

export function loadEnv({ envPath = DEFAULT_ENV_PATH, keyPath = DEFAULT_KEY_PATH, override = false } = {}) {
  dotenv.config({ path: envPath, override, quiet: true });

  const encryptedKeys = parseEncryptedKeys(envPath);
  if (encryptedKeys.size === 0) return { encryptedKeys: [], legacyKeys: [] };

  const passphrase = getEnvcryptKey(keyPath);
  if (!passphrase) {
    throw new Error(
      `Encrypted env values found in ${envPath}, but no envrypt key was provided. ` +
      "Create .envrypt or set ENVRYPT_KEY / ENVCRYPT_KEY.",
    );
  }

  const legacyKeys = [];
  for (const envKey of encryptedKeys) {
    const value = process.env[envKey];
    if (value == null || value === "") continue;
    if (!String(value).startsWith(V2_PREFIX)) legacyKeys.push(envKey);
    process.env[envKey] = envryptDecrypt(value, passphrase);
  }

  if (legacyKeys.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[envrypt] WARNING: ${legacyKeys.length} env value(s) still use the insecure legacy XOR ` +
      `format (${legacyKeys.join(", ")}). Re-encrypt by running: npm run env:encrypt`,
    );
  }

  return { encryptedKeys: [...encryptedKeys], legacyKeys };
}

export function encryptEnvRaw({
  rawPath = path.join(process.cwd(), ".env.raw"),
  outPath = DEFAULT_ENV_PATH,
  keyPath = DEFAULT_KEY_PATH,
} = {}) {
  if (!fs.existsSync(rawPath)) {
    throw new Error(`No ${rawPath} file found.`);
  }

  const passphrase = getEnvcryptKey(keyPath);
  if (!passphrase) {
    throw new Error("Create .envrypt or set ENVRYPT_KEY / ENVCRYPT_KEY before encrypting.");
  }

  const parsed = dotenv.parse(fs.readFileSync(rawPath, "utf8"));
  const lines = ["# Envrypt managed environment file.", ""];
  for (const [envKey, value] of Object.entries(parsed)) {
    if (shouldEncryptEnvKey(envKey)) {
      lines.push("# encrypted");
      lines.push(`${envKey}=${envryptEncrypt(value, passphrase)}`, "");
    } else {
      lines.push(`${envKey}=${value}`);
    }
  }

  fs.writeFileSync(outPath, `${lines.join("\n").replace(/\n+$/, "")}\n`);
  return { rawPath, outPath };
}

// Constant-time helper exported in case downstream tests want to compare ciphertexts.
export function envryptConstantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

loadEnv();
