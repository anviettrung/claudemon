# ClaudeMon

ClaudeMon là bảng điều khiển các session Claude Code trên mọi máy của mình (các PC khai trong `machines.json`, cùng điện thoại).
Ngồi ở một máy vẫn mở, chat, duyệt quyền và đóng được session trên máy khác, đồng thời sắp xếp session vào
thư mục, nhãn và ghim theo ý mình.

Chỉ chạy trên **Windows**. Các PC và điện thoại nối với nhau bằng **Tailscale** (không mở port, không cần server).

## Cài

Mỗi người một kho riêng (private): ClaudeMon ghi cách sắp xếp session lên nhánh `claudemon-library` của chính kho
này, và nút *Khởi động lại agent* kéo bản mới từ kho này.

1. Trên GitHub tạo kho mới từ kho này (**Use this template** → Private), clone về PC, nên cùng đường dẫn trên mọi máy:
   ```powershell
   git clone https://github.com/<you>/claudemon.git D:\Projects\claudemon
   ```
   Máy phải push được lên kho (Git Credential Manager tự hỏi đăng nhập ở lần đầu).
2. Sửa `machines.json`: `owner` = email tài khoản Tailscale của bạn (chỉ tài khoản này mở được trang qua tailnet),
   mỗi PC một dòng: `name` (tên ngắn hiện trên giao diện), `computer` (= `$env:COMPUTERNAME` của máy đó), `host` (tên
   máy trong tailnet, chữ thường; `install.ps1` tự đặt). `wakeup.claude.enabled: true` nếu muốn tự mở cửa sổ 5 giờ
   của Claude (mục "Hạn mức Claude"). Commit, push.
3. Cài Tailscale theo mục "Triển khai Tailscale" bên dưới (một máy dùng một mình thì bỏ qua được, mở `localhost`).
4. Nháy đúp `install.cmd` trên từng PC (chạy lại bao nhiêu lần cũng được). Cần `claude` (Claude Code) đã đăng nhập.

`install.ps1` làm:

1. Tìm Bun, chưa có thì cài bằng winget.
2. `bun install` khi `bun.lock` đổi.
3. Đăng ký Scheduled Task **ClaudeMon Agent** chạy lúc đăng nhập, qua `conhost --headless` nên không có cửa sổ.
   Task chạy `scripts/run-agent.ps1`: bật agent, ghi `agent.log` / `agent.out.log` / `agent.err.log`, agent thoát
   thì 5 giây sau bật lại.
4. Kho sang commit khác thì khởi động lại agent, trừ khi đang có session chạy (để lần cài sau).
5. Tailscale đã đăng nhập thì đặt tên máy theo `machines.json` và bật `tailscale serve --bg 7420`.

Chạy tay để phát triển (tắt task trước: `Stop-ScheduledTask 'ClaudeMon Agent'`):

```powershell
cd tools\claudemon
bun run dev          # http://127.0.0.1:7420, tự nạp lại khi sửa mã
```

Cài thành app: mở `http://127.0.0.1:7420` bằng Chrome, bấm biểu tượng Cài trên thanh địa chỉ. Chỉ app cài kiểu này (PWA) mới có
thanh tiêu đề theo theme; đã có app thì `install.ps1` gỡ shortcut `chrome --app` cũ và không tạo lại.

Khởi động lại agent (kéo code mới trước): trên máy tính, nút bánh răng (Hệ thống) → **Khởi động lại agent <máy>**. Không mở được app thì
chạy tay: `Stop-ScheduledTask 'ClaudeMon Agent'`, tắt tiến trình `run-agent.ps1` và `bun ... src/agent.ts`, rồi `Start-ScheduledTask 'ClaudeMon Agent'`.

Biến môi trường: `CLAUDEMON_PORT` đổi cổng, `CLAUDEMON_DEV=1` bật chế độ dev của Bun.

Kiểm thử từ đầu đến cuối trên các agent đang chạy (mọi máy trong `machines.json`), chạy session Claude thật nên
tốn một ít lượt dùng:

```powershell
bun run smoke                                   # mọi nhóm
bun run scripts/smoke.ts basic security pwa     # chỉ các nhóm không gọi Claude
```

