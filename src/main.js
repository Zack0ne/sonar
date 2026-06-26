const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

const $ = (id) => document.getElementById(id);

const els = {
  start: $("start"),
  end: $("end"),
  ports: $("ports"),
  threads: $("threads"),
  timeout: $("timeout"),
  startBtn: $("startBtn"),
  stopBtn: $("stopBtn"),
  presetLocal: $("presetLocal"),
  tbody: $("tbody"),
  status: $("status"),
  counts: $("counts"),
  threadStatus: $("threadStatus"),
  progressBar: $("progressBar"),
  statusFilter: $("statusFilter"),
  search: $("search"),
  portFilter: $("portFilter"),
  clearFilters: $("clearFilters"),
  exportCsv: $("exportCsv"),
  exportJson: $("exportJson"),
  thead: document.querySelector("#results thead"),
};

const appWindow = getCurrentWindow();
const APP_TITLE = "Sonar — Network Scanner";

let scanning = false;
// ip -> { tr, data }
let rowsByIp = new Map();
let stats = { total: 0, done: 0, alive: 0, ports: 0 };
// Current sort: key + direction (1 asc, -1 desc). Default = IP ascending.
let sortState = { key: "ip", dir: 1 };

// Well-known service names for the Ports column.
const SERVICES = {
  20: "FTP", 21: "FTP", 22: "SSH", 23: "Telnet", 25: "SMTP", 53: "DNS",
  67: "DHCP", 69: "TFTP", 80: "HTTP", 110: "POP3", 111: "RPC", 123: "NTP",
  135: "MSRPC", 139: "NetBIOS", 143: "IMAP", 161: "SNMP", 389: "LDAP",
  443: "HTTPS", 445: "SMB", 465: "SMTPS", 514: "Syslog", 587: "SMTP",
  631: "IPP", 993: "IMAPS", 995: "POP3S", 1433: "MSSQL", 1521: "Oracle",
  1723: "PPTP", 2049: "NFS", 2375: "Docker", 3000: "Dev", 3306: "MySQL",
  3389: "RDP", 5060: "SIP", 5432: "Postgres", 5900: "VNC", 5985: "WinRM",
  6379: "Redis", 8000: "HTTP-alt", 8080: "HTTP-alt", 8443: "HTTPS-alt",
  8888: "HTTP-alt", 9000: "Dev", 9200: "Elastic", 11211: "Memcached",
  27017: "MongoDB",
};

function portLabel(p) {
  return SERVICES[p] ? `${p} (${SERVICES[p]})` : `${p}`;
}

function parsePorts(str) {
  const set = new Set();
  for (const part of str.split(",")) {
    const t = part.trim();
    if (!t) continue;
    if (t.includes("-")) {
      const [a, b] = t.split("-").map((x) => parseInt(x.trim(), 10));
      if (Number.isInteger(a) && Number.isInteger(b)) {
        for (let p = Math.min(a, b); p <= Math.max(a, b); p++) {
          if (p >= 1 && p <= 65535) set.add(p);
        }
      }
    } else {
      const p = parseInt(t, 10);
      if (Number.isInteger(p) && p >= 1 && p <= 65535) set.add(p);
    }
  }
  return [...set].sort((a, b) => a - b);
}

function dotClass(state) {
  if (state === "ports") return "green";
  if (state === "alive") return "blue";
  return "red";
}

function pingText(r) {
  const v = r.ping_ms;
  if (v == null) return "[n/a]";
  if (v <= 0) return "<1 ms"; // reply seen but sub-millisecond / unmeasured
  return `${Math.round(v * 10) / 10} ms`;
}

function ipToNum(ip) {
  return ip.split(".").reduce((acc, o) => acc * 256 + parseInt(o, 10), 0);
}

function numToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

