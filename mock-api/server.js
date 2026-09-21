// TSMC n8n 課程 — Mock 設備/告警/工單/事件 API（擴充版 2026-08-14）
// 在 2026-08-09 重建版基礎上，additive 新增三組端點供三個新 Lab 使用：
//   - GET /api/certificates                     憑證/網域到期監控（Lab C）
//   - GET /api/threat-intel/url?url=            URL 威脅情資查詢（Lab D）
//   - GET /api/devices                          設備清單（Lab E 批次備份用）
//   - GET /api/devices/:id/config              設備 running-config + baseline（Lab E diff 用）
// 原有端點（devices/:id、alerts、alerts/history、metrics、incidents、tickets、notify）完全保留，向後相容。
// 純 Node.js 內建 http 模組，無外部依賴。
const http = require('http');
const { URL } = require('url');

const PORT = process.env.PORT || 3001;

// ---------------------------------------------------------------------------
// 設備狀態（GET /api/devices/:id）
// ---------------------------------------------------------------------------
const devices = {
  'prod-node-03': { device_id: 'prod-node-03', cpu_percent: 97, memory_percent: 81, network_status: 'ok', status: 'critical' },
  'prod-node-01': { device_id: 'prod-node-01', cpu_percent: 22, memory_percent: 44, network_status: 'ok', status: 'healthy' },
  'prod-node-04': { device_id: 'prod-node-04', cpu_percent: 55, memory_percent: 60, network_status: 'ok', status: 'warning' },
  'prod-node-07': { device_id: 'prod-node-07', cpu_percent: 38, memory_percent: 50, network_status: 'degraded', status: 'warning' },
  'prod-db-01': { device_id: 'prod-db-01', cpu_percent: 61, memory_percent: 87, network_status: 'ok', status: 'warning' },
  'prod-web-02': { device_id: 'prod-web-02', cpu_percent: 18, memory_percent: 35, network_status: 'ok', status: 'healthy' },
  'dist-sw-03': { device_id: 'dist-sw-03', cpu_percent: 12, memory_percent: 30, network_status: 'ok', status: 'warning' },
};

function getDevice(id) {
  return devices[id] || { device_id: id, cpu_percent: 15, memory_percent: 25, network_status: 'ok', status: 'healthy' };
}

// ---------------------------------------------------------------------------
// 告警歷史（GET /api/alerts, GET /api/alerts/history?hours=24&host=x）
// ---------------------------------------------------------------------------
function buildAlertHistory() {
  const now = Date.now();
  const hour = 3600 * 1000;
  const rows = [];
  let id = 1;
  const push = (host, alertname, severity, hoursAgo, message) => {
    rows.push({
      id: `ALT-${String(id++).padStart(3, '0')}`,
      host, alertname, severity, message,
      timestamp: new Date(now - hoursAgo * hour).toISOString(),
    });
  };
  [1, 3.5, 6, 9.5, 13, 17, 21].forEach((h, i) => {
    push('prod-node-03', 'HighCPUUsage', 'critical', h, `CPU usage exceeded 90% (reading: ${94 + i}%)`);
  });
  push('prod-db-01', 'HighMemoryUsage', 'warning', 2, 'Memory usage at 87%, approaching threshold of 90%');
  push('prod-db-01', 'HighMemoryUsage', 'warning', 15, 'Memory usage at 85%, approaching threshold of 90%');
  push('prod-node-04', 'DiskSpaceLow', 'warning', 4, 'Disk space usage at 78% on /var/log partition');
  push('prod-node-07', 'NetworkDegraded', 'warning', 8, 'Packet loss 3% on uplink interface');
  push('dist-sw-03', 'InterfaceFlapping', 'warning', 11, 'GE0/3 interface flapping detected');
  push('prod-web-02', 'HighLatency', 'info', 5, 'p99 latency 420ms, within acceptable range');
  push('prod-node-01', 'ScheduledMaintenance', 'info', 20, 'Routine maintenance window completed');
  push('prod-db-01', 'BackupCompleted', 'info', 22, 'Nightly backup completed successfully');
  push('prod-node-04', 'DiskSpaceLow', 'warning', 18, 'Disk space usage at 74% on /var/log partition');
  push('prod-web-02', 'DeploymentCompleted', 'info', 10, 'Rolling deployment completed, 0 errors');
  push('prod-node-07', 'ConfigDrift', 'warning', 16, 'Configuration drift detected vs baseline');
  push('prod-node-01', 'HealthCheckOk', 'info', 12, 'All health checks passing');
  push('prod-db-01', 'SlowQueryDetected', 'warning', 7, 'Query execution time exceeded 3s threshold');
  push('prod-node-04', 'HealthCheckOk', 'info', 14, 'All health checks passing');
  return rows;
}
const alertHistory = buildAlertHistory();