Nhóm: `basic` (danh sách, cảnh báo nơi khác), `security` (tài khoản/Origin lạ, đầu vào sai), `session` (từ chối,
cho phép, AskUserQuestion, acceptEdits, dừng, đóng, chạy tiếp), `remote` (điều khiển máy khác qua tailnet),
`library` (sắp xếp và đồng bộ hai chiều), `pwa` (manifest, icon, service worker, HTTPS). Máy khác dùng thư mục
`CLAUDEMON_REMOTE_CWD` (mặc định `D:\Projects\claudemon`, đặt theo chỗ kho nằm trên máy kia).
Gỡ: `Unregister-ScheduledTask 'ClaudeMon Agent' -Confirm:$false` và `tailscale serve --https=443 off`.

| Tệp | Vai trò |
|---|---|
| `src/agent.ts` | Server HTTP + WebSocket, API `/api/...`, kiểm quyền truy cập |
| `src/sessions.ts` | Một session đang chạy: hàng đợi tin nhắn, duyệt quyền, ngắt, đóng |
| `src/normalize.ts` | Đổi tin nhắn Claude Code sang dạng gọn cho giao diện |
| `src/wakeup.ts` | Hạn mức Claude và tự đánh thức cửa sổ 5 giờ |
| `src/push.ts`, `web/push.ts` | Thông báo đẩy (Web Push) khi session xong lượt hoặc cần duyệt |
| `src/library.ts` | Cách sắp xếp session, đồng bộ qua nhánh git `claudemon-library` |
| `src/protocol.ts` | Kiểu dữ liệu chung giữa agent và giao diện |
| `web/` | Giao diện chat (Bun tự đóng gói khi chạy) |
| `web/htmlview.ts` | Xem báo cáo HTML ngay trong app (iframe sandbox), kèm nút mở bằng trình duyệt |
| `web/theme.ts`, `web/theme-retro.css`, `web/theme-aero.css` | Chọn giao diện: Claude / Retro (Windows 95) / Frutiger Aero (Vista / 7), mỗi kiểu có Sáng / Tối / Theo máy |
| `scripts/ui-preview.ts`, `scripts/ui-shots.ts` | Xem giao diện với dữ liệu giả (cổng 7430) và chụp màn hình điện thoại / PC, sáng / tối |
| `machines.json` | Danh sách máy, cổng, tài khoản chủ |

## Những gì đã chốt

| Câu hỏi | Đã chọn | Hệ quả |
|---|---|---|
| Các máy nối với nhau thế nào | Tailscale | Không cần mở port hay thuê server. Mỗi máy và điện thoại cài Tailscale một lần, cùng một tài khoản. |
| Giao diện chạy ở đâu | Web app + PWA | Mở trên trình duyệt ở PC hay điện thoại đều được, cài lên màn hình chính như một app. |
| AI chạy bằng gì | Claude Code + gói đăng ký | Điều khiển Claude Code có sẵn trên từng máy, dùng luôn lượt đăng nhập hiện có. Session nằm ở `~/.claude/projects`, nên CLI và Claude desktop mở tiếp được. |
| Cách sắp xếp session lưu ở đâu | Trong chính kho này (git), nhánh riêng `claudemon-library` | Không cần server. Máy đang mở thấy ngay; máy khác thấy sau tối đa 1 phút. |

## Kiến trúc

```
 Trình duyệt (PC / điện thoại)
        │  HTTPS + WebSocket, chỉ trong tailnet
        ▼
 ┌─────────────────┐  tailnet  ┌─────────────────┐
 │ claudemon-agent A│◄─────────►│ claudemon-agent B│
 └────────┬────────┘           └────────┬────────┘
          │ Agent SDK                   │ Agent SDK
          ▼                             ▼
     Claude Code                   Claude Code
     ~/.claude/projects            ~/.claude/projects
          │                             │
          └─ nhánh claudemon-library (git) ───────┘
```

**claudemon-agent** là một daemon nhỏ viết bằng TypeScript, chạy trên Bun, có mặt trên mỗi máy:

