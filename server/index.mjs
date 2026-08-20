import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import http from 'node:http';

const PORT = Number(process.env.PORT || 8080);
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS || 8000);
const REQUEST_TTL_MS = 30_000;
const configuredChatTtlMs = Number(process.env.CHAT_TTL_MS);
const CHAT_TTL_MS = Number.isFinite(configuredChatTtlMs) && configuredChatTtlMs > 0
  ? configuredChatTtlMs
  : 60 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILE_SENDS_PER_CHAT = 5;
const MAX_SEARCH_LENGTH = 32;
const MAX_RESULTS = 20;
const HEARTBEAT_MS = 25_000;
// A 10 MiB file expands by roughly 4/3 when encoded as base64.
const MAX_WS_PAYLOAD = Math.ceil(MAX_FILE_SIZE * 4 / 3) + 64 * 1024;
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

const users = new Map();
const usernameToId = new Map();
const chats = new Map();
const userChats = new Map();
const pendingRequests = new Map();
const wsToUserId = new WeakMap();

function safeSend(ws, payload) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function sendError(ws, message, code = 'BAD_REQUEST') {
  safeSend(ws, { type: 'error', code, message });
}

function onlineUserCount() {
  return [...users.values()].filter((user) => user.ws?.readyState === WebSocket.OPEN).length;
}

function broadcastOnlineCount() {
  const onlineUsers = onlineUserCount();
  for (const user of users.values()) {
    safeSend(user.ws, { type: 'online_count', onlineUsers });
  }
}

function normalizeUsername(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  return cleaned;
}

function formatCollisionSuffix(index) {
  return String(index).padStart(2, '0');
}

function generateUsername(baseTimestamp = Date.now()) {
  const base = `user_${baseTimestamp}`;
  if (!usernameToId.has(base)) return base;

  for (let i = 1; i <= 99; i += 1) {
    const candidate = `${base}_${formatCollisionSuffix(i)}`;
    if (!usernameToId.has(candidate)) return candidate;
  }

  return `user_${baseTimestamp}_${randomUUID().slice(0, 6)}`;
}

function uniqueUsername(requested) {
  const normalized = normalizeUsername(requested);

  if (normalized) {
    if (!usernameToId.has(normalized)) return normalized;

    for (let i = 1; i <= 99; i += 1) {
      const candidate = `${normalized}_${formatCollisionSuffix(i)}`;
      if (!usernameToId.has(candidate)) return candidate;
    }
  }

  return generateUsername();
}

function publicUser(user) {
  return { id: user.id, username: user.username };
}

function getUserFromWs(ws) {
  const userId = wsToUserId.get(ws);
  return userId ? users.get(userId) : null;
}

function ensureUserChatSet(userId) {
  if (!userChats.has(userId)) userChats.set(userId, new Set());
  return userChats.get(userId);
}

function findExistingChat(userA, userB) {
  const ids = userChats.get(userA);
  if (!ids) return null;
  for (const chatId of ids) {
    const chat = chats.get(chatId);
    if (!chat?.members.includes(userB)) continue;
    if (chat.expiresAt <= Date.now()) {
      deleteChat(chat.id, 'expired');
      continue;
    }
    return chat;
  }
  return null;
}

function chatForUser(chat, userId) {
  const peerId = chat.members.find((id) => id !== userId);
  const peer = users.get(peerId);
  if (!peer) return null;
  return {
    id: chat.id,
    peer: publicUser(peer),
    createdAt: chat.createdAt,
    expiresAt: chat.expiresAt,
    attachmentCount: chat.attachmentCount,
    maxFileSends: MAX_FILE_SENDS_PER_CHAT,
  };
}

