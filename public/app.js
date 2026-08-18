/* ==========================================================================
   SyncFlow Frontend Logic & Real-time WebSockets Integration
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {

  // --- 1. Robust Room ID Initialization & Parsing ---
  function getOrGenRoomId() {
    const rawHash = window.location.hash.replace('#', '').trim();
    let roomId = '';

    if (rawHash) {
      const params = new URLSearchParams(rawHash);
      if (params.has('room')) {
        roomId = params.get('room');
      } else {
        // 如果直接是 #testroom 格式
        roomId = rawHash.split('?')[0];
      }
    }

    // 格式净化与兜底
    roomId = roomId.toLowerCase().replace(/[^a-z0-9-]/g, '').trim();

    if (!roomId) {
      // 生成 5 位随机房间号
      const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
      for (let i = 0; i < 5; i++) {
        roomId += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      window.location.hash = `room=${roomId}`;
    } else if (!window.location.hash.includes('room=')) {
      window.location.hash = `room=${roomId}`;
    }

    return roomId;
  }

  const roomId = getOrGenRoomId();

  // --- 2. DOM Elements Selection (MUST BE AT THE TOP) ---
  const displayRoomIdEl = document.getElementById('display-room-id');
  if (displayRoomIdEl) displayRoomIdEl.textContent = roomId.toUpperCase();

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

  // App Global States
  let currentUserId = null;
  let isLocalTyping = false;
  let typingTimeout = null;
  let isCurrentRoomPinned = false;

  // --- 3. UI Utility Functions (MUST BE DEFINED BEFORE SOCKET LISTENERS) ---
  
  function updateTextStats() {
    if (!textarea) return;
    const val = textarea.value;
    if (charCount) charCount.textContent = `${val.length} 字符`;
    const lines = val ? val.split('\n').length : 0;
    if (lineCount) lineCount.textContent = `${lines} 行`;
  }

  function setRoomPinnedState(pinned) {
    isCurrentRoomPinned = pinned;
    if (!pinnedBadge || !roomPill || !btnPinToggle || !pinToggleIcon) return;
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

  function getFileIcon(mimetype, filename) {
    const parts = (filename || '').split('.');
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
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderFilesList(files) {
    if (!filesGrid || !filesCountBadge || !totalSizeText) return;
    filesCountBadge.textContent = files.length;

    const totalBytes = files.reduce((acc, f) => acc + (f.size || 0), 0);
    totalSizeText.textContent = `总计 ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`;

    if (files.length === 0) {
      filesGrid.innerHTML = '';
      if (emptyFilesState) {
        filesGrid.appendChild(emptyFilesState);
        emptyFilesState.style.display = 'block';
      }
      return;
    }

    if (emptyFilesState) emptyFilesState.style.display = 'none';
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

    document.querySelectorAll('.btn-delete-file').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const fileId = e.currentTarget.dataset.id;
        if (socket) socket.emit('delete-file', fileId);
      });
    });
  }

  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
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

  // --- 4. Socket.IO Connection & Listeners Setup ---
  const socket = io();

  // 首要注册：确保收到 init-room-state 时所有函数与 DOM 均已就绪
  socket.on('init-room-state', (state) => {
    currentUserId = state.userId;
    if (!isLocalTyping && textarea) {
      textarea.value = state.text || '';
      updateTextStats();
    }
    renderFilesList(state.files || []);
    setRoomPinnedState(state.isPinned || false);
  });

  socket.on('connect', () => {
    socket.emit('join-room', roomId);
  });

  socket.on('room-users-update', (data) => {
    if (userCountText) userCountText.textContent = `在线设备: ${data.count}`;
  });

  socket.on('text-sync', (data) => {
    if (!textarea) return;
    textarea.value = data.text;
    updateTextStats();

    const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
    if (activeTab !== 'tab-text' && textBadge) {
      textBadge.style.display = 'inline-block';
    }
  });

  socket.on('user-typing', (data) => {
    if (!typingIndicator || !typingUserText) return;
    if (data.isTyping) {
      typingUserText.textContent = `${data.userId} 正在输入...`;
      typingIndicator.classList.add('show');
    } else {
      typingIndicator.classList.remove('show');
    }
  });

  socket.on('files-updated', (files) => {
    renderFilesList(files);
  });

  socket.on('room-destroyed', () => {
    showToast('房间已清空并彻底销毁！即将重定向...', 'warning');
    setTimeout(() => {
      window.location.hash = '';
      window.location.reload();
    }, 1500);
  });

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

  // --- 5. Page Active/Visibility Re-Sync ---
  function refreshRoomStateOnActive() {
    if (!socket) return;
    if (!socket.connected) {
      socket.connect();
    } else {
      socket.emit('join-room', roomId);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshRoomStateOnActive();
    }
  });

  window.addEventListener('focus', () => {
    refreshRoomStateOnActive();
  });

  window.addEventListener('hashchange', () => {
    window.location.reload();
  });

  // --- 6. Textarea Input & Action Controls ---
  let textDebounceTimer = null;
  if (textarea) {
    textarea.addEventListener('input', () => {
      updateTextStats();

      if (!isLocalTyping) {
        isLocalTyping = true;
        socket.emit('typing-status', true);
      }

      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        isLocalTyping = false;
        socket.emit('typing-status', false);
      }, 1200);

      clearTimeout(textDebounceTimer);
      textDebounceTimer = setTimeout(() => {
        socket.emit('text-change', { text: textarea.value });
      }, 200);
    });
  }

  document.getElementById('btn-copy-text')?.addEventListener('click', () => {
    if (!textarea || !textarea.value) {
      showToast('暂无文本可复制', 'info');
      return;
    }
    navigator.clipboard.writeText(textarea.value).then(() => {
      showToast('已复制全文到剪贴板！', 'success');
    }).catch(() => {
      showToast('复制失败，请手动选择复制', 'error');
    });
  });

  document.getElementById('btn-paste-text')?.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && textarea) {
        textarea.value = text;
        updateTextStats();
        socket.emit('text-change', { text: textarea.value });
        showToast('从剪贴板粘贴成功！', 'success');
      }
    } catch (err) {
      showToast('无法读取剪贴板，请允许浏览器剪贴板权限或使用 Ctrl+V / Cmd+V 粘贴', 'info');
    }
  });

  document.getElementById('btn-clear-text')?.addEventListener('click', () => {
    if (!textarea || !textarea.value) return;
    if (confirm('确定要清空文本框内容吗？')) {
      textarea.value = '';
      updateTextStats();
      socket.emit('clear-text');
      showToast('已清空文本', 'info');
    }
  });

  // --- 7. Tab Switching Logic ---
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(targetTab)?.classList.add('active');

      if (targetTab === 'tab-text' && textBadge) {
        textBadge.style.display = 'none';
      }
    });
  });

  // --- 8. File Upload Logic ---
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const progressContainer = document.getElementById('upload-progress-container');
  const progressFill = document.getElementById('progress-fill');
  const progressPercent = document.getElementById('progress-percent');
  const progressFilename = document.getElementById('progress-filename');

  if (dropzone && fileInput) {
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
  }

  function uploadFiles(files) {
    const formData = new FormData();
    formData.append('roomId', roomId);

    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }

    if (progressContainer) progressContainer.style.display = 'block';
    if (progressFilename) progressFilename.textContent = files.length === 1 ? files[0].name : `正在上传 ${files.length} 个文件...`;
    if (progressFill) progressFill.style.width = '0%';
    if (progressPercent) progressPercent.textContent = '0%';

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload', true);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && progressFill && progressPercent) {
        const percent = Math.round((e.loaded / e.total) * 100);
        progressFill.style.width = percent + '%';
        progressPercent.textContent = percent + '%';
      }
    };

    xhr.onload = () => {
      if (progressContainer) progressContainer.style.display = 'none';
      if (xhr.status === 200) {
        showToast('文件上传成功！', 'success');
      } else {
        showToast('文件上传失败，请重试', 'error');
      }
    };

    xhr.onerror = () => {
      if (progressContainer) progressContainer.style.display = 'none';
      showToast('网络错误，文件上传中断', 'error');
    };

    xhr.send(formData);
  }

  // --- 9. Modal Windows Logic ---
  const shareModal = document.getElementById('share-modal');
  const shareUrlInput = document.getElementById('share-url-input');
  const qrcodeBox = document.getElementById('qrcode-box');

  function openShareModal() {
    const shareUrl = window.location.href;
    if (shareUrlInput) shareUrlInput.value = shareUrl;
    if (qrcodeBox) {
      qrcodeBox.innerHTML = '';
      if (typeof QRCode !== 'undefined') {
        const canvas = document.createElement('canvas');
        QRCode.toCanvas(canvas, shareUrl, { width: 180, margin: 2, color: { dark: '#0b0f19', light: '#ffffff' } }, (err) => {
          if (!err) qrcodeBox.appendChild(canvas);
        });
      } else {
        qrcodeBox.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(shareUrl)}" alt="QR">`;
      }
    }
    if (shareModal) shareModal.style.display = 'flex';
  }

  document.getElementById('btn-share-modal')?.addEventListener('click', openShareModal);
  document.getElementById('btn-close-modal')?.addEventListener('click', () => {
    if (shareModal) shareModal.style.display = 'none';
  });

  shareModal?.addEventListener('click', (e) => {
    if (e.target === shareModal) shareModal.style.display = 'none';
  });

  document.getElementById('btn-copy-room')?.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href);
    showToast('已复制房间链接！', 'success');
  });

  document.getElementById('btn-modal-copy')?.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href);
    showToast('已复制房间链接！', 'success');
  });

  document.getElementById('btn-destroy-room')?.addEventListener('click', () => {
    if (confirm('警告：此操作将彻底抹除当前房间内的文本及所有暂存文件，确定销毁吗？')) {
      socket.emit('destroy-room');
    }
  });

  // --- 10. Pinned Rooms Navigation & Management ---
  btnPinToggle?.addEventListener('click', () => {
    if (isCurrentRoomPinned) {
      if (confirm('取消固定后，此房间将在 24 小时无活动后自动销毁，确定吗？')) {
        socket.emit('unpin-room');
      }
    } else {
      socket.emit('pin-room');
    }
  });

  document.getElementById('btn-pinned-nav')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!pinnedDropdown) return;
    const isOpen = pinnedDropdown.classList.toggle('show');
    if (pinnedArrow) pinnedArrow.classList.toggle('open', isOpen);
    if (isOpen) loadPinnedRoomsList();
  });

  document.addEventListener('click', () => {
    if (pinnedDropdown) pinnedDropdown.classList.remove('show');
    if (pinnedArrow) pinnedArrow.classList.remove('open');
  });

  pinnedDropdown?.addEventListener('click', e => e.stopPropagation());

  async function loadPinnedRoomsList() {
    if (!pinnedRoomsList) return;
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

  loadPinnedRoomsList();

  const PINNED_ID_REGEX = /^[a-z0-9][a-z0-9-]{2,18}[a-z0-9]$/;

  document.getElementById('btn-open-create-pinned')?.addEventListener('click', () => {
    if (pinnedDropdown) pinnedDropdown.classList.remove('show');
    if (pinnedArrow) pinnedArrow.classList.remove('open');
    if (pinnedRoomIdInput) pinnedRoomIdInput.value = '';
    if (pinnedHintText) {
      pinnedHintText.textContent = '4~20 位小写字母、数字或连字符，不可以连字符开头/结尾';
      pinnedHintText.className = 'pinned-hint';
    }
    if (createPinnedModal) createPinnedModal.style.display = 'flex';
    setTimeout(() => pinnedRoomIdInput?.focus(), 50);
  });

  document.getElementById('btn-close-pinned-modal')?.addEventListener('click', () => {
    if (createPinnedModal) createPinnedModal.style.display = 'none';
  });

  createPinnedModal?.addEventListener('click', e => {
    if (e.target === createPinnedModal) createPinnedModal.style.display = 'none';
  });

  pinnedRoomIdInput?.addEventListener('input', () => {
    const val = pinnedRoomIdInput.value.toLowerCase().trim();
    pinnedRoomIdInput.value = val;
    if (!val) {
      if (pinnedHintText) {
        pinnedHintText.textContent = '4~20 位小写字母、数字或连字符，不可以连字符开头/结尾';
        pinnedHintText.className = 'pinned-hint';
      }
    } else if (!PINNED_ID_REGEX.test(val)) {
      if (pinnedHintText) {
        pinnedHintText.textContent = '❌ 格式不合法，请检查';
        pinnedHintText.className = 'pinned-hint error';
      }
    } else {
      if (pinnedHintText) {
        pinnedHintText.textContent = '✅ 格式正确';
        pinnedHintText.className = 'pinned-hint ok';
      }
    }
  });

  document.getElementById('btn-confirm-create-pinned')?.addEventListener('click', async () => {
    if (!pinnedRoomIdInput) return;
    const val = pinnedRoomIdInput.value.toLowerCase().trim();
    if (!PINNED_ID_REGEX.test(val)) {
      if (pinnedHintText) {
        pinnedHintText.textContent = '❌ 格式不合法，请检查';
        pinnedHintText.className = 'pinned-hint error';
      }
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
        if (pinnedHintText) {
          pinnedHintText.textContent = `❌ ${data.error}`;
          pinnedHintText.className = 'pinned-hint error';
        }
        return;
      }
      if (createPinnedModal) createPinnedModal.style.display = 'none';
      showToast(`固定房间 /r/${val} 创建成功！`, 'success');
      window.location.hash = `room=${val}`;
      window.location.reload();
    } catch (err) {
      if (pinnedHintText) {
        pinnedHintText.textContent = '❌ 网络错误，请重试';
        pinnedHintText.className = 'pinned-hint error';
      }
    }
  });

  pinnedRoomIdInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      document.getElementById('btn-confirm-create-pinned')?.click();
    }
  });

});
