# ClaudeMon

ClaudeMon là bảng điều khiển các session Claude Code trên mọi PC của bạn: từ máy khác hoặc điện thoại vẫn mở, chat,
duyệt quyền và đóng được session đang chạy trên từng máy. Session được sắp xếp theo thư mục, nhãn, dự án và task,
đồng bộ giữa các máy; có thông báo đẩy khi session xong việc hay cần duyệt.

## Install bằng AI

Mở Claude Code (hoặc AI agent khác chạy được lệnh trên máy) ở một thư mục bất kỳ trên PC, dán prompt sau:

````text
Cài ClaudeMon cho tôi trên máy Windows này. Mã nguồn: https://github.com/anviettrung/claudemon. Làm lần lượt, mỗi bước kiểm tra kết quả rồi mới sang bước sau:

1. Kiểm tra có git, GitHub CLI (gh) đã đăng nhập (`gh auth status`), Claude Code (`claude --version`) đã đăng nhập.
   Thiếu gì thì cài bằng winget nếu được; việc cần tôi đăng nhập thì dừng lại chỉ tôi cách làm.
2. Hỏi tôi: (a) thư mục đặt kho (gợi ý D:\Projects\claudemon, nên giống nhau trên mọi máy), (b) đây là máy đầu tiên
   hay tôi đã có kho claudemon riêng rồi, (c) tôi muốn vào ClaudeMon từ máy khác / điện thoại bằng gì: Tailscale
   (mặc định, dễ nhất), Cloudflare Tunnel + Access (cần tên miền trên Cloudflare), proxy khác (ngrok OAuth,
   oauth2-proxy...), hay chỉ dùng trên máy này; giải thích ngắn khác biệt nếu tôi chưa rõ, (d) email tôi dùng để đăng
   nhập cách đó.
3. Máy đầu tiên: clone https://github.com/anviettrung/claudemon.git vào thư mục đó, đổi remote origin thành upstream,
   tạo kho private của tôi bằng `gh repo create <tài khoản gh của tôi>/claudemon --private --source . --push`.
   Đã có kho riêng: clone kho riêng của tôi vào thư mục đó.
4. Đọc README.md trong kho, làm theo mục "Install manual": sửa machines.json (owner = email ở bước 2d; access.mode
   theo bước 2c; thêm dòng cho máy này nếu chưa có, computer = $env:COMPUTERNAME, host = tên ngắn chữ thường không
   dấu, name = tên ngắn viết hoa, url nếu không dùng Tailscale), commit và push. Không để lại dòng mẫu PC1/PC2 nếu
   không dùng.
5. Dựng cách truy cập từ xa đã chọn theo mục "3. Truy cập từ xa" trong README: tự cài phần mềm được (tailscale,
   cloudflared) thì cài; việc phải đăng nhập hay bấm trên trang quản trị (Tailscale, Cloudflare Zero Trust) thì chỉ tôi
   từng bước, chờ tôi báo xong, hỏi tôi giá trị cần điền (AUD tag, team domain, hostname) rồi ghi vào machines.json.
6. Chạy `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1` trong kho. Đọc từng dòng nó in ra, có lỗi
   thì đọc agent.log / agent.err.log trong kho để sửa.
7. Kiểm tra http://127.0.0.1:7420/api/info trả JSON. Dùng Tailscale thì chạy `tailscale serve status` xem đã có cổng
   7420; dùng cách khác thì nhờ tôi mở url của máy này trên điện thoại.
8. Cuối cùng liệt kê cho tôi các việc phải tự làm tay (mục "Việc làm tay" trong README) và địa chỉ để mở ClaudeMon
   trên máy này và trên điện thoại.
````

Máy thứ hai trở đi: dán lại đúng prompt đó, trả lời "đã có kho riêng".

## Install manual

Cần: **Windows** 10/11, `git`, Claude Code đã đăng nhập (`claude`). Bun được `install.ps1` tự cài bằng winget. Truy cập
từ máy khác và điện thoại qua Tailscale, Cloudflare Tunnel hoặc proxy khác tuỳ bạn (bước 3), không cần mở port.

**1. Tạo kho riêng (một lần).** Mỗi người một kho private: ClaudeMon ghi cách sắp xếp session lên nhánh
`claudemon-library` của kho này, và nút *Khởi động lại agent* kéo bản mới từ kho này. Giữ kho gốc làm `upstream`
để sau này lấy bản mới:

