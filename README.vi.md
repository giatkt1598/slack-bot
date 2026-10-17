# Slack Command Runner

[English](README.md) | **Tiếng Việt**

Bot Slack nhận lệnh từ người dùng (ví dụ `deploy GCD-123`), xếp vào hàng đợi và chạy lệnh ngay trên máy Windows có `gcmd` — tất cả trong **một tiến trình Node.js**. Trong lúc lệnh chạy:

- output của lệnh được stream trực tiếp vào thread Slack (một message log tự cập nhật);
- khi lệnh hỏi (ví dụ `Are you sure? [Y/n]`), bot đăng `❓ [#N] <câu hỏi>`; người dùng reply trong thread và câu trả lời được đưa thẳng vào lệnh;
- xong thì bot báo `#N completed` hoặc `#N failed …`.

Tin nhắn của bot trên Slack đều bằng tiếng Anh.

Lệnh có sẵn:

| Lệnh | Chạy | Kiểu |
|---|---|---|
| `deploy GCD-123` | `gcmd deploy --ticket GCD-123` | Tuần tự (mỗi lần 1 job), có hỏi xác nhận |
| `status GCD-123` | `gcmd status --ticket GCD-123` | Song song (tối đa 4 job) |
| `ipconfig` / `ipconfig /all` | `ipconfig` / `ipconfig /all` trên máy chạy bot | Song song (tối đa 4 job); chỉ nhận đúng 2 dạng này |

## Kiến trúc

```
Slack ◀──Socket Mode──▶ Node.js trên máy Windows ──▶ gcmd
                        ├─ bot (src/bot/): nhận tin nhắn, hiển thị log, câu hỏi, kết quả
                        ├─ hàng đợi (src/worker/scheduler.ts): tuần tự / song song theo từng lệnh
                        └─ SQLite (data/slack-bot.sqlite): lịch sử job, đánh số #N
```

- Socket Mode chỉ cần kết nối **ra ngoài** tới Slack — không cần mở cổng hay public URL.
- Không cần Docker, Redis hay dịch vụ hàng đợi riêng.
- **Chỉ được chạy một bản.** Bản thứ hai sẽ tự thoát với thông báo `The bot is already running in another process (PID …)` (lock file `data/slack-bot.lock`).
- Khi khởi động lại: job đang chạy dở bị báo `#N failed: Interrupted because the bot restarted.`; job còn trong hàng đợi được chạy tiếp theo thứ tự.

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
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - chat:write
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
   `app_mentions:read`, `channels:history`, `chat:write`, `groups:history`, `im:history`.
4. **Event Subscriptions** → bật **Enable Events** → **Subscribe to bot events** → thêm:
   `app_mention`, `message.channels`, `message.groups`, `message.im` → **Save Changes**.
5. **App Home** → mục **Show Tabs** → bật **Messages Tab** và tick **Allow users to send Slash commands and messages from the messages tab**.

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

Điền vào `AUTHORIZED_CHANNEL_IDS` / `AUTHORIZED_USER_IDS` (nhiều giá trị cách nhau bằng dấu phẩy). Để trống nghĩa là **ai cũng dùng được**. Cùng danh sách này áp dụng cho việc chạy lệnh, trả lời câu hỏi của lệnh, xem hàng đợi và huỷ job.

---

## 2. Cài đặt và chạy

Yêu cầu: Node.js ≥ 24 trên máy Windows có `gcmd`. Dự án viết bằng TypeScript và được Node chạy trực tiếp (không cần bước build).

### Cấu hình

```powershell
copy .env.example .env
```

Mở `.env` và điền:

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | Token ở bước trên | — |
| `DATABASE_PATH` | File SQLite lưu lịch sử job; lock file nằm cùng thư mục | `./data/slack-bot.sqlite` |
| `COMMAND_TIMEOUT_MS` | Thời gian chạy tối đa của lệnh (không tính lúc chờ trả lời) | 30 phút |
| `INPUT_TIMEOUT_MS` | Thời gian chờ người dùng trả lời một câu hỏi, quá hạn thì huỷ lệnh | 30 phút |
| `AUTHORIZED_CHANNEL_IDS`, `AUTHORIZED_USER_IDS` | Giới hạn kênh / người dùng | trống = tất cả |

### Chạy bot

```powershell
npm ci
npm run start   # dev: nodemon, tự reload khi sửa file trong src/ hoặc .env
npm run serve   # chạy một lần, không reload
```

Phải thấy `⚡ Slack bot is running in Socket Mode (commands: …)`. `gcmd` phải nằm trong `PATH` của tài khoản chạy bot. Dừng bằng `Ctrl+C`.

