// SERVER-ONLY reader + ephemeral tracker for the multi-device "Devices" surface.
//
// This is the board's window onto the OTHER machines that talk to it. Unlike the
// backup/guard readers (which read off-machine state), the "who has been here"
// signal is DERIVED FROM REQUEST HEADERS and kept in memory ONLY — it is NEVER
// persisted to cases.json (no schemaVersion bump; a restart forgets it, which is
// correct: last-seen is live presence, not durable data). recordDevice() is fed
// the `x-device` / `x-device-role` headers the MCP wrappers send (see
// packages/mcp-kit); fetchDeviceStatus() folds that map together with THIS
// machine's identity (cos-env) and the hub lease (backup-status) into one
// render-ready envelope. Like every status reader here, it NEVER throws.
//
// Honest scoping: last-seen is keyed on `x-device`, which only agent/MCP traffic
// carries — a plain browser sends none. So the column is "agent last-seen", not a
// claim about browser activity. A device with no header is not invented.

import type { NextRequest } from "next/server";
import type { DeviceStatus, DeviceSeen } from "./types";
import { getDeviceId, getDeviceRole, machineValue, slugifyDeviceId } from "./cos-env";
import { readHubLease, LEASE_STALE_HOURS } from "./backup-status";
import { SCHEMA_VERSION } from "./types";

// ── The ephemeral last-seen map (module singleton) ────────────────────────────
// deviceId → last-seen. Bounded (a runaway header can't grow it without bound):
// we keep the most-recently-seen MAX_DEVICES. In a single Next process this is the
// one source; a multi-process deploy would each hold their own view (acceptable —
// it is presence, not truth).
const MAX_DEVICES = 50;
const seen = new Map<string, DeviceSeen>();

// Record a request's device identity, if it carries one. Called from the request
// paths that agents traverse (resolveActor for writes; the healthz + devices GETs
// spokes poll). No header ⇒ no-op (never invent a device). Fail-safe. The header id
// is untrusted input, so it is slugified to the canonical device-id shape.
export function recordDevice(req: NextRequest): void {
  try {
    const rawId = req.headers.get("x-device");
    if (!rawId) return;
    const id = slugifyDeviceId(rawId.trim());
    if (!id) return;
    const roleHeader = req.headers.get("x-device-role");
    const role = roleHeader === "hub" || roleHeader === "spoke" ? roleHeader : undefined;
    const prev = seen.get(id);
    // delete-then-set so an UPDATE moves the entry to the end of the Map's
    // insertion order — eviction below is then driven by insertion order (LRU),
    // which is clock-independent (a backward clock adjustment can't mis-evict).
    if (prev) seen.delete(id);
    seen.set(id, {
      deviceId: id,
      role: role ?? prev?.role,
      lastSeen: new Date().toISOString(),
      count: (prev?.count ?? 0) + 1,
    });
    // Bound: evict the least-recently-updated (front of the Map) — never the entry
    // just set. Snapshot the excess count before mutating.
    const excess = seen.size - MAX_DEVICES;
    if (excess > 0) {
      const it = seen.keys();
      for (let i = 0; i < excess; i++) {
        const { value, done } = it.next();
        if (done || value === undefined) break;
        seen.delete(value);
      }
    }
  } catch {
    /* header tracking is best-effort — never break the request it rides on */
  }
}

// ── Join blob (cos-join://) ───────────────────────────────────────────────────
// A single string a NEW spoke pastes into spoke-setup: the hub's tailnet URL +
// this hub's schemaVersion + the optional backup-repo ref. ADDRESSES + EXPECTATIONS
// only — NOT credentials — so it neither expires nor needs protecting. The hub's
// externally-reachable URL is COS_HUB_PUBLIC_URL (the `tailscale serve` MagicDNS
// name — a hub-local config value, since BOARD_URL on a hub is localhost). Null
// when unset (the UI then explains how to set it / run the CLI).
//
// GRAMMAR MIRROR: scripts/join-blob.mjs emits the SAME `cos-join://v1?hub=&schema=&
// backup=` shape from the CLI (it is a .mjs outside the Next root and cannot import
// this) — keep the two in lockstep; spoke-setup parses whichever produced the blob.
export function buildJoinBlob(): string | null {
  // env > cos.env (machineValue), matching getDeviceRole/getDeviceId.
  const hubUrl = machineValue("COS_HUB_PUBLIC_URL", "").trim().replace(/\/$/, "");
  // Must be a real http(s) URL (same guard as scripts/join-blob.mjs) — a
  // scheme-less value would produce an unusable blob; null makes the UI show its
  // "set COS_HUB_PUBLIC_URL to your tailnet URL" hint instead.
  if (!hubUrl || !/^https?:\/\//.test(hubUrl)) return null;
  const params = new URLSearchParams({ hub: hubUrl, schema: String(SCHEMA_VERSION) });
  const backupRef = machineValue("BACKUP_REPO_REF", "").trim();
  if (backupRef) params.set("backup", backupRef);
  return `cos-join://v1?${params.toString()}`;
}

// The render-ready Devices envelope — this machine's identity + role, the hub lease
// (who is authoritative), the known devices (newest-first), and the join blob. Cheap
// and fail-safe. `online` is always true (the board process answered); a null lease /
// empty devices list is a normal state, not an error.
export function fetchDeviceStatus(): DeviceStatus {
  const lease = readHubLease();
  const devices = [...seen.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  return {
    online: true,
    role: getDeviceRole(),
    deviceId: getDeviceId(),
    schemaVersion: SCHEMA_VERSION,
    lease,
    leaseStaleHours: LEASE_STALE_HOURS,
    devices,
    joinBlob: buildJoinBlob(),
  };
}

// Test-only: reset the in-memory map (the api-devices test drives recordDevice via
// real HTTP, but the unit test pokes it directly).
export function _resetDevices(): void {
  seen.clear();
}
