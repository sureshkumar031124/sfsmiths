/**
 * dispatch.ts — entry for `sfsmiths-hook <name>`. Fast hooks never import the toolkit.
 * Any unexpected error → exit 0 with a systemMessage (never crash a session), EXCEPT the deny hooks,
 * which fail CLOSED (deny) when the input is unreadable — a hook that cannot judge must not allow.
 */
import { readStdinJson, projectRoot, loadPolicy, decideAgentGate, decidePolicy, decideWriteGuard, decideDataGuard, emit } from "./fast.js";

const name = process.argv[2] ?? "";
const t0 = Date.now();

async function main(): Promise<void> {
  const input = readStdinJson();
  const root = projectRoot(input);
  switch (name) {
    case "agent-gate": {
      if (process.env.SFSMITHS_HOOKS_OFF === "1") return emit({ allow: true });
      return emit(decideAgentGate(input, root));
    }
    case "policy": {
      if (process.env.SFSMITHS_HOOKS_OFF === "1") return emit({ allow: true });
      return emit(decidePolicy(input, root, loadPolicy(root)));
    }
    case "write-guard": {
      if (process.env.SFSMITHS_HOOKS_OFF === "1") return emit({ allow: true });
      return emit(decideWriteGuard(input, root, loadPolicy(root)));
    }
    case "data-guard": {
      if (process.env.SFSMITHS_HOOKS_OFF === "1") return emit({ allow: true });
      return emit(decideDataGuard(input, root, loadPolicy(root)));
    }
    case "prompt-router": return (await import("./heavy.js")).promptRouter(input as never);
    case "stage-gate": return (await import("./heavy.js")).stageGate(input as never);
    case "stop-guard": return (await import("./heavy.js")).stopGuard(input as never);
    case "tokens": return (await import("./heavy.js")).tokensHook(input as never);
    case "post-edit": return (await import("./heavy.js")).postEdit(input as never);
    case "session-start": return (await import("./heavy.js")).sessionStart(input as never);
    case "precompact": return (await import("./heavy.js")).preCompact(input as never);
    case "latency": {
      process.stdout.write(JSON.stringify({ hook: "latency", ms: Date.now() - t0 }) + "\n");
      return;
    }
    default:
      process.stderr.write(`sfsmiths-hook: unknown hook "${name}"\n`);
      process.exit(0);
  }
}

main().catch((e) => {
  const msg = (e as Error).message ?? String(e);
  if (["agent-gate", "policy", "write-guard", "data-guard"].includes(name)) {
    // fail closed
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `SFsmiths hook error (fail-closed): ${msg}` } }) + "\n");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ systemMessage: `SFsmiths hook "${name}" error: ${msg}` }) + "\n");
  process.exit(0);
});
