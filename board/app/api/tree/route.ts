import { NextResponse, type NextRequest } from "next/server";
import { readDB } from "@/lib/store";
import { buildForest, type TreeNode } from "@/lib/selectors";
import { VALID_DOMAIN, type CaseDomain } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET /api/tree?includeArchived=0&domain=work|life&hideDone=1 → { tree: TreeNode[], version }.
// The STRATEGY view's read surface: buildForest() projects the flat db.cases
// (containers + leaves) into the Initiative > Workstream > Case forest with rollup
// progress per container. By default archived nodes are pruned; includeArchived=1
// keeps them. A `domain` filter keeps only roots whose own domain matches (kept
// deliberately simple — a root's domain is the initiative-level theme). hideDone=1
// PRESENTATION-ONLY-prunes finished leaf cases from the tree — the rollups still
// count done leaves (built before the prune), so a container's progress bar is
// unchanged; only the visible leaf rows shrink.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const sp = req.nextUrl.searchParams;
  const includeArchived = sp.get("includeArchived") === "1" || sp.get("includeArchived") === "true";
  const hideDone = sp.get("hideDone") === "1" || sp.get("hideDone") === "true";

  const rawDomain = sp.get("domain");
  const domain: CaseDomain | null =
    rawDomain && VALID_DOMAIN.includes(rawDomain as CaseDomain) ? (rawDomain as CaseDomain) : null;

  const db = await readDB();
  let tree: TreeNode[] = buildForest(db.cases, { includeArchived, hideDoneLeaves: hideDone });
  if (domain) tree = tree.filter((n) => n.case.domain === domain);

  return NextResponse.json({ tree, version: db.version });
}
