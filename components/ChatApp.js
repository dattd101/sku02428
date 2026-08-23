'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const STORAGE_KEY = 'tempchat:session:v1';
const MAX_MESSAGE_LENGTH = 2000;
const CHAT_DURATION_MINUTES = 60;
const MAX_FILE_SIZE = 3.5 * 1024 * 1024;
const MAX_FILE_SENDS_PER_CHAT = 30;
const FILE_CHUNK_BASE64_LENGTH = 128 * 1024;
const MAX_SOCKET_BUFFER = 512 * 1024;
const SIMPLE_EMOJIS = ['😀', '😂', '😍', '🥰', '😎', '😭', '😡', '👍', '👏', '🙏', '❤️', '🎉'];

function makeSessionId() {
  return crypto.randomUUID();
}

function generateLocalUsername() {
  return `user_${Date.now()}`;
}

function blankState() {
  return {
    sessionId: makeSessionId(),
    username: generateLocalUsername(),
    chats: {},
  };
}

function loadState() {
  if (typeof window === 'undefined') return null;

  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return blankState();
    const parsed = JSON.parse(raw);
    if (!parsed?.sessionId || !parsed?.chats) return blankState();
    return {
      ...parsed,
      username: parsed.username || generateLocalUsername(),
    };
  } catch {
    return blankState();
  }
}

function persistState(state) {
  try {
    // File bodies can be larger than the browser's sessionStorage quota. Keep
    // their metadata across refreshes, while the actual bytes remain ephemeral.
    const chats = Object.fromEntries(Object.entries(state.chats).map(([chatId, chat]) => [
      chatId,
      {
        ...chat,
        messages: chat.messages.map((message) => message.file
          ? { ...message, file: { ...message.file, data: undefined } }
          : message),
      },
    ]));
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, chats }));
  } catch {
    // Ignore storage failures; realtime chat can still function.
  }
}