```powershell
git clone https://github.com/anviettrung/claudemon.git D:\Projects\claudemon
cd D:\Projects\claudemon
git remote rename origin upstream
gh repo create <you>/claudemon --private --source . --push     # hoặc tạo kho trống trên web, rồi git remote add origin ... && git push -u origin main
```

**2. Khai các máy** trong `machines.json`, commit, push:

| Trường | Ý nghĩa |
|---|---|
| `owner` | Email bạn dùng để đăng nhập lớp truy cập từ xa (tài khoản Tailscale, email Cloudflare Access...). Truy cập từ xa chỉ nhận đúng người này. |
| `access` | Cách truy cập từ xa, xem bước 3 |
| `machines[].name` | Tên ngắn hiện trên giao diện (vd `PC1`, `NHA`, `CTY`) |
| `machines[].computer` | Kết quả `$env:COMPUTERNAME` trên máy đó |
| `machines[].host` | Tên máy trong tailnet, chữ thường (chế độ `tailscale`; `install.ps1` tự đặt bằng `tailscale set --hostname`) |
| `machines[].url` | Địa chỉ HTTPS của máy khi không dùng Tailscale, vd `https://pc1-claude.example.com` |
| `port` | Cổng agent, mặc định 7420 |
| `wakeup.claude` | `enabled: true` để tự mở cửa sổ 5 giờ của Claude theo giờ `dailyResetAt` (xem Kiến trúc) |

Máy không có trong danh sách vẫn chạy được, chỉ dùng một mình qua `localhost`.

**3. Truy cập từ xa** (chọn một cách, khai ở `access.mode` trong `machines.json`; chỉ dùng một máy thì chọn `local`
và mở bằng `localhost`). ClaudeMon chỉ nghe ở `127.0.0.1`; máy khác và điện thoại vào qua một lớp chuyển tiếp HTTPS,
lớp đó phải xác nhận người dùng là `owner`.

| `mode` | Dùng gì | Hợp khi |
|---|---|---|
| `tailscale` (mặc định) | Tailscale + `tailscale serve` | Dễ nhất, không cần tên miền. Mọi thiết bị phải cài Tailscale. |
| `cloudflare` | Cloudflare Tunnel + Cloudflare Access | Có tên miền trên Cloudflare, muốn mở từ trình duyệt bất kỳ không cần cài gì. |
| `proxy` | Reverse proxy tự xác thực: ngrok (OAuth), oauth2-proxy, Authelia, Pomerium... | Đã có sẵn hạ tầng riêng. |
| `local` | Không có | Chỉ dùng trên chính máy. |

*Tailscale*

