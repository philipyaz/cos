/**
 * Default "views on diet" context returned by `GET /api/nutrition/diet-profile`
 * and the `get_diet_profile` MCP tool when `dietProfile.philosophy` is unset.
 * It is study-grounded methodology the planning AGENT reasons over to author
 * daily nutrition targets — the component never executes it as code. Fully
 * user-overridable: vegan / keto / halal users replace it via `set_diet_profile`.
 */
export const DEFAULT_DIET_PHILOSOPHY = `# Daily Nutrition Targets for Any Body-Composition Objective

This is the default methodology for translating a user's stated body-composition
goal into daily nutrition targets — fat loss, muscle/mass gain, body recomposition,
maintenance, and performance. It covers the inputs to gather, the math per objective,
macro logic, the universal feedback loop, and guardrails. It is grounded in the
strongest current evidence (meta-analyses and controlled trials cited at the end).

**The unifying idea:** *Maintenance (TDEE) is the hub. Every objective is a calorie offset from maintenance, paired with an objective-specific protein target and a safe rate of change. Training status — not just body weight — decides what is physically achievable.*

## 1. The objective taxonomy

A user's goal selects which math runs. There are really six, and two user properties (body composition and **training status**) become as important as weight:

| Objective | What the user wants | Energy stance |
|---|---|---|
| **Fat loss (cut)** | Lose fat, keep muscle | Deficit |
| **Lean muscle gain (bulk)** | Add muscle, minimize fat | Small surplus |
| **Body recomposition** | Lose fat *and* gain muscle at once | Maintenance / small deficit |
| **Maintenance** | Hold current physique | Balance |
| **Performance / sport** | Fuel training & recovery | ≥ maintenance |
| **Health-driven** | General/metabolic health | Usually maintenance + food quality |

The key correction: **the surplus/deficit is the smaller decision. The protein target and the rate cap, both of which depend on training status and body composition, are what make a plan work or fail.**

## 2. Inputs the system needs (expanded profile)

Beyond weight/height/age/sex, capture:

- **Body composition** (body-fat %, fat-free mass) if a smart scale / DXA / BIA is available. Lets you scale protein to FFM and use the Katch–McArdle BMR equation, both of which matter most at the extremes (very lean or high body fat).
- **Training status** — the single most important field: *novice* (<~1 yr consistent resistance training), *intermediate* (~1–3 yr), *advanced* (>3 yr). This governs how fast muscle can be gained and how favorably a surplus or deficit partitions between muscle and fat.
- **Whether they resistance train at all.** Without a progressive resistance stimulus, "gain muscle" and "recomp" are not on the table regardless of diet — nutrition is permissive, training is causal. Protein supplementation does essentially nothing for strength/size without resistance training.
- **Objective + target + timeline**, plus any medical conditions, dietary preferences, and meal frequency.

## 3. The universal engine

Estimate **maintenance** = BMR (Mifflin–St Jeor; or Katch–McArdle if FFM known) × activity multiplier. Treat it as a *starting prior* (the equation is within ±10% of measured RMR only ~half the time), then correct it against measured response (Section 6).

\`\`\`
maintenance (TDEE) = BMR × activity_factor          ← the hub
target_intake      = maintenance + objective_offset  ← Section 4
macros             = split(target_intake, objective) ← Section 5
\`\`\`

## 4. The math, per objective

### A. Fat loss
Deficit of **~10–25% below maintenance** (≈300–1,000 kcal), capped so the **rate stays at 0.25–1.0% of body weight per week** (leaner → slower). Protein goes **up** to preserve muscle (see Section 5). Don't trust the old 7,700-kcal/kg arithmetic for long-horizon predictions — it over-promises because metabolism adapts; use the feedback loop.

### B. Lean muscle gain (bulk)
Two evidence-based principles, both pointing the same way — **smaller is better**:
- **Surplus size:** ~**+5–15% over maintenance (≈+200–500 kcal/day)**. A controlled trial comparing a 5% vs 15% surplus in trained lifters found the larger surplus mostly added *fat*, with no extra muscle or strength. Expert off-season bodybuilding guidance (Iraki et al. 2019) lands at ~200–300 kcal/day. Bigger surpluses don't build muscle faster; they just require a later cut.
- **Rate target:** **+0.25–0.5% of body weight per week** on the scale.

The hard ceiling that bounds it all: **muscle accrues slowly, and the ceiling falls with training age.** Realistic *muscle* gain (not scale weight, which also includes water/glycogen/fat):

| Training status | Realistic muscle gain | Practical surplus |
|---|---|---|
| Novice (<1 yr) | ~0.5–1.0 kg/month | +300–500 kcal, top of rate range |
| Intermediate (1–3 yr) | ~0.2–0.4 kg/month | +200–400 kcal |
| Advanced (>3 yr) | <~0.2 kg/month | +150–300 kcal, or mini-surplus/maintenance cycling |

Because the muscle ceiling is low, any calories above it become fat. The surplus calories should come mostly from **carbohydrate** (to fuel training and fill glycogen), with some fat; protein stays at the hypertrophy target — it does *not* need to rise just because calories rose.

### C. Body recomposition (fat loss + muscle gain together)
Real, but conditional. It works best for, in rough order: **novices, returning trainees** (muscle memory makes regaining lost muscle faster), **higher-body-fat individuals** (ample fat stores can fuel muscle growth even in a deficit), and — with high protein and well-programmed training — even **trained** individuals (a substantial body of RCTs, summarized by Barakat et al. 2020, shows it). The trade-off: you will **not** maximize either fat loss or muscle gain; it's incremental progress on both.

Settings: calories at **maintenance or a small deficit**; **protein high** (Section 5); **progressive resistance training is mandatory**. Critical: **the scale is nearly useless here** — losing 2 kg fat while gaining 2 kg muscle shows zero scale change. Recomp *must* be tracked with body-composition signals (tape measurements, progress photos, BIA/DXA), not body weight, or the loop will look "stalled" when it's actually working.

### D. Maintenance
Intake = **measured TDEE**. Protein moderate (1.2–1.6 g/kg). Track against a small weight *band* (e.g., ±1–1.5 kg) rather than a point target, and only act when the trend leaves the band.

### E. Performance / sport
Here the binding constraint flips: the risk is **under-fueling**, not over-eating. Keep **energy availability ≥ ~30 kcal/kg FFM/day** (below that is the low-energy-availability / RED-S danger zone, with hormonal, bone, and performance costs — relevant for endurance athletes and especially women). Carbohydrate scales with training load (it's the limiter for hard/long sessions); protein 1.6–2.2 g/kg.

## 5. Macro logic (one procedure for all goals)

Order of operations is constant; only the protein coefficient changes by objective.

**1. Protein first** — anchor to body weight (or FFM / target weight for very lean or high-body-fat users):

| Situation | Protein target |
|---|---|
| Maintenance / general | 1.2–1.6 g/kg |
| Muscle gain (surplus) | 1.6–2.2 g/kg |
| Fat loss or recomposition (deficit/maintenance) | **1.8–2.4 g/kg**, or 2.3–3.1 g/kg of **FFM** for lean/trained users |

The evidence base: meta-analysis (Morton et al. 2018) places the breakpoint for added muscle from protein at **~1.6 g/kg/day**, with the confidence interval reaching ~2.2; newer analyses (Tagawa 2020, Nunes 2022) suggest trained lifters may benefit further toward ~2.2–2.4 g/kg. **Protein needs are highest, relative to body weight, during a deficit** — when the job shifts from building to *defending* muscle. The leaner the person and the steeper the deficit, the higher the requirement (scaling to FFM captures this).

**2. Fat to a floor** — **0.5–1.0 g/kg** (or ≥20–30% of calories) for hormonal health and fat-soluble vitamin absorption. Don't go below.

**3. Carbohydrate fills the remainder** — (target_kcal − protein_kcal − fat_kcal) / 4. Carbs flex most: high for gaining/performance, lower (preference-driven) for cutting. There's no fixed metabolic requirement that forces carbs before this step; **adherence and training fuel are what matter.**

(Energy densities: protein 4, carb 4, fat 9 kcal/g.)

**Per-meal distribution (a minor optimization on top of daily totals):** aim for **~0.4 g/kg of protein per meal** (up to ~0.55 g/kg at higher daily intakes) across **3–5 meals**, each with a leucine-rich/complete source. Even distribution modestly beats skewing everything to dinner for 24-h muscle protein synthesis. But the headline finding is that **total daily protein dominates** — the "anabolic window" is wide (roughly 4–6 hours around training, not 30 minutes), and absorption isn't capped per meal; only the *rate of use for muscle building* is. So treat timing as fine-tuning, not a make-or-break.

## 6. The universal closed loop

Every estimate above carries error, so measure the response and correct — and this works for surpluses too, not just deficits.

Over a trailing 10–14 day window:

\`\`\`
measured_TDEE ≈ mean_daily_intake − (Δweight_trend[kg] × 7700) / days
\`\`\`

Then re-anchor target = measured_TDEE + objective_offset. How to steer per goal:
- **Cut:** weight trend not dropping at target rate → increase deficit (or it's stalled adaptation); dropping too fast → ease up (protects muscle).
- **Bulk:** gaining slower than target → add ~100–150 kcal; faster than ~0.5%/wk → trim ~100–150 kcal (the excess is fat).
- **Recomp:** the scale won't move meaningfully — drive the loop off **body-composition trend** (waist tape, photos, periodic BIA/DXA), not weight.
- **Maintenance:** act only when the trend exits the band.

Two essentials: **smooth the weight signal** (7-day moving average or an exponentially-weighted trend — daily swings of 0.5–1+ kg from water/glycogen/gut contents are noise), and **recompute on cadence** (every 2–4 weeks or ~2–4 kg of change), since TDEE drifts as body mass changes.

## 7. Guardrails (hard constraints, by objective)

- **Universal energy-availability floor:** keep intake above ~**30 kcal/kg FFM/day**. This is a better, body-aware floor than the crude "1,200 kcal women / 1,500 kcal men" rule and protects lean/active users from RED-S. Very-low-calorie diets (<800 kcal) are medical-supervision-only.
- **Fat loss:** cap deficit ~20–25% / rate ≤1%/wk; don't accept a target below a healthy BMI (~18.5); floor protein and fat so a low-calorie plan never produces a dangerous split.
- **Muscle gain:** enforce the rate cap (≤~0.5%/wk) to limit fat gain — refuse to "bulk faster"; flag if a goal pushes into an unhealthy high BMI without context (e.g., not lean/muscular).
- **Recomposition:** set expectations explicitly (slow; scale won't move) and require a body-comp tracking method, or the user will think it's failing.
- **All goals:** route users with relevant conditions (pregnancy/breastfeeding, eating-disorder history, diabetes/CKD/etc., under-18) to a clinician or registered dietitian. The agent is informational, not a substitute for medical care. Avoid enabling extreme targets in **either** direction.

## 8. Worked examples

**Lean bulk** — 28 y male, 178 cm, 75 kg, intermediate, lightly-to-moderately active.
\`\`\`
BMR  = 10·75 + 6.25·178 − 5·28 + 5 = 1728 kcal
TDEE = 1728 × 1.55 = 2678 kcal
surplus +10% ≈ +270 → target ≈ 2950 kcal      (rate target ≈ +0.25%/wk ≈ +0.19 kg/wk)
protein 2.0 g/kg × 75 = 150 g → 600 kcal
fat     0.8 g/kg × 75 = 60 g  → 540 kcal
carbs   (2950 − 600 − 540)/4  ≈ 452 g → 1810 kcal
\`\`\`
→ **2950 kcal · P150 / F60 / C452.** Most of the surplus went to carbs (training fuel). If the scale climbs >0.5%/wk, trim ~150 kcal — that overage is fat.

**Recomposition** — 35 y male, 170 cm, 80 kg, ~28% body fat (FFM ≈ 58 kg), returning after a layoff, lightly active. Goal: leaner + add muscle.
\`\`\`
BMR  = 10·80 + 6.25·170 − 5·35 + 5 = 1693 kcal
TDEE = 1693 × 1.375 = 2328 kcal
small deficit −10% → target ≈ 2100 kcal       (scale stays ~flat; waist should shrink)
protein ~2.0 g/kg target-weight (~80 kg lean goal) = 160 g → 640 kcal
fat     0.8 g/kg × 80 = 64 g → 576 kcal
carbs   (2100 − 640 − 576)/4 ≈ 221 g → 884 kcal
\`\`\`
→ **2100 kcal · P160 / F64 / C221.** Resistance training non-negotiable; track tape/photos/BIA, not the scale.

## Evidence base (selected)

- **Protein for muscle:** Morton et al., *Br J Sports Med* (2018) — ~1.6 g/kg breakpoint (CI to ~2.2); Tagawa (2020) and Nunes (2022) suggest benefit toward ~2.2–2.4 g/kg in trained lifters; resistance training required for any strength effect (dose-response meta-analysis, 2022).
- **Protein in a deficit / recomp:** ISSN Position Stand (2.3–3.1 g/kg FFM for trained in hypocaloric states); ASN/NAASO obesity statement; lean-mass-preservation meta-analyses (≥1.2–1.6 g/kg general).
- **Surplus size:** RCT on 5% vs 15% surplus in trained lifters (Sports Med Open, 2023) — larger surplus added fat, not muscle; Iraki et al. (2019) off-season bodybuilding guidance (~200–300 kcal).
- **Body recomposition:** Barakat et al., *Strength & Conditioning Journal* (2020) — recomp documented even in trained populations with high protein + progressive RT.
- **Protein distribution / window:** Schoenfeld & Aragon (2018) — ~0.4 g/kg per meal, ≥4 meals; Aragon & Schoenfeld anabolic-window review (~4–6 h); total daily protein is the dominant variable.
- **Energy expenditure & adaptation:** Mifflin–St Jeor accuracy reviews; Hall & Chow (2013) and the 2012 ASN/ILSI consensus on why the static 3,500-kcal rule over-predicts; NIH Body Weight Planner.

*This guidance is an engineering/informational reference, not individualized medical or dietary advice; route users with medical conditions to qualified professionals.*`;