// If the start field holds a CIDR (e.g. 192.168.1.0/24), expand it into the
// start/end fields. For prefixes <= 30 we skip the network and broadcast
// addresses (the usual host range), matching the .1–.254 convention.
function expandCidrInputs() {
  const m = els.start.value.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!m) return;
  const prefix = parseInt(m[2], 10);
  if (prefix < 0 || prefix > 32) return;
  const base = ipToNum(m[1]);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (base & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const first = prefix <= 30 ? (network + 1) >>> 0 : network;
  const last = prefix <= 30 ? (broadcast - 1) >>> 0 : broadcast;
  els.start.value = numToIp(first);
  els.end.value = numToIp(last);
}

function makeRow(r) {
  const tr = document.createElement("tr");
  tr.dataset.ipnum = ipToNum(r.ip);
  tr._data = r;
  tr.innerHTML = `
    <td><span class="dot ${dotClass(r.state)}"></span></td>
    <td class="ip-cell">${r.ip}</td>
    <td class="ping-cell"></td>
    <td class="host-cell"></td>
    <td class="ports-cell"></td>
    <td class="web-cell"></td>`;
  fillRow(tr, r);
  return tr;
}

function fillRow(tr, r) {
  tr.className = r.state === "dead" ? "dead" : "";
  tr.querySelector(".dot").className = `dot ${dotClass(r.state)}`;
  tr.querySelector(".ping-cell").textContent = pingText(r);
  const host = tr.querySelector(".host-cell");
  host.textContent = r.hostname || "[n/a]";
  if (!r.hostname) host.classList.add("muted");
  else host.classList.remove("muted");
  const ports = tr.querySelector(".ports-cell");
  ports.textContent =
    r.open_ports && r.open_ports.length ? r.open_ports.map(portLabel).join(", ") : "[n/a]";
  if (!r.open_ports || !r.open_ports.length) ports.classList.add("muted");
  else ports.classList.remove("muted");
  const web = tr.querySelector(".web-cell");
  web.textContent = r.web || "[n/a]";
  if (!r.web) web.classList.add("muted");
  else web.classList.remove("muted");
}

// --- Sorting -----------------------------------------------------------------

const STATE_RANK = { ports: 0, alive: 1, dead: 2 };

function sortValue(r, key) {
  switch (key) {
    case "ip": return ipToNum(r.ip);
    case "ping": return r.ping_ms ?? Number.POSITIVE_INFINITY;
    case "host": return (r.hostname || "").toLowerCase();
    case "ports": return r.open_ports ? r.open_ports.length : 0;
    case "web": return (r.web || "").toLowerCase();
    case "status": return STATE_RANK[r.state] ?? 3;
    default: return 0;
  }
}

function compareRows(a, b) {
  const va = sortValue(a, sortState.key);
  const vb = sortValue(b, sortState.key);
  let cmp;
  if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
  else cmp = String(va).localeCompare(String(vb));
  if (cmp !== 0) return cmp * sortState.dir;
  // Stable tie-break: always by IP ascending.
  return ipToNum(a.ip) - ipToNum(b.ip);
}

// Insert a row into the tbody at the position dictated by the active sort.
function insertSorted(tr) {
  const rows = els.tbody.children;
  for (let i = 0; i < rows.length; i++) {
    if (compareRows(tr._data, rows[i]._data) < 0) {
      els.tbody.insertBefore(tr, rows[i]);
      return;
    }
  }
  els.tbody.appendChild(tr);
}

// Reorder all existing rows after a sort change.
function resortRows() {
  const rows = [...els.tbody.children];
  rows.sort((a, b) => compareRows(a._data, b._data));
  for (const tr of rows) els.tbody.appendChild(tr);
  updateSortIndicators();
}

function updateSortIndicators() {
  els.thead.querySelectorAll("th.sortable").forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.key === sortState.key) {
      th.classList.add(sortState.dir === 1 ? "sort-asc" : "sort-desc");
    }
  });
}

function onHeaderClick(ev) {
  const th = ev.target.closest("th.sortable");
  if (!th) return;
  const key = th.dataset.key;
  if (sortState.key === key) sortState.dir *= -1;
  else sortState = { key, dir: 1 };
  resortRows();
}