- Đọc `~/.claude/projects/*/*.jsonl` để biết máy có những session nào: thư mục làm việc, tiêu đề, lần cuối hoạt động.
- Mở session mới hoặc chạy tiếp session cũ (`resume`) qua Claude Agent SDK, rồi đẩy luồng tin nhắn ra WebSocket.
- Đóng session: ngắt lượt đang chạy, rồi tắt tiến trình.
- Cảnh báo, không khoá: nếu tệp `.jsonl` của session vừa được nơi khác ghi vào (Claude desktop, CLI) trong vài
  phút gần đây, giao diện hiện dải cảnh báo "Session có thể đang mở ở nơi khác" trước khi gửi tin. Người dùng
  vẫn gửi được; chạy song song hai nơi có thể làm rối lịch sử.
- Cấp cho mọi session tool `send_user_file` (MCP `claudemon` chạy ngay trong agent): Claude gửi ảnh, video, tệp trên
  máy cho người dùng, hiện ngay trong khung chat như `SendUserFile` của app Claude (tool đó không có khi chạy qua
  Agent SDK). Tool được cho phép sẵn, không hỏi quyền; agent chỉ phục vụ tệp có tên trong lịch sử session.
- Gặp yêu cầu duyệt quyền (`canUseTool`) thì hiện thành thẻ Cho phép / Từ chối trên giao diện, bất kể đang mở
  từ máy nào. Nhờ vậy điều khiển được hết từ xa.
- Phục vụ luôn web app. Vào agent của máy nào cũng thấy đủ mọi máy, vì giao diện tự nối tới từng agent trong danh sách.

**Giao diện** có bố cục giống Claude desktop:

- Cột trái: **Đã ghim**, rồi các **thư mục tự đặt** (chứa session của máy nào cũng được), rồi phần còn lại theo
  chế độ xem chọn ở thanh **Máy · Dự án · Thời gian** (nhớ trên từng thiết bị):
  - *Máy*: máy → thư mục làm việc (nhóm con, mặc định đóng) → session. Session tự do là một nhóm con như mọi thư mục.
  - *Dự án*: nhóm **✦ Session tự do**, rồi các **dự án tự tạo** (◆, theo thứ tự đặt) → dòng *Task* + máy → session,
    rồi nhóm **Khác** (mặc định đóng) chứa phần còn lại, chia theo tên thư mục. Chưa tạo dự án nào thì các nhóm thư
    mục nằm ngay cấp đầu như trước.
  - *Thời gian*: Hôm nay / Hôm qua / 2–7 ngày / Cũ hơn, theo *hoạt động gần đây* hoặc *ngày tạo*; session tự do nằm chung.
  Chấm trạng thái: đang chạy, chờ duyệt, đang mở, đang mở nơi khác.
- **Dự án tự tạo** (`＋ Dự án mới…` cuối danh sách xem *Dự án*): tên, mã (đầu mã task, vd `GAME` → `GAME-12`) và các thư
  mục gốc trên từng máy. Session có thư mục làm việc nằm trong một thư mục gốc (kể cả thư mục con như worktree) thuộc
  dự án, nên một dự án gộp được thư mục khác tên ở mỗi máy (vd game1 = `game1-client` ở máy A + `game1` ở máy B).
  Nút ⋯ của nhóm thư mục trong *Khác*: *Đưa vào dự án* (thêm thư mục gốc) hoặc *Dự án mới từ nhóm này*.
- **Task của dự án**: bấm dòng *Task* dưới dự án (hoặc ⋯ → *Task của dự án*). Mỗi task có mã tự đánh số trong dự án,
  tiêu đề, mô tả Markdown, ảnh (chọn tệp, dán hoặc kéo thả; ảnh lớn được thu nhỏ), trạng thái Cần làm / Đang làm / Xong.
  *Session mới cho task này* mở session ở thư mục gốc của dự án, điền sẵn mã, tiêu đề, mô tả và ảnh vào ô nhập.
  Link thẳng tới trang task: `#tasks/<id dự án>`.
