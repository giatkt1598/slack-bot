import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.ts';
import type { Command, CommandDefinition, QueueGroup } from '../types.ts';

// Built-in bot commands (see src/bot/chat.ts) that command files must not shadow.
const reservedNames = ['cancel', 'queue'];

const requiredFields = {
  name: 'string',
  description: 'string',
  usage: 'string',
  parse: 'function',
  validate: 'function',
  build: 'function'
} as const;

export interface Registry {
  commands: Command[];
  getCommand(name: string): Command | undefined;
  queueGroups: QueueGroup[];
}

// Validates command definitions and groups them by queue. Commands sharing a queue must agree on its concurrency.
// Definitions come from files at runtime, so their shape is checked here even though they are typed.
export function defineCommands(definitions: CommandDefinition[]): Registry {
  const byName = new Map<string, Command>();
  for (const definition of definitions) {
    const label = definition?.name || '(không tên)';
    for (const [field, type] of Object.entries(requiredFields)) {
      if (typeof (definition as unknown as Record<string, unknown> | undefined)?.[field] !== type) {
        throw new Error(`Command ${label}: "${field}" phải là ${type}.`);
      }
    }
    if (!/^[a-z][a-z0-9-]*$/.test(definition.name)) throw new Error(`Command ${label}: tên chỉ gồm a-z, 0-9, "-".`);
    if (byName.has(definition.name)) throw new Error(`Command ${label} bị khai báo trùng.`);
    if (reservedNames.includes(definition.name)) throw new Error(`Command ${label}: tên này dành cho lệnh có sẵn của bot.`);
    const queue = { name: definition.name, concurrency: 1, ...definition.queue };
    if (!Number.isInteger(queue.concurrency) || queue.concurrency < 1) {
      throw new Error(`Command ${label}: queue.concurrency phải là số nguyên >= 1.`);
    }
    byName.set(definition.name, { timeoutMs: config.commandTimeoutMs, promptPatterns: [], ...definition, queue });
  }

  const groups = new Map<string, QueueGroup>();
  for (const command of byName.values()) {
    const group = groups.get(command.queue.name);
    if (!group) {
      groups.set(command.queue.name, { ...command.queue, commands: [command.name] });
    } else if (group.concurrency !== command.queue.concurrency) {
      throw new Error(`Queue ${group.name} có concurrency không thống nhất giữa các command.`);
    } else {
      group.commands.push(command.name);
    }
  }

  return {
    commands: [...byName.values()],
    getCommand: (name) => byName.get(name),
    queueGroups: [...groups.values()]
  };
}

// Every *.command.ts file in this folder default-exports a command definition.
export async function loadCommands(directory: string = import.meta.dirname): Promise<Registry> {
  const files = readdirSync(directory).filter((file) => file.endsWith('.command.ts')).sort();
  const modules: { default: CommandDefinition }[] = await Promise.all(
    files.map((file) => import(pathToFileURL(join(directory, file)).href))
  );
  return defineCommands(modules.map((module) => module.default));
}

export const { commands, getCommand, queueGroups } = await loadCommands();
