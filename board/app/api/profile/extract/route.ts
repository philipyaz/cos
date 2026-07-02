import { NextResponse } from "next/server";
import { writeFile, mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { readSecret } from "@/lib/jobs-store";

export async function POST(request: Request) {
  let tempDir: string | null = null;
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "Un fichier PDF est requis." }, { status: 400 });
    }

    const apiKey = readSecret("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY not configured in config/secrets.env" },
        { status: 500 }
      );
    }

    // Save PDF to temp dir, then read it as base64 for the Claude API
    const bytes = new Uint8Array(await file.arrayBuffer());
    tempDir = await mkdtemp(path.join(tmpdir(), "cos-cv-extract-"));
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = path.join(tempDir, safeName);
    await writeFile(filePath, bytes);

    const pdfBase64 = (await readFile(filePath)).toString("base64");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: pdfBase64,
                },
              },
              {
                type: "text",
                text: `Analyse ce CV et extrais les informations suivantes en JSON strict (pas de markdown, pas de code block).

{
  "nom": "<nom complet>",
  "titre": "<titre ou poste actuel>",
  "localisation": "<ville, pays>",
  "disponibilite": "<immediat, en poste, preavis X mois — deduis du contexte ou mets 'Non precise'>",
  "competences": ["<competence 1>", "<competence 2>", "..."],
  "langues": ["<langue 1 (niveau)>", "<langue 2 (niveau)>", "..."],
  "formations": ["<diplome 1 — etablissement, annee>", "<diplome 2>", "..."]
}

Reponds UNIQUEMENT avec le JSON, rien d'autre.`,
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json(
        { error: `Claude API returned ${res.status}: ${errText}` },
        { status: 502 }
      );
    }

    const data = await res.json();
    const responseText = data.content?.[0]?.text || "";
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json(
        { error: "Could not parse Claude response as JSON", raw: responseText },
        { status: 502 }
      );
    }

    const extracted = JSON.parse(jsonMatch[0]);
    return NextResponse.json(extracted);
  } catch (e) {
    return NextResponse.json(
      { error: `Extraction failed: ${(e as Error).message}` },
      { status: 500 }
    );
  } finally {
    if (tempDir) {
      const dir = tempDir;
      rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