function addResult(r) {
  const existing = rowsByIp.get(r.ip);
  if (existing) {
    fillRow(existing.tr, r);
    existing.tr._data = r;
    existing.data = r;
    applyRowVisibility(existing.tr, r);
  } else {
    const tr = makeRow(r);
    rowsByIp.set(r.ip, { tr, data: r });
    insertSorted(tr);
    applyRowVisibility(tr, r);
  }
  if (r.state !== "dead") stats.alive++;
  if (r.state === "ports") stats.ports++;
  updateCounts();
}

// --- Filtering ---------------------------------------------------------------

function currentFilters() {
  return {
    status: els.statusFilter.value,
    text: els.search.value.trim().toLowerCase(),
    port: parseInt(els.portFilter.value, 10),
  };
}

function matchesFilters(r, f) {
  // Status filter
  if (f.status === "alive" && r.state === "dead") return false;
  if (f.status === "ports" && r.state !== "ports") return false;
  if (f.status === "dead" && r.state !== "dead") return false;

  // Open-port filter
  if (Number.isInteger(f.port)) {
    if (!r.open_ports || !r.open_ports.includes(f.port)) return false;
  }

  // Free-text filter across IP, hostname, web server and ports
  if (f.text) {
    const hay = [
      r.ip,
      r.hostname || "",
      r.web || "",
      (r.open_ports || []).join(","),
    ]
      .join(" ")
      .toLowerCase();
    if (!hay.includes(f.text)) return false;
  }
  return true;
}

function applyRowVisibility(tr, r, f = currentFilters()) {
  tr.style.display = matchesFilters(r, f) ? "" : "none";
}

function applyAllFilters() {
  const f = currentFilters();
  for (const { tr, data } of rowsByIp.values()) {
    applyRowVisibility(tr, data, f);
  }
  updateCounts();
}

function visibleCount() {
  let n = 0;
  for (const { tr } of rowsByIp.values()) {
    if (tr.style.display !== "none") n++;
  }
  return n;
}

function clearFilters() {
  els.statusFilter.value = "all";
  els.search.value = "";
  els.portFilter.value = "";
  applyAllFilters();
}

function updateCounts() {
  const shown = visibleCount();
  const filtered = els.statusFilter.value !== "all" || els.search.value.trim() || els.portFilter.value;
  const display = filtered ? `Showing ${shown}/${rowsByIp.size}` : `Display: All (${rowsByIp.size})`;
  els.counts.textContent = `${display}  |  Alive: ${stats.alive}  |  Open ports: ${stats.ports}  |  Scanned: ${stats.done}/${stats.total}`;
}

function setScanning(on) {
  scanning = on;
  els.startBtn.disabled = on;
  els.stopBtn.disabled = !on;
  [els.start, els.end, els.ports, els.threads, els.timeout, els.presetLocal].forEach(
    (e) => (e.disabled = on)
  );
}

async function startScan() {
  expandCidrInputs();
  const ports = parsePorts(els.ports.value);
  if (ports.length === 0) {
    els.status.textContent = "Enter at least one valid port.";
    return;
  }
  els.tbody.innerHTML = "";
  rowsByIp = new Map();
  stats = { total: 0, done: 0, alive: 0, ports: 0 };
  els.progressBar.style.width = "0%";
  appWindow.setTitle(`0% — ${APP_TITLE}`);
  updateCounts();
  setScanning(true);
  els.status.textContent = "Scanning…";

  try {
    await invoke("scan", {
      options: {
        start: els.start.value.trim(),
        end: els.end.value.trim(),
        ports,
        threads: parseInt(els.threads.value, 10) || 100,
        timeout_ms: parseInt(els.timeout.value, 10) || 1000,
      },
    });
  } catch (e) {
    els.status.textContent = `Error: ${e}`;
    setScanning(false);
  }
}

async function stopScan() {
  els.status.textContent = "Stopping…";
  await invoke("cancel_scan");
}