- **Chọn nhiều** (nút ☑ cạnh ô tìm, hoặc menu Hệ thống): bấm session để chọn, ô vuông ở đầu nhóm chọn cả nhóm (kể cả
  khi đang đóng). Thanh dưới danh sách: *Xoá*, *Sắp xếp…* (ghim, chuyển thư mục), *Cũ hơn…*. Esc để thoát.
- **Xoá session cũ** (menu Hệ thống → *Xoá session cũ…*, hoặc *Cũ hơn…* khi đang chọn): chọn mọi session không hoạt động
  quá X ngày trên các máy đang nối, trừ session đã ghim hoặc đang mở, rồi hỏi xoá. Bấm Huỷ thì vẫn giữ lựa chọn để bỏ
  bớt rồi mới xoá.
- Nút ⋯ ở mỗi session: ghim, đổi tên, gắn nhãn, chuyển vào thư mục, xoá. Ô tìm kiếm tìm theo tên, thư mục làm việc và
  nhãn; gõ `#nhãn` để lọc đúng nhãn.
- Nút ⋯ ở nhóm dự án (xem *Dự án*) và nhóm thư mục làm việc (xem *Máy*): session mới ở đây, đổi tên dự án (tên hiển
  thị, đồng bộ giữa các máy), chuyển cả nhóm vào thư mục, xoá mọi session trong nhóm. Nút ⋯ ở thư mục tự đặt: lên
  trên / xuống dưới, đổi tên, xoá thư mục, xoá mọi session bên trong.
- Tên session: session chưa có tên (tự đặt hoặc do Claude Code sinh) hiện câu hỏi đầu rút gọn (câu đầu, tối đa 50 ký tự).
  Session mới mở từ ClaudeMon có tên đó ngay lúc gửi; Claude Code tự sinh tên gọn hơn (`ai-title`) vài giây sau, danh
  sách làm mới lúc 4, 12 và 30 giây để hiện sớm.
- Xoá session: agent của máy giữ session đóng tiến trình (nếu đang chạy) rồi chuyển `<id>.jsonl` và thư mục `<id>/`
  trong `~/.claude/projects` vào **Thùng rác** của máy đó, nên khôi phục được.
- Giữa: khung chat, kết quả chạy tool có thể thu gọn, ô nhập tin.
- **Nút chép** (`web/copy.ts`): mỗi khối code có nút *Copy* ở góc trên phải, chép đúng chữ trong khối (giữ tab và
  xuống dòng, dán TSV lên Google Sheet vẫn đúng cột), đổi thành *Đã chép* 1,5 giây. Cuối mỗi lượt trả lời, cạnh giờ
  xong, có nút chép cả tin (Markdown gốc mọi đoạn chữ của lượt): máy tính hiện khi rê chuột lên lượt đó, điện thoại
  luôn hiện. Mở qua http (không HTTPS) thì không có `navigator.clipboard`, nên dùng textarea ẩn + `execCommand('copy')`;
  cả hai hỏng thì nút báo *Lỗi* kèm thẻ thông báo.
- Thanh trên: tên máy và thư mục của session, các nút đổi model, đổi chế độ quyền và Đóng.
- Nút ◐ cạnh tên máy: chọn giao diện, nhớ trên từng thiết bị. **Claude** (mặc định, tông ấm) hoặc **Retro**
  (cửa sổ Windows 95 trên nền hoàng hôn vaporwave, chữ tiêu đề VT323, giấy phép OFL trong `web/fonts/`), mỗi kiểu có
  Sáng / Tối / Theo máy. Màu chữ đạt tương phản ≥ 4.5:1 ở cả bốn biến thể.
- Sửa giao diện: `bun run scripts/ui-preview.ts` (dữ liệu giả, không gọi Claude), rồi `bun run scripts/ui-shots.ts`
  chụp mọi theme ở cỡ điện thoại và PC vào `%TEMP%\claudemon-shots`.

## Hạn mức Claude và tự đánh thức cửa sổ 5 giờ

Cửa sổ 5 giờ chỉ bắt đầu đếm khi có
tin đầu tiên, nên agent gửi một request tí hon (Haiku, `max_tokens: 1`, nội dung `.`, ký bằng OAuth token trong
`~/.claude/.credentials.json`) ngay khi cửa sổ cũ hết (+20 giây). Header `anthropic-ratelimit-unified-*` của chính
request đó cho % đã dùng và giờ reset chính xác của cửa sổ 5 giờ và 7 ngày.

