"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import PasswordInput from "../../password-input";

interface Stats {
  totalPlans: number;
  lastImportDate: string | null;
  plansByYear: { year: number; count: number }[];
}

interface ImportStatus {
  running: boolean;
  logs: string[];
  result: { imported: number; skipped: number } | null;
  error: string | null;
}

export default function AdminImportPage() {
  const [password, setPassword] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [authError, setAuthError] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const [polling, setPolling] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const authHeader = useCallback(
    () => ({ Authorization: `Bearer ${password}` }),
    [password],
  );

  // Fetch stats
  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/stats", { headers: authHeader() });
      if (res.ok) {
        setStats(await res.json());
      }
    } catch { /* ignore */ }
  }, [authHeader]);

  // Fetch import progress
  const fetchProgress = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/import", { headers: authHeader() });
      if (res.ok) {
        const data: ImportStatus = await res.json();
        setImportStatus(data);
        return data.running;
      }
    } catch { /* ignore */ }
    return false;
  }, [authHeader]);

  // Login handler
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setAuthError("");
    const res = await fetch("/api/admin/stats", {
      headers: { Authorization: `Bearer ${password}` },
    });
    if (res.ok) {
      setAuthenticated(true);
      setStats(await res.json());
    } else {
      setAuthError("Invalid password");
    }
  }

  // Start import
  async function startImport() {
    const res = await fetch("/api/admin/import", {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ year }),
    });
    if (res.ok) {
      setPolling(true);
      setImportStatus({ running: true, logs: [], result: null, error: null });
    } else {
      const data = await res.json();
      alert(data.error || "Failed to start import");
    }
  }

  // Poll while import is running
  useEffect(() => {
    if (!polling) return;
    const interval = setInterval(async () => {
      const stillRunning = await fetchProgress();
      if (!stillRunning) {
        setPolling(false);
        fetchStats();
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [polling, fetchProgress, fetchStats]);

  // Auto-scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [importStatus?.logs.length]);

  // Login screen
  if (!authenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 p-4">
        <form
          onSubmit={handleLogin}
          className="bg-gray-900 rounded-lg border border-gray-700 p-8 w-full max-w-sm"
        >
          <h1 className="text-xl font-bold text-white mb-6">Admin Login</h1>
          <label className="block text-sm text-gray-300 mb-2" htmlFor="admin-pw">
            Admin Password
          </label>
          <PasswordInput
            suppressHydrationWarning={true}
            id="admin-pw"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full h-10 rounded-md border border-gray-600 bg-gray-800 px-3 pr-10 text-white text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            placeholder="Enter admin password"
          />
          {authError && <p className="text-red-400 text-sm mt-2">{authError}</p>}
          <button
            type="submit"
            className="mt-4 w-full h-10 bg-blue-600 text-white text-sm font-semibold rounded-md hover:bg-blue-700 transition-colors"
          >
            Login
          </button>
        </form>
      </div>
    );
  }

  // Authenticated admin UI
  return (
    <div className="min-h-screen bg-gray-950 p-6">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-white mb-6">CMS Data Import</h1>

        {/* Stats */}
        <div className="bg-gray-900 rounded-lg border border-gray-700 p-6 mb-6">
          <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wide mb-4">
            Database Status
          </h2>
          {stats ? (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <p className="text-3xl font-bold text-white">{stats.totalPlans.toLocaleString()}</p>
                <p className="text-sm text-gray-400">Total Plans</p>
              </div>
              <div>
                <p className="text-lg font-medium text-white">
                  {stats.lastImportDate
                    ? new Date(stats.lastImportDate).toLocaleDateString("en-US", {
                        year: "numeric", month: "short", day: "numeric",
                        hour: "2-digit", minute: "2-digit",
                      })
                    : "Never"}
                </p>
                <p className="text-sm text-gray-400">Last Import</p>
              </div>
              <div>
                <div className="space-y-1">
                  {stats.plansByYear.map((py) => (
                    <p key={py.year} className="text-sm text-gray-300">
                      <span className="font-medium text-white">{py.year}:</span>{" "}
                      {py.count.toLocaleString()} plans
                    </p>
                  ))}
                </div>
                <p className="text-sm text-gray-400 mt-1">Plans by Year</p>
              </div>
            </div>
          ) : (
            <p className="text-gray-400">Loading...</p>
          )}
        </div>

        {/* Import controls */}
        <div className="bg-gray-900 rounded-lg border border-gray-700 p-6 mb-6">
          <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wide mb-4">
            Import CMS Data
          </h2>
          <div className="flex items-end gap-4">
            <div>
              <label className="block text-sm text-gray-300 mb-2" htmlFor="import-year">
                Plan Year
              </label>
              <input
                suppressHydrationWarning={true}
                id="import-year"
                type="number"
                value={year}
                onChange={(e) => setYear(parseInt(e.target.value, 10))}
                min={2020}
                max={2030}
                className="h-10 w-28 rounded-md border border-gray-600 bg-gray-800 px-3 text-white text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
              />
            </div>
            <button
              onClick={startImport}
              disabled={importStatus?.running}
              className="h-10 px-6 bg-green-600 text-white text-sm font-semibold rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {importStatus?.running ? "Importing..." : "Start Import"}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Downloads PBP data from CMS and landscape data from NBER, then upserts
            plan records into the database. Safe to re-run — existing records for the
            same plan year, plan ID, state, and county are replaced.
          </p>
        </div>

        {/* Progress log */}
        {importStatus && (importStatus.logs.length > 0 || importStatus.running) && (
          <div className="bg-gray-900 rounded-lg border border-gray-700 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wide">
                Import Log
              </h2>
              {importStatus.running && (
                <span className="flex items-center gap-2 text-sm text-yellow-400">
                  <span className="inline-block w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
                  Running
                </span>
              )}
              {importStatus.result && !importStatus.running && (
                <span className="text-sm text-green-400">
                  Complete — {importStatus.result.imported.toLocaleString()} imported,{" "}
                  {importStatus.result.skipped.toLocaleString()} skipped
                </span>
              )}
              {importStatus.error && !importStatus.running && (
                <span className="text-sm text-red-400">Failed: {importStatus.error}</span>
              )}
            </div>
            <div className="bg-black rounded-md p-4 max-h-96 overflow-y-auto font-mono text-xs text-gray-300 leading-relaxed">
              {importStatus.logs.map((line, i) => (
                <div key={i} className={line.includes("[ERROR]") ? "text-red-400" : ""}>
                  {line}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
