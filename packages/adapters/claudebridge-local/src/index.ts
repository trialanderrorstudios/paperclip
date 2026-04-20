export const type = "claudebridge_local";
export const label = "Claude Code (Claudebridge)";

export const models = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export const agentConfigurationDoc = `
## claudebridge_local adapter

Runs Claude Code via the local Claudebridge daemon (ws://127.0.0.1:7737).
Sessions appear in Second Brain → Claude on the iPad.

### Required config

- \`cwd\` — working directory for the Claude Code session. For Paperclip-owned
  sessions this is typically the agent workspace directory.

### Optional config

- \`wsUrl\` — Claudebridge WebSocket URL (default: \`ws://127.0.0.1:7737\`)
- \`token\` — Claudebridge pairing token. If omitted, the first token in
  \`~/.claudebridge/pairings.json\` is used automatically.
- \`model\` — Claude model ID (default: \`claude-opus-4-7\`)
- \`systemPrompt\` — Extra system prompt injected at session creation.
- \`label\` — Human-readable name shown in the iPad session list.
`.trim();
