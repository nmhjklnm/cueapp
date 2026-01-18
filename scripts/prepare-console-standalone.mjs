import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const consoleRoot = path.join(repoRoot, "apps", "console");

const standaloneDir = path.join(consoleRoot, ".next", "standalone");
const staticSrc = path.join(consoleRoot, ".next", "static");
const staticDest = path.join(standaloneDir, ".next", "static");
const publicSrc = path.join(consoleRoot, "public");
const publicDest = path.join(standaloneDir, "public");

if (!fs.existsSync(standaloneDir)) {
  throw new Error(`Next standalone output not found at ${standaloneDir}. Did next build run with output: \"standalone\"?`);
}

if (fs.existsSync(staticSrc)) {
  fs.mkdirSync(path.dirname(staticDest), { recursive: true });
  fs.cpSync(staticSrc, staticDest, { recursive: true });
}

if (fs.existsSync(publicSrc)) {
  fs.cpSync(publicSrc, publicDest, { recursive: true });
}
