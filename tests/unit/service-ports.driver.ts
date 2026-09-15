// service-ports.driver.ts — board-side subprocess helper for
// tests/unit/service-ports.test.ts (cos-ops#99).
//
// board/lib/cos-env.ts's machineEnv() caches config/cos.env at first call, keyed on
// path.resolve(process.cwd(), ".."), and that cache is per-PROCESS — so the only way
// to observe the file layer against a FIXTURE cos.env is a fresh child process
// spawned with cwd = <fixture>/board (the same pattern device-mirrors.driver.ts uses
// for mirrors #2/#3). Prints one JSON line: { guard, search, fitness }.
//
// Deliberately named *.driver.ts, not *.test.ts, so the [1] glob
// (tests/run.sh — `--test tests/unit/*.test.ts`) never runs this as a test itself;
// ts-resolve.mjs is the existing precedent for a non-test file living here un-globbed.
import { serviceUrl, servicePort } from "../../board/lib/cos-env";

process.stdout.write(
  JSON.stringify({
    guard: serviceUrl("COS_GUARD_URL", "GUARD_SIDECAR_PORT", 8009, "http://127.0.0.1"),
    search: serviceUrl("COS_SEARCH_URL", "SEARCH_SIDECAR_PORT", 8008, "http://127.0.0.1"),
    fitness: servicePort("FITNESS_BRIDGE_PORT", 8011),
  }) + "\n",
);
