// Pure helpers over the label catalog (db.labels). The API routes call these
// inside mutate() so catalog edits and label-id validation share the store's lock.
// Kept separate from store.ts (which owns the case/task primitives) so the catalog
// logic stays self-contained. Bundle DEFINITIONS live in label-bundles.ts; this is
// the mutating/validation layer over the per-user active catalog.

import type { DBShape, LabelColor, LabelDef, CaseDomain } from "./types";
import { VALID_LABEL_COLORS, VALID_DOMAIN } from "./types";
import { BadRequestError, NotFoundError } from "./store";
import { findBundle } from "./label-bundles";

// The active catalog, always an array (parseAndMigrate guarantees db.labels exists
// in memory, but be defensive for callers holding a hand-built db).
export function activeLabels(db: DBShape): LabelDef[] {
  if (!db.labels) db.labels = [];
  return db.labels;
}

export function labelById(db: DBShape, id: string): LabelDef | undefined {
  return activeLabels(db).find((l) => l.id === id);
}

export function labelIdSet(db: DBShape): Set<string> {
  return new Set(activeLabels(db).map((l) => l.id));
}

// Throw a 400-mapped error if any id isn't in the catalog. This is the anti-failure
// contract: a case write naming an unknown label fails LOUDLY with the valid set, so
// a caller (skill/agent) learns to fetch GET /api/labels first rather than silently
// dropping a category. `[]` / undefined is a no-op (clearing labels is always fine).
export function assertKnownLabels(db: DBShape, ids: unknown): void {
  if (ids === undefined || ids === null) return;
  if (!Array.isArray(ids)) {
    throw new BadRequestError("'labels' must be an array of label ids.");
  }
  const known = labelIdSet(db);
  const unknown = Array.from(
    new Set(ids.map((x) => String(x).trim()).filter((s) => s && !known.has(s))),
  );
  if (unknown.length) {
    const valid = Array.from(known).sort();
    throw new BadRequestError(
      `Unknown label id(s): ${unknown.join(", ")}. ` +
        (valid.length
          ? `Valid ids: ${valid.join(", ")}. `
          : "The label catalog is empty — install a bundle first. ") +
        "Fetch GET /api/labels (or the list_labels tool) for the catalog.",
    );
  }
}

// kebab-case a title into an id seed.
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// Mint a unique id from a seed, suffixing -2, -3 … against the taken set.
export function mintLabelId(seed: string, taken: Set<string>): string {
  const base = slugify(seed) || "label";
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

const coerceColor = (v: unknown): LabelColor | undefined =>
  typeof v === "string" && VALID_LABEL_COLORS.includes(v as LabelColor) ? (v as LabelColor) : undefined;
const coerceDomain = (v: unknown): CaseDomain | undefined =>
  typeof v === "string" && VALID_DOMAIN.includes(v as CaseDomain) ? (v as CaseDomain) : undefined;

// Add a single custom label to the catalog. Validates title/description; mints a
// unique id from the title (or honours a provided, still-unique id). Throws
// BadRequestError on bad input or a colliding explicit id.
export function addCustomLabel(
  db: DBShape,
  input: { id?: unknown; title?: unknown; description?: unknown; color?: unknown; domain?: unknown },
): LabelDef {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) throw new BadRequestError("'title' is required (a non-empty string).");
  const description = typeof input.description === "string" ? input.description.trim() : "";

  const taken = labelIdSet(db);
  let id: string;
  if (typeof input.id === "string" && input.id.trim()) {
    id = slugify(input.id);
    if (!id) throw new BadRequestError("'id' must contain at least one alphanumeric character.");
    if (taken.has(id)) throw new BadRequestError(`Label id '${id}' already exists.`);
  } else {
    id = mintLabelId(title, taken);
  }

  const label: LabelDef = { id, title, description };
  const color = coerceColor(input.color);
  if (color) label.color = color;
  const domain = coerceDomain(input.domain);
  if (domain) label.domain = domain;

  activeLabels(db).push(label);
  return label;
}

// A bundle label skipped on install because the catalog already has that id with a
// DIFFERENT definition (shared ids across bundles are intentional — a shared concept
// installs once — but a genuine meaning mismatch is surfaced, not silently dropped).
export interface BundleConflict {
  id: string;
  kept: { title: string; description: string; bundle?: string };
  skipped: { title: string; description: string };
}

