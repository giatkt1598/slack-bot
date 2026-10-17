# Slack Command Runner

Bot Slack nhận lệnh từ người dùng (ví dụ `deploy GCD-123`), đưa vào hàng đợi BullMQ/Redis và giao cho một worker Node.js chạy trên máy Windows. Trong lúc lệnh chạy:

- output của lệnh được stream trực tiếp vào thread Slack (một message log tự cập nhật);
- khi lệnh hỏi (ví dụ `Are you sure? [Y/n]`), bot đăng `❓ <câu hỏi>`; người dùng reply trong thread và câu trả lời được đưa thẳng vào lệnh;
- xong thì bot báo `#N hoàn tất` hoặc `#N thất bại …`.

Lệnh có sẵn:

| Lệnh | Chạy | Kiểu |
|---|---|---|
| `deploy GCD-123` | `gcmd deploy --ticket GCD-123` | Tuần tự (mỗi lần 1 job), có hỏi xác nhận |
| `status GCD-123` | `gcmd status --ticket GCD-123` | Song song (tối đa 4 job) |

## Kiến trúc

```
Slack ──Socket Mode──▶ Bot (Docker) ──BullMQ / Redis pub/sub──▶ Worker (Windows) ──▶ gcmd
        ◀── message, log, câu hỏi ──┘                ◀── output, prompt, kết quả ──┘
```

- **Bot** (`src/bot/`): chạy trong Docker, nhận tin nhắn từ Slack, xếp job vào hàng đợi, hiển thị log và chuyển câu trả lời tới worker.
- **Worker** (`src/worker/`): chạy trực tiếp trên máy Windows có `gcmd`, thực thi lệnh và gửi output về.
- **Redis**: chạy trong Docker, chỉ mở ở `127.0.0.1:6379` cho worker trên cùng máy.

---

## 1. Đăng ký Slack app và bot

### Cách nhanh: tạo bằng manifest

1. Vào <https://api.slack.com/apps> → **Create New App** → **From an app manifest**.
2. Chọn workspace, chọn định dạng **YAML**, dán nội dung sau (có thể đổi `name`/`display_name`):

