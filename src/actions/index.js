const fs = require('node:fs');
const path = require('node:path');
const { config } = require('../config');

const requiredFields = {
  name: 'string',
  description: 'string',
  usage: 'string',
  parse: 'function',
  validate: 'function',
  command: 'function'
};

// Validates action definitions and groups them by queue. Actions sharing a queue must agree on its concurrency.
function defineActions(definitions) {
  const byName = new Map();
  for (const definition of definitions) {
    const label = definition?.name || '(không tên)';
    for (const [field, type] of Object.entries(requiredFields)) {
      if (typeof definition?.[field] !== type) throw new Error(`Action ${label}: "${field}" phải là ${type}.`);
    }
    if (!/^[a-z][a-z0-9-]*$/.test(definition.name)) throw new Error(`Action ${label}: tên chỉ gồm a-z, 0-9, "-".`);
    if (byName.has(definition.name)) throw new Error(`Action ${label} bị khai báo trùng.`);
    const queue = { name: definition.name, concurrency: 1, ...definition.queue };
    if (!Number.isInteger(queue.concurrency) || queue.concurrency < 1) {
      throw new Error(`Action ${label}: queue.concurrency phải là số nguyên >= 1.`);
    }
    byName.set(definition.name, { timeoutMs: config.commandTimeoutMs, promptPatterns: [], ...definition, queue });
  }

  const groups = new Map();
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

// Every *.js file in this folder except index.js is an action definition.
function loadActions(directory = __dirname) {
  const files = fs.readdirSync(directory).filter((file) => file.endsWith('.js') && file !== 'index.js').sort();
  return defineActions(files.map((file) => require(path.join(directory, file))));
}

module.exports = { ...loadActions(), defineActions, loadActions };
