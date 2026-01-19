import { app, BrowserWindow } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Menu, Notification, Tray, dialog, nativeImage, shell } from "electron";

import { getCliDiagnostics, installCliIntegration, uninstallCliIntegration } from "./cli-integration.js";

const HOST = "127.0.0.1";
const PREFERRED_PORT = 3443;
const FALLBACK_PORT_END = 3453;

const POLL_INTERVAL_MS = 3000;

async function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        server.close(() => resolve(true));
      })
      .listen(port, host);
  });
}

async function ensureCliIntegration(): Promise<void> {
  const d = getCliDiagnostics();
  if (d.shimExists && d.profileHasMarker) return;
  installCliIntegration({
    appExecPath: process.execPath,
    repoRootForDev: getRepoRoot(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
  });
}

async function pickPort(): Promise<number> {
  for (let p = PREFERRED_PORT; p <= FALLBACK_PORT_END; p += 1) {
    if (await isPortAvailable(HOST, p)) return p;
  }
  return 0;
}

async function pickRandomFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net
      .createServer()
      .once("error", (err) => reject(err))
      .listen(0, HOST, () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") return reject(new Error("failed to bind random port"));
        const p = addr.port;
        server.close(() => resolve(p));
      });
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net
        .connect({ host, port })
        .once("connect", () => {
          s.end();
          resolve(true);
        })
        .once("error", () => resolve(false));
    });
    if (ok) return;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for server on ${host}:${port}`);
}

function getRepoRoot(): string {
  // apps/desktop/src/main.ts -> apps/desktop/dist/main.js
  // repo root is ../../.. from dist/
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..");
}

function getConsoleRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "apps", "console");
  }
  return path.join(getRepoRoot(), "apps", "console");
}

function getNextBin(consoleRoot: string): string {
  return path.join(consoleRoot, "node_modules", "next", "dist", "bin", "next");
}

function getStandaloneServer(consoleRoot: string): string {
  const root = path.join(consoleRoot, ".next", "standalone");
  const direct = path.join(root, "server.js");
  if (fs.existsSync(direct)) return direct;
  const nested = path.join(root, "apps", "console", "server.js");
  return nested;
}

async function startNextServer(port: number): Promise<{ port: number; proc: ChildProcessWithoutNullStreams }> {
  const consoleRoot = getConsoleRoot();

  const args: string[] = [];

  if (app.isPackaged) {
    const serverJs = getStandaloneServer(consoleRoot);
    if (!fs.existsSync(serverJs)) {
      throw new Error(`Unable to resolve Next standalone server at ${serverJs}. Did you run next build with output: \"standalone\"?`);
    }
    args.push(serverJs);
  } else {
    const nextBin = getNextBin(consoleRoot);
    if (!fs.existsSync(nextBin)) {
      throw new Error(`Unable to resolve Next.js CLI at ${nextBin}. Did you run pnpm install?`);
    }
    args.push(
      nextBin,
      "dev",
      "--port",
      String(port),
      "--hostname",
      HOST
    );
  }

  const proc = spawn(process.execPath, args, {
    cwd: app.isPackaged ? path.dirname(args[0] ?? path.join(consoleRoot, ".next", "standalone")) : consoleRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(port),
      HOSTNAME: HOST,
      NODE_ENV: app.isPackaged ? "production" : process.env.NODE_ENV,
      // Make Next logs deterministic in desktop app
      FORCE_COLOR: "0",
    },
    stdio: "pipe",
  });

  proc.stdout.on("data", (buf) => process.stdout.write(buf));
  proc.stderr.on("data", (buf) => process.stderr.write(buf));

  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  proc.once("exit", (code, signal) => {
    exited = { code, signal };
  });

  let spawnErrMsg: string | null = null;
  // The typed overloads for ChildProcess event listeners can be overly strict.
  // We still want to fail-fast on spawn errors (ENOENT, EACCES, etc.).
  (proc as unknown as NodeJS.EventEmitter).once("error", (err: unknown) => {
    spawnErrMsg = err instanceof Error ? String(err.message) : String(err);
  });

  // If the chosen port is already bound by something else, Next will fail fast.
  // We'll detect readiness by connecting to the port.
  const start = Date.now();
  while (true) {
    if (spawnErrMsg !== null) {
      throw new Error(`Failed to spawn Next server: ${spawnErrMsg}`);
    }
    if (exited !== null) {
      const { code, signal } = exited;
      throw new Error(`Next server exited early (code=${String(code)} signal=${String(signal)})`);
    }
    if (Date.now() - start > 60_000) {
      throw new Error(`Timed out waiting for Next server on ${HOST}:${port}`);
    }
    try {
      await waitForPort(HOST, port, 2_000);
      break;
    } catch {
      // keep waiting
    }
  }
  return { port, proc };
}

function createWindow(serverUrl: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: {
      preload: new URL("./preload.js", import.meta.url).pathname,
    },
  });

  void win.loadURL(serverUrl);
  return win;
}

