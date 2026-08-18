const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 50 * 1024 * 1024 // 50MB socket limit if needed
});

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const PINNED_ROOMS_FILE = path.join(DATA_DIR, 'pinned-rooms.json');

[UPLOAD_DIR, DATA_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// #7 CORS: 仅允许来自环境变量配置的来源，默认本地
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000'
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Storage configuration for Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});

// #4 文件类型白名单：只允许安全的 MIME 类型前缀
const ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'text/', 'application/'];
const BLOCKED_MIME_EXACT = ['application/x-msdownload', 'application/x-executable',
  'application/x-sh', 'application/x-php'];

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max file size
  fileFilter: (req, file, cb) => {
    const mime = file.mimetype || '';
    const allowed = ALLOWED_MIME_PREFIXES.some(p => mime.startsWith(p))
      && !BLOCKED_MIME_EXACT.includes(mime);
    if (allowed) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${mime}`), false);
    }
  }
});

// #5 房间数量上限（防止内存 DoS）
const MAX_ROOMS = 1000;

// 临时房间 ID 格式：小写字母+数字，4~12 位
const ROOM_ID_REGEX = /^[a-z2-9]{4,12}$/;
// 固定房间 ID 格式：字母/数字/连字符，4~20 位（允许更人性化的名称）
const PINNED_ROOM_ID_REGEX = /^[a-z0-9][a-z0-9-]{2,18}[a-z0-9]$/;
// 文件/下载 ID 格式：字母数字与连字符
const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

// 判断 roomId 是否合法（临时或固定均可）
function isValidRoomId(id) {
  return ROOM_ID_REGEX.test(id) || PINNED_ROOM_ID_REGEX.test(id);
}

// In-Memory Data Store for All Rooms
// roomId -> { text, files, lastActive, isPinned, createdAt }
const rooms = new Map();

// ─────────────────────────────────────────────
// 固定房间持久化：从磁盘加载 / 写入磁盘
// ─────────────────────────────────────────────
function loadPinnedRooms() {
  if (!fs.existsSync(PINNED_ROOMS_FILE)) return;
  try {
    const raw = fs.readFileSync(PINNED_ROOMS_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [roomId, room] of Object.entries(data)) {
      rooms.set(roomId, {
        text: room.text || '',
        files: room.files || [],
        lastActive: Date.now(),
        isPinned: true,
        createdAt: room.createdAt || Date.now()
      });
    }
    console.log(`[Pinned] Loaded ${Object.keys(data).length} pinned room(s) from disk.`);
  } catch (err) {
    console.error('[Pinned] Failed to load pinned rooms:', err);
  }
}

let saveTimer = null;

function savePinnedRooms() {
  const data = {};
  for (const [roomId, room] of rooms.entries()) {
    if (room.isPinned) {
      data[roomId] = {
        text: room.text,
        files: room.files,
        createdAt: room.createdAt
      };
    }
  }
  try {
    // 原子化写入：先写临时文件再重命名，防止写入中途崩溃损坏文件
    const tempFile = PINNED_ROOMS_FILE + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempFile, PINNED_ROOMS_FILE);
  } catch (err) {
    console.error('[Pinned] Failed to save pinned rooms:', err);
  }
}

// 防抖落盘，避免高频文本变更导致频繁磁盘 I/O
function savePinnedRoomsDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    savePinnedRooms();
  }, 1000);
}

// 启动时立即从磁盘恢复固定房间
loadPinnedRooms();

function getOrCreateRoom(roomId, options = {}) {
  if (!rooms.has(roomId)) {
    // #5 强制房间数量上限（固定房间豁免限制）
    if (!options.isPinned && rooms.size >= MAX_ROOMS) {
      throw new Error('Server room capacity reached, please try later.');
    }
    rooms.set(roomId, {
      text: '',
      files: [],
      lastActive: Date.now(),
      isPinned: options.isPinned || false,
      createdAt: Date.now()
    });
    if (options.isPinned) savePinnedRooms();
  }
  return rooms.get(roomId);
}

// Clean up helper for files and room
function destroyRoomData(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const wasPinned = room.isPinned;

  // Delete physical files
  room.files.forEach(file => {
    const filePath = path.join(UPLOAD_DIR, file.filename);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error(`Failed to delete file ${filePath}:`, err);
      }
    }
  });

  rooms.delete(roomId);
  // 如果销毁的是固定房间，必须同步擦除磁盘记录
  if (wasPinned) {
    savePinnedRooms();
  }
  console.log(`Room [${roomId}] and all associated files destroyed.`);
}

// Upload Endpoint - multer 错误处理中间件
app.post('/api/upload', (req, res, next) => {
  upload.array('files', 10)(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload error' });
    }
    next();
  });
}, (req, res) => {
  const roomId = req.body?.roomId;
  // #3 上传接口：临时或固定房间 ID 均可
  if (!roomId || !isValidRoomId(roomId)) {
    return res.status(400).json({ error: 'Invalid or missing room ID format.' });
  }

  let room;
  try {
    room = getOrCreateRoom(roomId);
  } catch (e) {
    return res.status(503).json({ error: e.message });
  }
  room.lastActive = Date.now();

  const newFiles = (req.files || []).map(file => ({
    id: path.basename(file.filename, path.extname(file.filename)),
    filename: file.filename,
    originalName: Buffer.from(file.originalname, 'latin1').toString('utf8'),
    size: file.size,
    mimetype: file.mimetype,
    uploadTime: Date.now()
  }));

  room.files.push(...newFiles);

  // 固定房间：文件上传后立即持久化
  if (room.isPinned) savePinnedRooms();

  // Broadcast to room members via Socket.IO
  io.to(roomId).emit('files-updated', room.files);

  res.json({ success: true, files: newFiles });
});

// ─────────────────────────────────────────────
// 固定房间 REST 接口
// ─────────────────────────────────────────────

// GET /api/pinned-rooms：获取所有固定房间列表
app.get('/api/pinned-rooms', (req, res) => {
  const list = [];
  for (const [roomId, room] of rooms.entries()) {
    if (room.isPinned) {
      list.push({
        id: roomId,
        createdAt: room.createdAt,
        fileCount: room.files.length,
        textLength: room.text.length
      });
    }
  }
  res.json(list);
});

// POST /api/pinned-rooms：创建固定房间
app.post('/api/pinned-rooms', (req, res) => {
  // express 5 中 req.body 未解析时为 undefined，需防御性兜底
  const { roomId } = req.body || {};
  if (!roomId || !PINNED_ROOM_ID_REGEX.test(roomId)) {
    return res.status(400).json({
      error: '固定房间 ID 格式错误，需为 4~20 位小写字母/数字/连字符，且不可以连字符开头或结尾。'
    });
  }
  if (rooms.has(roomId) && rooms.get(roomId).isPinned) {
    return res.status(409).json({ error: '该固定房间 ID 已存在。' });
  }
  try {
    getOrCreateRoom(roomId, { isPinned: true });
  } catch (e) {
    return res.status(503).json({ error: e.message });
  }
  res.json({ success: true, roomId });
});

// Download Endpoint
app.get('/api/download/:roomId/:fileId', (req, res) => {
  const { roomId, fileId } = req.params;

  // #1 路径遍历防御：临时或固定房间 ID 均校验
  if (!isValidRoomId(roomId) || !SAFE_ID_REGEX.test(fileId)) {
    return res.status(400).send('Invalid parameters.');
  }

  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).send('Room not found or expired.');
  }

  const fileItem = room.files.find(f => f.id === fileId);
  if (!fileItem) {
    return res.status(404).send('File not found.');
  }

  // 防止文件名被篡改后逃逸出 UPLOAD_DIR
  const filePath = path.resolve(UPLOAD_DIR, fileItem.filename);
  if (!filePath.startsWith(path.resolve(UPLOAD_DIR))) {
    return res.status(400).send('Invalid file path.');
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File expired or deleted on disk.');
  }

  res.download(filePath, fileItem.originalName);
});

// Socket.IO Real-time Synchronization
io.on('connection', (socket) => {
  let currentRoomId = null;
  let userId = 'User_' + Math.random().toString(36).substring(2, 6);

  socket.on('join-room', (roomId) => {
    if (typeof roomId !== 'string') return;
    const cleanRoomId = roomId.toLowerCase().trim();
    if (!isValidRoomId(cleanRoomId)) return;

    if (currentRoomId && currentRoomId !== cleanRoomId) {
      socket.leave(currentRoomId);
    }
    currentRoomId = cleanRoomId;
    socket.join(cleanRoomId);

    let room;
    try {
      room = getOrCreateRoom(cleanRoomId);
    } catch (e) {
      return;
    }
    room.lastActive = Date.now();

    // Send initial room state to newly joined client
    socket.emit('init-room-state', {
      text: room.text,
      files: room.files,
      userId,
      isPinned: room.isPinned || false
    });

    // Notify room of updated client count
    const roomSize = io.sockets.adapter.rooms.get(cleanRoomId)?.size || 1;
    io.to(cleanRoomId).emit('room-users-update', { count: roomSize });
  });

  // Text Live Sync
  // #2 输入类型与大小双重守卫（500K 字符上限 ≈ 0.5MB）
  const MAX_TEXT_LENGTH = 500_000;
  socket.on('text-change', (data) => {
    if (!currentRoomId) return;
    if (typeof data?.text !== 'string') return;
    if (data.text.length > MAX_TEXT_LENGTH) return;
    const room = rooms.get(currentRoomId);
    if (room) {
      room.text = data.text;
      room.lastActive = Date.now();
      socket.to(currentRoomId).emit('text-sync', {
        text: data.text,
        updatedBy: userId
      });
      // 固定房间：文本变更后防抖落盘
      if (room.isPinned) savePinnedRoomsDebounced();
    }
  });

  // Typing Notification
  socket.on('typing-status', (isTyping) => {
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('user-typing', {
      userId,
      isTyping
    });
  });

  // Clear Text Action
  socket.on('clear-text', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (room) {
      room.text = '';
      io.to(currentRoomId).emit('text-sync', { text: '', updatedBy: userId });
      if (room.isPinned) savePinnedRooms();
    }
  });

  // Delete Individual File
  // #8 fileId 格式校验
  socket.on('delete-file', (fileId) => {
    if (!currentRoomId) return;
    if (typeof fileId !== 'string' || !SAFE_ID_REGEX.test(fileId)) return;
    const room = rooms.get(currentRoomId);
    if (room) {
      const index = room.files.findIndex(f => f.id === fileId);
      if (index !== -1) {
        const [deletedFile] = room.files.splice(index, 1);
        const filePath = path.resolve(UPLOAD_DIR, deletedFile.filename);
        // 二次确认路径在 UPLOAD_DIR 内，防止路径逃逸
        if (filePath.startsWith(path.resolve(UPLOAD_DIR)) && fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch (e) { console.error('Failed to delete file:', e); }
        }
        io.to(currentRoomId).emit('files-updated', room.files);
        if (room.isPinned) savePinnedRooms();
      }
    }
  });

  // Pin / Unpin 房间
  socket.on('pin-room', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.isPinned) return;
    // 临时房间升级为固定房间：必须满足固定 ID 格式
    if (!PINNED_ROOM_ID_REGEX.test(currentRoomId) && !ROOM_ID_REGEX.test(currentRoomId)) return;
    room.isPinned = true;
    room.createdAt = room.createdAt || Date.now();
    savePinnedRooms();
    io.to(currentRoomId).emit('room-pinned', { roomId: currentRoomId });
    console.log(`[Pinned] Room [${currentRoomId}] pinned.`);
  });

  socket.on('unpin-room', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.isPinned) return;
    room.isPinned = false;
    savePinnedRooms(); // 从 JSON 中移除该房间
    io.to(currentRoomId).emit('room-unpinned', { roomId: currentRoomId });
    console.log(`[Pinned] Room [${currentRoomId}] unpinned.`);
  });

  // Destroy Whole Room
  socket.on('destroy-room', () => {
    if (!currentRoomId) return;
    destroyRoomData(currentRoomId);
    io.to(currentRoomId).emit('room-destroyed');
  });

  // Handle Disconnect
  // #6 断开连接时不刷新 lastActive，让过期清理任务能正常回收空闲房间
  socket.on('disconnect', () => {
    if (currentRoomId) {
      const adapterRoom = io.sockets.adapter.rooms.get(currentRoomId);
      const remainingCount = adapterRoom ? adapterRoom.size : 0;
      io.to(currentRoomId).emit('room-users-update', { count: remainingCount });
      // lastActive 不在此处更新，由活跃操作（文本变更、文件上传等）维护
    }
  });
});

// Periodic Cleanup Task: Automatically remove inactive rooms older than 24 hours
// 固定房间（isPinned）豁免过期清理
setInterval(() => {
  const NOW = Date.now();
  const EXPIRY_TIME = 24 * 60 * 60 * 1000;
  for (const [roomId, room] of rooms.entries()) {
    if (room.isPinned) continue; // ← 固定房间跳过
    if (NOW - room.lastActive > EXPIRY_TIME) {
      destroyRoomData(roomId);
    }
  }
}, 30 * 60 * 1000);

// ─────────────────────────────────────────────
// 孤儿文件清理任务
// 服务重启后内存 rooms 被清空，但磁盘 uploads/ 中可能残留上一次
// 运行期间上传但未被正常删除的文件，本任务负责将其回收。
// ─────────────────────────────────────────────
function cleanOrphanFiles() {
  let deleted = 0;
  let skipped = 0;

  // 收集所有"在用"文件名（含临时房间与固定房间）
  const knownFilenames = new Set();
  for (const room of rooms.values()) {
    for (const f of room.files) {
      knownFilenames.add(f.filename);
    }
  }

  // 扫描 uploads/ 目录
  let entries;
  try {
    entries = fs.readdirSync(UPLOAD_DIR);
  } catch (err) {
    console.error('[OrphanClean] Failed to read upload directory:', err);
    return;
  }

  const ORPHAN_THRESHOLD = 24 * 60 * 60 * 1000; // 文件存在超过 24 小时才算孤儿
  const now = Date.now();

  for (const filename of entries) {
    if (knownFilenames.has(filename)) {
      // 仍被某个活跃房间引用，跳过
      skipped++;
      continue;
    }

    const filePath = path.join(UPLOAD_DIR, filename);

    // 安全边界检查：确保路径仍在 UPLOAD_DIR 内
    if (!path.resolve(filePath).startsWith(path.resolve(UPLOAD_DIR))) {
      continue;
    }

    try {
      const stat = fs.statSync(filePath);
      // 只删除超过阈值时间的孤儿文件，保护刚上传但还未被房间索引到的文件
      if (now - stat.mtimeMs > ORPHAN_THRESHOLD) {
        fs.unlinkSync(filePath);
        deleted++;
        console.log(`[OrphanClean] Deleted orphan file: ${filename}`);
      }
    } catch (err) {
      console.error(`[OrphanClean] Failed to process ${filename}:`, err);
    }
  }

  if (deleted > 0 || skipped > 0) {
    console.log(`[OrphanClean] Done — deleted: ${deleted}, active (skipped): ${skipped}`);
  }
}

// 启动时立即扫描一次（清理上次运行残留的孤儿文件）
cleanOrphanFiles();

// 之后每 6 小时定期扫描
setInterval(cleanOrphanFiles, 6 * 60 * 60 * 1000);

server.listen(PORT, () => {
  const os = require('os');
  const ifaces = os.networkInterfaces();
  let lanIp = 'unknown';
  for (const iface of Object.values(ifaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        lanIp = alias.address;
        break;
      }
    }
    if (lanIp !== 'unknown') break;
  }
  console.log(`✅ SyncFlow Server started`);
  console.log(`   本机访问：http://localhost:${PORT}`);
  console.log(`   局域网访问：http://${lanIp}:${PORT}`);
});