- Đầu cột trái có thẻ **Claude**: thanh 5h và 7d, giờ reset, đếm ngược. Bấm vào để xem chi tiết: tài khoản, mốc neo,
  lần tự poke kế tiếp, lần poke gần nhất, nút *Làm mới* (khi cửa sổ đang mở) hoặc *Mở cửa sổ ngay* (khi cửa sổ trống).
- Các máy đăng nhập cùng tài khoản gộp thành một dòng, lấy số mới nhất; khác tài khoản thì mỗi tài khoản một dòng.
- Cửa sổ đang mở thì probe lại mỗi 2 phút khi có người đang mở giao diện, 5 phút khi không. Probe lỗi thì giữ số cũ.
- **Mốc neo hằng ngày** (`wakeup.claude` trong `machines.json`): `dailyResetAt` là giờ muốn reset, mốc poke là giờ đó
  trừ `windowHours`. Không bao giờ mở cửa sổ mới từ `quietFrom` tới mốc poke, nên lần poke đầu sau giờ nghỉ rơi đúng mốc
  và ngày nào cũng reset đúng `dailyResetAt`. Trong giờ nghỉ mà cửa sổ đã hết thì cũng không probe, vì probe là mở cửa sổ.
- Token hết hạn (401) thì chạy `claude -p` một lần để CLI tự làm mới token rồi probe lại.
- Trạng thái (số liệu gần nhất, lần poke gần nhất) lưu ở `wakeup.state.json` (gitignore). Log trong `agent.out.log`,
  dòng bắt đầu bằng `[wakeup]`. Tắt trên mọi máy: `"enabled": false`.

## Đồng bộ

Có hai loại dữ liệu, mỗi loại đồng bộ một kiểu:

| Dữ liệu | Đường đi | Độ trễ |
|---|---|---|
| Trạng thái sống: session nào đang chạy, tin nhắn đang đến | Đi thẳng từ agent qua tailnet | Tức thì |
| Cách sắp xếp: thư mục, nhãn, ghim, tên đặt lại, dự án, task (kèm ảnh) | Nhánh `claudemon-library` của kho này | Máy đang mở: tức thì. Máy khác: ≤ 1 phút |

Cách sắp xếp nằm trong `library.json` trên **nhánh riêng `claudemon-library`**, không nằm trên `main`:

- Agent đọc và ghi nhánh đó bằng lệnh git cấp thấp (`hash-object`, `mktree`, `commit-tree`, `push`), không đụng
  thư mục làm việc hay nhánh `main`. Nhờ vậy `git pull` trên `main` không bao giờ vướng "thay đổi chưa commit" hay
  "lệch nhánh" chỉ vì vừa ghim một session.
- Mỗi lần sửa: lưu ngay vào `library.cache.json` (gitignore), 1,5 giây sau đẩy lên. Mỗi phút agent kéo bản mới.
- Hai máy cùng sửa: push bị từ chối thì kéo về, gộp, thử lại (tối đa 3 lần). Gộp theo từng thư mục và từng
  session, bản ghi có `updatedAt` mới hơn thắng. Lịch sử nhánh luôn thẳng.
- Khoá bản ghi là `máy:sessionId`. Không lưu nội dung chat vào kho, nội dung chat ở lại máy chạy session.
- Dự án tự tạo (`projectDefs`) và task (`tasks`) cũng nằm trong `library.json`. Ảnh của task là blob git: agent lưu
  bằng `hash-object -w` lúc tải lên, rồi mỗi commit của nhánh có thư mục `images/<sha>` chứa mọi ảnh task còn dùng, nên
  push mang ảnh sang máy khác. Agent phục vụ ảnh ở `/api/library/image/<sha>` (chưa có thì kéo nhánh về rồi thử lại).
