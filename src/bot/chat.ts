import type { Command } from "../types.ts";

// Turns Slack message text into plain text: drops user mentions and decodes Slack's HTML escaping.
export function toPlainText(text: string | undefined): string {
  return String(text || "")
    .replace(/<@[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

export function createChatParser(commands: Command[]) {
  // "<@U123> /deploy GCD-123" or "deploy GCD-123" → { command, args: 'GCD-123' }; unknown → null.
  function parseCommand(
    text: string | undefined,
  ): { command: Command; args: string } | null {
    const words = toPlainText(text).split(/\s+/);
    const name = words[0].replace(/^\//, "").toLowerCase();
    const command = commands.find((candidate) => candidate.name === name);
    return command ? { command, args: words.slice(1).join(" ") } : null;
  }

  function helpText(): string {
    const builtins = [
      {
        usage: "queue",
        description: "Show running and waiting jobs.",
      },
      {
        usage: "cancel #3",
        description: "Cancel a queued, running or waiting job.",
      },
    ];
    const list = [...commands, ...builtins]
      .map(({ usage, description }) => `• \`${usage}\` — ${description}`)
      .join("\n");
    return (
      `Supported commands:\n${list}\n` +
      "_Send it in a DM, @mention me, or use a slash command. When a command asks something, reply in its thread (in a DM, just send the answer)._"
    );
  }

  return { parseCommand, helpText };
}

// "queue" (optionally "/queue" or with a mention) → true.
export function isQueueCommand(text: string | undefined): boolean {
  return /^\/?queue$/i.test(toPlainText(text));
}

// "cancel #3" / "cancel 3" → { number: 3 }; "cancel" followed by anything else → { number: null }; not a cancel → null.
export function parseCancel(
  text: string | undefined,
): { number: number | null } | null {
  const match = toPlainText(text).match(/^\/?cancel(?:\s+(.*))?$/i);
  if (!match) return null;
  const number = (match[1] || "").trim().match(/^#?(\d+)$/);
  return { number: number ? Number(number[1]) : null };
}