function createChat(userA, userB) {
  const existing = findExistingChat(userA.id, userB.id);
  if (existing) return existing;

  const createdAt = Date.now();
  const chat = {
    id: randomUUID(),
    members: [userA.id, userB.id],
    createdAt,
    expiresAt: createdAt + CHAT_TTL_MS,
    attachmentCount: 0,
    expiryTimer: null,
  };
  chats.set(chat.id, chat);
  ensureUserChatSet(userA.id).add(chat.id);
  ensureUserChatSet(userB.id).add(chat.id);
  chat.expiryTimer = setTimeout(() => {
    deleteChat(chat.id, 'expired');
  }, CHAT_TTL_MS);
  return chat;
}

function deleteChat(chatId, reason = 'closed', actorUserId = null) {
  const chat = chats.get(chatId);
  if (!chat) return;

  chats.delete(chatId);
  if (chat.expiryTimer) clearTimeout(chat.expiryTimer);
  for (const memberId of chat.members) {
    userChats.get(memberId)?.delete(chatId);
  }

  for (const memberId of chat.members) {
    if (memberId === actorUserId) continue;
    const member = users.get(memberId);
    if (!member) continue;
    const peerId = chat.members.find((id) => id !== memberId);
    const peer = users.get(peerId);

    if (reason === 'disconnect') {
      safeSend(member.ws, {
        type: 'peer_disconnected',
        chatId,
        peerUsername: peer?.username || 'peer',
      });
    } else if (reason === 'expired') {
      safeSend(member.ws, {
        type: 'chat_expired',
        chatId,
        peerUsername: peer?.username || 'peer',
      });
    } else {
      safeSend(member.ws, {
        type: 'chat_closed',
        chatId,
        peerUsername: peer?.username || 'peer',
      });
    }
  }
}

function clearPendingForUser(userId) {
  for (const [requestId, request] of pendingRequests) {
    if (request.fromId !== userId && request.toId !== userId) continue;

    const otherId = request.fromId === userId ? request.toId : request.fromId;
    const other = users.get(otherId);
    safeSend(other?.ws, { type: 'chat_request_cancelled', requestId });
    pendingRequests.delete(requestId);
  }
}

function destroySession(userId, reason = 'disconnect') {
  const user = users.get(userId);
  if (!user) return;

  const chatIds = [...(userChats.get(userId) || [])];
  for (const chatId of chatIds) {
    deleteChat(chatId, reason, userId);
  }

  clearPendingForUser(userId);
  userChats.delete(userId);
  usernameToId.delete(user.username);
  users.delete(userId);
  console.log(`[session] offline @${user.username} (${userId.slice(0, 8)})`);
  broadcastOnlineCount();
}

function markDisconnected(user) {
  if (!user || user.disconnectTimer) return;
  user.ws = null;
  user.disconnectedAt = Date.now();

  for (const chatId of userChats.get(user.id) || []) {
    const chat = chats.get(chatId);
    const peerId = chat?.members.find((id) => id !== user.id);
    const peer = users.get(peerId);
    safeSend(peer?.ws, { type: 'peer_status', chatId, online: false });
  }

  broadcastOnlineCount();

  user.disconnectTimer = setTimeout(() => {
    destroySession(user.id, 'disconnect');
  }, DISCONNECT_GRACE_MS);
}

function attachSession(ws, data) {
  const requestedId = typeof data.sessionId === 'string' ? data.sessionId : '';
  let user = requestedId ? users.get(requestedId) : null;
  let resumed = false;

  if (user) {
    resumed = true;
    if (user.disconnectTimer) {
      clearTimeout(user.disconnectTimer);
      user.disconnectTimer = null;
    }
    if (user.ws && user.ws !== ws && user.ws.readyState === WebSocket.OPEN) {
      user.ws.close(4001, 'Session replaced');
    }
    user.ws = ws;
    user.disconnectedAt = null;
  } else {
    const id = requestedId && /^[0-9a-f-]{20,64}$/i.test(requestedId) ? requestedId : randomUUID();
    const username = uniqueUsername(data.username);
    user = {
      id,
      username,
      ws,
      disconnectTimer: null,
      disconnectedAt: null,
      rate: { windowStartedAt: Date.now(), count: 0 },
      alive: true,
    };
    users.set(id, user);
    usernameToId.set(username, id);
    ensureUserChatSet(id);
    console.log(`[session] online @${username} (${id.slice(0, 8)})`);
  }

  user.rate = { windowStartedAt: Date.now(), count: 0 };
  user.alive = true;
  wsToUserId.set(ws, user.id);

  safeSend(ws, {
    type: 'session_ready',
    resumed,
    user: publicUser(user),
    graceMs: DISCONNECT_GRACE_MS,
    onlineUsers: onlineUserCount(),
    chats: [...(userChats.get(user.id) || [])]
      .map((chatId) => chats.get(chatId))
      .filter((chat) => chat && chat.expiresAt > Date.now())
      .map((chat) => chatForUser(chat, user.id))
      .filter(Boolean),
  });

  broadcastOnlineCount();

  if (resumed) {
    for (const chatId of userChats.get(user.id) || []) {
      const chat = chats.get(chatId);
      const peerId = chat?.members.find((id) => id !== user.id);
      const peer = users.get(peerId);
      safeSend(peer?.ws, { type: 'peer_status', chatId, online: true });
    }
  }
}