// ---------------------------------------------------------------------------
// Metrics 趨勢（GET /api/metrics/:host）
// ---------------------------------------------------------------------------
function buildMetrics(host) {
  const now = Date.now();
  const points = [];
  const climbing = host === 'prod-node-03';
  for (let i = 12; i >= 0; i--) {
    const t = new Date(now - i * 30 * 60 * 1000).toISOString();
    const base = climbing ? 97 - i * 2.5 : (devices[host] ? devices[host].cpu_percent : 15) + (Math.sin(i) * 4);
    points.push({ timestamp: t, cpu_percent: Math.max(5, Math.round(base)) });
  }
  return { host, window_hours: 6, points };
}

// ===========================================================================
// 【新增 · Lab C】憑證/網域到期監控（GET /api/certificates）
// days_remaining 於請求當下即時計算，讓「到期天數」永遠貼近上課當天。
// 設計成：2 張已快到期（critical/warning）+ 3 張安全，讓分流有戲。
// ---------------------------------------------------------------------------
const certSeeds = [
  { domain: 'portal.corp.example.com',   issuer: "Let's Encrypt R3",        days: 6,   san: ['portal.corp.example.com'] },
  { domain: 'vpn.corp.example.com',      issuer: 'DigiCert TLS RSA SHA256', days: 21,  san: ['vpn.corp.example.com'] },
  { domain: 'api.corp.example.com',      issuer: "Let's Encrypt R3",        days: 58,  san: ['api.corp.example.com', 'api-v2.corp.example.com'] },
  { domain: 'mail.corp.example.com',     issuer: 'DigiCert TLS RSA SHA256', days: 143, san: ['mail.corp.example.com', 'autodiscover.corp.example.com'] },
  { domain: 'intranet.corp.example.com', issuer: 'Internal CA G2',          days: 402, san: ['intranet.corp.example.com'] },
];
function buildCertificates() {
  const now = Date.now();
  const day = 86400 * 1000;
  return certSeeds.map((c) => ({
    domain: c.domain,
    issuer: c.issuer,
    san: c.san,
    serial: 'MOCK-' + Buffer.from(c.domain).toString('hex').slice(0, 12).toUpperCase(),
    valid_from: new Date(now - (365 - c.days) * day).toISOString(),
    expires_at: new Date(now + c.days * day).toISOString(),
    days_remaining: c.days,
  }));
}

// ===========================================================================
// 【新增 · Lab D】URL 威脅情資查詢（GET /api/threat-intel/url?url=...）
// 以 URL 特徵做確定性判定（課堂可重現），模擬 VirusTotal 風格回應。
// ---------------------------------------------------------------------------
function lookupThreatIntel(rawUrl) {
  const u = (rawUrl || '').toLowerCase();
  let verdict = 'clean';
  let score = 3;
  const categories = [];
  const badSignals = ['secure-login', 'verify-account', 'account-update', 'confirm-identity', '.zip/', 'login-alert'];
  const suspSignals = ['bit.ly', 'tinyurl', 'is.gd', 't.co/', 'free-', 'bonus'];
  const ipLiteral = /https?:\/\/(\d{1,3}\.){3}\d{1,3}/.test(u);
  if (badSignals.some((s) => u.includes(s)) || ipLiteral) {
    verdict = 'malicious'; score = 88;
    categories.push('phishing', 'credential-harvesting');
  } else if (suspSignals.some((s) => u.includes(s))) {
    verdict = 'suspicious'; score = 47;
    categories.push('url-shortener', 'newly-registered-domain');
  }
  return {
    url: rawUrl,
    verdict,
    score,                       // 0-100，越高越危險
    positives: verdict === 'malicious' ? 14 : verdict === 'suspicious' ? 4 : 0,
    total_engines: 68,
    categories,
    last_seen: new Date(Date.now() - 3600 * 1000).toISOString(),
  };
}

