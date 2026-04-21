import fs from "fs";
import path from "path";

const CMS_TMP_DIR = path.join(process.cwd(), ".cms-import-tmp");

const NOT_AVAILABLE = Response.json(
  { error: "Import not available in production - run locally" },
  { status: 503 }
);

// Store import state globally so multiple requests can check progress
let importRunning = false;
let importLogs: string[] = [];
let importResult: { imported: number; skipped: number } | null = null;
let importError: string | null = null;

export async function POST(request: Request) {
  if (!fs.existsSync(CMS_TMP_DIR)) {
    return NOT_AVAILABLE;
  }

  const authHeader = request.headers.get("authorization");
  const expected = process.env.ADMIN_PASSWORD || "mapd-admin-2024";
  if (authHeader !== `Bearer ${expected}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (importRunning) {
    return Response.json({ error: "Import already in progress" }, { status: 409 });
  }

  const body = await request.json().catch(() => ({}));
  const year = body.year ? parseInt(body.year, 10) : undefined;

  // Lazy-load so the build doesn't fail when CMS files are missing in production
  const { runImport, setLogCallback } = await import("@/scripts/import-cms-data");

  // Reset state
  importRunning = true;
  importLogs = [];
  importResult = null;
  importError = null;

  // Wire up log callback
  setLogCallback((msg: string) => {
    importLogs.push(msg);
  });

  // Run import in background (don't await — return immediately)
  runImport(year)
    .then((result: { imported: number; skipped: number }) => {
      importResult = result;
    })
    .catch((err: unknown) => {
      importError = err instanceof Error ? err.message : String(err);
      importLogs.push(`[ERROR] ${importError}`);
    })
    .finally(() => {
      importRunning = false;
    });

  return Response.json({ status: "started", message: "Import started in background" });
}

export async function GET(request: Request) {
  if (!fs.existsSync(CMS_TMP_DIR)) {
    return NOT_AVAILABLE;
  }

  const authHeader = request.headers.get("authorization");
  const expected = process.env.ADMIN_PASSWORD || "mapd-admin-2024";
  if (authHeader !== `Bearer ${expected}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return Response.json({
    running: importRunning,
    logs: importLogs,
    result: importResult,
    error: importError,
  });
}