function rateAllowed(user) {
  const now = Date.now();
  if (now - user.rate.windowStartedAt > 10_000) {
    user.rate.windowStartedAt = now;
    user.rate.count = 0;
  }
  user.rate.count += 1;
  return user.rate.count <= 120;
}

function handleSearch(ws, user, data) {
  const query = typeof data.query === 'string' ? data.query.trim().toLowerCase().replace(/^@/, '') : '';
  if (query.length < 2 || query.length > MAX_SEARCH_LENGTH) {
    return sendError(ws, 'Search cần từ 2 đến 32 ký tự.');
  }

  const results = [];
  for (const candidate of users.values()) {
    if (candidate.id === user.id || !candidate.ws) continue;
    if (candidate.username.toLowerCase().includes(query)) {
      results.push(publicUser(candidate));
      if (results.length >= MAX_RESULTS) break;
    }
  }

  console.log(`[search] @${user.username} \"${query}\" -> ${results.length} result(s)`);
  safeSend(ws, { type: 'search_results', users: results });
}

function handleChatRequest(ws, user, data) {
  const target = users.get(data.targetUserId);
  if (!target || !target.ws) return sendError(ws, 'User này không còn online.', 'USER_OFFLINE');
  if (target.id === user.id) return sendError(ws, 'Không thể chat với chính bạn.');

  const existing = findExistingChat(user.id, target.id);
  if (existing) {
    const view = chatForUser(existing, user.id);
    return safeSend(ws, { type: 'chat_created', requestId: null, chat: view });
  }

  for (const request of pendingRequests.values()) {
    const samePair =
      (request.fromId === user.id && request.toId === target.id) ||
      (request.fromId === target.id && request.toId === user.id);
    if (samePair && request.expiresAt > Date.now()) {
      return sendError(ws, 'Đã có yêu cầu chat đang chờ giữa hai user.', 'REQUEST_EXISTS');
    }
  }

  const requestId = randomUUID();
  pendingRequests.set(requestId, {
    id: requestId,
    fromId: user.id,
    toId: target.id,
    expiresAt: Date.now() + REQUEST_TTL_MS,
  });

  safeSend(target.ws, {
    type: 'chat_request',
    requestId,
    from: publicUser(user),
    expiresAt: Date.now() + REQUEST_TTL_MS,
  });
  safeSend(ws, { type: 'chat_request_sent', requestId, to: publicUser(target) });
  console.log(`[chat-request] @${user.username} -> @${target.username}`);
}

