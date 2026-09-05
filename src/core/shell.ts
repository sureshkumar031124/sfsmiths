/**
 * shell.ts — spawn wrapper with timeout, captured output, never a shell string (no injection).
 */
import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  maxBuffer?: number;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const max = opts.maxBuffer ?? 20 * 1024 * 1024;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;
    child.stdout.on("data", (d) => {
      if (stdout.length < max) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < max) stderr += d.toString();
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + `\n${err.message}`, timedOut, durationMs: Date.now() - started });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

export function which(cmd: string): Promise<string | undefined> {
  const probe = process.platform === "win32" ? "where" : "which";
  return run(probe, [cmd], { timeoutMs: 5000 }).then((r) => (r.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] : undefined));
}
