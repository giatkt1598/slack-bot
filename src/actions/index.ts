import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.ts';
import type { Action, ActionDefinition, QueueGroup } from '../types.ts';

// Built-in bot commands (see src/bot/commands.ts) that actions must not shadow.
const reservedNames = ['cancel'];

const requiredFields = {
  name: 'string',
  description: 'string',
  usage: 'string',
  parse: 'function',
  validate: 'function',
  command: 'function'
} as const;

export interface Registry {
  actions: Action[];
  getAction(name: string): Action | undefined;
  queueGroups: QueueGroup[];
}

// Validates action definitions and groups them by queue. Actions sharing a queue must agree on its concurrency.
// Definitions come from files at runtime, so their shape is checked here even though they are typed.
export function defineActions(definitions: ActionDefinition[]): Registry {
  const byName = new Map<string, Action>();
  for (const definition of definitions) {
    const label = definition?.name || '(không tên)';
    for (const [field, type] of Object.entries(requiredFields)) {
      if (typeof (definition as unknown as Record<string, unknown> | undefined)?.[field] !== type) {
        throw new Error(`Action ${label}: "${field}" phải là ${type}.`);
      }
    }
    if (!/^[a-z][a-z0-9-]*$/.test(definition.name)) throw new Error(`Action ${label}: tên chỉ gồm a-z, 0-9, "-".`);
    if (byName.has(definition.name)) throw new Error(`Action ${label} bị khai báo trùng.`);
    if (reservedNames.includes(definition.name)) throw new Error(`Action ${label}: tên này dành cho lệnh có sẵn của bot.`);
    const queue = { name: definition.name, concurrency: 1, ...definition.queue };
    if (!Number.isInteger(queue.concurrency) || queue.concurrency < 1) {
      throw new Error(`Action ${label}: queue.concurrency phải là số nguyên >= 1.`);
    }
    byName.set(definition.name, { timeoutMs: config.commandTimeoutMs, promptPatterns: [], ...definition, queue });
  }

  const groups = new Map<string, QueueGroup>();
  for (const action of byName.values()) {
    const group = groups.get(action.queue.name);
    if (!group) {
      groups.set(action.queue.name, { ...action.queue, actions: [action.name] });
    } else if (group.concurrency !== action.queue.concurrency) {
      throw new Error(`Queue ${group.name} có concurrency không thống nhất giữa các action.`);
    } else {
      group.actions.push(action.name);
    }
  }

  return {
    actions: [...byName.values()],
    getAction: (name) => byName.get(name),
    queueGroups: [...groups.values()]
  };
}

// Every *.ts file in this folder except index.ts default-exports an action definition.
export async function loadActions(directory: string = import.meta.dirname): Promise<Registry> {
  const files = readdirSync(directory).filter((file) => file.endsWith('.ts') && file !== 'index.ts').sort();
  const modules: { default: ActionDefinition }[] = await Promise.all(
    files.map((file) => import(pathToFileURL(join(directory, file)).href))
  );
  return defineActions(modules.map((module) => module.default));
}

export const { actions, getAction, queueGroups } = await loadActions();
