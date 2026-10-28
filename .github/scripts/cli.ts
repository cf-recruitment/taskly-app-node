// Exit handling shared by every script.

export type ExitReason = 'failed' | 'blocked' | 'usage';

// 1 = a check failed or input is missing, 2 = a PreToolUse hook blocks the tool call, 64 = bad usage.
export const EXIT_CODES: Record<ExitReason, number> = { failed: 1, blocked: 2, usage: 64 };

export function die(script: string, message: string, reason: ExitReason = 'failed'): never {
  console.error(`${script}: ${message}`);
  process.exit(EXIT_CODES[reason]);
}
