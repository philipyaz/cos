# Pantry capture — worked examples, the ambiguous-case gallery, and extraction tips

Depth for the [Bulk capture job](../SKILL.md#bulk-capture--a-photo-of-a-receipt-or-a-fridge-shelf)
in `nutrition-chef`. Read this the first time you run that job; the SKILL.md body only carries the
five-step workflow. Every name below is synthetic — it mirrors the *shape* of duplicates that
actually show up in a real pantry (the same food at two pack sizes, the same fruit in two
languages), never real inventory.

## Resolving semantic aliases — worked examples

`reconcile_pantry` only fixes the **mechanical** half of dedup (case, whitespace, accents, a
trailing plural). It cannot tell that two different-looking names are the *same food* — that
judgement is yours, done in step 2 of the capture job, **before** you submit.

- **Two pack sizes of one product.** `read_pantry` already shows `PANTRY-14 — "Tinned mackerel
  160g"` and `PANTRY-22 — "Tinned mackerel 200g"`. The receipt adds another 160g tin. Don't submit
  a third row — merge in your own reasoning and submit **one** update:
  `{ name: "Tinned mackerel 160g", quantity: 2, unit: "tins" }` (matches `PANTRY-14`'s normalised
  name, so it updates in place), and mention the untouched 200g tin in your report so Philip knows
  you left it alone rather than silently combined the two sizes into one count.
- **The same food, two languages.** `read_pantry` shows `PANTRY-31 — "Äpfel"`. The receipt reads
  "Apples x6". These are one item. Submit `{ name: "Äpfel", quantity: 6 }` — reusing the **existing**
  name as the match key updates `PANTRY-31` instead of minting a same-food second row under the
  English spelling. (Submitting `"Apples"` instead would also work — `normalizePantryName` strips
  accents and case, so `"Äpfel"` and `"apfel"` collide, but `"apples"` does **not** collide with
  `"äpfel"`; when the two names don't share a normalised form, YOU are the one who has to point
  both submissions at the same row.)
- **A brand name vs. a generic name.** Receipt: "Barilla Fusilli 500g". Pantry already has
  `PANTRY-8 — "Fusilli"`. Same product — update `PANTRY-8`'s quantity, don't add "Barilla Fusilli"
  as a new row. When in doubt, prefer the **existing** row's name as your submitted `name`.

## The ambiguous-case gallery — what to flag, not silently decide

Some pairs are **not** obviously the same or obviously different. These are exactly what belongs
in the collapsed-diff confirmation's *"N look like duplicates — merge?"* clause, rather than a
silent merge or a silent add:

- **Cut vs. product.** "Chicken thighs" on the receipt, `PANTRY-5 — "Chicken breast"` on hand.
  Different cuts of the same animal are **different pantry items** — do not merge these; add the
  thighs as new.
- **A qualifier that might matter.** Receipt: "Olive oil". Pantry: `PANTRY-19 — "Extra virgin olive
  oil"`. Plausibly the same bottle re-bought, plausibly a second, cheaper oil for cooking. Flag it
  by name in the confirmation rather than guessing either way: *"'Olive oil' looks like it might be
  PANTRY-19 (Extra virgin olive oil) — same or different?"*
- **A near-miss spelling that isn't a normalisation case.** "Courgette" vs. "Zucchini" — the same
  vegetable in two dialects, but nowhere near each other after normalisation (no shared accent/
  case/plural). Treat it exactly like the two-languages case above: resolve it yourself if you're
  confident, or name it in the confirmation if you're not.

When resolution is genuinely unclear, naming the item in the confirmation costs one line of chat
and is always safer than a silent merge (which could combine two different foods into one count)
or a silent add (which recreates the exact duplicate this job exists to prevent).

## Receipt / photo extraction tips

- **Skip the non-food lines.** Bag fees, deposits, loyalty discounts, subtotal/tax/total lines,
  and payment-method footers are not pantry items — don't extract them.
- **Quantity from repeated lines.** A receipt that lists the same item twice (two separate lines
  for two units bought at different per-unit promo prices) is **one** submitted item with the
  combined `quantity`, not two.
- **Category and location are your inference, not the receipt's.** Receipts don't print "produce"
  or "fridge" — infer them the same way JOB 2's single-add path does (spinach → produce/fridge,
  tinned goods → pantry/pantry, frozen peas → frozen/freezer).
- **Expiry dates come from packaging, not receipts — and never from your own estimate.** A receipt
  almost never prints a use-by date; a fridge-shelf photo sometimes shows one stamped on the
  package. Only set `expiresAt` when you can actually read a date, or the user states their own
  shelf life (*"good for a week"*) — **never estimate one yourself, single item or bulk batch.** An
  absent `expiresAt` is honest, and it is still monitored: the status read computes a per-class
  freshness horizon (`category` × `location` × `updatedAt`) at read time, never stored and never
  presented as a printed date — see JOB 0 and [`lifecycle.md`](lifecycle.md).
- **Illegible quantity/unit → omit, don't guess.** If a receipt line's weight or count is cut off
  or blurry, submit the item without `quantity`/`unit` rather than inventing a number — the same
  false-precision trap as food-log calories.
