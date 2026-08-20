# Temp Session Chat — Next.js 15 + WebSocket

Web chat realtime kiểu **ephemeral/session-only**:

- Mỗi tab/browser session tự có một user tạm với username dạng `user_<milliseconds>`; nếu trùng sẽ thành `user_<milliseconds>_01`, `..._02`, ...
- Search user đang online theo username.
- Gửi request/accept/reject rồi chat 1-1.
- Một user có thể chat với nhiều user khác cùng lúc.
- Mỗi cuộc chat có thời hạn 60 phút, hiển thị đếm ngược và tự giải tán khi hết giờ.
- Có bảng emoji đơn giản và gửi file tạm thời qua WebSocket (tối đa 10 MB/file, 5 lượt/cuộc chat).
- Tin nhắn **không được lưu trên WebSocket server**.
- Lịch sử phía client nằm trong `sessionStorage`.
- Khi peer hết session, server huỷ chat liên quan và client còn lại xoá lịch sử chat đó.
- Refresh/reconnect ngắn được grace 8 giây để tránh huỷ chat do F5/mất mạng chớp nhoáng.
- Không có database, email hay password.

## Kiến trúc

```text
GitHub Pages (Next.js static)
          |
          | wss://...
          v
WebSocket relay server (Node.js + ws)
          |
    online users / chats
    chỉ giữ trong RAM
```

> GitHub Pages chỉ host frontend tĩnh. WebSocket server phải chạy ở một máy/dịch vụ Node.js khác.

## Yêu cầu

Project dùng Next.js `15.5.23`. `package.json` đặt Node `>=20`.

Máy có Node 25 / npm 11 vẫn có thể thử chạy project. GitHub Actions được pin Node 22 để build/deploy ổn định và dễ tái lập hơn.

## Chạy local

### 1. Cài package

```bash
npm install
```

### 2. Tạo env frontend

```bash
cp .env.local.example .env.local
```

Mặc định:

```env
NEXT_PUBLIC_WS_URL=ws://127.0.0.1:8080
```

### 3. Chạy cả Next.js + WebSocket server

```bash
npm run dev
```

Lệnh này tự bật cả hai service:

- Web: `http://localhost:3000`
- WebSocket: `ws://127.0.0.1:8080` (frontend cũng tự fallback sang `localhost`)
- Health: `http://127.0.0.1:8080/health`

Mở `http://localhost:3000` bằng 2 browser khác nhau. Chỉ test search khi góc trái hiển thị **Online** màu xanh lá.

Nếu muốn chạy riêng từng service để debug:

```bash
npm run dev:ws
npm run dev:web
```

Nếu giao diện hiện **Đang reconnect**, kiểm tra WebSocket server bằng:

```bash
curl http://127.0.0.1:8080/health
```

Kết quả mong đợi có dạng:

```json
{"ok":true,"onlineUsers":2}
```


### Nếu UI cứ báo “Đang reconnect” trên macOS

Bản này không ép WebSocket server bind vào `0.0.0.0` nữa, để Node nhận cả cách `localhost` resolve qua IPv4/IPv6. Frontend cũng tự thử nhiều endpoint local (`127.0.0.1`, `localhost`, và hostname đang mở trang).

Kiểm tra nhanh trong terminal khác:

```bash
curl http://127.0.0.1:8080/health
```

Kết quả mong đợi khi chưa có browser:

```json
{"ok":true,"onlineUsers":0}
```

Khi mở 2 browser và cả hai đã kết nối, `onlineUsers` phải là `2`. Terminal WebSocket sẽ có log `[ws] connected` và `[session] online`.

## Build static

```bash
npm run build
```

Next.js xuất website tĩnh vào thư mục `out/`.

## Deploy frontend lên GitHub Pages

Workflow đã có sẵn tại:

```text
.github/workflows/deploy-pages.yml
```

1. Push code lên GitHub, branch `main`.
2. Repository → **Settings → Pages → Source → GitHub Actions**.
3. Repository → **Settings → Secrets and variables → Actions → Variables**.
4. Tạo repository variable:

