import { NextResponse } from "next/server";
import { writeFile } from "fs/promises";
import path from "path";

const PROFILE_FILE = path.join(process.cwd(), "data", "candidate-profile.json");

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const profileJson = formData.get("profile") as string | null;

    if (!profileJson) {
      return NextResponse.json(
        { error: "Fournissez un profil extrait." },
        { status: 400 }
      );
    }

    let profile: Record<string, unknown>;
    try {
      profile = JSON.parse(profileJson);
    } catch {
      return NextResponse.json(
        { error: "Le champ profile n'est pas du JSON valide." },
        { status: 400 }
      );
    }

    // Build a text summary for the analyze route
    const lines: string[] = [];
    if (profile.nom) lines.push(`Nom: ${profile.nom}`);
    if (profile.titre) lines.push(`Titre / poste actuel: ${profile.titre}`);
    if (profile.localisation) lines.push(`Localisation: ${profile.localisation}`);
    if (profile.disponibilite) lines.push(`Disponibilite: ${profile.disponibilite}`);
    if (Array.isArray(profile.competences) && profile.competences.length)
      lines.push(`Competences cles: ${profile.competences.join(", ")}`);
    if (Array.isArray(profile.langues) && profile.langues.length)
      lines.push(`Langues: ${profile.langues.join(", ")}`);
    if (Array.isArray(profile.formations) && profile.formations.length)
      lines.push(`Formations: ${profile.formations.join("; ")}`);

    const saved = {
      updatedAt: new Date().toISOString(),
      nom: profile.nom ?? null,
      titre: profile.titre ?? null,
      localisation: profile.localisation ?? null,
      disponibilite: profile.disponibilite ?? null,
      competences: Array.isArray(profile.competences) ? profile.competences : [],
      langues: Array.isArray(profile.langues) ? profile.langues : [],
      formations: Array.isArray(profile.formations) ? profile.formations : [],
      rawContent: lines.join("\n"),
    };

    await writeFile(PROFILE_FILE, JSON.stringify(saved, null, 2), "utf8");
    console.log(`[profile/ingest] Saved profile to ${PROFILE_FILE}`);

    return NextResponse.json({ status: "saved", profile: saved });
  } catch (e) {
    return NextResponse.json(
      { error: `Ingest failed: ${(e as Error).message}` },
      { status: 500 }
    );
  }
}
