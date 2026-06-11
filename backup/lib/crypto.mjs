// AES-256-GCM authenticated encryption for backups. Zero external dependencies
// (Node's built-in crypto). The on-disk format is self-describing so a snapshot
// can be decrypted years later with only the recovery key:
//
//   MAGIC(8) | salt(16) | iv(12) | authTag(16) | ciphertext
//
// - Key:  scrypt(passphrase, salt) → 32 bytes. Salt is random per backup and
//         stored in the header, so the same passphrase yields a fresh key each time.
// - GCM:  authenticated — decryption THROWS if the ciphertext or header was
//         tampered with (this is the integrity guarantee).
import crypto from "node:crypto";

const MAGIC = Buffer.from("COSBAK1\0", "binary"); // 8 bytes, format version 1
const SALT_LEN = 16;
const IV_LEN = 12; // 96-bit nonce, the GCM standard
const TAG_LEN = 16;

// scrypt cost params — fixed (must match for encrypt/decrypt; the salt is stored,
// the params are not, so they live here as constants).
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(Buffer.from(String(passphrase), "utf8"), salt, 32, SCRYPT);
}

/** Encrypt a Buffer with a passphrase. Returns the framed Buffer (magic|salt|iv|tag|ct). */
export function encrypt(plaintext, passphrase) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, ct]);
}

/** Decrypt a framed Buffer. THROWS on bad magic or failed authentication. */
export function decrypt(blob, passphrase) {
  if (blob.length < MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error("backup blob too short / not a COS backup");
  }
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("bad magic — not a COS backup (or wrong format version)");
  }
  let off = MAGIC.length;
  const salt = blob.subarray(off, (off += SALT_LEN));
  const iv = blob.subarray(off, (off += IV_LEN));
  const tag = blob.subarray(off, (off += TAG_LEN));
  const ct = blob.subarray(off);
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  // .final() throws "Unsupported state or unable to authenticate data" if the
  // key is wrong or the bytes were tampered with — that IS the integrity check.
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