// ===========================================================================
// 【新增 · Lab E】設備 running-config + baseline（GET /api/devices/:id/config）
// 為了讓「一次執行就看得到 diff」，端點同時回傳 baseline_config 與 running_config。
// dist-sw-03 故意有差異（新增一條未經核准的 ACL + 關閉 logging）；其餘設備兩者相同（no change）。
// ---------------------------------------------------------------------------
const baselineConfigs = {
  'dist-sw-03': [
    'hostname dist-sw-03',
    'ip access-list extended GUEST-ACL',
    ' permit tcp any any eq 443',
    ' deny ip any 10.10.0.0 0.0.255.255',
    'logging host 10.20.0.5',
    'snmp-server community R0-READONLY RO',
  ].join('\n'),
  'prod-node-07': [
    'hostname prod-node-07',
    'interface eth0',
    ' mtu 1500',
    'logging host 10.20.0.5',
  ].join('\n'),
};
const runningConfigs = {
  // dist-sw-03：與 baseline 有差異 —— 多一條放行 SSH 到內網的 ACL、且把 logging 關掉（可疑變更）
  'dist-sw-03': [
    'hostname dist-sw-03',
    'ip access-list extended GUEST-ACL',
    ' permit tcp any any eq 443',
    ' permit tcp any 10.10.0.0 0.0.255.255 eq 22',
    ' deny ip any 10.10.0.0 0.0.255.255',
    'no logging host 10.20.0.5',
    'snmp-server community R0-READONLY RO',
  ].join('\n'),
  // prod-node-07：與 baseline 相同（no change 對照組）
  'prod-node-07': [
    'hostname prod-node-07',
    'interface eth0',
    ' mtu 1500',
    'logging host 10.20.0.5',
  ].join('\n'),
};
function getDeviceConfig(id) {
  const baseline = baselineConfigs[id] || `hostname ${id}\n! (no baseline captured)`;
  const running = runningConfigs[id] || baseline; // 未知設備視為無變更
  return {
    device_id: id,
    retrieved_at: new Date().toISOString(),
    baseline_captured_at: '2026-08-01T00:00:00Z',
    baseline_config: baseline,
    running_config: running,
  };
}

// ---------------------------------------------------------------------------
// Incident（GET /api/incidents/:id）
// ---------------------------------------------------------------------------
const incidents = {
  'INC-2026-0703': {
    incident_id: 'INC-2026-0703',
    title: 'prod-node-03 CPU 持續過載導致 API 回應延遲',
    severity: 'critical',
    started_at: '2026-07-03T09:12:00Z',
    resolved_at: '2026-07-03T11:47:00Z',
    affected_hosts: ['prod-node-03', 'prod-web-02'],
    timeline: [
      { time: '2026-07-03T09:12:00Z', event: 'HighCPUUsage 告警觸發，prod-node-03 CPU 97%' },
      { time: '2026-07-03T09:18:00Z', event: '值班工程師確認告警，開始排查' },
      { time: '2026-07-03T09:35:00Z', event: '發現 prod-web-02 API p99 延遲上升至 1.8s' },
      { time: '2026-07-03T10:05:00Z', event: '判斷為背景批次任務未限制資源導致 CPU 搶佔' },
      { time: '2026-07-03T10:40:00Z', event: '調整批次任務 cgroup CPU limit，觀察 CPU 開始下降' },
      { time: '2026-07-03T11:47:00Z', event: 'CPU 回穩至 20% 以下，延遲恢復正常，事件關閉' },
    ],
    actions_taken: [
      { action: '調整批次任務 cgroup CPU limit 為 50%', by: 'network-ops', time: '2026-07-03T10:40:00Z' },
      { action: '重啟 prod-web-02 應用程序釋放連線池', by: 'network-ops', time: '2026-07-03T11:00:00Z' },
      { action: '新增 CPU > 90% 持續 5 分鐘的預警規則', by: 'network-ops', time: '2026-07-03T11:47:00Z' },
    ],
    impact: '約 2.5 小時內 api-gateway 服務 p99 延遲上升至 1.8 秒，未觀察到請求失敗，僅使用者體驗變慢。',
  },
};

