# SyncFlow - 免登录跨端文本与文件极速中转站

![SyncFlow White Theme](public/syncflow_white.png)

> **SyncFlow** 是一款现代、轻量、免登录的跨设备文本剪贴板同步与文件临时共享 Web 应用。基于 Node.js、Socket.IO 与 HTML5 构建，旨在替代传统的“微信文件传输助手”或“发送邮件给自身”，提供零门槛、即用即走、隐私安全的数据中转体验。

---

## 🌟 核心特性

- **⚡ 免登录与房间隔离**
  - 无需注册/登录账号，访问页面即自动分配 5 位随机临时房间号（如 `r/a8x9k`）。
  - 支持快捷生成/复制房间链接与**动态 QR 二维码**，手机扫码秒级配对。

- **💬 文本与剪贴板实时同步**
  - 基于 Socket.IO 毫秒级广播，多端打字实时同步，支持对方打字中状态指示（`User_xxx is typing...`）。
  - 提供“一键复制全文”、“一键粘贴”与“清空内容”工具按键，集成原生 Clipboard API。

- **📁 文件共享栈 (Files Dropzone)**
  - 支持拖拽多文件上传，单文件最大支持 500MB，包含真实上传进度条展示。
  - 针对图片、视频、音频、PDF、代码/文本、压缩包自动提供 Remixicon 语义图标与一键下载/删除。

- **📌 固化房间与持久化 (Pinned Rooms)**
  - 支持将临时房间“固定”或新建自定义名称房间（如 `/r/my-team`）。
  - 固定房间**豁免 24h 自动清理**，且数据自动原子落盘存储（`data/pinned-rooms.json`），服务器重启后自动恢复。

- **🔒 隐私保护与自动清理**
  - **即用即走**：临时房间支持全员一键彻底销毁房间并抹除物理文件。
  - **定时回收**：超过 24 小时无活动临时房间自动彻底销毁。
  - **孤儿文件清理**：服务启动及每 6 小时自动扫描磁盘，清除残留的孤儿文件。

- **🎨 现代白调视觉设计 (Light Design System)**
  - 采用柔和淡灰点阵背景 (`#f0f2f8`)、纯白悬浮卡片、靛蓝/紫罗兰渐变 Accent 色与琥珀金固定房间徽章。
  - 全响应式移动端适配与平滑动画过渡。

---

## 🏗️ 项目目录结构

```
d:\work\text_file_sync_app\
├── Dockerfile              # Docker 镜像构建文件
├── docker-compose.yml      # Docker Compose / Dockge 编排配置
├── package.json            # Node.js 项目依赖与运行脚本
├── server.js               # 后端主程序 (Express + Socket.IO)
├── uploads/                # 物理文件存储目录 (自动创建)
├── data/                   # 持久化数据目录 (pinned-rooms.json, 自动创建)
└── public/                 # 前端静态资源
    ├── index.html          # 单页结构与 Modal 模态框
    ├── style.css           # 现代白色主题视觉样式系统
    └── app.js              # WebSocket 实时交互、文件上传与 UI 逻辑
```

---

## 🚀 部署指南

### 1. PM2 常规部署（推荐 Linux 服务器）

```bash
# 解压项目代码
unzip syncflow.zip -d /opt/syncflow
cd /opt/syncflow

# 安装生产依赖
npm install --production

# 全局安装 PM2 并启动
npm install -g pm2
pm2 start server.js --name "syncflow"
pm2 save
pm2 startup
```

### 2. Dockge 可视化部署（推荐）

1. 将 `syncflow.zip` 解压到 Dockge 的 Stacks 目录：`/opt/stacks/syncflow`
2. 打开 Dockge 控制台 (`http://服务器IP:5001`)。
3. 找到自动识别的 `syncflow` 项目，直接点击 **`🚀 部署` (Deploy)** 即可基于自带的 `Dockerfile` 完成自动构建与运行。

### 3. 原生 Docker / Docker Compose 部署

```bash
# 使用 Docker Compose 启动
docker-compose up -d --build
```

---

## 📡 API 与 Socket.IO 事件规范

### REST API

| 请求方式 | 路由 | 说明 |
|---------|------|------|
| `POST` | `/api/upload` | 上传文件（Multipart FormData，需带 `roomId`） |
| `GET` | `/api/download/:roomId/:fileId` | 下载指定房间中的文件 |
| `GET` | `/api/pinned-rooms` | 获取当前所有固定房间列表 |
| `POST` | `/api/pinned-rooms` | 创建新的固定房间 |

### Socket.IO 实时事件

- `join-room`: 加入房间通道
- `text-change`: 广播文本变更（内置 500K 字符上限与服务端 1s 落盘防抖）
- `typing-status`: 广播用户打字状态
- `clear-text`: 清空文本框
- `delete-file`: 删除指定文件
- `pin-room` / `unpin-room`: 将当前房间固定或取消固定
- `destroy-room`: 彻底销毁房间并删除磁盘文件

---

## 🛡️ 安全与健壮性设计

1. **路径遍历防御**：下载与删除接口使用 `ROOM_ID_REGEX` / `SAFE_ID_REGEX` 格式白名单校验，并辅以 `path.resolve` 路径边界检查。
2. **安全 MIME 过滤**：multer 上传拦截危险扩展名及脚本类型（如 `.exe`、`.sh`、`.php`）。
3. **容量限制**：服务端限制最大临时房间数为 `1000`，单次上传文件上限为 `10` 个。
4. **原子化持久化**：使用写入 `.tmp` 临时文件再 `renameSync` 的原子化文件落盘策略，防止因异常断电造成 JSON 损毁。

---

## 📄 开源许可

[MIT License](LICENSE) © 2026 SyncFlow
