// Side-effect module: loads .env.local and .env into process.env before any other
// imports run. Mirrors Next.js precedence: shell > .env.local > .env. Existing
// values in process.env are preserved so anything the user set on the command
// line wins. To use, put `import "./load-env";` as the FIRST import of a script.
import fs from "fs";
import path from "path";

function loadEnvFile(file: string) {
  const full = path.resolve(file);
  if (!fs.existsSync(full)) return;
  const content = fs.readFileSync(full, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// Order matters: first writer wins (we only set keys not already present),
// so .env.local takes precedence over .env, and shell-exported values beat both.
loadEnvFile(".env.local");
loadEnvFile(".env");
