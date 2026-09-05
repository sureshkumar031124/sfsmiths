/**
 * args.ts — tiny argv parser (no dependency): positionals + --flags (--k v | --k=v | --k).
 */
export interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean>;
  list(name: string): string[];
  str(name: string, fallback?: string): string | undefined;
  bool(name: string): boolean;
  num(name: string, fallback?: number): number | undefined;
}

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const multi: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      let name = a.slice(2);
      let val: string | boolean = true;
      if (name.includes("=")) { const [n, ...rest] = name.split("="); name = n; val = rest.join("="); }
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) { val = argv[++i]; }
      if (typeof val === "string") (multi[name] ??= []).push(val);
      flags[name] = val;
    } else positional.push(a);
  }
  return {
    positional,
    flags,
    list: (n) => multi[n] ?? [],
    str: (n, fb) => (typeof flags[n] === "string" ? (flags[n] as string) : fb),
    bool: (n) => flags[n] === true || flags[n] === "true",
    num: (n, fb) => (typeof flags[n] === "string" && Number.isFinite(Number(flags[n])) ? Number(flags[n]) : fb),
  };
}

export function fail(msg: string, code = 1): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

export function say(s: string): void {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
}

export function json(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}