- Agent bản cũ (trước khi có dự án / task) gộp mà bỏ mất hai nhóm này và ảnh. Agent bản mới trên máy khác đẩy lại
  sau tối đa 1 phút nên không mất, nhưng nên khởi động lại agent mọi máy cùng lúc khi cập nhật.
- Giao diện lấy cách sắp xếp từ agent của máy đang phục vụ trang; mất mạng thì vẫn sửa được, chân trang báo
  "Chưa đồng bộ" và agent đẩy khi có mạng lại.

## Thời gian và thông báo

- **Giờ gửi**: dưới mỗi tin của mình có giờ gửi; cuối mỗi lượt của Claude có dòng `14:35 · làm trong 2 phút 13 giây`
  (giờ trả lời xong, tính từ lúc gửi tới tin cuối của lượt). Giờ lấy từ `timestamp` trong tệp `.jsonl`, nên session
  cũ và session mở từ Claude desktop / CLI cũng có. Hôm nay chỉ ghi giờ, ngày khác ghi thêm ngày.
- **Đang chạy bao lâu**: đồng hồ đếm lên ở nhãn trạng thái trên thanh trên, ở dòng "Claude đang làm…" và ở danh sách
  session bên trái. Agent giữ mốc bắt đầu lượt (`turnStartedAt`), nên tải lại trang hay mở từ máy khác vẫn đếm đúng.
- **Thông báo**: menu ◐ → *Thông báo trên thiết bị này* → *Báo khi xong việc / cần duyệt*. Bật rồi thì thiết bị nhận
  thông báo khi session xong lượt (kèm thời gian đã làm), lỗi, cần duyệt quyền, hỏi (AskUserQuestion) hay duyệt kế
  hoạch, kể cả khi đã đóng app. Bấm thông báo mở đúng session. Bấm dừng thì không báo.
  - iPhone / iPad: phải *Thêm vào màn hình chính* rồi mở ClaudeMon từ đó (iOS 16.4+) mới bật được.
  - Đang mở app trên màn hình thì không đẩy; session khác xong / cần duyệt hiện thành thẻ nhỏ trong app, bấm để mở.
  - Thiết bị đăng ký với agent của máy phục vụ trang (khoá VAPID `push.keys.json`, danh sách thiết bị
    `push.subs.json`, cả hai gitignore, riêng từng máy). Agent đó nối WebSocket tới agent các máy khác để báo cả
    session chạy ở máy khác. Thiết bị gỡ app hay tắt quyền thì agent tự bỏ đăng ký khi dịch vụ đẩy báo 404/410.
  - Có mục *Gửi thông báo thử* khi đã bật.

## Session tự do, thanh bên, báo cáo HTML

- **Session tự do** (không thuộc dự án nào): mục đầu tiên trong ô chọn thư mục của Session mới. Agent tạo cho mỗi
  session một thư mục riêng `~/ClaudeMon/scratch-workspaces/scratch-<ngày giờ>`, nên tệp nó tạo ra không lẫn nhau.
  Ở chế độ xem *Dự án*, danh sách bên trái gom chúng (cùng phiên Claude desktop mở không chọn thư mục) vào mục
  **✦ Session tự do**; ở *Máy* và *Thời gian* chúng nằm chung với session khác.
- **Ẩn / hiện thanh bên** (máy tính): nút cạnh tiêu đề session hoặc `Ctrl+B`; nhớ trên thiết bị đó.
- **Báo cáo HTML** gửi bằng `send_user_file` hiện thành thẻ: bấm để xem ngay trong app, `↗` mở bằng trình duyệt,
  `⇩` tải về. Trang chạy trong iframe sandbox (không cùng origin nên không gọi được API của agent). Ảnh, css, js để
  cùng thư mục hoặc thư mục con của tệp HTML thì agent phục vụ theo đường dẫn tương đối; ngoài thư mục đó thì không.

## Bảo mật

claudemon-agent chạy được mọi lệnh trên máy, nên:

- Agent chỉ nghe ở `127.0.0.1:7420`. Máy khác vào qua `tailscale serve`, nó cấp HTTPS (điều kiện để cài PWA)
  và chuyển tiếp vào cổng đó; không bao giờ nghe ở `0.0.0.0`.