- Một lần trên [trang quản trị](https://login.tailscale.com/admin) sau khi máy đầu tiên vào tailnet: trang DNS bật
  **MagicDNS** và **HTTPS Certificates** (tên máy sẽ nằm trong nhật ký chứng chỉ công khai, đừng đặt tên chứa thông tin
  riêng); trang Machines chọn **Disable key expiry** cho từng PC để máy không tự rớt sau 180 ngày.
- Mỗi PC: `winget install --id Tailscale.Tailscale -e`, rồi `tailscale up --unattended` (mở trình duyệt để đăng nhập;
  `--unattended` để chạy cả khi chưa đăng nhập Windows). `install.ps1` tự đặt tên máy theo `host` và bật `tailscale serve`.
- Điện thoại: cài app Tailscale, đăng nhập cùng tài khoản, bật VPN. `owner` = email tài khoản Tailscale.

*Cloudflare Tunnel + Access* (gói Zero Trust miễn phí đủ dùng)

- Mỗi PC: `winget install --id Cloudflare.cloudflared -e`. Trong [Zero Trust](https://one.dash.cloudflare.com) →
  Networks → Tunnels → *Create a tunnel* (Cloudflared), chạy lệnh `cloudflared service install <token>` nó đưa. Thêm
  *Public hostname* cho máy đó, vd `pc1-claude.example.com` → `http://localhost:7420`. Mỗi máy một tunnel, một hostname, cùng một
  tên miền.
- Một lần: Access → Applications → *Add an application* → Self-hosted, thêm mọi hostname ở trên, policy *Allow* với
  email của bạn. Ghi lại **Application Audience (AUD) tag** và tên miền team (`<team>.cloudflareaccess.com`, ở
  Settings → Custom pages / Team domain).
- Để trang mở từ một máy gọi được sang máy khác: trong application đó, mục CORS bật *Allow credentials*, thêm mọi
  hostname vào *Allowed origins*, bật *Bypass OPTIONS requests to origin*. Mỗi hostname phải mở (đăng nhập) một lần
  trên từng trình duyệt; hostname nào chưa đăng nhập thì máy đó hiện mất kết nối.
- `machines.json`: `"access": { "mode": "cloudflare", "cloudflare": { "teamDomain": "<team>.cloudflareaccess.com",
  "aud": "<AUD tag>" } }`, mỗi máy điền `url` (vd `https://pc1-claude.example.com`), `owner` = email đăng nhập Access.
  ClaudeMon kiểm chữ ký JWT của Access, nên ai gọi thẳng tunnel mà không qua Access đều bị chặn.

*Proxy khác*

- Proxy đưa mỗi máy ra một địa chỉ HTTPS, tự bắt đăng nhập, rồi gắn email người dùng vào một header và **ghi đè**
  header đó nếu client tự gửi. Vd ngrok `ngrok http 7420 --url <tên miền> --oauth google --oauth-allow-email <email>`
  gắn `ngrok-auth-user-email`; oauth2-proxy gắn `X-Forwarded-Email`.
- `machines.json`: `"access": { "mode": "proxy", "userHeader": "<tên header>" }`, mỗi máy điền `url`.

Với `cloudflare` và `proxy`: mở ClaudeMon bằng url của một máy (không phải `localhost`) để thấy cả các máy khác, và
thông báo đẩy chỉ báo session của máy đang phục vụ trang (agent không nối thẳng sang agent máy khác được khi lớp
chuyển tiếp đòi đăng nhập trình duyệt).

**4. Cài trên từng PC:** clone kho riêng của bạn (cùng đường dẫn càng tốt), nháy đúp `install.cmd`. Chạy lại bao nhiêu
lần cũng được. Nó làm:

1. Tìm Bun, chưa có thì cài bằng winget; `bun install` khi `bun.lock` đổi.
2. Đăng ký Scheduled Task **ClaudeMon Agent** chạy lúc đăng nhập, qua `conhost --headless` nên không có cửa sổ.
3. Khởi động lại agent khi kho sang commit khác, trừ khi đang có session chạy (để lần cài sau).
4. Tạo shortcut ClaudeMon ở Desktop và Start Menu (bỏ qua nếu đã cài app PWA từ trình duyệt).
5. Chế độ `tailscale` và Tailscale đã đăng nhập: đặt tên máy theo `host` và bật `tailscale serve --bg 7420`
   (`https://<host>.<tailnet>.ts.net` → `http://127.0.0.1:7420`, chỉ trong tailnet). Chế độ khác thì bỏ qua bước này.

**Việc làm tay sau khi cài:**

- Mở ClaudeMon: `http://127.0.0.1:7420` trên chính máy; từ máy khác hoặc điện thoại mở `https://<host>.<tailnet>.ts.net`
  (Tailscale) hoặc `url` của máy (Cloudflare, proxy).
- Cài thành app: Chrome trên PC bấm biểu tượng Cài trên thanh địa chỉ; điện thoại chọn *Thêm vào màn hình chính*.
- Thông báo đẩy: menu ◐ → *Thông báo trên thiết bị này*. iPhone/iPad phải mở ClaudeMon từ màn hình chính (iOS 16.4+).

## Gỡ, cập nhật

**Cập nhật**

- Bản mới từ kho gốc: `git pull upstream main`, `git push`, rồi chạy lại `install.cmd`. `machines.json` trùng
  dòng sửa thì giữ bản của bạn.
- Máy khác nhận bản mới: menu bánh răng (Hệ thống) → **Khởi động lại agent <máy>** (agent kéo kho của bạn, chỉ
  fast-forward, rồi tự chạy lại), hoặc `git pull` + `install.cmd` trên máy đó.
- Khởi động lại tay khi không mở được app: `Stop-ScheduledTask 'ClaudeMon Agent'`, tắt tiến trình `run-agent.ps1`
  và `bun ... src/agent.ts`, rồi `Start-ScheduledTask 'ClaudeMon Agent'`.

**Gỡ khỏi một máy**

```powershell
Unregister-ScheduledTask 'ClaudeMon Agent' -Confirm:$false
Get-CimInstance Win32_Process -Filter "Name='bun.exe'" | ? CommandLine -like '*claudemon*' | % { Stop-Process -Id $_.ProcessId -Force }
tailscale serve --https=443 off                # nếu dùng Tailscale
Remove-Item "$env:USERPROFILE\.claudemon" -Recurse -Force
```

Dùng Cloudflare Tunnel thì gỡ thêm `cloudflared service uninstall` (cần quyền admin) và xoá tunnel, hostname trong
Zero Trust; dùng proxy khác thì tắt nó theo cách của nó.

Rồi xoá shortcut `ClaudeMon.lnk` ở Desktop và Start Menu (hoặc gỡ app PWA trong Chrome), và thư mục kho.
`~/ClaudeMon/scratch-workspaces` chứa thư mục của các session tự do: giữ hoặc xoá tuỳ ý. Session Claude Code
(`~/.claude/projects`) không bị đụng tới.

## Kiến trúc

```
 Trình duyệt (PC / điện thoại)
        │  HTTPS + WebSocket qua lớp chuyển tiếp (tailscale serve / Cloudflare Tunnel / proxy)
        ▼
 ┌───────────────────┐   HTTPS   ┌───────────────────┐
 │ claudemon-agent A │◄─────────►│ claudemon-agent B │
 └─────────┬─────────┘           └─────────┬─────────┘
           │ Claude Agent SDK              │ Claude Agent SDK
           ▼                               ▼
      Claude Code                     Claude Code
      ~/.claude/projects              ~/.claude/projects
           │                               │
           └──── nhánh claudemon-library (git) ────┘
```

**Agent** (TypeScript trên Bun, mỗi PC một agent, nghe ở `127.0.0.1:7420`):

- Đọc `~/.claude/projects/*/*.jsonl` để biết máy có những session nào. Mở session mới hoặc chạy tiếp session cũ qua
  Claude Agent SDK, đẩy luồng tin nhắn ra WebSocket. Dùng đúng bản `claude` đã cài và lượt đăng nhập sẵn có, nên CLI
  và Claude desktop vẫn mở tiếp được các session đó.
- Yêu cầu duyệt quyền (`canUseTool`, AskUserQuestion, duyệt kế hoạch) hiện thành thẻ trên giao diện, từ máy nào cũng
  trả lời được. Tệp `.jsonl` vừa được nơi khác ghi vào thì giao diện cảnh báo "có thể đang mở ở nơi khác" (không khoá).
- Cấp cho mọi session MCP server `claudemon` ngay trong agent: `send_user_file` (Claude gửi ảnh, video, tệp, báo cáo
  HTML hiện ngay trong khung chat), `checklist_get` / `checklist_report`.
- Phục vụ luôn web app. Vào agent của máy nào cũng thấy đủ mọi máy: giao diện tự nối tới từng agent trong
  `machines.json`.
- Xoá session: chuyển `<id>.jsonl` và thư mục `<id>/` vào Thùng rác của máy đó, khôi phục được.

**Đồng bộ.** Trạng thái sống (session nào đang chạy, tin nhắn đang đến) đi thẳng từ agent tới trình duyệt (và giữa các agent khi dùng Tailscale). Cách sắp
xếp (thư mục, nhãn, ghim, tên đặt lại, dự án, task kèm ảnh) nằm trong `library.json` trên nhánh riêng
`claudemon-library` của kho:

- Agent đọc ghi nhánh đó bằng lệnh git cấp thấp (`hash-object`, `mktree`, `commit-tree`, `push`), không đụng thư mục
  làm việc hay nhánh `main`, nên `git pull` không bao giờ vướng vì vừa ghim một session.
- Mỗi lần sửa lưu ngay vào `library.cache.json`, 1,5 giây sau đẩy lên; mỗi phút kéo bản mới. Hai máy cùng sửa thì
  gộp theo từng bản ghi, `updatedAt` mới hơn thắng. Không lưu nội dung chat vào kho.
- Ảnh của task là blob git trong thư mục `images/` của nhánh, đi theo push sang máy khác.

**Bảo mật.** Agent chạy được mọi lệnh trên máy, nên:

- Chỉ nghe ở `127.0.0.1`, không bao giờ nghe ở `0.0.0.0`. Máy khác vào qua lớp chuyển tiếp HTTPS (điều kiện để cài
  PWA): `tailscale serve` (chỉ trong tailnet, không dùng `tailscale funnel`), Cloudflare Tunnel, hoặc proxy khác.
- `src/access.ts` quyết định ai được vào. Request thẳng từ chính máy (Host là localhost, không có header chuyển tiếp
  như `X-Forwarded-For`, `Cf-Connecting-Ip`) thì cho qua. Request qua lớp chuyển tiếp phải mang danh tính đúng `owner`:
  header `Tailscale-User-Login` (tailscale), JWT `Cf-Access-Jwt-Assertion` / cookie `CF_Authorization` kiểm chữ ký theo
  khoá công khai của team, đúng `aud`, còn hạn (cloudflare), hoặc header `userHeader` (proxy). Chế độ `local` chặn mọi
  request từ xa. WebSocket và CORS chỉ nhận `Origin` là localhost hoặc địa chỉ HTTPS của các máy khai báo.
- Kho không chứa token hay mật khẩu. Khoá VAPID của thông báo đẩy (`push.keys.json`) và danh sách thiết bị
  (`push.subs.json`) là gitignore, riêng từng máy.

**Hạn mức Claude** (`src/wakeup.ts`). Thẻ Claude đầu cột trái hiện % đã dùng và giờ reset của cửa sổ 5 giờ và 7 ngày,
lấy từ header `anthropic-ratelimit-unified-*` của một request tí hon (Haiku, `max_tokens: 1`, ký bằng OAuth token trong
`~/.claude/.credentials.json`). Bật `wakeup.claude.enabled` thì agent gửi request đó ngay khi cửa sổ cũ hết, để cửa sổ
mới bắt đầu đếm; không mở cửa sổ mới từ `quietFrom` tới `dailyResetAt - windowHours`, nên ngày nào cũng reset đúng
`dailyResetAt`.

**Giao diện** (`web/`, Bun tự đóng gói): bố cục giống Claude desktop. Cột trái xếp session theo *Máy*, *Dự án* hoặc
*Thời gian*, có ghim, thư mục tự đặt, nhãn (`#nhãn` để lọc), chọn nhiều để xoá/chuyển, xoá session cũ. Dự án tự tạo gộp
thư mục khác tên trên từng máy và có trang task (mã tự đánh số, Markdown, ảnh, trạng thái). Session tự do (không thuộc
dự án) chạy trong `~/ClaudeMon/scratch-workspaces/scratch-<giờ>`. Ba kiểu giao diện Claude / Retro / Frutiger Aero,
mỗi kiểu Sáng / Tối / Theo máy.

| Tệp | Vai trò |
|---|---|
| `src/agent.ts` | Server HTTP + WebSocket, API `/api/...`, kiểm quyền truy cập, MCP server `claudemon` |
| `src/sessions.ts` | Một session đang chạy: hàng đợi tin nhắn, duyệt quyền, ngắt, đóng |
| `src/normalize.ts`, `src/transcript.ts` | Đọc lịch sử `.jsonl`, đổi tin nhắn Claude Code sang dạng gọn cho giao diện |
| `src/library.ts` | Cách sắp xếp session, đồng bộ qua nhánh git `claudemon-library` |
| `src/push.ts`, `web/push.ts` | Thông báo đẩy (Web Push) |
| `src/wakeup.ts` | Hạn mức Claude và tự mở cửa sổ 5 giờ |
| `src/protocol.ts` | Kiểu dữ liệu chung giữa agent và giao diện |
| `web/` | Giao diện chat, theme, xem báo cáo HTML (iframe sandbox), nút chép |
| `install.ps1`, `scripts/run-agent.ps1` | Cài đặt; vòng chạy agent của Scheduled Task (agent thoát thì 5 giây sau bật lại) |
| `machines.json` | Danh sách máy, cổng, tài khoản chủ |

**Phát triển và kiểm thử**

- Chạy tay: `Stop-ScheduledTask 'ClaudeMon Agent'`, rồi `bun run dev` (tự nạp lại khi sửa mã). `CLAUDEMON_PORT` đổi
  cổng, `CLAUDEMON_DEV=1` bật chế độ dev của Bun. Log: `agent.log`, `agent.out.log`, `agent.err.log` trong kho.
- Sửa giao diện không cần agent thật: `bun run scripts/ui-preview.ts` (dữ liệu giả, cổng 7430), rồi
  `bun run scripts/ui-shots.ts` chụp mọi theme ở cỡ điện thoại và PC.
- Kiểm thử đầu cuối trên các agent đang chạy (gọi Claude thật nên tốn một ít lượt): `bun run smoke`, hoặc chỉ các nhóm
  không gọi Claude: `bun run scripts/smoke.ts basic security pwa`. Máy khác dùng thư mục `CLAUDEMON_REMOTE_CWD`.
- Lưu ý: Anthropic không cho bên thứ ba *cung cấp* đăng nhập claude.ai hay hạn mức gói cho sản phẩm của họ. ClaudeMon
  là công cụ cá nhân, chủ tài khoản tự chạy trên máy mình bằng bản `claude` đã cài. Muốn chắc thì đặt
  `ANTHROPIC_API_KEY` cho tiến trình agent: SDK dùng API key thay cho gói.
