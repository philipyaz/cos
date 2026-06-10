// Resolve the AES-256 recovery passphrase. NEVER printed, NEVER written to the repo.
// Priority: COS_BACKUP_KEY env (for CI / one-off restores) → macOS Keychain.
import { execFileSync } from "node:child_process";
import { KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT } from "../config.mjs";

export function resolveKey() {
  const env = process.env.COS_BACKUP_KEY;
  if (typeof env === "string" && env.trim() !== "") return env.trim();
  try {
    const out = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf8" },
    );
    const k = out.replace(/\n$/, "");
    if (k) return k;
  } catch {
    // not in Keychain
  }
  throw new Error(
    `No backup key. Set COS_BACKUP_KEY or store it in Keychain:\n` +
      `  security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w '<key>'\n` +
      `Run the /backup-recovery skill (setup mode) to generate + store it.`,
  );
}

/** True if a key is resolvable (used by setup/status checks; never reveals it). */
export function keyAvailable() {
  try {
    resolveKey();
    return true;
  } catch {
    return false;
  }
}
