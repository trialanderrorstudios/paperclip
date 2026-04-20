/**
 * Shared envelope matcher (NEW 3 V1.2, -tne delta).
 *
 * Pure pattern-matching primitive used by two layers:
 *   1. Pre-dispatch enforcement in `server/src/services/autonomy-state-machine.ts`
 *      (NEW 3 V1) — rejects hires whose declared envelope exceeds the company floor.
 *   2. Runtime enforcement in the `claudebridge-local` adapter (NEW 3 V1.2) —
 *      rejects mid-run tool calls that escape the envelope the agent was spawned with.
 *
 * Both layers MUST use this function. Matcher divergence would mean the board
 * says "this hire is safe" but the runtime disagrees (or vice versa) — a
 * category of bug we're explicitly engineering away here.
 *
 * Intentionally distinct from {@link server/src/services/allowlist-matcher.ts}
 * `compileAllowlistMatcher`. That matcher bakes the autonomy-level
 * (gated/policy/autopilot) → verdict mapping. This is the underlying pattern
 * primitive only; the level-aware wrapper that replaces the inline pre-dispatch
 * logic is a follow-up PR.
 *
 * Empty-allowlist semantics are "no restriction" (opt-in to restrict by
 * populating the allowlist key). A `deniedTools`/`deniedPaths` entry always
 * wins over `allowedTools`/`allowedPaths`.
 */
import { homedir } from "node:os";

export interface EnvelopeRules {
  allowedTools?: string[];
  deniedTools?: string[];
  /**
   * Glob-like patterns: `**` matches anything, `*` matches a single path segment,
   * exact-path match, leading `~/` expanded to HOME. Prefix like `src/**` matches
   * any path beginning with `src/`.
   */
  allowedPaths?: string[];
  deniedPaths?: string[];
  networkAccess?: "none" | "localhost" | "full";
  /**
   * When set and `allowedPaths` is undefined, absolute paths outside this
   * subtree are treated as not-in-allowedPaths. If `allowedPaths` is an
   * explicit array (even empty), it governs and `workingDir` is ignored for
   * path checks.
   */
  workingDir?: string;
}

export type MatchResult =
  | { allowed: true }
  | { allowed: false; reason: string; matchedPattern?: string };

const PATH_ARG_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "MultiEdit",
]);

const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);

/**
 * Minimal glob. Supports:
 *   - `**` — matches any sequence of characters including `/`
 *   - `*`  — matches any sequence of characters except `/`
 *   - exact literals (everything else)
 *   - leading `~/` expanded to the user's HOME directory before matching
 *
 * Not full minimatch — deliberately small. Sufficient for the envelope
 * patterns users actually write (`**`, `src/**`, absolute paths, `~/foo`).
 */
export function matchPath(pattern: string, path: string): boolean {
  const normalizedPattern = expandTilde(pattern);
  const normalizedPath = expandTilde(path);
  const regex = globToRegExp(normalizedPattern);
  return regex.test(normalizedPath);
}

function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return `${homedir()}/${value.slice(2)}`;
  return value;
}