- Request đi qua `tailscale serve` mang header `Tailscale-User-Login`; agent chỉ nhận đúng tài khoản của mình.
  Request đến thẳng từ chính máy đó (không có header) thì cho qua.
- WebSocket chỉ nhận `Origin` là địa chỉ HTTPS của các máy trong `machines.json`.
- Danh sách máy (`machines.json`: tên ngắn và hostname trong tailnet) để trong kho. Không có token hay mật khẩu nào trong kho.

## Triển khai Tailscale

Làm một lần cho cả tailnet, rồi một lần cho mỗi thiết bị.

**Một lần, trên trang quản trị** ([login.tailscale.com/admin](https://login.tailscale.com/admin)), sau khi máy đầu tiên đã vào:

1. Trang DNS: bật **MagicDNS** và **HTTPS Certificates**. Lưu ý: tên máy (vd `pc1.<tailnet>.ts.net`) sẽ xuất hiện
   trong nhật ký chứng chỉ công khai (Certificate Transparency), nên đừng đặt tên máy chứa thông tin riêng.
2. Trang Machines: với từng PC, chọn **Disable key expiry** để máy không tự rớt khỏi tailnet sau 180 ngày.
3. Access controls: để mặc định (mọi thiết bị của cùng một người thấy nhau) là đủ.

**Mỗi PC:**

```powershell
winget install --id Tailscale.Tailscale -e
tailscale up --unattended          # mở trình duyệt để đăng nhập; unattended = chạy cả khi chưa đăng nhập Windows
tailscale set --hostname pc1       # tên ngắn của máy, trùng `host` trong machines.json
tailscale serve --bg 7420          # HTTPS https://pc1.<tailnet>.ts.net -> http://127.0.0.1:7420, tự chạy lại khi khởi động
```

`tailscale serve` chỉ mở trong tailnet, khác `tailscale funnel` (mở ra Internet, không dùng).
`install.ps1` tự chạy `tailscale set` và `tailscale serve` nếu thấy Tailscale đã đăng nhập.

**Điện thoại:** cài app Tailscale, đăng nhập cùng tài khoản, bật VPN. Mở `https://pc1.<tailnet>.ts.net` rồi
"Thêm vào màn hình chính".

**Kiểm tra:** `tailscale status` trên mỗi PC phải thấy đủ các PC và điện thoại; từ một máy chạy `tailscale ping <máy kia>`.

## Lộ trình

1. ✅ **Một máy.** Agent liệt kê session, mở mới, chạy tiếp, chat có streaming, duyệt quyền (kể cả câu hỏi
   AskUserQuestion), dừng lượt đang chạy, đổi chế độ quyền và đóng session. Web app chạy ở `localhost`.
2. ✅ **Nhiều máy.** Dùng `machines.json`. Giao diện gộp session từ mọi agent, có `tailscale serve` và PWA cho điện thoại.
3. ✅ **Sắp xếp.** Thư mục, nhãn, ghim và đổi tên, đồng bộ qua nhánh `claudemon-library`.
4. ✅ **Cài đặt.** `install.ps1` cài thư viện, rồi đăng ký Scheduled Task để agent tự chạy lúc đăng nhập, không mở cửa sổ.

## Việc cần làm tay

- Cài và đăng nhập Tailscale theo mục "Triển khai Tailscale" (cần trước bước 2).
- Tài liệu Agent SDK ghi: trừ khi được duyệt trước, Anthropic không cho bên thứ ba *cung cấp* đăng nhập claude.ai
  hay hạn mức của gói cho sản phẩm của họ, kể cả agent viết bằng Agent SDK. ClaudeMon là công cụ riêng, chỉ chủ tài
  khoản dùng trên máy của mình, và chạy đúng bản `claude` đã cài (`pathToClaudeCodeExecutable`). Nếu muốn chắc chắn
  thì đặt `ANTHROPIC_API_KEY` cho tiến trình agent: SDK dùng API key thay cho gói, mã không đổi gì.

## Câu hỏi còn mở

- Có cần mở session ở máy đang tắt không. Nếu cần thì phải có thêm Wake-on-LAN, tạm chưa làm.
