/* ==========================================================================
   SyncFlow Frontend Logic & Real-time WebSockets Integration
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  
  // --- 1. Room ID Initialization ---
  function getOrGenRoomId() {
    const hash = window.location.hash.replace('#', '');
    const params = new URLSearchParams(hash);
    let roomId = params.get('room');
    
    if (!roomId) {
      // Generate a clean 5-character random room code
      const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
      roomId = '';
      for (let i = 0; i < 5; i++) {
        roomId += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      window.location.hash = `room=${roomId}`;
    }
    return roomId;
  }

  const roomId = getOrGenRoomId();
  document.getElementById('display-room-id').textContent = roomId.toUpperCase();

  // 监听地址栏 Hash 变更，手动切换房间时自动重载
  window.addEventListener('hashchange', () => {
    window.location.reload();
  });

  // --- 2. Socket.IO Connection Setup ---
  const socket = io();
  let currentUserId = null;
  let isLocalTyping = false;
  let typingTimeout = null;

  socket.emit('join-room', roomId);

  // UI Elements
  const textarea = document.getElementById('sync-textarea');
  const typingIndicator = document.getElementById('typing-indicator');
  const typingUserText = document.getElementById('typing-user-text');
  const charCount = document.getElementById('char-count');
  const lineCount = document.getElementById('line-count');
  const userCountText = document.getElementById('user-count-text');
  const textBadge = document.getElementById('text-badge');
  const filesCountBadge = document.getElementById('files-count-badge');
  const totalSizeText = document.getElementById('total-size-text');
  const filesGrid = document.getElementById('files-grid');
  const emptyFilesState = document.getElementById('empty-files-state');

  // --- 3. Socket Event Handlers ---

  // Initial Room State — handled in Section 10 (includes isPinned)

  // Room Users Count
  socket.on('room-users-update', (data) => {
    userCountText.textContent = `在线设备: ${data.count}`;
  });

  // Live Text Sync from Other Clients
  socket.on('text-sync', (data) => {
    textarea.value = data.text;
    updateTextStats();
    
    // Highlight tab if on files tab
    const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
    if (activeTab !== 'tab-text') {
      textBadge.style.display = 'inline-block';
    }
  });

  // Typing Status
  socket.on('user-typing', (data) => {
    if (data.isTyping) {
      typingUserText.textContent = `${data.userId} 正在输入...`;
      typingIndicator.classList.add('show');
    } else {
      typingIndicator.classList.remove('show');
    }
  });

  // Files List Update
  socket.on('files-updated', (files) => {
    renderFilesList(files);
  });

  // Room Destroyed Notification
  socket.on('room-destroyed', () => {
    showToast('房间已清空并彻底销毁！即将重定向...', 'warning');
    setTimeout(() => {
      window.location.hash = '';
      window.location.reload();
    }, 1500);
  });

  // --- 4. Textarea Live Sync & Stats ---
  function updateTextStats() {
    const val = textarea.value;
    charCount.textContent = `${val.length} 字符`;
    const lines = val ? val.split('\n').length : 0;
    lineCount.textContent = `${lines} 行`;
  }

  let textDebounceTimer = null;
  textarea.addEventListener('input', () => {
    updateTextStats();

    // Broadcast Typing Status
    if (!isLocalTyping) {
      isLocalTyping = true;
      socket.emit('typing-status', true);
    }

    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      isLocalTyping = false;
      socket.emit('typing-status', false);
    }, 1200);

    // Debounce Text Sync Broadcast
    clearTimeout(textDebounceTimer);
    textDebounceTimer = setTimeout(() => {
      socket.emit('text-change', { text: textarea.value });
    }, 200);
  });

  // Action: Copy Text
  document.getElementById('btn-copy-text').addEventListener('click', () => {
    if (!textarea.value) {
      showToast('暂无文本可复制', 'info');
      return;
    }
    navigator.clipboard.writeText(textarea.value).then(() => {
      showToast('已复制全文到剪贴板！', 'success');
    }).catch(() => {
      showToast('复制失败，请手动选择复制', 'error');
    });
  });

  // Action: Paste Text from Clipboard
  document.getElementById('btn-paste-text').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        textarea.value = text;
        updateTextStats();
        socket.emit('text-change', { text: textarea.value });
        showToast('从剪贴板粘贴成功！', 'success');
      }
    } catch (err) {
      showToast('无法读取剪贴板，请允许浏览器剪贴板权限或直接使用 Ctrl+V / Cmd+V 粘贴', 'info');
    }
  });

  // Action: Clear Text
  document.getElementById('btn-clear-text').addEventListener('click', () => {
    if (!textarea.value) return;
    if (confirm('确定要清空文本框内容吗？')) {
      textarea.value = '';
      updateTextStats();
      socket.emit('clear-text');
      showToast('已清空文本', 'info');
    }
  });

  // --- 5. Tab Switching Logic ---
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;

      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      document.getElementById(targetTab).classList.add('active');

      if (targetTab === 'tab-text') {
        textBadge.style.display = 'none';
      }
    });
  });

  // --- 6. File Upload & Drag-and-Drop ---
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const progressContainer = document.getElementById('upload-progress-container');
  const progressFill = document.getElementById('progress-fill');
  const progressPercent = document.getElementById('progress-percent');
  const progressFilename = document.getElementById('progress-filename');

  dropzone.addEventListener('click', () => fileInput.click());

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    }, false);
  });

  dropzone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length) uploadFiles(files);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) {
      uploadFiles(fileInput.files);
      fileInput.value = '';
    }
  });

  function uploadFiles(files) {
    const formData = new FormData();
    formData.append('roomId', roomId);

    // #11: 移除未使用的 totalUploadSize 变量
    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }

    progressContainer.style.display = 'block';
    progressFilename.textContent = files.length === 1 ? files[0].name : `正在上传 ${files.length} 个文件...`;
    progressFill.style.width = '0%';
    progressPercent.textContent = '0%';

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload', true);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        progressFill.style.width = percent + '%';
        progressPercent.textContent = percent + '%';
      }
    };

    xhr.onload = () => {
      progressContainer.style.display = 'none';
      if (xhr.status === 200) {
        showToast('文件上传成功！', 'success');
      } else {
        showToast('文件上传失败，请重试', 'error');
      }
    };

    xhr.onerror = () => {
      progressContainer.style.display = 'none';
      showToast('网络错误，文件上传中断', 'error');
    };

    xhr.send(formData);
  }

  // --- 7. Render Files List Grid ---
  function renderFilesList(files) {
    filesCountBadge.textContent = files.length;
    
    // Calculate total size
    const totalBytes = files.reduce((acc, f) => acc + (f.size || 0), 0);
    totalSizeText.textContent = `总计 ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`;

    if (files.length === 0) {
      filesGrid.innerHTML = '';
      filesGrid.appendChild(emptyFilesState);
      emptyFilesState.style.display = 'block';
      return;
    }

    emptyFilesState.style.display = 'none';
    filesGrid.innerHTML = '';

    files.forEach(file => {
      const card = document.createElement('div');
      card.className = 'file-card';

      const iconClass = getFileIcon(file.mimetype, file.originalName);
      const formattedSize = formatBytes(file.size);

      card.innerHTML = `
        <div class="file-icon">
          <i class="${iconClass}"></i>
        </div>
        <div class="file-details">
          <div class="file-name" title="${escapeHtml(file.originalName)}">${escapeHtml(file.originalName)}</div>
          <div class="file-size">${formattedSize}</div>
        </div>
        <div class="file-actions">
          <a href="/api/download/${roomId}/${file.id}" class="btn-icon" title="下载文件" download>
            <i class="ri-download-2-line"></i>
          </a>
          <button class="btn-icon danger btn-delete-file" data-id="${file.id}" title="删除文件">
            <i class="ri-delete-bin-line"></i>
          </button>
        </div>
      `;

      filesGrid.appendChild(card);
    });

    // Add click event for delete buttons
    document.querySelectorAll('.btn-delete-file').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const fileId = e.currentTarget.dataset.id;
        socket.emit('delete-file', fileId);
      });
    });
  }

  function getFileIcon(mimetype, filename) {
    // #9: 正确处理无扩展名文件（如 Makefile、Dockerfile）
    const parts = filename.split('.');
    const ext = parts.length > 1 ? parts.pop().toLowerCase() : '';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext) || mimetype?.startsWith('image/')) {
      return 'ri-image-line';
    }
    if (['mp4', 'webm', 'mkv', 'mov'].includes(ext) || mimetype?.startsWith('video/')) {
      return 'ri-video-line';
    }
    if (['mp3', 'wav', 'ogg', 'flac'].includes(ext) || mimetype?.startsWith('audio/')) {
      return 'ri-music-2-line';
    }
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
      return 'ri-file-zip-line';
    }
    if (['pdf'].includes(ext)) {
      return 'ri-file-pdf-line';
    }
    if (['txt', 'md', 'json', 'js', 'html', 'css', 'py', 'java', 'cpp'].includes(ext)) {
      return 'ri-file-code-line';
    }
    return 'ri-file-3-line';
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // --- 8. Share & QR Modal ---
  const shareModal = document.getElementById('share-modal');
  const shareUrlInput = document.getElementById('share-url-input');
  const qrcodeBox = document.getElementById('qrcode-box');

  function openShareModal() {
    const shareUrl = window.location.href;
    shareUrlInput.value = shareUrl;
    qrcodeBox.innerHTML = '';

    if (typeof QRCode !== 'undefined') {
      // #12: 正确签名为 QRCode.toCanvas(canvasEl, text, options, callback)
      const canvas = document.createElement('canvas');
      QRCode.toCanvas(canvas, shareUrl, { width: 180, margin: 2, color: { dark: '#0b0f19', light: '#ffffff' } }, (err) => {
        if (!err) qrcodeBox.appendChild(canvas);
      });
    } else {
      qrcodeBox.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(shareUrl)}" alt="QR">`;
    }

    shareModal.style.display = 'flex';
  }

  document.getElementById('btn-share-modal').addEventListener('click', openShareModal);
  document.getElementById('btn-close-modal').addEventListener('click', () => {
    shareModal.style.display = 'none';
  });
  
  shareModal.addEventListener('click', (e) => {
    if (e.target === shareModal) shareModal.style.display = 'none';
  });

  document.getElementById('btn-copy-room').addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href);
    showToast('已复制房间链接，发送给对方即可同频同步！', 'success');
  });

  document.getElementById('btn-modal-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href);
    showToast('已复制房间链接！', 'success');
  });

  // Action: Destroy Room
  document.getElementById('btn-destroy-room').addEventListener('click', () => {
    if (confirm('警告：此操作将彻底抹除当前房间内的文本及所有暂存文件，确定销毁吗？')) {
      socket.emit('destroy-room');
    }
  });

  // --- 9. Toast Notification Helper ---
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';

    let icon = 'ri-information-line';
    if (type === 'success') icon = 'ri-checkbox-circle-line';
    if (type === 'error') icon = 'ri-error-warning-line';
    if (type === 'warning') icon = 'ri-alert-line';

    toast.innerHTML = `<i class="${icon}"></i> <span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(20px)';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // --- 10. Pinned Room Logic ---
  const roomPill = document.getElementById('room-pill');
  const pinnedBadge = document.getElementById('pinned-room-badge');
  const btnPinToggle = document.getElementById('btn-pin-toggle');
  const pinToggleIcon = document.getElementById('pin-toggle-icon');
  const pinnedDropdown = document.getElementById('pinned-dropdown');
  const pinnedArrow = document.getElementById('pinned-arrow');
  const pinnedRoomsList = document.getElementById('pinned-rooms-list');
  const createPinnedModal = document.getElementById('create-pinned-modal');
  const pinnedRoomIdInput = document.getElementById('pinned-room-id-input');
  const pinnedHintText = document.getElementById('pinned-hint-text');

  let isCurrentRoomPinned = false;

  // Room pinned/unpinned state update helper
  function setRoomPinnedState(pinned) {
    isCurrentRoomPinned = pinned;
    if (pinned) {
      pinnedBadge.style.display = 'inline-flex';
      roomPill.classList.add('is-pinned');
      btnPinToggle.classList.add('pin-active');
      btnPinToggle.title = '取消固定此房间';
      pinToggleIcon.className = 'ri-pushpin-2-fill';
    } else {
      pinnedBadge.style.display = 'none';
      roomPill.classList.remove('is-pinned');
      btnPinToggle.classList.remove('pin-active');
      btnPinToggle.title = '固定此房间（重启后保留）';
      pinToggleIcon.className = 'ri-pushpin-line';
    }
  }

  // Extend init-room-state to include isPinned
  socket.on('init-room-state', (state) => {
    currentUserId = state.userId;
    textarea.value = state.text || '';
    updateTextStats();
    renderFilesList(state.files || []);
    setRoomPinnedState(state.isPinned || false);
  });

  // Override original init-room-state — merge via join-room extra info
  // Server sends isPinned in join-room response, handled above

  // Socket: room pinned by this or another session
  socket.on('room-pinned', () => {
    setRoomPinnedState(true);
    showToast('📌 房间已固定，数据将长期保留并在重启后恢复！', 'success');
    loadPinnedRoomsList();
  });

  socket.on('room-unpinned', () => {
    setRoomPinnedState(false);
    showToast('已取消固定，房间将恢复为临时模式（24h 自动过期）', 'info');
    loadPinnedRoomsList();
  });

  // Pin / Unpin toggle button
  btnPinToggle.addEventListener('click', () => {
    if (isCurrentRoomPinned) {
      if (confirm('取消固定后，此房间将在 24 小时无活动后自动销毁，确定吗？')) {
        socket.emit('unpin-room');
      }
    } else {
      socket.emit('pin-room');
    }
  });

  // ── Pinned Rooms Dropdown ──
  document.getElementById('btn-pinned-nav').addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = pinnedDropdown.classList.toggle('show');
    pinnedArrow.classList.toggle('open', isOpen);
    if (isOpen) loadPinnedRoomsList();
  });

  document.addEventListener('click', () => {
    pinnedDropdown.classList.remove('show');
    pinnedArrow.classList.remove('open');
  });

  pinnedDropdown.addEventListener('click', e => e.stopPropagation());

  async function loadPinnedRoomsList() {
    try {
      const res = await fetch('/api/pinned-rooms');
      const list = await res.json();
      pinnedRoomsList.innerHTML = '';
      if (list.length === 0) {
        pinnedRoomsList.innerHTML = '<li class="pinned-empty">暂无固定房间</li>';
        return;
      }
      list.forEach(room => {
        const li = document.createElement('li');
        li.className = 'pinned-room-item';
        li.innerHTML = `
          <i class="ri-pushpin-2-fill item-icon"></i>
          <span class="item-id">${escapeHtml(room.id)}</span>
          <span class="item-meta">${room.fileCount} 文件</span>
        `;
        li.addEventListener('click', () => {
          window.location.hash = `room=${room.id}`;
          window.location.reload();
        });
        pinnedRoomsList.appendChild(li);
      });
    } catch (err) {
      pinnedRoomsList.innerHTML = '<li class="pinned-empty">加载失败</li>';
    }
  }

  // Pre-load pinned rooms list
  loadPinnedRoomsList();

  // ── Create Pinned Room Modal ──
  const PINNED_ID_REGEX = /^[a-z0-9][a-z0-9-]{2,18}[a-z0-9]$/;

  document.getElementById('btn-open-create-pinned').addEventListener('click', () => {
    pinnedDropdown.classList.remove('show');
    pinnedArrow.classList.remove('open');
    pinnedRoomIdInput.value = '';
    pinnedHintText.textContent = '4~20 位小写字母、数字或连字符，不可以连字符开头/结尾';
    pinnedHintText.className = 'pinned-hint';
    createPinnedModal.style.display = 'flex';
    setTimeout(() => pinnedRoomIdInput.focus(), 50);
  });

  document.getElementById('btn-close-pinned-modal').addEventListener('click', () => {
    createPinnedModal.style.display = 'none';
  });

  createPinnedModal.addEventListener('click', e => {
    if (e.target === createPinnedModal) createPinnedModal.style.display = 'none';
  });

  // Live validation while typing
  pinnedRoomIdInput.addEventListener('input', () => {
    const val = pinnedRoomIdInput.value.toLowerCase().trim();
    pinnedRoomIdInput.value = val;
    if (!val) {
      pinnedHintText.textContent = '4~20 位小写字母、数字或连字符，不可以连字符开头/结尾';
      pinnedHintText.className = 'pinned-hint';
    } else if (!PINNED_ID_REGEX.test(val)) {
      pinnedHintText.textContent = '❌ 格式不合法，请检查';
      pinnedHintText.className = 'pinned-hint error';
    } else {
      pinnedHintText.textContent = '✅ 格式正确';
      pinnedHintText.className = 'pinned-hint ok';
    }
  });

  // Submit create pinned room
  document.getElementById('btn-confirm-create-pinned').addEventListener('click', async () => {
    const val = pinnedRoomIdInput.value.toLowerCase().trim();
    if (!PINNED_ID_REGEX.test(val)) {
      pinnedHintText.textContent = '❌ 格式不合法，请检查';
      pinnedHintText.className = 'pinned-hint error';
      return;
    }

    try {
      const res = await fetch('/api/pinned-rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: val })
      });
      const data = await res.json();
      if (!res.ok) {
        pinnedHintText.textContent = `❌ ${data.error}`;
        pinnedHintText.className = 'pinned-hint error';
        return;
      }
      createPinnedModal.style.display = 'none';
      showToast(`固定房间 /r/${val} 创建成功！`, 'success');
      // Navigate to new pinned room
      window.location.hash = `room=${val}`;
      window.location.reload();
    } catch (err) {
      pinnedHintText.textContent = '❌ 网络错误，请重试';
      pinnedHintText.className = 'pinned-hint error';
    }
  });

  // Enter key shortcut in input
  pinnedRoomIdInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      document.getElementById('btn-confirm-create-pinned').click();
    }
  });

});