function globToRegExp(pattern: string): RegExp {
  // Walk the pattern, escaping regex metachars and translating glob tokens.
  // Token order matters: `**` must be recognized before `*`.
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
        // Swallow a trailing `/` so `src/**` also matches `src` exactly.
        if (pattern[i] === "/") i += 1;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    // Escape regex metachars. Note: we deliberately do not interpret
    // bracket expressions — users write literal `[` if they need it.
    if (/[.+^$(){}|\\\[\]]/.test(ch)) re += "\\" + ch;
    else re += ch;
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function anyPatternMatches(
  patterns: string[] | undefined,
  value: string,
): string | null {
  if (!patterns || patterns.length === 0) return null;
  for (const pattern of patterns) {
    if (matchPath(pattern, value)) return pattern;
  }
  return null;
}

function normalizePathArg(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return expandTilde(raw);
}

function checkPath(
  pathArg: string,
  rules: EnvelopeRules,
): MatchResult {
  const deniedPattern = anyPatternMatches(rules.deniedPaths, pathArg);
  if (deniedPattern) {
    return {
      allowed: false,
      reason: `path denied by envelope: ${pathArg}`,
      matchedPattern: deniedPattern,
    };
  }

  if (rules.allowedPaths !== undefined) {
    if (rules.allowedPaths.length === 0) return { allowed: true };
    const allowed = anyPatternMatches(rules.allowedPaths, pathArg);
    if (!allowed) {
      return {
        allowed: false,
        reason: `path not in envelope allowlist: ${pathArg}`,
      };
    }
    return { allowed: true };
  }

  // allowedPaths is undefined — workingDir may constrain.
  if (rules.workingDir && pathArg.startsWith("/")) {
    const workingDir = expandTilde(rules.workingDir);
    if (!isInsideDir(pathArg, workingDir)) {
      return {
        allowed: false,
        reason: `absolute path outside workingDir: ${pathArg}`,
      };
    }
  }
  return { allowed: true };
}

function isInsideDir(absPath: string, dir: string): boolean {
  const normalizedDir = dir.endsWith("/") ? dir : `${dir}/`;
  return absPath === dir || absPath.startsWith(normalizedDir);
}

/**
 * Extract every absolute path referenced in a bash command string.
 * Matches `/`-prefixed tokens that stop at whitespace or common shell
 * delimiters (`'"|&;()`). Not a full shell parser — sufficient for the
 * envelope patterns users write.
 */
function extractAbsolutePaths(command: string): string[] {
  const matches: string[] = [];
  // Allow the path to be introduced by whitespace OR a quote so
  // `cat '/var/log/messages'` and `cat "/etc/passwd"` both extract. The
  // path token still stops at the next whitespace or shell delimiter
  // including the closing quote.
  const re = /(?:^|[\s'"])(\/[^\s'";|&()]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    matches.push(m[1]!);
  }
  return matches;
}

/**
 * True if `command` (Bash-style) tries to reach the network in a way that
 * violates `mode`. `full` = always allowed. `none` = reject any recognized
 * network-capable tool invocation. `localhost` = allow only when an explicit
 * localhost/127.0.0.1/::1 token appears in the command args.
 */
export function checkBashNetwork(
  command: string,
  mode: "none" | "localhost" | "full",
): { allowed: true } | { allowed: false; reason: string } {
  if (mode === "full") return { allowed: true };

  // Heuristic: does the command look like it reaches out?
  // We look for common networking tools and URL-ish tokens.
  const networkIndicators =
    /\b(curl|wget|nc|ncat|netcat|telnet|ssh|scp|rsync|ping|dig|nslookup|host|traceroute|git\s+(?:clone|fetch|pull|push)|npm\s+(?:install|i|publish)|pnpm\s+(?:install|i|publish)|yarn\s+install|pip\s+install|http(?:s)?:\/\/)/i;
  const hasNetworkIndicator = networkIndicators.test(command);
  if (!hasNetworkIndicator) return { allowed: true };

  if (mode === "none") {
    return { allowed: false, reason: "network access disabled by envelope" };
  }

  // mode === "localhost": command looks like it reaches out; only allow
  // when an explicit localhost token appears. Sub-domains of localhost
  // (e.g. `foo.localhost`) are treated as not-localhost.
  const localhostToken =
    /(?:^|[\s/@=])(?:localhost|127\.0\.0\.1|::1|\[::1\])(?:[\s/:?#]|$)/i;
  if (!localhostToken.test(command)) {
    return {
      allowed: false,
      reason: "network access restricted to localhost by envelope",
    };
  }
  return { allowed: true };
}

function checkWebUrl(
  url: string,
  mode: NonNullable<EnvelopeRules["networkAccess"]>,
): MatchResult {
  if (mode === "full") return { allowed: true };
  if (mode === "none") {
    return {
      allowed: false,
      reason: "network access disabled by envelope",
    };
  }
  // localhost mode: parse and require loopback hostname.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      allowed: false,
      reason: `unparsable url: ${url}`,
    };
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `network access restricted to localhost by envelope: ${host}`,
  };
}

/**
 * Check if `tool(input)` is inside `rules`. Empty allowlists mean
 * "no restriction" (not "deny everything") — caller sets
 * `allowedTools: ['Read','Grep']` to restrict; omits the key for no
 * tool restriction. Unknown tools are allowed.
 */
export function matchToolCall(
  tool: string,
  input: Record<string, unknown>,
  rules: EnvelopeRules,
): MatchResult {
  // 1) Tool name check.
  if (rules.deniedTools && rules.deniedTools.includes(tool)) {
    return {
      allowed: false,
      reason: `tool denied by envelope: ${tool}`,
      matchedPattern: tool,
    };
  }
  if (
    rules.allowedTools !== undefined &&
    rules.allowedTools.length > 0 &&
    !rules.allowedTools.includes(tool)
  ) {
    return {
      allowed: false,
      reason: `tool not in envelope allowlist: ${tool}`,
    };
  }

  // 2) Arg-level checks per tool.
  if (PATH_ARG_TOOLS.has(tool)) {
    const candidate =
      normalizePathArg(input["file_path"]) ??
      normalizePathArg(input["path"]) ??
      // Glob's primary arg is `pattern`; `path` is optional scope.
      (tool === "Glob" ? normalizePathArg(input["pattern"]) : null);
    if (candidate) {
      const result = checkPath(candidate, rules);
      if (!result.allowed) return result;
    }
    return { allowed: true };
  }

  if (tool === "Grep") {
    const candidate = normalizePathArg(input["path"]);
    if (candidate) {
      const result = checkPath(candidate, rules);
      if (!result.allowed) return result;
    }
    return { allowed: true };
  }

  if (tool === "Bash") {
    const command = typeof input["command"] === "string"
      ? (input["command"] as string)
      : "";

    // Path extraction: deny if any extracted absolute path hits deniedPaths
    // or (with non-empty allowedPaths) hits none of them.
    const paths = extractAbsolutePaths(command);
    for (const p of paths) {
      const deniedPattern = anyPatternMatches(rules.deniedPaths, p);
      if (deniedPattern) {
        return {
          allowed: false,
          reason: `bash path denied by envelope: ${p}`,
          matchedPattern: deniedPattern,
        };
      }
    }
    if (rules.allowedPaths !== undefined && rules.allowedPaths.length > 0) {
      for (const p of paths) {
        const allowed = anyPatternMatches(rules.allowedPaths, p);
        if (!allowed) {
          return {
            allowed: false,
            reason: `bash path not in envelope allowlist: ${p}`,
          };
        }
      }
    } else if (
      rules.allowedPaths === undefined &&
      rules.workingDir
    ) {
      const workingDir = expandTilde(rules.workingDir);
      for (const p of paths) {
        if (!isInsideDir(p, workingDir)) {
          return {
            allowed: false,
            reason: `bash absolute path outside workingDir: ${p}`,
          };
        }
      }
    }

    // Network enforcement.
    if (rules.networkAccess && rules.networkAccess !== "full") {
      const net = checkBashNetwork(command, rules.networkAccess);
      if (!net.allowed) return net;
    }
    return { allowed: true };
  }

  if (NETWORK_TOOLS.has(tool)) {
    const mode = rules.networkAccess ?? "full";
    if (tool === "WebFetch") {
      const url = typeof input["url"] === "string" ? (input["url"] as string) : "";
      if (!url) {
        // Missing URL — if network is locked down, deny; otherwise allow.
        if (mode === "none") {
          return { allowed: false, reason: "network access disabled by envelope" };
        }
        return { allowed: true };
      }
      return checkWebUrl(url, mode);
    }
    // WebSearch has no URL — it issues queries against a search provider.
    // Only `full` permits it; `localhost` cannot be guaranteed and `none`
    // explicitly forbids.
    if (mode !== "full") {
      return {
        allowed: false,
        reason: "WebSearch requires full network access",
      };
    }
    return { allowed: true };
  }

  // Unknown tool: allow by default (matcher is the enforcement floor, not
  // the tool catalogue).
  return { allowed: true };
}