// Install a built-in bundle: union its labels into the catalog by id (idempotent —
// an id already present is left untouched), stamping each new one's `bundle`
// provenance. Returns the ids actually added plus any `conflicts` (an existing
// same-id label whose title/description differs from this bundle's — the existing
// one is KEPT). Throws NotFoundError for a bad id.
export function installBundle(
  db: DBShape,
  bundleId: string,
): { installed: string[]; conflicts: BundleConflict[] } {
  const bundle = findBundle(bundleId);
  if (!bundle) throw new NotFoundError(`Label bundle '${bundleId}' not found.`);
  const cat = activeLabels(db);
  const byId = new Map(cat.map((l) => [l.id, l]));
  const installed: string[] = [];
  const conflicts: BundleConflict[] = [];
  for (const l of bundle.labels) {
    const existing = byId.get(l.id);
    if (existing) {
      if (existing.title !== l.title || (existing.description ?? "") !== (l.description ?? "")) {
        conflicts.push({
          id: l.id,
          kept: { title: existing.title, description: existing.description ?? "", bundle: existing.bundle },
          skipped: { title: l.title, description: l.description ?? "" },
        });
      }
      continue; // idempotent: keep the existing definition
    }
    const copy: LabelDef = { ...l, bundle: bundle.id };
    cat.push(copy);
    byId.set(l.id, copy);
    installed.push(l.id);
  }
  return { installed, conflicts };
}

// Uninstall a bundle: remove every catalog label whose PROVENANCE is this bundle
// (`label.bundle === bundleId`). This is the clean inverse of installBundle —
// a label shared across bundles is owned (provenance) by whichever installed it
// first, so only that bundle's uninstall removes it; custom labels (no provenance)
// are never touched. With `scrub`, also strip the removed ids from every
// case.labels. Returns the removed ids + how many cases were scrubbed. Throws
// NotFoundError for an unknown bundle id.
export function uninstallBundle(
  db: DBShape,
  bundleId: string,
  opts: { scrub?: boolean } = {},
): { removed: string[]; scrubbed: number } {
  if (!findBundle(bundleId)) throw new NotFoundError(`Label bundle '${bundleId}' not found.`);
  const cat = activeLabels(db);
  const removed: string[] = [];
  const keep: LabelDef[] = [];
  for (const l of cat) {
    if (l.bundle === bundleId) removed.push(l.id);
    else keep.push(l);
  }
  if (removed.length) db.labels = keep;

  let scrubbed = 0;
  if (opts.scrub && removed.length) {
    const rm = new Set(removed);
    for (const c of db.cases) {
      if (c.labels?.some((id) => rm.has(id))) {
        const next = c.labels.filter((id) => !rm.has(id));
        c.labels = next.length ? next : undefined;
        scrubbed++;
      }
    }
  }
  return { removed, scrubbed };
}

// How many catalog labels are OWNED by a bundle (provenance match) — i.e. would be
// removed by uninstallBundle. Distinct from "present" (a shared id may be in the
// catalog but owned by a different bundle). Drives the UI's Uninstall affordance.
export function ownedCount(db: DBShape, bundleId: string): number {
  return activeLabels(db).filter((l) => l.bundle === bundleId).length;
}

// Patch an existing label's display fields. Identity (id) and provenance (bundle)
// are immutable here. Throws NotFoundError if the id isn't in the catalog.
export function updateLabelDef(
  db: DBShape,
  id: string,
  patch: { title?: unknown; description?: unknown; color?: unknown; domain?: unknown },
): LabelDef {
  const label = labelById(db, id);
  if (!label) throw new NotFoundError(`Label '${id}' not found.`);
  if ("title" in patch) {
    const t = typeof patch.title === "string" ? patch.title.trim() : "";
    if (!t) throw new BadRequestError("'title' must be a non-empty string.");
    label.title = t;
  }
  if ("description" in patch) {
    label.description = patch.description == null ? "" : String(patch.description);
  }
  if ("color" in patch) {
    if (patch.color === null || patch.color === "") label.color = undefined;
    else {
      const c = coerceColor(patch.color);
      if (!c) throw new BadRequestError(`'color' must be one of: ${VALID_LABEL_COLORS.join(", ")}.`);
      label.color = c;
    }
  }
  if ("domain" in patch) {
    label.domain = patch.domain == null ? undefined : coerceDomain(patch.domain);
  }
  return label;
}

// Remove a label from the catalog. With `scrub`, also strip the id from every
// case.labels so no card keeps a dangling reference. Returns whether it existed.
export function removeLabelDef(db: DBShape, id: string, opts: { scrub?: boolean } = {}): boolean {
  const cat = activeLabels(db);
  const idx = cat.findIndex((l) => l.id === id);
  if (idx === -1) return false;
  cat.splice(idx, 1);
  if (opts.scrub) {
    for (const c of db.cases) {
      if (c.labels?.includes(id)) {
        c.labels = c.labels.filter((l) => l !== id);
        if (c.labels.length === 0) c.labels = undefined;
      }
    }
  }
  return true;
}
