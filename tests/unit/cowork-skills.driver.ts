// Driver for cowork-skills.test.ts's 11b (default-resolution) pin — spawned with
// cwd=REPO_ROOT so it exercises repoSkillFiles()'s no-argument default from the exact
// cwd tests/run.sh [1] runs the unit tests from, without the test file itself having to
// mutate its own process's cwd (which would leak into every test that runs after it).
import { repoSkillFiles } from "../../board/lib/cowork-skills";

process.stdout.write(JSON.stringify(repoSkillFiles()));