function openCueDb(): Database.Database | null {
  const dbPath = path.join(os.homedir(), ".cue", "cue.db");
  try {
    if (!fs.existsSync(dbPath)) return null;
    // readonly: the UI will handle schema init/migrate; we only read for notifications.
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function isPausePayload(payload: string | null): boolean {
  const p = String(payload || "");
  return p.includes('"type"') && p.includes('confirm') && p.includes('"variant"') && p.includes('pause');
}

function setupTray(getMainWindow: () => BrowserWindow | null): Tray | null {
  // Use a tiny transparent icon to avoid depending on external assets in MVP.
  const transparentPngDataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ob6pQAAAABJRU5ErkJggg==";
  const icon = nativeImage.createFromDataURL(transparentPngDataUrl);
  const tray = new Tray(icon);
  tray.setToolTip("cueapp");
  tray.on("click", () => {
    const w = getMainWindow();
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  });

  const menu = Menu.buildFromTemplate([
    {
      label: "Open",
      click: () => {
        const w = getMainWindow();
        if (!w) return;
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
      },
    },
    { type: "separator" },
    {
      label: "Install CLI (cueme)",
      click: async () => {
        const d = getCliDiagnostics();
        const installDetail =
          process.platform === "win32"
            ? `This will create ${d.shimPath}.\n\nWindowsApps is typically already in PATH, so new terminals should have \`cueme\` available.\n\nNo shell profile files will be modified.`
            : "This will create ~/.local/bin/cueme and append a managed PATH block to ~/.zprofile (marker: cuemeapp).\n\nNew terminals will have `cueme` available. You can uninstall from this menu.";
        const res = await dialog.showMessageBox({
          type: "question",
          buttons: ["Install", "Cancel"],
          defaultId: 0,
          cancelId: 1,
          message: "Install cueme CLI integration?",
          detail: installDetail,
        });
        if (res.response !== 0) return;

        installCliIntegration({
          appExecPath: process.execPath,
          repoRootForDev: getRepoRoot(),
          resourcesPath: process.resourcesPath,
          isPackaged: app.isPackaged,
        });
      },
    },
    {
      label: "Uninstall CLI integration",
      click: async () => {
        const d = getCliDiagnostics();
        const uninstallDetail =
          process.platform === "win32"
            ? `This will remove ${d.shimPath}.`
            : "This will remove ~/.local/bin/cueme and remove the managed PATH block from ~/.zprofile.";
        const res = await dialog.showMessageBox({
          type: "warning",
          buttons: ["Uninstall", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          message: "Uninstall cueme CLI integration?",
          detail: uninstallDetail,
        });
        if (res.response !== 0) return;
        uninstallCliIntegration();
      },
    },
    {
      label: "Show CLI diagnostics",
      click: () => {
        const d = getCliDiagnostics();
        void dialog.showMessageBox({
          type: "info",
          message: "CLI diagnostics",
          detail: JSON.stringify(d, null, 2),
        });
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ]);
  tray.setContextMenu(menu);
  return tray;
}

function setupNotifications(getMainWindow: () => BrowserWindow | null) {
  const db = openCueDb();

  let lastNotifiedRequestId: string | null = null;

  function pollOnce() {
    if (!db) {
      app.setBadgeCount(0);
      return;
    }

    try {
      const rows = db
        .prepare(
          `SELECT request_id, payload, created_at
           FROM cue_requests
           WHERE status = 'PENDING'
           ORDER BY created_at DESC
           LIMIT 50`
        )
        .all() as Array<{ request_id: string; payload: string | null; created_at: string }>;

      const pending = rows.filter((r) => !isPausePayload(r.payload));
      const pendingCount = pending.length;
      app.setBadgeCount(pendingCount);

      const newest = pending[0];
      if (newest && newest.request_id && newest.request_id !== lastNotifiedRequestId) {
        lastNotifiedRequestId = newest.request_id;

        const notif = new Notification({
          title: "cueapp",
          body: `New pending request (${pendingCount})`,
          silent: false,
        });

        // Audible/system attention cues (best-effort)
        try {
          shell.beep();
        } catch {
          // ignore
        }
        try {
          if (process.platform === "darwin" && app.dock) app.dock.bounce("informational");
        } catch {
          // ignore
        }

        notif.on("click", () => {
          const w = getMainWindow();
          if (!w) return;
          if (w.isMinimized()) w.restore();
          w.show();
          w.focus();
        });

        notif.show();
      }
    } catch {
      // If schema is missing or db is locked/corrupt, do not crash the app.
    }
  }

  const timer = setInterval(pollOnce, POLL_INTERVAL_MS);
  pollOnce();

  app.on("before-quit", () => {
    clearInterval(timer);
    try {
      db?.close();
    } catch {
      // ignore
    }
  });
}

async function main() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on("second-instance", () => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });

  await app.whenReady();

  const wantedPort = await pickPort();
  const port = wantedPort === 0 ? await pickRandomFreePort() : wantedPort;

  const { proc } = await startNextServer(port);
  const serverUrl = `http://${HOST}:${port}`;

  let mainWindow: BrowserWindow | null = null;
  mainWindow = createWindow(serverUrl);

  const getMainWindow = () => {
    const w = BrowserWindow.getAllWindows()[0];
    return w || mainWindow;
  };

  // Native reminders
  setupNotifications(getMainWindow);

  // Tray (macOS menu bar)
  let tray: Tray | null = null;
  try {
    tray = setupTray(getMainWindow);
  } catch {
    // ignore missing icon etc
  }

  // CLI integration (best-effort, non-blocking)
  void ensureCliIntegration().catch(() => {
    // ignore
  });

  app.on("before-quit", () => {
    try {
      proc.kill();
    } catch {
      // ignore
    }

    // Keep references for GC
    void tray;
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(serverUrl);
  });
}

void main();
