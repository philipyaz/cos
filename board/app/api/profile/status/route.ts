import { NextResponse } from "next/server";
import { callVaultTool } from "@/lib/vault-mcp-client";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get("job_id");

  if (!jobId) {
    return NextResponse.json({ error: "job_id query parameter is required" }, { status: 400 });
  }

  try {
    const data = await callVaultTool("ingest_status", { job_id: jobId });
    const content = data?.result?.content;

    // The vault returns structuredContent with status, result, error, etc.
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.annotations?.structuredContent) {
          const sc = block.annotations.structuredContent;
          return NextResponse.json({
            job_id: sc.job_id,
            status: sc.status ?? "unknown",
            status_message: sc.status_message ?? null,
            result: sc.result ?? null,
            error: sc.error ?? null,
          });
        }
      }
      // Fallback: check if it's an error result (isError)
      const errBlock = content.find((b: { type: string }) => b.type === "text");
      if (data?.result?.isError && errBlock) {
        return NextResponse.json(
          { job_id: jobId, status: "error", error: errBlock.text },
          { status: 404 }
        );
      }
    }

    return NextResponse.json(
      { error: "Could not parse vault ingest_status response" },
      { status: 502 }
    );
  } catch (e) {
    return NextResponse.json(
      { error: `Status check failed: ${(e as Error).message}` },
      { status: 500 }
    );
  }
}