> Mỗi lần nodemon reload, các lệnh đang chạy (ví dụ deploy đang chờ `[Y/n]`) bị kill và báo `#N failed: Interrupted because the bot restarted.` Vì vậy chỉ dùng `npm run start` khi phát triển.

### Tự chạy khi đăng nhập Windows (Task Scheduler)

```powershell
npm run register                # tạo task: tự chạy bot mỗi khi bạn đăng nhập Windows
npm run register -- -StartNow   # tạo task và chạy luôn bây giờ
npm run unregister              # gỡ task (và folder), dừng bot mà task đang chạy
```

- Task nằm trong folder riêng: **Task Scheduler Library › SlackBot › SlackCommandRunner** (mở Task Scheduler từ Windows Search). `unregister` xoá cả folder khi nó trống.
- Task chạy `node src/index.ts` (không nodemon) bằng tài khoản Windows của bạn, không cần quyền admin, qua launcher ẩn `scripts/run-bot.vbs` (`wscript.exe`) nên không hiện cửa sổ console.
- Log ghi thêm vào `data/bot.log`.
- Không giới hạn thời gian chạy; nếu task lỗi thì tự chạy lại sau 1 phút. Chạy lại `npm run register` để cập nhật task (ví dụ sau khi đổi thư mục dự án hoặc phiên bản Node).
- `unregister` chỉ dừng bot do task khởi động; bot chạy bằng `npm run start`/`serve` được giữ nguyên.
- **Chỉ được chạy một bản**: khi task đang chạy thì không chạy thêm `npm run start`/`serve` (và ngược lại) — bản thứ hai sẽ thoát với `The bot is already running in another process (PID …)`.

---

## 3. Sử dụng trên Slack

### Gửi lệnh

Có hai cách, kết quả như nhau:

- **Nhắn riêng** cho bot: `deploy GCD-123`
- **@mention** trong kênh: `@Command Runner deploy GCD-123`

Ticket phải có dạng `CHỮ-SỐ` (ví dụ `GCD-123`). Gõ bất kỳ thứ gì bot không hiểu, bot sẽ trả lời `Supported commands:` kèm danh sách lệnh có thể dùng.

### Theo dõi và trả lời

**Nhắn riêng (DM):** bot trả lời thẳng vào cuộc trò chuyện, không dùng thread. Khi bot đăng `❓ [#N] …`, chỉ cần nhắn câu trả lời như tin nhắn bình thường:

```
#1 Running `gcmd deploy --ticket GCD-123`
📜 Log #1 (running…)
❓ [#1] Are you sure you want to deploy GCD-123 to production? [Y/n]
Y                                                 ← bạn nhắn
❓ [#1] Release note (optional):
fix login                                         ← bạn nhắn
#1 completed
```

> Trong DM, khi có job đang chờ trả lời thì tin nhắn tiếp theo **luôn được coi là câu trả lời** (kể cả khi bạn gõ `deploy …`). Trả lời xong rồi mới gửi lệnh mới.

**Trong kênh:** mọi cập nhật của job nằm trong thread của message `#N Running …` (hoặc thread nơi bạn @mention bot):

```
#1 Running `gcmd deploy --ticket GCD-123`
  └ 📜 Log #1 (running…)                          ← tự cập nhật ~2 giây/lần
  └ ❓ [#1] Are you sure you want to deploy GCD-123 to production? [Y/n]
  └ (bạn reply: Y)                                ← bot không trả lời, câu trả lời hiện trong log
  └ ❓ [#1] Release note (optional):
  └ (bạn reply: fix login)
  └ #1 completed
```

- Trong kênh, trả lời bằng cách **reply trong thread của job**. Câu trả lời được gửi vào lệnh kèm phím Enter; reply rỗng (chỉ @mention bot) tương đương nhấn Enter.
- Bất kỳ ai có quyền dùng bot đều trả lời được.
- Không ai trả lời sau `INPUT_TIMEOUT_MS` (mặc định 30 phút) → lệnh bị huỷ: `#1 failed: No answer received in time (30 minutes).`
- Các job `deploy` chạy lần lượt — job sau ở trạng thái chờ cho tới khi job trước xong (và đã báo `completed`/`failed`). Các job `status` chạy song song.
- Nếu job phải chờ (đã có job đang đợi, hoặc mọi suất chạy đều bận), bot báo trước `Added #4 \`gcmd deploy --ticket GCD-111\` to the queue`, rồi khi job bắt đầu chạy mới báo `#4 Running …`. Job chạy được ngay thì chỉ có message `#4 Running …`.

### Xem hàng đợi

Gõ `queue` (trong DM, khi @mention bot, hoặc reply trong thread của một job đang chạy) để xem các job đang chạy và đang đợi, theo từng lệnh:

```
📋 Queue
*deploy* (sequential)
• #15 `gcmd deploy --ticket GCD-1` — ❓ waiting for an answer · @Gia
• #16 `gcmd deploy --ticket GCD-2` — ⏳ queued (position 1) · @Gia
*status* (up to 4 in parallel)
• #18 `gcmd status --ticket GCD-9` — ▶️ running · @Gia
```

Lệnh không có job nào sẽ không được liệt kê; nếu tất cả đều trống, bot trả lời `📋 The queue is empty…`. Giống `cancel`, `queue` luôn được hiểu là lệnh của bot, kể cả khi có job trong DM đang chờ trả lời.

### Huỷ job

Gõ `cancel #3` (hoặc `cancel 3`) — trong DM, khi @mention bot, hoặc reply trong thread của job:

| Trạng thái job | Bot làm gì |
|---|---|
| Đang xếp hàng | Gỡ khỏi hàng đợi, báo `#3 cancelled by @bạn` |
| Đang chạy / đang chờ trả lời | Kill lệnh (cả các tiến trình con), báo `#3 cancelled by @bạn` |
| Đã xong (hoàn tất, thất bại hoặc đã huỷ) | Trả lời `#3 has already finished.` |
| Không có job số đó | Trả lời `#3 not found.` |

- `cancel` luôn được hiểu là lệnh huỷ, kể cả khi job trong DM đang chờ trả lời.
- Thông báo huỷ được đăng ở nơi của job (DM hoặc thread của job). Nếu bạn gõ `cancel` ở chỗ khác, bot trả lời thêm `Cancelling #3…` ngay tại chỗ đó.
- Ai có quyền dùng bot ở kênh của job thì huỷ được job đó.

### Khi có sự cố

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Bot không phản hồi gì | Bot chưa chạy (`npm run start` / `npm run register`, xem `data/bot.log`), thiếu scope/event, hoặc chưa **Reinstall** app sau khi đổi scope; trong kênh thì bot chưa được `/invite` |
| Reply trong thread bị bỏ qua | Thiếu event `message.channels` / `message.groups` hoặc scope `channels:history` / `groups:history` |
| `The bot is already running in another process (PID …)` khi khởi động | Đã có một bản đang chạy (ví dụ từ Task Scheduler). Tắt bản đó trước (`npm run unregister` hoặc `Ctrl+C`) |
| `#N failed: Interrupted because the bot restarted.` | Bot bị tắt/khởi động lại khi job đang chạy; chạy lại lệnh nếu cần |
| `#N failed: spawn gcmd ENOENT` | `gcmd` không nằm trong `PATH` của tài khoản chạy bot |

---

## 4. Thêm lệnh mới

Mỗi lệnh là một **command**: một file `<tên>.command.ts` trong `src/commands/`. Bot tự nạp mọi file `*.command.ts`; help text và cú pháp chat tự cập nhật:

```ts
// src/commands/restart.command.ts
import { validateTicket } from '../shared/validators.ts';
import type { CommandDefinition } from '../types.ts';

export default {
  name: 'restart',                                   // từ khoá lệnh khi chat
  description: 'Restart the service of a ticket.',   // hiện trong help text (tiếng Anh)
  usage: 'restart GCD-123',
  queue: { name: 'restart', concurrency: 1 },        // 1 = tuần tự, N = tối đa N job song song
  timeoutMs: 10 * 60 * 1000,                         // thời gian chạy tối đa, không tính lúc chờ trả lời
  promptPatterns: [/\[y\/n\]\s*$/i],                 // tuỳ chọn; dòng chưa kết thúc mà im lặng 0.5 giây cũng được coi là câu hỏi
  parse: (argsText) => ({ ticket: argsText.trim() }),
  validate: (input) => ({ ticket: validateTicket(input.ticket) }),
  build: (input) => ({ file: 'gcmd', args: ['restart', '--ticket', input.ticket] })  // tiến trình sẽ chạy
} satisfies CommandDefinition;
```

Lưu ý:

- Import tương đối phải ghi rõ đuôi `.ts`; chạy `npm run typecheck` để kiểm tra kiểu.
- Luôn truyền tham số dưới dạng mảng `args` và kiểm tra mọi giá trị người dùng nhập trong `validate` — **không bao giờ ghép thành chuỗi lệnh shell**.
- Viết `description` và thông báo lỗi bằng tiếng Anh, giống các lệnh có sẵn.
- Khởi động lại bot sau khi thêm lệnh.

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
npm run typecheck                               # kiểm tra kiểu (tsc, không build)
npm test                                        # toàn bộ
node --test test/runner.test.ts                 # một file
node --test --test-name-pattern="cancels"       # một test theo tên
```