```text
NEXT_PUBLIC_WS_URL = wss://YOUR-WS-SERVER.example.com
```

5. Push lại hoặc chạy workflow thủ công.

`next.config.mjs` tự thêm `basePath` khi repository là project Pages kiểu `https://user.github.io/repo/`. Với repo `user.github.io`, base path vẫn là `/`.

## Deploy WebSocket server

WebSocket backend là `server/index.mjs`.

Chạy trực tiếp:

```bash
PORT=8080 \
ALLOWED_ORIGINS=http://localhost:3000 \
npm run start:ws
```

Production phải dùng HTTPS/WSS ở phía public. Ví dụ frontend GitHub Pages dùng HTTPS thì `NEXT_PUBLIC_WS_URL` phải là `wss://...`, không phải `ws://...`.

### Origin allow-list

Nên cấu hình:

```env
ALLOWED_ORIGINS=https://YOURNAME.github.io,http://localhost:3000
```

Nếu để trống, server chấp nhận mọi origin (tiện dev nhưng không nên dùng production).

### Docker

Có `server/Dockerfile`:

```bash
docker build -f server/Dockerfile -t temp-chat-ws .
docker run --rm -p 8080:8080 \
  -e ALLOWED_ORIGINS=http://localhost:3000 \
  temp-chat-ws
```

## Session / xoá dữ liệu hoạt động thế nào?

1. Browser tạo `sessionId` bằng `crypto.randomUUID()` và lưu trong `sessionStorage`.
2. WebSocket server cấp username theo dạng `user_<milliseconds>` và giữ user/chat **trong RAM**.
3. Nội dung message được relay thẳng tới peer, server không ghi history.
4. Mỗi browser tự lưu message trong `sessionStorage`.
5. Socket mất kết nối → server chờ `DISCONNECT_GRACE_MS` (mặc định 8 giây).
6. Nếu reconnect cùng session trong grace period: giữ chat.
7. Nếu không reconnect: server xoá user, xoá mọi chat liên quan, báo các peer; peer nhận event và xoá local history của chat đó.
8. Nếu browser restore một `sessionStorage` cũ nhưng server đã xoá session, server trả `resumed: false`; frontend tự bỏ toàn bộ chat history cũ.

## Protocol chính

Client → server:

- `hello`
- `search_users`
- `chat_request`
- `chat_accept`
- `chat_reject`
- `message`
- `file_message`
- `chat_close`
- `end_session`

Server → client:

- `session_ready`
- `online_count`
- `search_results`
- `chat_request`
- `chat_request_sent`
- `chat_request_cancelled`
- `chat_rejected`
- `chat_created`
- `message`
- `file_message`
- `peer_status`
- `peer_disconnected`
- `chat_closed`
- `chat_expired`
- `error`


## Gõ tiếng Việt / IME

Composer đã xử lý IME trên macOS/Windows: Enter trong lúc đang composition chỉ dùng để hoàn tất từ đang gõ, không gửi tin nhắn. Enter kế tiếp mới gửi. `Shift+Enter` vẫn xuống dòng. Client cũng dedupe theo `messageId` để tránh render một message hai lần.

## Giới hạn bản MVP

- Server giữ state trong RAM nên restart server sẽ kết thúc toàn bộ session/chat.
- Một WebSocket server instance phù hợp cho MVP. Nếu scale nhiều instance thì cần shared presence/pub-sub (Redis/NATS/etc.).
- `sessionStorage` có thể được browser khôi phục trong một số cơ chế restore tab; frontend xử lý bằng cách hỏi server xem session có thật sự còn tồn tại không và xoá history nếu session đã chết.
- Không có mã hoá end-to-end. WSS mã hoá đường truyền, nhưng server relay vẫn thấy plaintext message trong RAM lúc chuyển tiếp.

## Test nhanh syntax WebSocket server

```bash
npm run check:ws
```
