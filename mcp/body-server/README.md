# `body` MCP server

The stdio MCP server for the Cos **Body** add-on — the single owner of body identity, the weight +
body-composition series, and the user's **free-text objective**. A thin `fetch` wrapper over the
board's `/api/body/*` routes (like `nutrition`/`calendar`); no sidecar, no external repo.

- **Bridge port:** `BODY_BRIDGE_PORT` (default `:8012`), set in `config/load-config.sh`.
- **Gate:** writes are gated behind `Settings.addons.body.enabled`; reads are always open. `body`
  **hard auto-enables** whenever the `nutrition` or `fitness` add-on is enabled.
- **Setup:** `/body-mcp-setup` (clones `/fitness-mcp-setup`).

## Tools

| Tool | Maps to | R/W |
|---|---|---|
| `get_body_profile` / `set_body_profile` | `/api/body/profile` | r / w |
| `get_body_objective` / `set_body_objective` | `/api/body/objective` | r / w |
| `log_weight` / `list_weights` / `delete_weight` | `/api/body/weight[/id]` | w / r / w |
| `get_body_status` | `/api/body/status` | r |

## The philosophy (read before authoring)

This server stores body **state**; it never recommends. The objective is **free text** (a paragraph
in the user's own words) plus one structured anchor (`targetWeightKg`). `get_body_status` returns
deterministic physiology **facts** (BMR / TDEE / BMI / trend / fat-free mass) — **not** a calorie or
macro plan. The agent reads the goal + the facts + the nutrition add-on's `get_diet_profile`
(allergies + the diet-views philosophy) and **authors** the daily targets via the nutrition add-on's
`save_nutrition_targets`. Allergies are honored by the **skills**, not enforced by this component.

## Run it directly

```sh
CRM_BASE_URL=http://localhost:3000 node mcp/body-server/server.mjs
```
