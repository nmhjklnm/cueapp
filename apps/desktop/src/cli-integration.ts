import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MARKER_BEGIN = "# >>> cuemeapp cli (managed) >>>";
const MARKER_END = "# <<< cuemeapp cli (managed) <<<";

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function writeFileAtomic(p: string, content: string) {
  const dir = path.dirname(p);
  ensureDir(dir);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, p);
}

function validateZshProfileFile(p: string): boolean {
  const res = spawnSync("zsh", ["-n", p], { stdio: "ignore" });
  return res.status === 0;
}

function writeProfileSafely(profilePath: string, nextContent: string): void {
  const dir = path.dirname(profilePath);
  ensureDir(dir);

  const tmp = profilePath + ".cueapp.tmp";
  fs.writeFileSync(tmp, nextContent, "utf8");

  if (!validateZshProfileFile(tmp)) {
    fs.rmSync(tmp, { force: true });
    return;
  }

  // Backup once per write
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const bak = profilePath + `.bak.${stamp}`;
    if (fs.existsSync(profilePath)) fs.copyFileSync(profilePath, bak);
  } catch {
    // ignore
  }

  fs.renameSync(tmp, profilePath);
}

export function getShimDir(): string {
  if (process.platform === "win32") {
    const localAppData =
      String(process.env.LOCALAPPDATA || "") || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "Microsoft", "WindowsApps");
  }
  return path.join(os.homedir(), ".local", "bin");
}

export function getShimPath(): string {
  return path.join(getShimDir(), process.platform === "win32" ? "cueme.cmd" : "cueme");
}

export function getProfilePath(): string {
  if (process.platform === "win32") return "";
  return path.join(os.homedir(), ".zprofile");
}

export function isCliIntegrated(): boolean {
  return fs.existsSync(getShimPath());
}

function getCliEntryPath(args: {
  repoRootForDev: string;
  resourcesPath: string;
  isPackaged: boolean;
}): string {
  if (args.isPackaged) {
    return path.join(args.resourcesPath, "packages", "cli", "bin", "cue-command.js");
  }
  return path.join(args.repoRootForDev, "packages", "cli", "bin", "cue-command.js");
}

export function getCliDiagnostics(): {
  shimPath: string;
  shimExists: boolean;
  profilePath: string;
  profileHasMarker: boolean;
} {
  const shimPath = getShimPath();
  const profilePath = getProfilePath();
  const profile = profilePath ? readFileSafe(profilePath) : "";
  return {
    shimPath,
    shimExists: fs.existsSync(shimPath),
    profilePath,
    profileHasMarker:
      process.platform === "win32" ? true : profile.includes(MARKER_BEGIN) && profile.includes(MARKER_END),
  };
}

function removeManagedBlock(text: string): string {
  const begin = text.indexOf(MARKER_BEGIN);
  const end = text.indexOf(MARKER_END);
  if (begin < 0 || end < 0 || end <= begin) return text;
  const afterEnd = end + MARKER_END.length;
  const before = text.slice(0, begin);
  const after = text.slice(afterEnd);
  return (before + after).replace(/\n{3,}/g, "\n\n");
}

export function uninstallCliIntegration(): void {
  try {
    fs.rmSync(getShimPath(), { force: true });
  } catch {
    // ignore
  }

  if (process.platform === "win32") return;

  const profilePath = getProfilePath();
  const existing = readFileSafe(profilePath);
  if (existing) {
    const next = removeManagedBlock(existing);
    if (next !== existing) writeFileAtomic(profilePath, next);
  }
}

export function installCliIntegration(args: {
  appExecPath: string;
  repoRootForDev: string;
  resourcesPath: string;
  isPackaged: boolean;
}): void {
  // 1) shim
  const shimDir = getShimDir();
  ensureDir(shimDir);

  const cliEntry = getCliEntryPath(args);
  if (process.platform === "win32") {
    const shim =
      `@echo off\r\n` +
      `set ELECTRON_RUN_AS_NODE=1\r\n` +
      `"${args.appExecPath}" "${cliEntry}" %*\r\n`;
    writeFileAtomic(getShimPath(), shim);
  } else {
    const shim =
      `#!/bin/sh\n` +
      `export ELECTRON_RUN_AS_NODE=1\n` +
      `exec \"${args.appExecPath}\" \"${cliEntry}\" \"$@\"\n`;
    writeFileAtomic(getShimPath(), shim);
    fs.chmodSync(getShimPath(), 0o755);
  }

  // 2) ~/.zprofile PATH block
  if (process.platform === "win32") return;

  const profilePath = getProfilePath();
  const existing = readFileSafe(profilePath);

  if (!existing.includes(MARKER_BEGIN) || !existing.includes(MARKER_END)) {
    const block =
      `\n${MARKER_BEGIN}\n` +
      `# Added by cueapp to enable cueme in PATH.\n` +
      `if [ -d \"$HOME/.local/bin\" ]; then\n` +
      `  case \":$PATH:\" in\n` +
      `    *\":$HOME/.local/bin:\"*) :;;\n` +
      `    *) export PATH=\"$HOME/.local/bin:$PATH\";;\n` +
      `  esac\n` +
      `fi\n` +
      `${MARKER_END}\n`;

    const nextProfile = existing + block;
    writeProfileSafely(profilePath, nextProfile);
  }
}