function handleChatAnswer(ws, user, data, accepted) {
  const request = pendingRequests.get(data.requestId);
  if (!request || request.toId !== user.id || request.expiresAt <= Date.now()) {
    pendingRequests.delete(data.requestId);
    return sendError(ws, 'Yêu cầu chat đã hết hạn hoặc không tồn tại.', 'REQUEST_EXPIRED');
  }

  pendingRequests.delete(data.requestId);
  const requester = users.get(request.fromId);
  if (!requester || !requester.ws) return sendError(ws, 'User gửi yêu cầu đã offline.', 'USER_OFFLINE');

  if (!accepted) {
    safeSend(requester.ws, { type: 'chat_rejected', requestId: request.id, by: publicUser(user) });
    return;
  }

  const chat = createChat(requester, user);
  safeSend(requester.ws, {
    type: 'chat_created',
    requestId: request.id,
    chat: chatForUser(chat, requester.id),
  });
  safeSend(user.ws, {
    type: 'chat_created',
    requestId: request.id,
    chat: chatForUser(chat, user.id),
  });
}

function handleMessage(ws, user, data) {
  const chat = chats.get(data.chatId);
  if (!chat || !chat.members.includes(user.id)) return sendError(ws, 'Chat không tồn tại.', 'CHAT_NOT_FOUND');
  if (chat.expiresAt <= Date.now()) {
    deleteChat(chat.id, 'expired');
    return;
  }

  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!text || text.length > MAX_MESSAGE_LENGTH) {
    return sendError(ws, `Tin nhắn phải từ 1 đến ${MAX_MESSAGE_LENGTH} ký tự.`);
  }

  const peerId = chat.members.find((id) => id !== user.id);
  const peer = users.get(peerId);
  if (!peer?.ws) return sendError(ws, 'Peer đang reconnect hoặc đã offline.', 'PEER_OFFLINE');

  safeSend(peer.ws, {
    type: 'message',
    chatId: chat.id,
    messageId: typeof data.clientMessageId === 'string' ? data.clientMessageId : randomUUID(),
    from: publicUser(user),
    text,
    timestamp: Date.now(),
  });
}

function handleFileMessage(ws, user, data) {
  const chat = chats.get(data.chatId);
  if (!chat || !chat.members.includes(user.id)) return sendError(ws, 'Chat không tồn tại.', 'CHAT_NOT_FOUND');
  if (chat.expiresAt <= Date.now()) {
    deleteChat(chat.id, 'expired');
    return;
  }
  if (chat.attachmentCount >= MAX_FILE_SENDS_PER_CHAT) {
    return sendError(ws, `Cuộc chat chỉ được gửi tối đa ${MAX_FILE_SENDS_PER_CHAT} file.`, 'FILE_LIMIT_REACHED');
  }

  const file = data.file;
  const name = typeof file?.name === 'string'
    ? file.name.split(/[\\/]/).pop().trim().slice(0, 255)
    : '';
  const mimeType = typeof file?.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(file.type)
    ? file.type.slice(0, 100)
    : 'application/octet-stream';
  const declaredSize = Number(file?.size);
  const base64 = typeof file?.data === 'string' ? file.data : '';

  if (!name || !Number.isInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_FILE_SIZE) {
    return sendError(ws, 'File không hợp lệ hoặc vượt quá dung lượng 10 MB.', 'FILE_TOO_LARGE');
  }
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    return sendError(ws, 'Dữ liệu file không hợp lệ.', 'INVALID_FILE');
  }

  const decodedSize = Buffer.byteLength(base64, 'base64');
  if (decodedSize !== declaredSize || decodedSize > MAX_FILE_SIZE) {
    return sendError(ws, 'Dung lượng file không khớp hoặc vượt quá 10 MB.', 'FILE_TOO_LARGE');
  }

  const peerId = chat.members.find((id) => id !== user.id);
  const peer = users.get(peerId);
  if (peer?.ws?.readyState !== WebSocket.OPEN) {
    return sendError(ws, 'Peer đang reconnect hoặc đã offline.', 'PEER_OFFLINE');
  }

  chat.attachmentCount += 1;
  const payload = {
    type: 'file_message',
    chatId: chat.id,
    messageId: typeof data.clientMessageId === 'string' ? data.clientMessageId : randomUUID(),
    from: publicUser(user),
    file: { name, type: mimeType, size: decodedSize, data: base64 },
    attachmentCount: chat.attachmentCount,
    maxFileSends: MAX_FILE_SENDS_PER_CHAT,
    timestamp: Date.now(),
  };
  safeSend(peer.ws, payload);
  safeSend(ws, payload);
}

