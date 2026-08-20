# n8n AI 自動化課程 — 學員環境 Starter

上課前只要完成本頁的「課前準備」，環境就緒，其他都在課堂上動手做。

## 環境架構

一套 Docker Compose 起三個服務：

| 服務 | 用途 | 網址 |
|------|------|------|
| **n8n** 2.21.7 | 工作流平台（課程主角）| http://localhost:5678 |
| **Qdrant** | 向量資料庫（Day 2 RAG 使用）| http://localhost:6333 |
| **Mock API** | 模擬 IT 設備狀態/告警/工單 | http://localhost:3001 |

> n8n 版本刻意固定在 2.21.7 —— 課程教材與所有範例都以此版本驗證，請不要改成 `latest`。

## 課前準備（10 分鐘）

### 1. 安裝 Docker Desktop

https://www.docker.com/products/docker-desktop/ （macOS / Windows 皆可；已裝 Docker 或 Podman 可跳過）

### 2. Clone 本 repo 並設定環境變數

```bash
git clone https://github.com/Lung-Yu/n8n-course-starter.git
cd n8n-course-starter
cp env.example .env
```

`.env` 可以先不改，預設值即可啟動。Gemini API Key 課堂上會帶大家申請（或使用課程提供的共用 Key）。

### 3. 啟動環境

```bash
docker compose up -d
```

### 4. 驗證三個服務都活著

```bash
curl http://localhost:5678/healthz        # {"status":"ok"}
curl http://localhost:3001/api/health     # {"status":"ok"}
curl http://localhost:6333/collections    # {"result":{...},"status":"ok"}
```

### 5. 建立 n8n 帳號

打開 http://localhost:5678 ，第一次進入會要求建立 Owner 帳號——填自己的 email 和密碼即可（存在你本機，不會外傳）。

到這裡就完成了，課堂見！

## 課堂上會用到的東西（先不用動）

- `sample-docs/`：Day 2 RAG Lab 的知識庫文件（IT 維運 SOP + Network Runbook）。
- `mock-api/`：模擬 API 原始碼，想看資料長怎樣可以直接讀 `server.js`。

課程設計是所有 workflow **從零一步步搭**——完成版 workflow 檔案會在課堂上視進度提供。

## 常見問題

**Port 被佔用（5678 / 6333 / 3001）**
改 `.env` 裡的 `N8N_PORT`，或找出佔用者：`lsof -i :5678`。

**workflow 裡的 `host.containers.internal` 是什麼？**
容器連回你本機的位址。compose 已設定 `extra_hosts` 讓 Docker / Podman 都能解析，不用修改。

**Jira 相關 Lab 的注意事項（Day 1 Lab A）**
- 需要免費 Atlassian 帳號：https://www.atlassian.com/software/jira/free
- API Token 申請：https://id.atlassian.com/manage-profile/security/api-tokens
- 免費版 Jira **沒有 "Incident" issue type、也沒有 "Critical" priority**（只有 Highest/High/Medium/Low/Lowest）——搭 workflow 時 issue type 用「任務」，priority 記得對映（例如 Critical → Highest）。

**Gemini API Key 申請**
https://aistudio.google.com/api-keys （免費額度足夠課堂使用）

## 課後清理

```bash
docker compose down        # 停止（保留資料）
docker compose down -v     # 停止並刪除所有資料
```
