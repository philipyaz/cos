import { NextResponse } from "next/server";
import { loadJobs, saveJobs } from "@/lib/jobs-store";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const minScore = searchParams.get("min_score");

  const db = loadJobs();
  let entries = db.entries;

  if (status) entries = entries.filter((e) => e.status === status);
  if (minScore) {
    const min = Number(minScore);
    entries = entries.filter((e) => typeof e.match_score === "number" && e.match_score >= min);
  }

  entries.sort((a, b) => {
    if (a.match_score !== null && b.match_score !== null) return b.match_score - a.match_score;
    if (a.match_score !== null) return -1;
    if (b.match_score !== null) return 1;
    return b.ts.localeCompare(a.ts);
  });

  return NextResponse.json({ entries, total: entries.length });
}

export async function PATCH(request: Request) {
  const body = await request.json();
  const { job_id, status } = body;

  if (!job_id || !status) {
    return NextResponse.json({ error: "job_id and status are required" }, { status: 400 });
  }

  const valid = ["new", "reviewed", "applied", "rejected"];
  if (!valid.includes(status)) {
    return NextResponse.json({ error: `status must be one of: ${valid.join(", ")}` }, { status: 400 });
  }

  const db = loadJobs();
  const job = db.entries.find((e) => e.id === job_id);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  job.status = status;
  saveJobs(db);

  return NextResponse.json({ entry: job });
}