```yaml
display_information:
  name: Command Runner
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Command Runner
    always_online: true
  slash_commands:
    - command: /deploy
      description: Deploy ticket qua gcmd
      usage_hint: GCD-123
      should_escape: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - chat:write
      - commands
      - groups:history
      - im:history
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

3. Bấm **Create**, rồi làm tiếp phần [Lấy token](#lấy-token).

### Cách thủ công (nếu không dùng manifest)

1. <https://api.slack.com/apps> → **Create New App** → **From scratch** → đặt tên, chọn workspace.
2. **Socket Mode** → bật **Enable Socket Mode**.
3. **OAuth & Permissions** → **Bot Token Scopes** → thêm:
   `app_mentions:read`, `channels:history`, `chat:write`, `commands`, `groups:history`, `im:history`.
4. **Event Subscriptions** → bật **Enable Events** → **Subscribe to bot events** → thêm:
   `app_mention`, `message.channels`, `message.groups`, `message.im` → **Save Changes**.
5. **Slash Commands** → **Create New Command** → Command `/deploy`, Short Description `Deploy ticket qua gcmd`, Usage Hint `GCD-123` → **Save**.
6. **App Home** → mục **Show Tabs** → bật **Messages Tab** và tick **Allow users to send Slash commands and messages from the messages tab**.

### Lấy token

Bot cần **cả hai** token:

| Biến | Lấy ở đâu | Dùng để |
|---|---|---|
| `SLACK_APP_TOKEN` (`xapp-…`) | **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** → thêm scope `connections:write` → **Generate** | Mở kết nối Socket Mode, nhận event |
| `SLACK_BOT_TOKEN` (`xoxb-…`) | **OAuth & Permissions** → **Install to Workspace** → **Allow** → copy **Bot User OAuth Token** | Gửi và cập nhật message |

> Mỗi khi thay đổi scope hoặc event, Slack sẽ yêu cầu **Reinstall to Workspace** — phải cài lại thì thay đổi mới có hiệu lực.

### Thêm bot vào kênh

Trong kênh muốn dùng bot, gõ `/invite @Command Runner` (hoặc tên bot của bạn). Nhắn riêng (DM) với bot thì không cần bước này.

### (Tuỳ chọn) Giới hạn ai được dùng bot

- **ID kênh**: mở kênh → bấm tên kênh → cuối tab **About** có dòng `Channel ID` (dạng `C0123…`).
- **ID người dùng**: mở profile → **⋮** → **Copy member ID** (dạng `U0123…`).

Điền vào `AUTHORIZED_CHANNEL_IDS` / `AUTHORIZED_USER_IDS` (nhiều giá trị cách nhau bằng dấu phẩy). Để trống nghĩa là **ai cũng dùng được**. Cùng danh sách này áp dụng cho cả việc chạy lệnh lẫn trả lời câu hỏi của lệnh.

---

## 2. Cài đặt và chạy

Yêu cầu: Docker Desktop, Node.js ≥ 20 trên máy Windows có `gcmd`.

### Cấu hình

```powershell
copy .env.example .env
```

Mở `.env` và điền:

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | Token ở bước trên | — |
| `REDIS_HOST`, `REDIS_PORT` | Redis cho worker (bot trong Docker tự dùng `redis`) | `127.0.0.1`, `6379` |
| `DATABASE_PATH` | File SQLite lưu lịch sử job (trong container bot) | `/data/slack-bot.sqlite` |
| `QUEUE_PREFIX` | Tiền tố tên hàng đợi trong Redis | `command-jobs` |
| `COMMAND_TIMEOUT_MS` | Thời gian chạy tối đa của lệnh (không tính lúc chờ trả lời) | 30 phút |
| `INPUT_TIMEOUT_MS` | Thời gian chờ người dùng trả lời một câu hỏi, quá hạn thì huỷ lệnh | 30 phút |
| `AUTHORIZED_CHANNEL_IDS`, `AUTHORIZED_USER_IDS` | Giới hạn kênh / người dùng | trống = tất cả |

### Chạy bot và Redis

```powershell
docker compose up -d --build
docker logs slack-bot-bot-1    # phải thấy: ⚡ Slack bot is running in Socket Mode (actions: deploy, status)
```

### Chạy worker (trên máy Windows có `gcmd`)

```powershell
npm ci
npm run start:worker
```

Worker in ra một dòng `ready on …` cho mỗi hàng đợi. `gcmd` phải nằm trong `PATH` của tài khoản chạy worker.

Nếu Docker chạy ở máy khác, đặt `REDIS_HOST` là địa chỉ máy đó và mở cổng Redis trong mạng nội bộ. **Không bao giờ mở Redis ra Internet.**

### Chạy worker tự động khi khởi động máy (Task Scheduler)

Tạo task chạy khi khởi động và tự khởi động lại khi lỗi:

```text
Program:   C:\Program Files\nodejs\node.exe
Arguments: D:\repos\slack-bot\src\worker\index.js
Start in:  D:\repos\slack-bot
```

Chạy task bằng tài khoản có quyền thực thi `gcmd`. Biến môi trường lấy từ file `.env` trong thư mục dự án.

---

## 3. Sử dụng trên Slack

### Gửi lệnh

Có ba cách, kết quả như nhau:

- **Nhắn riêng** cho bot: `deploy GCD-123`
- **@mention** trong kênh: `@Command Runner deploy GCD-123`
- **Slash command**: `/deploy GCD-123`

Ticket phải có dạng `CHỮ-SỐ` (ví dụ `GCD-123`). Gõ bất kỳ thứ gì bot không hiểu, bot sẽ trả lời danh sách lệnh có thể dùng.

### Theo dõi và trả lời

```
#1 Đang chạy lệnh `gcmd deploy --ticket GCD-123`
  └ 📜 Log (đang chạy…)                           ← tự cập nhật ~2 giây/lần
  └ ❓ Are you sure you want to deploy GCD-123 to production? [Y/n]
  └ (bạn reply: Y)                                ← bot không trả lời, câu trả lời hiện trong log
  └ ❓ Release note (optional):
  └ (bạn reply: fix login)
  └ #1 hoàn tất
