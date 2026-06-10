import { NextResponse, type NextRequest } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveVaultConfig } from "@/lib/vault-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The active vault root + its Obsidian deep-link identity are resolved from config
// (cos.env VAULT_NAME / COS_VAULT_DIR + settings.json) — NOT hardcoded. See
// board/lib/vault-config.ts. The same resolver drives the case drawer's obsidian://
// link, so the preview and the deep-link can never point at different vaults.

// Folders searched for a wikilink title, in priority order.
// The vault is domain-split: wiki pages live under work/wiki/{entities,concepts,
// sources}, life/wiki/{entities,concepts,sources}, and shared/wiki/entities.
const SEARCH_DIRS = [
  "work/wiki/entities",
  "work/wiki/concepts",
  "work/wiki/sources",
  "life/wiki/entities",
  "life/wiki/concepts",
  "life/wiki/sources",
  "shared/wiki/entities",
  "life",
  "work",
];

// Recursively list .md files under a dir (depth-limited so we don't wander the
// whole tree). Missing dirs yield []. Returns absolute paths.
async function listMarkdown(dir: string, depth = 3): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) {
      out.push(...(await listMarkdown(full, depth - 1)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

// First markdown H1 ("# Title") in a file's text, trimmed — or "".
function firstH1(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  return "";
}

// GET ?title=<page title> → resolve a wikilink title to a vault page by filename
// (sans .md) or H1 match, searching {work,life}/wiki/{entities,concepts,sources},
// shared/wiki/entities, life/, work/.
// Path-safe: the resolved file MUST stay inside VAULT_ROOT. Read-only.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const cfg = resolveVaultConfig();
  const identity = {
    vaultName: cfg.name,
    obsidianVaultId: cfg.obsidianVaultId,
    obsidianVaultName: cfg.obsidianVaultName,
  };

  const title = (req.nextUrl.searchParams.get("title") ?? "").trim();
  // No title ⇒ an IDENTITY request: return only the vault identity (the case drawer
  // fetches this once on mount to build its obsidian:// deep-link). 200, not 400.
  if (!title) {
    return NextResponse.json(identity);
  }

  const want = title.toLowerCase();
  const rootReal = path.resolve(cfg.dir);

  // Pass 1: filename match (cheap, no file reads). Pass 2: H1 match.
  const candidates: string[] = [];
  for (const rel of SEARCH_DIRS) {
    candidates.push(...(await listMarkdown(path.join(rootReal, rel))));
  }

  // Filename match first.
  let hit = candidates.find((f) => path.basename(f, ".md").toLowerCase() === want);

  // Then H1 match.
  if (!hit) {
    for (const f of candidates) {
      let text: string;
      try {
        text = await fs.readFile(f, "utf8");
      } catch {
        continue;
      }
      if (firstH1(text).toLowerCase() === want) {
        hit = f;
        break;
      }
    }
  }

  if (!hit) {
    return NextResponse.json({ error: `No vault page found for “${title}”.` }, { status: 404 });
  }

  // Path-safety: the resolved file must live under the vault root (defence in
  // depth — candidates are already scoped, but guard against any symlink escape).
  const resolved = path.resolve(hit);
  if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) {
    return NextResponse.json({ error: "Resolved path escapes the vault root." }, { status: 400 });
  }

  let markdown: string;
  try {
    markdown = await fs.readFile(resolved, "utf8");
  } catch {
    return NextResponse.json({ error: `Could not read vault page “${title}”.` }, { status: 404 });
  }

  return NextResponse.json({
    title,
    path: path.relative(rootReal, resolved),
    markdown,
    ...identity,
  });
}