async function detectLocalSubnet() {
  els.status.textContent = "Detecting local subnet…";
  let ip = null;
  try {
    ip = await invoke("local_ipv4");
  } catch (_) {
    /* ignore */
  }
  if (ip) {
    const p = ip.split(".");
    els.start.value = `${p[0]}.${p[1]}.${p[2]}.1`;
    els.end.value = `${p[0]}.${p[1]}.${p[2]}.254`;
    els.status.textContent = `Local subnet ${p[0]}.${p[1]}.${p[2]}.0/24 (this host: ${ip})`;
  } else {
    els.start.value = "192.168.1.1";
    els.end.value = "192.168.1.254";
    els.status.textContent = "Couldn't detect local IP — defaulted to 192.168.1.0/24.";
  }
}

// --- Export ------------------------------------------------------------------

// Currently visible rows, in display (sorted) order.
function collectVisible() {
  return [...els.tbody.children]
    .filter((tr) => tr.style.display !== "none")
    .map((tr) => tr._data);
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const head = ["IP", "Status", "Ping (ms)", "Hostname", "Open Ports", "Web Server"];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push(
      [r.ip, r.state, r.ping_ms ?? "", r.hostname ?? "", (r.open_ports || []).join(" "), r.web ?? ""]
        .map(csvEscape)
        .join(",")
    );
  }
  return lines.join("\n");
}

function toJson(rows) {
  return JSON.stringify(
    rows.map((r) => ({
      ip: r.ip,
      status: r.state,
      ping_ms: r.ping_ms ?? null,
      hostname: r.hostname ?? null,
      open_ports: r.open_ports || [],
      web: r.web ?? null,
    })),
    null,
    2
  );
}

async function exportResults(format) {
  const rows = collectVisible();
  if (rows.length === 0) {
    els.status.textContent = "Nothing to export.";
    return;
  }
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const name = `ip-scan-${ts}.${format}`;
  const content = format === "csv" ? toCsv(rows) : toJson(rows);
  try {
    const path = await invoke("export_results", { defaultName: name, content });
    els.status.textContent = path
      ? `Exported ${rows.length} row(s) → ${path}`
      : "Export cancelled.";
  } catch (e) {
    els.status.textContent = `Export failed: ${e}`;
  }
}

els.startBtn.addEventListener("click", startScan);
els.stopBtn.addEventListener("click", stopScan);
els.presetLocal.addEventListener("click", detectLocalSubnet);

els.statusFilter.addEventListener("change", applyAllFilters);
els.search.addEventListener("input", applyAllFilters);
els.portFilter.addEventListener("input", applyAllFilters);
els.clearFilters.addEventListener("click", clearFilters);

els.exportCsv.addEventListener("click", () => exportResults("csv"));
els.exportJson.addEventListener("click", () => exportResults("json"));
els.thead.addEventListener("click", onHeaderClick);
updateSortIndicators();

[els.start, els.end, els.ports].forEach((e) =>
  e.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !scanning) startScan();
  })
);

listen("scan-started", (e) => {
  stats.total = e.payload.total;
  els.threadStatus.textContent = `Threads: ${els.threads.value}`;
  updateCounts();
});

listen("scan-result", (e) => addResult(e.payload));

listen("scan-progress", (e) => {
  stats.done = e.payload.done;
  const pct = stats.total ? (stats.done / stats.total) * 100 : 0;
  els.progressBar.style.width = `${pct}%`;
  appWindow.setTitle(`${Math.round(pct)}% — ${APP_TITLE}`);
  updateCounts();
});

listen("scan-finished", (e) => {
  setScanning(false);
  els.threadStatus.textContent = "Threads: 0";
  els.progressBar.style.width = "100%";
  appWindow.setTitle(APP_TITLE);
  els.status.textContent = e.payload.cancelled
    ? `Stopped. Scanned ${stats.done}/${stats.total}.`
    : `Done. ${stats.alive} hosts alive of ${stats.total}.`;
});