function timeLabel(timestamp) {
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function countdownLabel(expiresAt, now) {
  const totalSeconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function fileSizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function base64ByteLength(value) {
  if (!value) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

export default function ChatApp() {
  const [session, setSession] = useState(null);
  const [connection, setConnection] = useState('connecting');
  const [connectionError, setConnectionError] = useState('');
  const [wsEndpoint, setWsEndpoint] = useState('');
  const [onlineCount, setOnlineCount] = useState(0);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [activeChatId, setActiveChatId] = useState(null);
  const [draft, setDraft] = useState('');
  const [incomingRequests, setIncomingRequests] = useState([]);
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [sendingFile, setSendingFile] = useState(false);
  const [fileProgress, setFileProgress] = useState({});
  const [fileBatch, setFileBatch] = useState(null);

  const socketRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const searchTimerRef = useRef(null);
  const sessionRef = useRef(null);
  const activeChatRef = useRef(null);
  const messagesEndRef = useRef(null);
  const manualEndRef = useRef(false);
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const draftRef = useRef('');
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const pendingFileIdRef = useRef(null);
  const outgoingFileRef = useRef(null);
  const incomingFilesRef = useRef(new Map());
  const startFileStreamRef = useRef(null);
  const startNextFileRef = useRef(null);
  const fileQueueRef = useRef([]);

  useEffect(() => {
    const initial = loadState();
    sessionRef.current = initial;
    setSession(initial);
  }, []);

  useEffect(() => {
    sessionRef.current = session;
    if (session) persistState(session);
  }, [session]);

  useEffect(() => {
    activeChatRef.current = activeChatId;
  }, [activeChatId]);

  const send = useCallback((payload) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }, []);

  const removeChat = useCallback((chatId, message) => {
    setSession((current) => {
      if (!current?.chats?.[chatId]) return current;
      const chats = { ...current.chats };
      delete chats[chatId];
      return { ...current, chats };
    });

    if (activeChatRef.current === chatId) {
      setActiveChatId(null);
    }

    setFileProgress((current) => Object.fromEntries(
      Object.entries(current).filter(([, progress]) => progress.chatId !== chatId),
    ));
    setFileBatch((current) => current?.chatId === chatId ? null : current);
    fileQueueRef.current = fileQueueRef.current.filter((queued) => queued.chatId !== chatId);

    if (message) setNotice(message);
  }, []);

  const upsertChat = useCallback((chat) => {
    setSession((current) => {
      if (!current) return current;
      const existing = current.chats[chat.id];
      return {
        ...current,
        chats: {
          ...current.chats,
          [chat.id]: {
            id: chat.id,
            peer: chat.peer,
            messages: existing?.messages ?? [],
            createdAt: chat.createdAt ?? existing?.createdAt ?? Date.now(),
            expiresAt: chat.expiresAt ?? existing?.expiresAt,
            attachmentCount: chat.attachmentCount ?? existing?.attachmentCount ?? 0,
            maxFileSends: chat.maxFileSends ?? existing?.maxFileSends ?? MAX_FILE_SENDS_PER_CHAT,
            unread: existing?.unread ?? 0,
            peerOnline: true,
          },
        },
      };
    });
    setActiveChatId((current) => current ?? chat.id);
  }, []);

  const handleServerMessage = useCallback((event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (data.type) {
      case 'session_ready': {
        setConnection('online');
        setConnectionError('');
        reconnectAttemptRef.current = 0;
        setOnlineCount(Number(data.onlineUsers || 1));

        setSession((current) => {
          if (!current) return current;
          // If the server no longer recognizes this session, any locally restored
          // chat history belongs to a finished session and must be discarded.
          const serverChats = Array.isArray(data.chats) ? data.chats : [];
          const chats = data.resumed
            ? Object.fromEntries(serverChats.map((chat) => {
                const existing = current.chats[chat.id];
                return [chat.id, {
                  ...chat,
                  messages: existing?.messages ?? [],
                  unread: existing?.unread ?? 0,
                  peerOnline: true,
                }];
              }))
            : {};
          return {
            ...current,
            sessionId: data.user.id,
            username: data.user.username,
            chats,
          };
        });

        if (!data.resumed) {
          setActiveChatId(null);
          setNotice('Đã tạo phiên chat tạm mới.');
        }
        break;
      }
      case 'online_count':
        setOnlineCount(Number(data.onlineUsers || 0));
        break;
      case 'search_results':
        setSearchResults(data.users ?? []);
        setSearching(false);
        break;
      case 'chat_request':
        setIncomingRequests((current) => {
          if (current.some((item) => item.requestId === data.requestId)) return current;
          return [...current, data];
        });
        window.setTimeout(() => {
          setIncomingRequests((current) => current.filter((item) => item.requestId !== data.requestId));
        }, Math.max(0, (data.expiresAt || Date.now() + 30_000) - Date.now()));
        break;
      case 'chat_request_cancelled':
        setIncomingRequests((current) => current.filter((item) => item.requestId !== data.requestId));
        break;
      case 'chat_request_sent':
        setNotice(`Đã gửi yêu cầu chat tới @${data.to.username}.`);
        break;
      case 'chat_rejected':
        setNotice(`@${data.by.username} đã từ chối yêu cầu chat.`);
        break;
      case 'chat_created':
        setIncomingRequests((current) => current.filter((item) => item.requestId !== data.requestId));
        upsertChat(data.chat);
        setNotice(`Đã kết nối với @${data.chat.peer.username}. Cuộc chat sẽ tự giải tán sau ${CHAT_DURATION_MINUTES} phút.`);
        break;
      case 'message': {
        setSession((current) => {
          if (!current?.chats?.[data.chatId]) return current;
          const chat = current.chats[data.chatId];
          if (chat.messages.some((message) => message.id === data.messageId)) return current;
          const isActive = activeChatRef.current === data.chatId;
          return {
            ...current,
            chats: {
              ...current.chats,
              [data.chatId]: {
                ...chat,
                unread: isActive ? 0 : (chat.unread ?? 0) + 1,
                messages: [
                  ...chat.messages,
                  {
                    id: data.messageId,
                    from: data.from.id,
                    text: data.text,
                    timestamp: data.timestamp,
                  },
                ],
              },
            },
          };
        });
        break;
      }
      case 'file_start': {
        const mine = data.from.id === sessionRef.current?.sessionId;
        setSession((current) => {
          if (!current?.chats?.[data.chatId]) return current;
          const chat = current.chats[data.chatId];
          return {
            ...current,
            chats: {
              ...current.chats,
              [data.chatId]: {
                ...chat,
                attachmentCount: data.attachmentCount,
                maxFileSends: data.maxFileSends ?? MAX_FILE_SENDS_PER_CHAT,
              },
            },
          };
        });
        setFileProgress((current) => ({
          ...current,
          [data.transferId]: {
            chatId: data.chatId,
            name: data.file.name,
            direction: mine ? 'send' : 'receive',
            position: data.batchPosition ?? 1,
            total: data.batchTotal ?? 1,
            percent: 0,
          },
        }));

        if (mine && outgoingFileRef.current?.transferId === data.transferId) {
          outgoingFileRef.current.file = { ...data.file, data: outgoingFileRef.current.file.data };
          outgoingFileRef.current.timestamp = data.timestamp;
          startFileStreamRef.current?.(data.transferId);
        } else {
          incomingFilesRef.current.set(data.transferId, {
            chatId: data.chatId,
            from: data.from.id,
            file: data.file,
            timestamp: data.timestamp,
            chunks: [],
            receivedBytes: 0,
          });
        }
        break;
      }
      case 'file_chunk': {
        const transfer = incomingFilesRef.current.get(data.transferId);
        if (transfer?.chatId === data.chatId && typeof data.data === 'string') {
          transfer.chunks.push(data.data);
          transfer.receivedBytes += base64ByteLength(data.data);
          const percent = transfer.file.size > 0
            ? Math.min(99, Math.round((transfer.receivedBytes / transfer.file.size) * 100))
            : 99;
          setFileProgress((current) => current[data.transferId]
            ? { ...current, [data.transferId]: { ...current[data.transferId], percent } }
            : current);
        }
        break;
      }
      case 'file_end': {
        const outgoing = outgoingFileRef.current?.transferId === data.transferId
          ? outgoingFileRef.current
          : null;
        const incoming = incomingFilesRef.current.get(data.transferId);
        const transfer = outgoing || incoming;
        if (transfer) {
          const file = outgoing
            ? outgoing.file
            : { ...incoming.file, data: incoming.chunks.join('') };
          const from = outgoing ? sessionRef.current?.sessionId : incoming.from;
          setSession((current) => {
            if (!current?.chats?.[transfer.chatId]) return current;
            const chat = current.chats[transfer.chatId];
            if (chat.messages.some((message) => message.id === data.transferId)) return current;
            const isActive = activeChatRef.current === transfer.chatId;
            return {
              ...current,
              chats: {
                ...current.chats,
                [transfer.chatId]: {
                  ...chat,
                  unread: !outgoing && !isActive ? (chat.unread ?? 0) + 1 : chat.unread,
                  messages: [
                    ...chat.messages,
                    {
                      id: data.transferId,
                      kind: 'file',
                      from,
                      file,
                      timestamp: transfer.timestamp,
                    },
                  ],
                },
              },
            };
          });
        }
        incomingFilesRef.current.delete(data.transferId);
        if (outgoing) {
          outgoingFileRef.current = null;
          pendingFileIdRef.current = null;
          window.setTimeout(() => startNextFileRef.current?.(), 0);
        }
        setFileProgress((current) => current[data.transferId]
          ? { ...current, [data.transferId]: { ...current[data.transferId], percent: 100 } }
          : current);
        window.setTimeout(() => {
          setFileProgress((current) => {
            if (!current[data.transferId]) return current;
            const next = { ...current };
            delete next[data.transferId];
            return next;
          });
        }, 500);
        break;
      }
      case 'file_abort':
        incomingFilesRef.current.delete(data.transferId);
        setFileProgress((current) => {
          if (!current[data.transferId]) return current;
          const next = { ...current };
          delete next[data.transferId];
          return next;
        });
        setSession((current) => {
          if (!current?.chats?.[data.chatId]) return current;
          return {
            ...current,
            chats: {
              ...current.chats,
              [data.chatId]: {
                ...current.chats[data.chatId],
                attachmentCount: data.attachmentCount,
              },
            },
          };
        });
        if (outgoingFileRef.current?.transferId === data.transferId) {
          outgoingFileRef.current = null;
          pendingFileIdRef.current = null;
          window.setTimeout(() => startNextFileRef.current?.(), 0);
        }
        setNotice(`Gửi file thất bại: ${data.message || 'File đã bị hủy.'}`);
        break;
      case 'chat_closed':
        removeChat(data.chatId, `Cuộc chat với @${data.peerUsername} đã kết thúc.`);
        break;
      case 'chat_expired':
        removeChat(data.chatId, `Đã hết ${CHAT_DURATION_MINUTES} phút. Cuộc chat với @${data.peerUsername} đã tự giải tán.`);
        break;
      case 'peer_disconnected':
        removeChat(data.chatId, `@${data.peerUsername} đã thoát. Lịch sử cuộc chat đã được xoá.`);
        break;
      case 'peer_status':
        setSession((current) => {
          if (!current?.chats?.[data.chatId]) return current;
          const chat = current.chats[data.chatId];
          return {
            ...current,
            chats: {
              ...current.chats,
              [data.chatId]: { ...chat, peerOnline: data.online },
            },
          };
        });
        break;
      case 'session_ended':
        sessionStorage.removeItem(STORAGE_KEY);
        setSession(blankState());
        setActiveChatId(null);
        setSearchResults([]);
        setIncomingRequests([]);
        setFileProgress({});
        setFileBatch(null);
        fileQueueRef.current = [];
        outgoingFileRef.current = null;
        pendingFileIdRef.current = null;
        setSendingFile(false);
        break;
      case 'error':
        setSearching(false);
        if (pendingFileIdRef.current) {
          const failedTransferId = pendingFileIdRef.current;
          pendingFileIdRef.current = null;
          outgoingFileRef.current = null;
          window.setTimeout(() => startNextFileRef.current?.(), 0);
          setFileProgress((current) => {
            if (!current[failedTransferId]) return current;
            const next = { ...current };
            delete next[failedTransferId];
            return next;
          });
          setNotice(`Gửi file thất bại: ${data.message || 'Có lỗi xảy ra.'}`);
          break;
        }
        setNotice(data.message || 'Có lỗi xảy ra.');
        break;
      default:
        break;
    }
  }, [removeChat, upsertChat]);

  useEffect(() => {
    if (!session?.sessionId) return undefined;

    manualEndRef.current = false;
    let cancelled = false;

    const getWsCandidates = () => {
      const candidates = [];
      const add = (value) => {
        if (!value || candidates.includes(value)) return;
        candidates.push(value);
      };

      const configured = process.env.NEXT_PUBLIC_WS_URL?.trim();
      const pageHost = window.location.hostname;
      const pageIsSecure = window.location.protocol === 'https:';

      if (configured) {
        try {
          const parsed = new URL(configured);
          add(parsed.toString());

          if (parsed.hostname === 'localhost') {
            const ipv4 = new URL(parsed.toString());
            ipv4.hostname = '127.0.0.1';
            add(ipv4.toString());
          }

          if (!pageIsSecure && pageHost && !['localhost', '127.0.0.1'].includes(pageHost)) {
            const sameHost = new URL(parsed.toString());
            sameHost.protocol = 'ws:';
            sameHost.hostname = pageHost;
            add(sameHost.toString());
          }
        } catch {
          add(configured);
        }
      }

      if (!pageIsSecure) {
        add(`ws://${pageHost}:8080`);
        if (pageHost === 'localhost') add('ws://127.0.0.1:8080');
        if (pageHost === '127.0.0.1') add('ws://localhost:8080');
      }

      return candidates;
    };

    const candidates = getWsCandidates();
    let candidateIndex = 0;

    const connect = () => {
      if (cancelled || manualEndRef.current) return;

      if (candidates.length === 0) {
        setConnection('config_error');
        setConnectionError('Không có WebSocket URL hợp lệ. Hãy cấu hình NEXT_PUBLIC_WS_URL bằng địa chỉ wss:// của backend rồi deploy lại.');
        return;
      }

      const wsUrl = candidates[candidateIndex % candidates.length];
      candidateIndex += 1;
      setWsEndpoint(wsUrl);
      setConnection((current) => (current === 'online' ? 'reconnecting' : 'connecting'));

      let ws;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        setConnection('reconnecting');
        setConnectionError(`WebSocket URL không hợp lệ: ${wsUrl}`);
        reconnectTimerRef.current = window.setTimeout(connect, 500);
        return;
      }
      socketRef.current = ws;

      ws.addEventListener('open', () => {
        setConnectionError('');
        ws.send(JSON.stringify({
          type: 'hello',
          sessionId: sessionRef.current?.sessionId,
          username: sessionRef.current?.username || generateLocalUsername(),
        }));
      });

      ws.addEventListener('message', handleServerMessage);

      ws.addEventListener('close', (event) => {
        if (socketRef.current === ws) socketRef.current = null;
        if (cancelled || manualEndRef.current) return;

        if (outgoingFileRef.current) {
          outgoingFileRef.current = null;
          pendingFileIdRef.current = null;
          setNotice('Kết nối bị gián đoạn. File chưa được gửi hoàn tất.');
        }
        incomingFilesRef.current.clear();
        setFileProgress({});
        setFileBatch(null);
        fileQueueRef.current = [];
        setSendingFile(false);

        setConnection('reconnecting');
        setOnlineCount(0);
        const reason = event.reason ? `, ${event.reason}` : '';
        setConnectionError(`Không kết nối được ${wsUrl} (code ${event.code}${reason}). Đang thử endpoint khác...`);
        reconnectAttemptRef.current += 1;
        const triedAllCandidates = candidateIndex % candidates.length === 0;
        const delay = triedAllCandidates
          ? Math.min(1000 * 2 ** Math.min(reconnectAttemptRef.current, 4), 10000)
          : 350;
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      });

      ws.addEventListener('error', () => {
        try { ws.close(); } catch { /* noop */ }
      });
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
    };
  }, [session?.sessionId, handleServerMessage]);

  useEffect(() => {
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);

    const trimmed = query.trim();
    if (trimmed.length < 2 || connection !== 'online') {
      setSearchResults([]);
      setSearching(false);
      return undefined;
    }

    setSearching(true);
    searchTimerRef.current = window.setTimeout(() => {
      send({ type: 'search_users', query: trimmed });
    }, 250);

    return () => {
      if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    };
  }, [query, connection, send]);

  const chats = useMemo(() => {
    if (!session) return [];
    return Object.values(session.chats).sort((a, b) => {
      const aTime = a.messages.at(-1)?.timestamp ?? a.createdAt;
      const bTime = b.messages.at(-1)?.timestamp ?? b.createdAt;
      return bTime - aTime;
    });
  }, [session]);

  const activeChat = activeChatId ? session?.chats?.[activeChatId] : null;

  useEffect(() => {
    if (chats.length === 0) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [chats.length]);

  useEffect(() => {
    const expiredChats = chats.filter((chat) => chat.expiresAt && chat.expiresAt <= now);
    if (expiredChats.length === 0) return;

    setSession((current) => {
      if (!current) return current;
      const nextChats = { ...current.chats };
      for (const chat of expiredChats) delete nextChats[chat.id];
      return { ...current, chats: nextChats };
    });
    if (expiredChats.some((chat) => chat.id === activeChatRef.current)) {
      setActiveChatId(null);
    }
    setNotice(`Đã hết ${CHAT_DURATION_MINUTES} phút. Cuộc chat đã tự giải tán.`);
  }, [chats, now]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [activeChatId, activeChat?.messages?.length]);

  const openChat = (chatId) => {
    setActiveChatId(chatId);
    setSession((current) => {
      if (!current?.chats?.[chatId]) return current;
      return {
        ...current,
        chats: {
          ...current.chats,
          [chatId]: { ...current.chats[chatId], unread: 0 },
        },
      };
    });
  };

  const requestChat = (user) => {
    if (send({ type: 'chat_request', targetUserId: user.id })) {
      setNotice(`Đang gửi yêu cầu tới @${user.username}...`);
    }
  };

  const answerRequest = (requestId, accept) => {
    send({ type: accept ? 'chat_accept' : 'chat_reject', requestId });
    setIncomingRequests((current) => current.filter((item) => item.requestId !== requestId));
  };

  const sendMessage = () => {
    const text = draftRef.current.trim();
    if (!activeChat || activeChat.peerOnline === false || !text || text.length > MAX_MESSAGE_LENGTH) return;

    const clientMessageId = crypto.randomUUID();
    const timestamp = Date.now();

    // Clear the draft synchronously before WebSocket.send(). This prevents a
    // duplicated key event from sending the same React state twice.
    draftRef.current = '';
    setDraft('');

    if (!send({ type: 'message', chatId: activeChat.id, text, clientMessageId })) {
      draftRef.current = text;
      setDraft(text);
      setNotice('Mất kết nối. Chưa gửi được tin nhắn.');
      return;
    }

    setSession((current) => {
      if (!current?.chats?.[activeChat.id]) return current;
      const chat = current.chats[activeChat.id];
      if (chat.messages.some((message) => message.id === clientMessageId)) return current;
      return {
        ...current,
        chats: {
          ...current.chats,
          [activeChat.id]: {
            ...chat,
            messages: [
              ...chat.messages,
              {
                id: clientMessageId,
                from: current.sessionId,
                text,
                timestamp,
              },
            ],
          },
        },
      };
    });
  };

  const addEmoji = (emoji) => {
    const textarea = textareaRef.current;
    const current = draftRef.current;
    const start = textarea?.selectionStart ?? current.length;
    const end = textarea?.selectionEnd ?? current.length;
    const next = `${current.slice(0, start)}${emoji}${current.slice(end)}`;
    if (next.length > MAX_MESSAGE_LENGTH) return;

    draftRef.current = next;
    setDraft(next);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  };

  const streamFileChunks = async (transferId) => {
    const transfer = outgoingFileRef.current;
    if (!transfer || transfer.transferId !== transferId) return;

    try {
      for (let offset = 0; offset < transfer.file.data.length; offset += FILE_CHUNK_BASE64_LENGTH) {
        while (socketRef.current?.bufferedAmount > MAX_SOCKET_BUFFER) {
          await new Promise((resolve) => window.setTimeout(resolve, 20));
          if (outgoingFileRef.current?.transferId !== transferId) return;
        }

        const data = transfer.file.data.slice(offset, offset + FILE_CHUNK_BASE64_LENGTH);
        if (!send({ type: 'file_chunk', chatId: transfer.chatId, transferId, data })) {
          throw new Error('SEND_FAILED');
        }
        const percent = transfer.file.data.length > 0
          ? Math.min(99, Math.round(((offset + data.length) / transfer.file.data.length) * 100))
          : 99;
        setFileProgress((current) => current[transferId]
          ? { ...current, [transferId]: { ...current[transferId], percent } }
          : current);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }

      if (!send({ type: 'file_end', chatId: transfer.chatId, transferId })) {
        throw new Error('SEND_FAILED');
      }
    } catch {
      if (outgoingFileRef.current?.transferId !== transferId) return;
      send({ type: 'file_cancel', chatId: transfer.chatId, transferId });
      outgoingFileRef.current = null;
      pendingFileIdRef.current = null;
      setFileProgress((current) => {
        if (!current[transferId]) return current;
        const next = { ...current };
        delete next[transferId];
        return next;
      });
      setNotice('Không thể gửi hoàn tất file. Vui lòng thử lại.');
      window.setTimeout(() => startNextFileRef.current?.(), 0);
    }
  };
  startFileStreamRef.current = streamFileChunks;

  const startNextFile = async () => {
    const queued = fileQueueRef.current.shift();
    if (!queued) {
      setSendingFile(false);
      setFileBatch(null);
      return;
    }

    const { file, chatId, position, total } = queued;
    const currentChat = sessionRef.current?.chats?.[chatId];
    if (!currentChat || currentChat.peerOnline === false) {
      fileQueueRef.current = [];
      setSendingFile(false);
      setFileBatch(null);
      setNotice('Đã dừng hàng đợi file vì cuộc chat không còn kết nối.');
      return;
    }

    const transferId = crypto.randomUUID();
    pendingFileIdRef.current = transferId;
    setFileBatch({ chatId, current: position, total, name: file.name });
    setFileProgress((current) => ({
      ...current,
      [transferId]: {
        chatId,
        name: file.name,
        direction: 'send',
        position,
        total,
        percent: 0,
      },
    }));

    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const commaIndex = dataUrl.indexOf(',');
      const data = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : '';
      const chatStillExists = sessionRef.current?.chats?.[chatId];
      outgoingFileRef.current = {
        transferId,
        chatId,
        file: { name: file.name, type: file.type, size: file.size, data },
        batchPosition: position,
        batchTotal: total,
        timestamp: Date.now(),
      };
      if (!chatStillExists || !send({
        type: 'file_start',
        chatId,
        transferId,
        file: { name: file.name, type: file.type, size: file.size },
        batchPosition: position,
        batchTotal: total,
      })) {
        throw new Error('SEND_FAILED');
      }
    } catch {
      outgoingFileRef.current = null;
      pendingFileIdRef.current = null;
      setFileProgress((current) => {
        if (!current[transferId]) return current;
        const next = { ...current };
        delete next[transferId];
        return next;
      });
      setNotice('Không thể đọc hoặc gửi file. Vui lòng thử lại.');
      window.setTimeout(() => startNextFileRef.current?.(), 0);
    }
  };
  startNextFileRef.current = startNextFile;

  const sendFiles = (selectedFiles) => {
    const chat = activeChat;
    if (!selectedFiles.length || !chat || chat.peerOnline === false || sendingFile) return;

    const maxFileSends = chat.maxFileSends ?? MAX_FILE_SENDS_PER_CHAT;
    const remaining = Math.max(0, maxFileSends - (chat.attachmentCount ?? 0));
    if (remaining === 0) {
      setNotice(`Cuộc chat chỉ được gửi tối đa ${maxFileSends} file.`);
      return;
    }

    const selected = selectedFiles.slice(0, MAX_FILE_SENDS_PER_CHAT);
    const valid = selected.filter((file) => file.size <= MAX_FILE_SIZE);
    const queued = valid.slice(0, remaining);
    const oversizedCount = selected.length - valid.length;
    const omittedCount = selectedFiles.length - selected.length + valid.length - queued.length;

    if (queued.length === 0) {
      setNotice(oversizedCount > 0
        ? 'Không có file hợp lệ. Mỗi file chỉ được tối đa 3.5 MB.'
        : `Cuộc chat chỉ còn ${remaining} lượt gửi file.`);
      return;
    }

    fileQueueRef.current = queued.map((file, index) => ({
      file,
      chatId: chat.id,
      position: index + 1,
      total: queued.length,
    }));
    setSendingFile(true);
    setFileBatch({ chatId: chat.id, current: 0, total: queued.length, name: '' });

    const skipped = oversizedCount + omittedCount;
    setNotice(skipped > 0
      ? `Đã thêm ${queued.length} file vào hàng đợi, bỏ qua ${skipped} file vượt giới hạn.`
      : `Đã thêm ${queued.length} file vào hàng đợi gửi.`);
    window.setTimeout(() => startNextFileRef.current?.(), 0);
  };

  const closeChat = () => {
    if (!activeChat) return;
    send({ type: 'chat_close', chatId: activeChat.id });
    removeChat(activeChat.id, 'Đã kết thúc cuộc chat.');
  };

  const endSession = () => {
    manualEndRef.current = true;
    send({ type: 'end_session' });
    sessionStorage.removeItem(STORAGE_KEY);
    socketRef.current?.close();
    socketRef.current = null;
    setSession(blankState());
    setActiveChatId(null);
    setIncomingRequests([]);
    setSearchResults([]);
    setFileProgress({});
    setFileBatch(null);
    fileQueueRef.current = [];
    outgoingFileRef.current = null;
    pendingFileIdRef.current = null;
    setSendingFile(false);
    setQuery('');
    setNotice('Phiên cũ đã được xoá. Đang tạo phiên mới...');
  };

  const copyUsername = async () => {
    if (!session?.username) return;
    try {
      await navigator.clipboard.writeText(session.username);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setNotice(`Username của bạn: @${session.username}`);
    }
  };

  const downloadFile = (file) => {
    if (!file?.data) {
      setNotice('File không còn khả dụng để tải xuống.');
      return;
    }

    try {
      const binary = window.atob(file.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }

      const blob = new Blob([bytes], { type: file.type || 'application/octet-stream' });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = file.name || 'download';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch {
      setNotice('Không thể tải file. Dữ liệu file không hợp lệ.');
    }
  };

  if (!session) {
    return <main className="boot">Đang tạo session tạm...</main>;
  }

  return (
    <main className="shell">
      <section className="app-card">
        <aside className="sidebar">
          <div className="brand-row">
            <div>
              <div className="brand">Temp Chat</div>
              <div className="muted tiny">Tin nhắn không lưu server</div>
            </div>
            <span className="status-wrap" title={connection}>
              <span className={`status-dot ${connection}`} />
              <span className={`status-text ${connection}`}>
                {connection === 'online' ? `Online · ${onlineCount} user` : connection === 'config_error' ? 'Lỗi cấu hình' : connection === 'reconnecting' ? 'Đang reconnect' : 'Đang kết nối'}
              </span>
            </span>
          </div>

          <button className="profile" onClick={copyUsername} type="button">
            <span className="avatar">{session.username?.slice(0, 1).toUpperCase() || '?'}</span>
            <span className="profile-text">
              <strong>@{session.username || 'user_đang_tạo'}</strong>
              <small>{copied ? 'Đã copy' : 'Nhấn để copy username'}</small>
            </span>
          </button>

          {connection !== 'online' && connectionError && (
            <div className="warning">
              <strong>{connectionError}</strong>
              {wsEndpoint && <small>Endpoint đang thử: <code>{wsEndpoint}</code></small>}
            </div>
          )}

          <div className="search-box">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={connection === 'online' ? 'Dán chính xác username...' : 'Chờ WebSocket kết nối...'}
              maxLength={32}
              aria-label="Tìm user online"
              disabled={connection !== 'online'}
            />
          </div>

          {connection === 'online' && query.trim().length >= 2 && (
            <div className="search-panel">
              <div className="section-label">User tìm thấy</div>
              {searching && <div className="empty-small">Đang tìm...</div>}
              {!searching && searchResults.length === 0 && (
                <div className="empty-small">Username không tồn tại hoặc đang offline.</div>
              )}
              {searchResults.map((user) => (
                <div className="user-row" key={user.id}>
                  <div className="user-main">
                    <span className="mini-avatar">{user.username.slice(0, 1).toUpperCase()}</span>
                    <span>@{user.username}</span>
                  </div>
                  <button type="button" onClick={() => requestChat(user)}>Chat</button>
                </div>
              ))}
            </div>
          )}

          {connection !== 'online' && (
            <div className="connection-hint">
              <strong>WebSocket chưa online</strong>
              <span>Search user chỉ hoạt động sau khi trạng thái chuyển sang Online.</span>
            </div>
          )}

          <div className="section-label chats-label">Đang chat</div>
          <div className="chat-list">
            {chats.length === 0 && (
              <div className="empty-small">Tìm username để bắt đầu chat.</div>
            )}
            {chats.map((chat) => {
              const last = chat.messages.at(-1);
              return (
                <button
                  className={`chat-list-item ${activeChatId === chat.id ? 'active' : ''}`}
                  key={chat.id}
                  onClick={() => openChat(chat.id)}
                  type="button"
                >
                  <span className="mini-avatar">{chat.peer.username.slice(0, 1).toUpperCase()}</span>
                  <span className="chat-list-copy">
                    <strong>@{chat.peer.username}</strong>
                    <small>{chat.expiresAt ? `Còn ${countdownLabel(chat.expiresAt, now)}` : (last?.text || 'Đã kết nối')}</small>
                  </span>
                  {chat.unread > 0 && <span className="badge">{chat.unread}</span>}
                </button>
              );
            })}
          </div>

          <button className="end-session" type="button" onClick={endSession}>
            Xoá & kết thúc session
          </button>
        </aside>

        <section className="chat-area">
          {activeChat ? (
            <>
              <header className="chat-header">
                <button className="mobile-back" type="button" onClick={() => setActiveChatId(null)} aria-label="Quay lại danh sách chat">‹</button>
                <div>
                  <strong>@{activeChat.peer.username}</strong>
                  <div className="muted tiny">
                    {activeChat.peerOnline === false ? 'Đang reconnect...' : '● Online'}
                  </div>
                </div>
                <button className="ghost danger" type="button" onClick={closeChat}>Kết thúc chat</button>
              </header>

              <div className="chat-expiry" role="status">
                <span>Cuộc chat tự giải tán sau {CHAT_DURATION_MINUTES} phút</span>
                <strong>Còn {countdownLabel(activeChat.expiresAt, now)}</strong>
              </div>

              <div className="messages">
                {activeChat.messages.length === 0 && (
                  <div className="empty-chat">
                    <div className="empty-icon">↔</div>
                    <strong>Đã kết nối</strong>
                    <span>Tin nhắn chỉ được giữ trong session của trình duyệt và chat sẽ tự giải tán sau {CHAT_DURATION_MINUTES} phút.</span>
                  </div>
                )}
                {activeChat.messages.map((message) => {
                  const mine = message.from === session.sessionId;
                  return (
                    <div className={`message-row ${mine ? 'mine' : ''}`} key={message.id}>
                      <div className="bubble">
                        {message.kind === 'file' ? (
                          <div className="file-message">
                            <span className="file-icon" aria-hidden="true">📄</span>
                            <span className="file-copy">
                              <strong>{message.file.name}</strong>
                              <small>{fileSizeLabel(message.file.size)}</small>
                              {message.file.data ? (
                                <button
                                  className="file-download"
                                  type="button"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    downloadFile(message.file);
                                  }}
                                >
                                  Tải xuống
                                </button>
                              ) : (
                                <em>File không còn sau khi tải lại trang</em>
                              )}
                            </span>
                          </div>
                        ) : (
                          <div>{message.text}</div>
                        )}
                        <time>{timeLabel(message.timestamp)}</time>
                      </div>
                    </div>
                  );
                })}
                {Object.entries(fileProgress)
                  .filter(([, progress]) => progress.chatId === activeChat.id)
                  .map(([transferId, progress]) => (
                    <div
                      className={`message-row file-progress-row ${progress.direction === 'send' ? 'mine' : ''}`}
                      key={transferId}
                      role="status"
                      aria-live="polite"
                    >
                      <div className="bubble file-progress-card">
                        <div className="file-progress-heading">
                          <span>
                            {progress.direction === 'send' ? 'Đang gửi' : 'Đang nhận'} file {progress.position}/{progress.total}: {progress.name}
                          </span>
                          <strong>{progress.percent}%</strong>
                        </div>
                        <div
                          className="file-progress-track"
                          role="progressbar"
                          aria-label={`${progress.direction === 'send' ? 'Đang gửi' : 'Đang nhận'} ${progress.name}`}
                          aria-valuemin="0"
                          aria-valuemax="100"
                          aria-valuenow={progress.percent}
                        >
                          <span style={{ width: `${progress.percent}%` }} />
                        </div>
                      </div>
                    </div>
                  ))}
                <div ref={messagesEndRef} />
              </div>

              {fileBatch?.chatId === activeChat.id && (
                <div className="file-batch-status" role="status" aria-live="polite">
                  <span>
                    {fileBatch.current > 0
                      ? `Đang gửi file ${fileBatch.current}/${fileBatch.total}: ${fileBatch.name}`
                      : `Đang chuẩn bị ${fileBatch.total} file...`}
                  </span>
                  <strong>Tối đa {MAX_FILE_SENDS_PER_CHAT} file/chat</strong>
                </div>
              )}

              <div className="composer">
                <div className="composer-tools">
                  <button
                    className="tool-button"
                    type="button"
                    onClick={() => setEmojiOpen((current) => !current)}
                    aria-label="Chọn emoji"
                    aria-expanded={emojiOpen}
                  >
                    ☺
                  </button>
                  <button
                    className="tool-button"
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    aria-label={`Đính kèm file, còn ${(activeChat.maxFileSends ?? MAX_FILE_SENDS_PER_CHAT) - (activeChat.attachmentCount ?? 0)} lượt`}
                    title={`Đính kèm file · còn ${(activeChat.maxFileSends ?? MAX_FILE_SENDS_PER_CHAT) - (activeChat.attachmentCount ?? 0)} lượt`}
                    disabled={sendingFile || connection !== 'online' || activeChat.peerOnline === false || (activeChat.attachmentCount ?? 0) >= (activeChat.maxFileSends ?? MAX_FILE_SENDS_PER_CHAT)}
                  >
                    📎
                    <small className="tool-count">
                      {(activeChat.maxFileSends ?? MAX_FILE_SENDS_PER_CHAT) - (activeChat.attachmentCount ?? 0)}
                    </small>
                  </button>
                  <input
                    ref={fileInputRef}
                    className="file-input"
                    type="file"
                    multiple
                    onChange={(event) => {
                      const files = Array.from(event.target.files || []);
                      event.target.value = '';
                      if (files.length) sendFiles(files);
                    }}
                  />
                  {emojiOpen && (
                    <div className="emoji-picker" role="group" aria-label="Emoji">
                      {SIMPLE_EMOJIS.map((emoji) => (
                        <button type="button" key={emoji} onClick={() => addEmoji(emoji)} aria-label={`Thêm ${emoji}`}>
                          {emoji}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={(event) => {
                    draftRef.current = event.target.value;
                    setDraft(event.target.value);
                  }}
                  onCompositionStart={() => {
                    composingRef.current = true;
                  }}
                  onCompositionEnd={(event) => {
                    composingRef.current = false;
                    compositionEndedAtRef.current = performance.now();
                    // Keep the ref aligned with the text committed by the IME.
                    draftRef.current = event.currentTarget.value;
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || event.shiftKey) return;

                    // Vietnamese/Japanese/Chinese IMEs use Enter to commit the
                    // current composition. Safari may report isComposing=false
                    // too early, while keyCode 229 still indicates IME input.
                    const nativeEvent = event.nativeEvent;
                    const justFinishedComposition = performance.now() - compositionEndedAtRef.current < 80;
                    if (
                      composingRef.current ||
                      nativeEvent?.isComposing ||
                      nativeEvent?.keyCode === 229 ||
                      justFinishedComposition
                    ) {
                      return;
                    }

                    event.preventDefault();
                    sendMessage();
                  }}
                  placeholder={sendingFile ? 'Đang gửi file...' : activeChat.peerOnline === false ? 'Đợi peer reconnect...' : 'Nhập tin nhắn...'}
                  maxLength={MAX_MESSAGE_LENGTH}
                  rows={1}
                  disabled={activeChat.peerOnline === false}
                />
                <button type="button" onClick={sendMessage} disabled={!draft.trim() || connection !== 'online' || activeChat.peerOnline === false}>
                  Gửi
                </button>
              </div>
            </>
          ) : (
            <div className="welcome">
              <div className="welcome-icon">⌁</div>
              <h1>Chat tạm thời</h1>
              <p>Tìm username của user đang online, gửi yêu cầu kết nối và chat realtime ngay trong session.</p>
              <div className="privacy-card">
                <strong>Session-only</strong>
                <span>User được tạo tự động theo dạng user_&lt;milliseconds&gt;. Mỗi cuộc chat tồn tại tối đa {CHAT_DURATION_MINUTES} phút hoặc bị xoá sớm hơn khi một peer hết session.</span>
              </div>
            </div>
          )}
        </section>
      </section>

      {incomingRequests.length > 0 && (
        <div className="request-stack">
          {incomingRequests.map((request) => (
            <div className="request-card" key={request.requestId}>
              <div>
                <strong>@{request.from.username}</strong>
                <p>muốn chat với bạn</p>
              </div>
              <div className="request-actions">
                <button type="button" className="ghost" onClick={() => answerRequest(request.requestId, false)}>
                  Từ chối
                </button>
                <button type="button" onClick={() => answerRequest(request.requestId, true)}>
                  Đồng ý
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {notice && (
        <button className="toast" type="button" onClick={() => setNotice('')}>
          {notice}
        </button>
      )}
    </main>
  );
}
