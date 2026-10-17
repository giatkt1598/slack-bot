// Turns Slack message text into plain text: drops user mentions and decodes Slack's HTML escaping.
function toPlainText(text) {
  return String(text || '')
    .replace(/<@[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function createCommands(actions) {
  // "<@U123> /deploy GCD-123" or "deploy GCD-123" → { action, args: 'GCD-123' }; unknown → null.
  function parseCommand(text) {
    const words = toPlainText(text).split(/\s+/);
    const name = words[0].replace(/^\//, '').toLowerCase();
    const action = actions.find((candidate) => candidate.name === name);
    return action ? { action, args: words.slice(1).join(' ') } : null;
  }

  function helpText() {
    const list = [...actions, { usage: 'cancel #3', description: 'Huỷ job đang xếp hàng, đang chạy hoặc đang chờ trả lời.' }]
      .map(({ usage, description }) => `• \`${usage}\` — ${description}`).join('\n');
    return `Tôi chưa hiểu ý bạn. Các lệnh tôi có thể hiểu là:\n${list}\n`
      + '_Gõ trong DM, khi @mention tôi, hoặc dùng slash command. Khi command hỏi, hãy trả lời trong thread của job._';
  }

  return { parseCommand, helpText };
}

// "cancel #3" / "cancel 3" → { number: 3 }; "cancel" followed by anything else → { number: null }; not a cancel → null.
function parseCancel(text) {
  const match = toPlainText(text).match(/^\/?cancel(?:\s+(.*))?$/i);
  if (!match) return null;
  const number = (match[1] || '').trim().match(/^#?(\d+)$/);
  return { number: number ? Number(number[1]) : null };
}

module.exports = { createCommands, parseCancel, toPlainText };
