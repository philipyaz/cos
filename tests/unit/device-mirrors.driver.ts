// device-mirrors.driver.ts — board-side subprocess helper for
// tests/unit/device-mirrors.test.ts (mirrors #2 + #3: the device id/role chain).
//
// board/lib/cos-env.ts's machineEnv() caches config/cos.env at first call, keyed
// on path.resolve(process.cwd(), ".."), and that cache is per-PROCESS — so the
// only way to observe the file layer against a FIXTURE cos.env is a fresh child
// process spawned with cwd = <fixture>/board. Prints one JSON line: { id, role }.
//
// Deliberately named *.driver.ts, not *.test.ts, so the [1] glob
// (tests/run.sh:460 — `--test tests/unit/*.test.ts`) never runs this as a test
// itself; ts-resolve.mjs is the existing precedent for a non-test file living
// here un-globbed.
import { getDeviceId, getDeviceRole } from "../../board/lib/cos-env";

process.stdout.write(JSON.stringify({ id: getDeviceId(), role: getDeviceRole() }) + "\n");
