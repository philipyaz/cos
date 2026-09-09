// Shared TSX source scanner for the A5 "phone-first controls" gates (cos-ops#82, #83).
//
// Built once in step 1 (text-entry-size.test.ts) and reused as-is in step 2
// (primary-action.test.ts) — same roots, same reporting shape, different tag list.
//
// Why this exists instead of a bare regex (the A5 census's own first attempt): a plain
// `/<select/` or `/text-\[\d+px\]/` scan over raw source is wrong in BOTH directions on this
// tree — it flags five `<select>`s that are only prose inside comments (label-filter.tsx:10,
// :114; case-detail-drawer.tsx — two comment mentions; artifact-feed.tsx:41), and it misses seven real
// controls whose size is set through same-file indirection a bare scan never resolves
// (fitness/overview-view.tsx's INPUT_CLASS constant, case-detail-drawer.tsx's `common` spread
// object). This module strips comments (quote-aware) and resolves same-file className
// constants/spreads/template-interpolations before anything is measured.
//
// Known floors (accepted, not fixed — stated so a future reader doesn't rediscover them):
//   - `stripComments` reads in JS-string-quoting mode, so a bare apostrophe or `//` sitting in
//     literal JSX TEXT (not inside a string/comment) could in principle desynchronise the walk
//     — a `'` there is treated as opening a string, and a `//` after it as ordinary text
//     instead of a comment. Verified harmless on today's tree: every apostrophe under
//     `board/components/**` sits in a `//`/`/* */` comment, which is already blanked out
//     before the desync could occur. The vacuous-pass floors in each *.test.ts would catch a
//     walk that actually went quiet from this.
//   - `resolveExpr`'s ternary handling is a pragmatic "pull every quoted string literal out of
//     the expression" pass, not a real parser — it matches this tree's actual shapes (a
//     `cond ? "a" : "b"` inside a template interpolation) and nothing fancier. A ternary whose
//     arms aren't plain string literals falls through to "unresolved", which the callers'
//     fail-closed handling turns into a reported violation rather than a silent skip.

import fs from "node:fs";
import path from "node:path";

/** Recursively collect every .tsx/.ts file under the given root directories, sorted. */
export function walkTsx(rootDirs) {
  const out = [];
  for (const root of rootDirs) walk(root, out);
  out.sort();
  return out;
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // root doesn't exist — caller's floor assertion will notice the shortfall
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && (full.endsWith(".tsx") || full.endsWith(".ts"))) out.push(full);
  }
}

/**
 * Replace every `//…` and `/*…*​/` span with same-length whitespace (newlines preserved, so
 * line numbers computed against the result still match the original file). Quote-aware: a
 * string or template literal's contents are never scanned for comment starters, and a
 * template's `${…}` interpolation resumes real code scanning (so a comment INSIDE an
 * interpolation is still stripped, and a `//` in the template's literal text is not).
 */
