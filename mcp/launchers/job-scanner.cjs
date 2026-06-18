// Scheduled job scanner — calls /api/jobs/daily-scan every 24 hours.
// Managed by pm2 via ecosystem.config.cjs.
//
// On startup, waits 30 seconds (let the board boot), runs the first scan,
// then repeats every 24 hours.

"use strict";

const BOARD_URL = process.env.BOARD_URL || "http://localhost:3000";
const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const INITIAL_DELAY_MS = 30 * 1000; // 30 seconds

async function runScan() {
  const ts = new Date().toISOString();
  console.log(`[job-scanner] ${ts} — starting daily scan`);
  try {
    const res = await fetch(`${BOARD_URL}/api/jobs/daily-scan`);
    if (res.ok) {
      const data = await res.json();
      console.log(`[job-scanner] done: scanned=${data.scanned} new=${data.new_jobs} matches=${data.above_threshold}`);
    } else {
      console.error(`[job-scanner] HTTP ${res.status}: ${await res.text()}`);
    }
  } catch (e) {
    console.error(`[job-scanner] error: ${e.message}`);
  }
}

// Initial delay, then first run, then interval
setTimeout(() => {
  runScan();
  setInterval(runScan, INTERVAL_MS);
}, INITIAL_DELAY_MS);

console.log(`[job-scanner] started — first scan in ${INITIAL_DELAY_MS / 1000}s, then every ${INTERVAL_MS / 3600000}h`);
