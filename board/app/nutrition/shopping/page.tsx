import { notFound } from "next/navigation";
import { readDB } from "@/lib/store";
import { isAddonEnabled } from "@/lib/addons";
import { computeShoppingCandidates } from "@/lib/shopping-candidates";
import { toISODay, addDays } from "@/lib/nutrition-format";
import { TopBar } from "@/components/topbar";
import { ShoppingView } from "@/components/nutrition/shopping-view";

// The Shopping surface — the fourth Nutrition & Chef vertical, and the first BOARD surface over
// db.shoppingItems (cos-ops#37 shipped the state; this is the UI half, cos-ops#38). A server
// component (like the other three nutrition pages) that SSR-seeds the interactive client view:
// the persisted list AND the computed Suggested candidates, the latter seeded by calling
// computeShoppingCandidates DIRECTLY — the log/page.tsx `bodyBaseline` precedent for server-side
// pure compute as an SSR seed, rather than the page fetching its own HTTP surface. GATED — a
// disabled "nutrition" add-on 404s (notFound), so it has no reachable surface even though its
// data stays readable via the API.
export const dynamic = "force-dynamic";

export default async function ShoppingPage() {
  const db = await readDB();
  if (!isAddonEnabled(db, "nutrition")) notFound();

  // ONE request-time clock — mirrors log/page.tsx: an ISO instant for the client (the "bought
  // X ago" hint) + the local calendar day the engine projects against.
  const clock = new Date();
  const now = clock.toISOString();
  const today = toISODay(clock);

  // Mirror the candidates route's own default window EXACTLY (candidates/route.ts:16-18) — the
  // vertical's single noon-anchored addDays, never a second implementation — so the SSR seed and
  // every client refetch agree on what "Suggested" means.
  const result = computeShoppingCandidates({
    mealPlanEntries: db.mealPlanEntries ?? [],
    foodLogs: db.foodLogs ?? [],
    pantryItems: db.pantryItems ?? [],
    nutritionTargets: db.nutritionTargets ?? [],
    shoppingItems: db.shoppingItems ?? [],
    from: today,
    to: addDays(today, 6),
    today,
  });

  return (
    <>
      <TopBar crumbs={["Cos", "Nutrition & Chef", "Shopping"]} live />
      <ShoppingView
        now={now}
        items={db.shoppingItems ?? []}
        candidates={result.candidates}
        version={db.version}
      />
    </>
  );
}