export function stripComments(src) {
  const stack = ["CODE"];
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = src[i];
    const c2 = src[i + 1];
    if (top === "CODE") {
      if (c === "/" && c2 === "/") {
        while (i < n && src[i] !== "\n") {
          out += " ";
          i++;
        }
        continue;
      }
      if (c === "/" && c2 === "*") {
        out += "  ";
        i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
          out += src[i] === "\n" ? "\n" : " ";
          i++;
        }
        if (i < n) {
          out += "  ";
          i += 2;
        }
        continue;
      }
      if (c === "{") {
        stack.push("CODE");
        out += c;
        i++;
        continue;
      }
      if (c === "}") {
        if (stack.length > 1) stack.pop();
        out += c;
        i++;
        continue;
      }
      if (c === '"') {
        stack.push('STR"');
        out += c;
        i++;
        continue;
      }
      if (c === "'") {
        stack.push("STR'");
        out += c;
        i++;
        continue;
      }
      if (c === "`") {
        stack.push("TEMPLATE");
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (top === 'STR"' || top === "STR'") {
      const q = top === 'STR"' ? '"' : "'";
      if (c === "\\") {
        out += c + (c2 ?? "");
        i += 2;
        continue;
      }
      if (c === q) stack.pop();
      out += c;
      i++;
      continue;
    }
    // top === "TEMPLATE"
    if (c === "\\") {
      out += c + (c2 ?? "");
      i += 2;
      continue;
    }
    if (c === "`") {
      stack.pop();
      out += c;
      i++;
      continue;
    }
    if (c === "$" && c2 === "{") {
      stack.push("CODE");
      out += "${";
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * From `src[openIdx] === '{'`, return the index of its matching `}` — quote- and
 * template-aware, so a `}` inside a string/template (or inside a NESTED `${…}`) never closes
 * the outer brace early. Returns -1 if unmatched (malformed/EOF).
 */
function findMatchingBrace(src, openIdx) {
  const stack = ["CODE"];
  let i = openIdx + 1;
  const n = src.length;
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = src[i];
    if (top === "CODE") {
      if (c === "{") {
        stack.push("CODE");
        i++;
        continue;
      }
      if (c === "}") {
        stack.pop();
        if (stack.length === 0) return i;
        i++;
        continue;
      }
      if (c === '"') {
        stack.push('STR"');
        i++;
        continue;
      }
      if (c === "'") {
        stack.push("STR'");
        i++;
        continue;
      }
      if (c === "`") {
        stack.push("TEMPLATE");
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (top === 'STR"' || top === "STR'") {
      const q = top === 'STR"' ? '"' : "'";
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === q) stack.pop();
      i++;
      continue;
    }
    // top === "TEMPLATE"
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      stack.pop();
      i++;
      continue;
    }
    if (c === "$" && src[i + 1] === "{") {
      stack.push("CODE");
      i += 2;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * For each `<tagName` in `tagNames` found at a word boundary in `src` (already
 * comment-stripped), consume forward tracking quote state and brace depth, stopping at the
 * first `>` reached at depth 0 outside any quote. Returns `{tag, attrText, line}` per match;
 * a tag whose end is never found (malformed/EOF) is silently skipped.
 */
export function openingTags(src, tagNames) {
  const nameSet = new Set(tagNames);
  const results = [];
  const tagRe = /<([A-Za-z][A-Za-z0-9]*)/g;
  let m;
  while ((m = tagRe.exec(src))) {
    const tag = m[1];
    if (!nameSet.has(tag)) continue;
    const start = m.index;
    const afterIdx = start + 1 + tag.length;

    const stack = ["CODE"];
    let i = afterIdx;
    let end = -1;
    while (i < src.length) {
      const top = stack[stack.length - 1];
      const c = src[i];
      if (top === "CODE") {
        if (c === "{") {
          stack.push("CODE");
          i++;
          continue;
        }
        if (c === "}") {
          if (stack.length > 1) stack.pop();
          i++;
          continue;
        }
        if (c === '"') {
          stack.push('STR"');
          i++;
          continue;
        }
        if (c === "'") {
          stack.push("STR'");
          i++;
          continue;
        }
        if (c === "`") {
          stack.push("TEMPLATE");
          i++;
          continue;
        }
        if (c === ">" && stack.length === 1) {
          end = i;
          break;
        }
        i++;
        continue;
      }
      if (top === 'STR"' || top === "STR'") {
        const q = top === 'STR"' ? '"' : "'";
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === q) stack.pop();
        i++;
        continue;
      }
      // top === "TEMPLATE"
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        stack.pop();
        i++;
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        stack.push("CODE");
        i += 2;
        continue;
      }
      i++;
    }
    if (end === -1) continue;
    const attrText = src.slice(afterIdx, end);
    const line = src.slice(0, start).split("\n").length;
    results.push({ tag, attrText, line });
  }
  return results;
}

/** The string literal of `name="…"` / `name='…'` inside attrText, or null. */
export function attrLiteral(attrText, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(["'])((?:(?!\\1).)*)\\1`);
  const m = attrText.match(re);
  return m ? m[2] : null;
}

/** `const IDENT = "…"` (or `const IDENT: Type = "…"`) anywhere in `src`; null if absent. */
function resolveSameFileConst(src, ident) {
  const re = new RegExp(`\\bconst\\s+${ident}\\s*(?::[^=]+)?=\\s*(["'])((?:(?!\\1).)*)\\1`);
  const m = src.match(re);
  return m ? m[2] : null;
}

/** The full `{ … }` text of `const IDENT = { … }` anywhere in `src`; null if absent. */
function findSameFileConstObject(src, ident) {
  const re = new RegExp(`\\bconst\\s+${ident}\\s*(?::[^=]+)?=\\s*\\{`);
  const m = re.exec(src);
  if (!m) return null;
  const braceIdx = m.index + m[0].length - 1;
  const closeIdx = findMatchingBrace(src, braceIdx);
  if (closeIdx === -1) return null;
  return src.slice(braceIdx, closeIdx + 1);
}

/** The `className: "…"` (or `'…'`) property value inside an object-literal source span. */
function extractClassNameFromObjectLiteral(objSrc) {
  const m = objSrc.match(/\bclassName\s*:\s*(["'])((?:(?!\1).)*)\1/);
  return m ? m[2] : null;
}

/** Resolve a `className={…}` expression's text (bare ident or template literal) to fragments. */
function resolveExpr(expr, src) {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(expr)) {
    const val = resolveSameFileConst(src, expr);
    return val !== null ? { fragments: [val], resolved: true } : { fragments: [], resolved: false };
  }
  if (expr.startsWith("`") && expr.endsWith("`")) {
    return resolveTemplate(expr.slice(1, -1), src);
  }
  return { fragments: [], resolved: false };
}

/** Split a template literal's inner text into static fragments + resolved `${…}` fragments. */
function resolveTemplate(inner, src) {
  const fragments = [];
  let resolvedAll = true;
  let i = 0;
  let staticStart = 0;
  while (i < inner.length) {
    if (inner[i] === "\\") {
      i += 2;
      continue;
    }
    if (inner[i] === "$" && inner[i + 1] === "{") {
      fragments.push(inner.slice(staticStart, i));
      const closeIdx = findMatchingBrace(inner, i + 1);
      if (closeIdx === -1) {
        resolvedAll = false;
        break;
      }
      const exprText = inner.slice(i + 2, closeIdx).trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exprText)) {
        const val = resolveSameFileConst(src, exprText);
        if (val !== null) fragments.push(val);
        else resolvedAll = false;
      } else {
        // Ternary-of-string-literals shape (this tree's only non-ident interpolation):
        // pull every quoted literal out rather than parsing the conditional properly.
        const strLits = [...exprText.matchAll(/"([^"]*)"|'([^']*)'/g)].map((mm) => mm[1] ?? mm[2]);
        if (strLits.length > 0) fragments.push(...strLits);
        else resolvedAll = false;
      }
      i = closeIdx + 1;
      staticStart = i;
      continue;
    }
    i++;
  }
  fragments.push(inner.slice(staticStart));
  return { fragments, resolved: resolvedAll };
}

/**
 * Every string fragment reachable from `attrText`'s className: a direct literal; a same-file
 * const identifier; a template literal's static text plus its resolved `${IDENT}` /
 * `${ternary}` interpolations; or, when the tag carries NO className attribute at all, a
 * `{...ident}` spread resolved against a same-file `const ident = { … className: "…" }`.
 * `resolved: false` means something class-bearing was found but couldn't be pinned down —
 * callers fail closed on that, they don't skip it.
 */
export function classNameStrings(attrText, src) {
  const lit = attrLiteral(attrText, "className");
  if (lit !== null) return { fragments: [lit], resolved: true };

  const idx = attrText.search(/\bclassName\s*=\s*\{/);
  if (idx !== -1) {
    const braceIdx = attrText.indexOf("{", idx);
    const closeIdx = findMatchingBrace(attrText, braceIdx);
    if (closeIdx === -1) return { fragments: [], resolved: false };
    const expr = attrText.slice(braceIdx + 1, closeIdx).trim();
    return resolveExpr(expr, src);
  }

  const spread = attrText.match(/\{\s*\.\.\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\}/);
  if (spread) {
    const objSrc = findSameFileConstObject(src, spread[1]);
    if (objSrc) {
      const cn = extractClassNameFromObjectLiteral(objSrc);
      if (cn !== null) return { fragments: [cn], resolved: true };
    }
    return { fragments: [], resolved: false };
  }

  return { fragments: [], resolved: false };
}

const NAMED_SIZES = {
  "text-xs": 12,
  "text-sm": 14,
  "text-base": 16,
  "text-lg": 18,
  "text-xl": 20,
};

/**
 * The UNPREFIXED `text-*` size tokens in a class string, as `{token, px}`. Variant-prefixed
 * tokens (`md:text-[13px]`, `focus:text-sm`) are deliberately skipped — Tailwind's breakpoints
 * are min-width and 390px sits below all of them, so the unprefixed token is what the phone
 * actually renders; `md:text-[13px]` layered over an unprefixed ≥16px base is the sanctioned
 * desktop-density route, not a violation. Known floor: a `max-*` variant (none exist in this
 * tree today) would evade this the same way `md:` is deliberately evaded.
 */
export function fontSizeTokens(classString) {
  const tokens = [];
  for (const w of classString.split(/\s+/).filter(Boolean)) {
    if (w.includes(":")) continue;
    let m = w.match(/^text-\[(\d+(?:\.\d+)?)px\]$/);
    if (m) {
      tokens.push({ token: w, px: parseFloat(m[1]) });
      continue;
    }
    m = w.match(/^text-\[(\d+(?:\.\d+)?)rem\]$/);
    if (m) {
      tokens.push({ token: w, px: parseFloat(m[1]) * 16 });
      continue;
    }
    if (NAMED_SIZES[w] !== undefined) {
      tokens.push({ token: w, px: NAMED_SIZES[w] });
    }
  }
  return tokens;
}