// ---------------------------------------------------------------------------
// 通知收件匣 & 工單（記憶體 store）
// ---------------------------------------------------------------------------
const notifications = [];
let ticketSeq = 0;
const tickets = {};
function createTicket(body) {
  ticketSeq += 1;
  const key = `IT-${String(ticketSeq).padStart(3, '0')}`;
  const ticket = {
    key, id: key,
    fields: {
      summary: body.summary || body.title || `[${body.severity || 'info'}] ${body.alertname || 'Untitled'}`,
      description: body.description || body.message || '',
      priority: body.priority || 'Medium',
      labels: body.labels || [],
    },
    comments: [],
    created_at: new Date().toISOString(),
  };
  tickets[key] = ticket;
  return ticket;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (parts[0] !== 'api') {
      if (parts[0] === 'health' || parts.length === 0) return sendJson(res, 200, { ok: true });
      return sendJson(res, 404, { error: 'not found' });
    }

    // README / 講稿的驗證指令打的是 /api/health
    if (parts[1] === 'health' && !parts[2]) return sendJson(res, 200, { status: 'ok' });

    // ---- 新增：GET /api/certificates（Lab C）----
    if (parts[1] === 'certificates' && !parts[2] && req.method === 'GET') {
      const certs = buildCertificates();
      return sendJson(res, 200, { total: certs.length, certificates: certs });
    }

    // ---- 新增：GET /api/threat-intel/url?url=（Lab D）----
    if (parts[1] === 'threat-intel' && parts[2] === 'url' && req.method === 'GET') {
      return sendJson(res, 200, lookupThreatIntel(url.searchParams.get('url') || ''));
    }

    // ---- 新增：GET /api/devices（清單，Lab E）----
    if (parts[1] === 'devices' && !parts[2] && req.method === 'GET') {
      return sendJson(res, 200, { devices: Object.keys(devices) });
    }

    // ---- 新增：GET /api/devices/:id/config（Lab E）----
    if (parts[1] === 'devices' && parts[2] && parts[3] === 'config' && req.method === 'GET') {
      return sendJson(res, 200, getDeviceConfig(decodeURIComponent(parts[2])));
    }

    // GET /api/devices/:id
    if (parts[1] === 'devices' && parts[2] && !parts[3] && req.method === 'GET') {
      return sendJson(res, 200, getDevice(decodeURIComponent(parts[2])));
    }

    // GET /api/alerts
    if (parts[1] === 'alerts' && !parts[2] && req.method === 'GET') {
      return sendJson(res, 200, { total: alertHistory.length, alerts: alertHistory.slice(0, 10) });
    }
    // GET /api/alerts/history?hours=24&host=x
    if (parts[1] === 'alerts' && parts[2] === 'history' && req.method === 'GET') {
      const hours = Number(url.searchParams.get('hours') || 24);
      const host = url.searchParams.get('host');
      const cutoff = Date.now() - hours * 3600 * 1000;
      let rows = alertHistory.filter((a) => new Date(a.timestamp).getTime() >= cutoff);
      if (host) rows = rows.filter((a) => a.host === host);
      const critical_count = rows.filter((a) => a.severity === 'critical').length;
      return sendJson(res, 200, { total_alerts: rows.length, critical_count, alerts: rows });
    }
    // GET /api/metrics/:host
    if (parts[1] === 'metrics' && parts[2] && req.method === 'GET') {
      return sendJson(res, 200, buildMetrics(decodeURIComponent(parts[2])));
    }
    // GET /api/incidents/:id
    if (parts[1] === 'incidents' && parts[2] && req.method === 'GET') {
      const inc = incidents[decodeURIComponent(parts[2])];
      if (!inc) return sendJson(res, 404, { error: 'incident not found' });
      return sendJson(res, 200, inc);
    }
    // tickets
    if (parts[1] === 'tickets' && !parts[2] && req.method === 'GET') {
      return sendJson(res, 200, Object.values(tickets));
    }
    if (parts[1] === 'tickets' && !parts[2] && req.method === 'POST') {
      const body = await readBody(req);
      const fields = body.fields || body;
      const ticket = createTicket({
        summary: fields.summary, description: fields.description,
        priority: fields.priority && fields.priority.name ? fields.priority.name : fields.priority,
        labels: fields.labels, alertname: body.alertname, severity: body.severity, message: body.message,
      });
      return sendJson(res, 201, ticket);
    }
    if (parts[1] === 'tickets' && parts[2] && parts[3] === 'comments' && req.method === 'POST') {
      const key = decodeURIComponent(parts[2]);
      const ticket = tickets[key];
      if (!ticket) return sendJson(res, 404, { error: 'ticket not found' });
      const body = await readBody(req);
      const comment = { body: body.body || body.comment || '(no text)', time: new Date().toISOString() };
      ticket.comments.push(comment);
      return sendJson(res, 201, { key, comment });
    }
    // notify
    if (parts[1] === 'notify' && req.method === 'GET') return sendJson(res, 200, notifications);
    if (parts[1] === 'notify' && req.method === 'POST') {
      const body = await readBody(req);
      notifications.push({ ...body, received_at: new Date().toISOString() });
      return sendJson(res, 201, { ok: true });
    }

    return sendJson(res, 404, { error: 'not found', path: url.pathname });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`mock-api (extended) listening on :${PORT}`);
});