function handleMessageEnvelope(ws, raw) {
  let data;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    return sendError(ws, 'JSON không hợp lệ.');
  }

  if (data.type === 'hello') {
    if (getUserFromWs(ws)) return sendError(ws, 'Session đã được khởi tạo.');
    return attachSession(ws, data);
  }

  const user = getUserFromWs(ws);
  if (!user) return sendError(ws, 'Cần khởi tạo session trước.', 'NO_SESSION');
  if (!rateAllowed(user)) return sendError(ws, 'Bạn thao tác quá nhanh. Thử lại sau.', 'RATE_LIMIT');

  switch (data.type) {
    case 'search_users':
      return handleSearch(ws, user, data);
    case 'chat_request':
      return handleChatRequest(ws, user, data);
    case 'chat_accept':
      return handleChatAnswer(ws, user, data, true);
    case 'chat_reject':
      return handleChatAnswer(ws, user, data, false);
    case 'message':
      return handleMessage(ws, user, data);
    case 'file_message':
      return handleFileMessage(ws, user, data);
    case 'chat_close': {
      const chat = chats.get(data.chatId);
      if (!chat || !chat.members.includes(user.id)) return sendError(ws, 'Chat không tồn tại.', 'CHAT_NOT_FOUND');
      deleteChat(chat.id, 'closed', user.id);
      return;
    }
    case 'end_session':
      safeSend(ws, { type: 'session_ended' });
      destroySession(user.id, 'disconnect');
      wsToUserId.delete(ws);
      ws.close(1000, 'Session ended');
      return;
    case 'pong':
      user.alive = true;
      return;
    default:
      return sendError(ws, 'Event không được hỗ trợ.');
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, onlineUsers: onlineUserCount() }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Temp Chat WebSocket server');
});

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_WS_PAYLOAD,
  verifyClient: ({ origin, req }) => {
    const allowed = ALLOWED_ORIGINS.size === 0 || ALLOWED_ORIGINS.has(origin);
    if (!allowed) {
      console.warn(`[ws] rejected origin=${origin || 'unknown'} ip=${req?.socket?.remoteAddress || 'unknown'}`);
    }
    return allowed;
  },
});

wss.on('connection', (ws, req) => {
  console.log(`[ws] connected ip=${req?.socket?.remoteAddress || 'unknown'} origin=${req?.headers?.origin || 'unknown'}`);
  ws.on('message', (raw) => handleMessageEnvelope(ws, raw));

  ws.on('pong', () => {
    const user = getUserFromWs(ws);
    if (user) user.alive = true;
  });

  ws.on('close', () => {
    const user = getUserFromWs(ws);
    wsToUserId.delete(ws);
    if (user && user.ws === ws) markDisconnected(user);
  });
});

const heartbeat = setInterval(() => {
  const now = Date.now();

  for (const [requestId, request] of pendingRequests) {
    if (request.expiresAt <= now) pendingRequests.delete(requestId);
  }

  for (const user of users.values()) {
    if (!user.ws) continue;
    if (!user.alive) {
      user.ws.terminate();
      continue;
    }
    user.alive = false;
    user.ws.ping();
  }
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

server.on('error', (error) => {
  console.error(`[server] ${error.code || error.name}: ${error.message}`);
});

// Do not force 0.0.0.0 here. Let Node bind the unspecified address so
// localhost works whether macOS resolves it to IPv4 (127.0.0.1) or IPv6 (::1).
server.listen(PORT, () => {
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.address : 'localhost';
  console.log(`Temp Chat WS server listening on port ${PORT} (${bound})`);
  console.log(`WebSocket local endpoints: ws://127.0.0.1:${PORT} and ws://localhost:${PORT}`);
  if (ALLOWED_ORIGINS.size > 0) {
    console.log(`Allowed origins: ${[...ALLOWED_ORIGINS].join(', ')}`);
  }
});