```

- Trả lời bằng cách **reply trong thread của job**. Câu trả lời được gửi vào lệnh kèm phím Enter; reply rỗng (chỉ @mention bot) tương đương nhấn Enter.
- Bất kỳ ai có quyền dùng bot đều trả lời được.
- Không ai trả lời sau `INPUT_TIMEOUT_MS` (mặc định 30 phút) → lệnh bị huỷ: `#1 thất bại: Hết thời gian chờ trả lời (30 phút).`
- Các job `deploy` chạy lần lượt — job sau ở trạng thái chờ cho tới khi job trước xong. Các job `status` chạy song song.

### Khi có sự cố

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Bot không phản hồi gì | Bot chưa chạy (`docker logs slack-bot-bot-1`), thiếu scope/event, hoặc chưa **Reinstall** app sau khi đổi scope; trong kênh thì bot chưa được `/invite` |
| Reply trong thread bị bỏ qua | Thiếu event `message.channels` / `message.groups` hoặc scope `channels:history` / `groups:history` |
| Job đứng mãi ở "Đang chạy lệnh…" mà không có log | Worker chưa chạy hoặc không kết nối được Redis |
| `⚠️ Không có worker nào đang chạy #N` | Worker đã dừng giữa chừng khi lệnh đang chờ trả lời |
| `#N thất bại: spawn gcmd ENOENT` | `gcmd` không nằm trong `PATH` của worker |

---

## 4. Thêm lệnh mới

Tạo một file trong `src/actions/` — bot và worker tự nạp, help text và cú pháp chat tự cập nhật:

```js
// src/actions/restart.js
const { validateTicket } = require('../shared/validators');

module.exports = {
  name: 'restart',                                   // từ khoá lệnh khi chat
  description: 'Restart service của ticket.',
  usage: 'restart GCD-123',
  slashCommand: '/restart',                          // tuỳ chọn; phải tạo thêm slash command trong Slack app
  queue: { name: 'restart', concurrency: 1 },        // 1 = tuần tự, N = tối đa N job song song
  timeoutMs: 10 * 60 * 1000,                         // thời gian chạy tối đa, không tính lúc chờ trả lời
  promptPatterns: [/\[y\/n\]\s*$/i],                 // tuỳ chọn; dòng chưa kết thúc mà im lặng 0.5 giây cũng được coi là câu hỏi
  parse: (argsText) => ({ ticket: argsText.trim() }),
  validate: (input) => ({ ticket: validateTicket(input.ticket) }),
  command: (input) => ({ file: 'gcmd', args: ['restart', '--ticket', input.ticket] })
};
```

Lưu ý:

- Luôn truyền tham số dưới dạng mảng `args` và kiểm tra mọi giá trị người dùng nhập trong `validate` — **không bao giờ ghép thành chuỗi lệnh shell**.
- Khởi động lại cả bot (`docker compose up -d --build bot`) và worker sau khi thêm lệnh.

---

## 5. Kiểm thử

### Mock `gcmd`

`tools/gcmd-command` là bản giả lập CLI `gcmd` (deploy có hỏi `[Y/n]` và release note, status không hỏi). Nó được cài global với tên **`gcmd`** nên sẽ **che `gcmd` thật** trên máy:

```powershell
npm i -g ./tools/gcmd-command     # cài
gcmd deploy --ticket GCD-123      # thử tay
npm rm -g gcmd-command            # gỡ khi dùng gcmd thật
```

Chi tiết: `tools/gcmd-command/README.md`.

### Unit test

```powershell
npm test                                        # toàn bộ
node --test test/runner.test.js                 # một file
node --test --test-name-pattern="cancels"       # một test theo tên
```
