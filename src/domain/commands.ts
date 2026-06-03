const BUILTIN_COMMANDS = ["all", "agents", "status", "reset", "push", "tasks"] as const;

export type BuiltInCommand = (typeof BUILTIN_COMMANDS)[number];

export interface ParsedCommand {
  builtin?: BuiltInCommand;
  alias?: string;
}

export const RESERVED_ALIASES = new Set<string>(BUILTIN_COMMANDS);

export function parseCommand(rawText: string): ParsedCommand {
  const normalized = rawText.trim();
  if (!normalized.startsWith("/")) {
    return {};
  }

  const token = normalized.slice(1).split(/\s+/, 1)[0]?.toLowerCase();
  if (!token) {
    return {};
  }

  if (RESERVED_ALIASES.has(token)) {
    return { builtin: token as BuiltInCommand };
  }

  return { alias: token };
}

export function listBuiltinCommands(): readonly BuiltInCommand[] {
  return BUILTIN_COMMANDS;
}
