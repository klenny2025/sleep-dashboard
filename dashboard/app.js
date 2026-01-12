const API_BASE = (window.__API_BASE__ || "").replace(/\/$/, "");
const MIN_SLEEP_MINUTES = Number(window.__MIN_SLEEP_MINUTES__ || 345);
const page = document.body?.dataset?.page || "";

function $(id) { return document.getElementById(id); }
function qsa(sel) { return Array.from(document.querySelectorAll(sel)); }
function qs(sel) { return document.querySelector(sel); }

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pct(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Number(v).toFixed(1)}%`;
}

function isoToday() { return new Date().toISOString().slice(0, 10); }
function isoMonth() { return new Date().toISOString().slice(0, 7); }

async function apiGet(path) {
  const resp = await fetch(`${API_BASE}${path}`, { headers: { "Accept": "application/json" } });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data) throw new Error(data?.error || `HTTP ${resp.status}`);
  return data;
}

async function apiWrite(method, path, bodyObj, apiKey) {
  const headers = { "Content-Type": "application/json", "Accept": "application/json" };
  if (apiKey) headers["X-API-KEY"] = apiKey;

  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: bodyObj ? JSON.stringify(bodyObj) : undefined
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data) throw new Error(data?.error || `HTTP ${resp.status}`);
  return data;
}

function setActiveNav() {
  const key = page || "home";
  qsa(".nav a").forEach(a => {
    if (a.dataset.nav === key) a.classList.add("active");
  });
}

function normalizeUrlForDisplay(url) {
  if (!url) return "";
  // If API stored relative URL ("/media/..."), make it absolute to current page origin.
  if (url.startsWith("/")) return `${window.location.origin}${url}`;
  return url;
}

function fileLinks(image_url, pdf_url) {
  const parts = [];
  if (image_url) parts.push(`<a class="link" href="${escapeHtml(normalizeUrlForDisplay(image_url))}" target="_blank" rel="noopener">Imagen</a>`);
  if (pdf_url) parts.push(`<a class="link" href="${escapeHtml(normalizeUrlForDisplay(pdf_url))}" target="_blank" rel="noopener">PDF</a>`);
  return parts.length ? parts.join(" · ") : `<span class="small">—</span>`;
}

function statusFromEntry(e) {
  // Pending: OCR failed or explicit status
  const st = (e.status || "").toUpperCase();
  if (st === "PENDING" || (e.sleep_text || "").toUpperCase().includes("PENDIENTE") || e.duration_min == null) {
    return { key: "pending", label: "Pendiente", cls: "pending" };
  }
  if (typeof e.duration_min === "number" && e.duration_min >= MIN_SLEEP_MINUTES) {
    return { key: "ok", label: "Cumple", cls: "ok" };
  }
  return { key: "bad", label: "No cumple", cls: "bad" };
}

function badgeHtml(e) {
  const s = statusFromEntry(e);
  return `<span class="badge ${s.cls}">${s.label}</span>`;
}

/* HOME */
function renderHome(today) {
  $("todayMeta").textContent = today.holiday_summary?.length
    ? `Feriado: ${today.holiday_summary.map(h=>h.name).join(" | ")}`
    : "Sin feriado configurado";

  const reg = today.registered || [];
  const pend = today.pending || [];

  // Table registered
  const rb = qs("#registeredTable tbody");
  rb.innerHTML = reg.length ? reg.map(r => {
    return `<tr>
      <td>${escapeHtml(r.worker_name)}</td>
      <td>${escapeHtml(r.sleep_text || "PENDIENTE")}</td>
      <td>${badgeHtml(r)}</td>
      <td>${fileLinks(r.image_url, r.pdf_url)}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="4" class="small">Sin registros</td></tr>`;

  // Table pending
  const pb = qs("#pendingTable tbody");
  pb.innerHTML = pend.length ? pend.map(p => `<tr>
    <td>${escapeHtml(p.worker_name)}</td>
    <td class="small">No registró (día requerido)</td>
  </tr>`).join("") : `<tr><td colspan="2" class="small">Nadie pendiente</td></tr>`;

  // Cards - union of workers known in system (from today payload)
  const all = [...new Set([...reg.map(r => r.worker_name), ...pend.map(p => p.worker_name)])]
    .sort((a,b)=>a.localeCompare(b));

  const cards = $("cardsGrid");
  cards.innerHTML = all.length ? all.map(name => {
    const r = reg.find(x => x.worker_name === name);
    if (r) {
      const s = statusFromEntry(r);
      return `<div class="card-mini">
        <div class="name">${escapeHtml(name)}</div>
        <div class="sleep">${escapeHtml(r.sleep_text || "PENDIENTE")}</div>
        <div style="margin-top:8px">${badgeHtml(r)}</div>
        <div class="files">${fileLinks(r.image_url, r.pdf_url)}</div>
      </div>`;
    }
    return `<div class="card-mini">
      <div class="name">${escapeHtml(name)}</div>
      <div class="sleep">—</div>
      <div style="margin-top:8px"><span class="badge pending">Pendiente</span></div>
      <div class="files">Sin entrega</div>
    </div>`;
  }).join("") : `<div class="small">Aún no hay trabajadores. Se crean automáticamente con el primer registro.</div>`;
}

async function refreshHome() {
  const date = $("todayPicker").value;
  $("refreshBtn").disabled = true;
  try {
    const data = await apiGet(`/api/today?date=${encodeURIComponent(date)}`);
    renderHome(data);
  } finally {
    $("refreshBtn").disabled = false;
  }
}

function initHome() {
  $("todayPicker").value = isoToday();
  $("refreshBtn").addEventListener("click", refreshHome);
  $("todayPicker").addEventListener("change", refreshHome);
  refreshHome().catch(err => alert(err.message || err));
}

/* MONTHLY */
let chart = null;
let rankingData = [];
let holidaysData = [];

function renderRankingTable(filterText = "") {
  const q = (filterText || "").trim().toLowerCase();
  const body = qs("#rankingTable tbody");
  const rows = rankingData.filter(r => r.worker_name.toLowerCase().includes(q));
  body.innerHTML = rows.length ? rows.map(r => {
    const compliance = r.cumplimiento_pct == null ? "—" : pct(r.cumplimiento_pct);
    const width = r.cumplimiento_pct == null ? 0 : Math.max(0, Math.min(100, r.cumplimiento_pct));
    return `<tr>
      <td>${escapeHtml(r.worker_name)}</td>
      <td>${r.dias_con_registro}</td>
      <td>${r.dias_requeridos}</td>
      <td>
        <div class="barrow">
          <span class="mono">${compliance}</span>
          <div class="bar"><div class="barfill" style="width:${width}%"></div></div>
        </div>
      </td>
      <td>${escapeHtml(r.promedio_sueno || "—")}</td>
      <td>${escapeHtml(r.max_sueno || "—")}</td>
      <td>${escapeHtml(r.min_sueno || "—")}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="7" class="small">Sin resultados</td></tr>`;
}

function renderMonthly(resp, month) {
  const kpi = resp.kpi || {};
  $("kpiCompliance").textContent = kpi.cumplimiento_promedio_pct == null ? "—" : pct(kpi.cumplimiento_promedio_pct);
  $("kpiSleepAvg").textContent = kpi.promedio_sueno_mes || "—";

  const top = $("kpiTop3"); top.innerHTML = "";
  (kpi.top3 || []).forEach(x => {
    const li = document.createElement("li");
    li.textContent = `${x.worker_name} — ${x.cumplimiento_pct == null ? "—" : pct(x.cumplimiento_pct)}`;
    top.appendChild(li);
  });
  if (!(kpi.top3 || []).length) top.innerHTML = "<li>—</li>";

  const bottom = $("kpiBottom3"); bottom.innerHTML = "";
  (kpi.bottom3 || []).forEach(x => {
    const li = document.createElement("li");
    li.textContent = `${x.worker_name} — ${x.cumplimiento_pct == null ? "—" : pct(x.cumplimiento_pct)}`;
    bottom.appendChild(li);
  });
  if (!(kpi.bottom3 || []).length) bottom.innerHTML = "<li>—</li>";

  $("monthMeta").textContent = `Mes: ${month} · Trabajadores: ${rankingData.length}`;

  if (window.Chart) {
    const labels = rankingData.map(r => r.worker_name);
    const values = rankingData.map(r => (typeof r.cumplimiento_pct === "number" ? r.cumplimiento_pct : 0));
    const ctx = $("rankChart");
    if (chart) chart.destroy();
    chart = new Chart(ctx, {
      type: "bar",
      data: { labels, datasets: [{ label: "Cumplimiento (%)", data: values, borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, max: 100 } }, plugins: { legend: { display: false } } }
    });
  }

  renderRankingTable($("rankFilter").value);
}

function renderHolidaysTable() {
  const body = qs("#holidaysTable tbody");
  body.innerHTML = holidaysData.length ? holidaysData.map(h => {
    return `<tr>
      <td class="mono">${escapeHtml(h.date)}</td>
      <td>${escapeHtml(h.name)}</td>
      <td>${h.is_required ? "Sí" : "No"}</td>
      <td><a class="btn-mini" href="#" data-del="${escapeHtml(h.date)}">Eliminar</a></td>
    </tr>`;
  }).join("") : `<tr><td colspan="4" class="small">Sin feriados</td></tr>`;

  qsa('[data-del]').forEach(a => {
    a.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const date = a.getAttribute("data-del");
      const apiKey = prompt("API KEY (para eliminar feriado):");
      if (!apiKey) return;
      await apiWrite("DELETE", `/api/holidays?date=${encodeURIComponent(date)}&country=PE`, null, apiKey);
      await refreshHolidays();
    });
  });
}

async function refreshHolidays() {
  const year = Number(($("monthPicker").value || isoMonth()).slice(0,4));
  const resp = await apiGet(`/api/holidays?year=${year}&country=PE`);
  holidaysData = resp.holidays || [];
  $("holidayMeta").textContent = `Año: ${year} · Feriados: ${holidaysData.length}`;
  renderHolidaysTable();
}

async function refreshMonthly() {
  const month = $("monthPicker").value;
  $("refreshBtn").disabled = true;
  try {
    const resp = await apiGet(`/api/ranking?month=${encodeURIComponent(month)}`);
    rankingData = (resp.ranking || []).slice().sort((a,b)=>(b.cumplimiento_pct||0)-(a.cumplimiento_pct||0));
    renderMonthly(resp, month);
    await refreshHolidays();
  } finally {
    $("refreshBtn").disabled = false;
  }
}

function initMonthly() {
  $("monthPicker").value = isoMonth();
  $("refreshBtn").addEventListener("click", refreshMonthly);
  $("monthPicker").addEventListener("change", refreshMonthly);
  $("rankFilter").addEventListener("input", () => renderRankingTable($("rankFilter").value));

  $("addHolidayBtn").addEventListener("click", async () => {
    const date = $("holidayDate").value;
    const name = $("holidayName").value.trim();
    const is_required = Number($("holidayRequired").value || "0");
    if (!date || !name) return alert("Completa fecha y nombre.");
    const apiKey = prompt("API KEY (para agregar feriado):");
    if (!apiKey) return;
    await apiWrite("POST", "/api/holidays", { date, country_code: "PE", name, is_required }, apiKey);
    $("holidayName").value = "";
    await refreshHolidays();
  });

  $("seedHolidaysBtn").addEventListener("click", async () => {
    const apiKey = prompt("API KEY (para cargar feriados 2026–2030):");
    if (!apiKey) return;
    await apiWrite("POST", "/api/holidays/seed", { country_code: "PE", start_year: 2026, years: 5 }, apiKey);
    await refreshHolidays();
  });

  $("seedDemoBtn").addEventListener("click", async () => {
    const apiKey = prompt("API KEY (para crear demo):");
    if (!apiKey) return;
    await apiWrite("POST", "/api/demo/seed", null, apiKey);
    alert("Demo creado. Ve a Hoy/Registros/Archivos.");
    await refreshMonthly();
  });

  $("clearDemoBtn").addEventListener("click", async () => {
    const apiKey = prompt("API KEY (para borrar demo):");
    if (!apiKey) return;
    await apiWrite("DELETE", "/api/demo/clear", null, apiKey);
    alert("Demo borrado.");
    await refreshMonthly();
  });

  refreshMonthly().catch(err => alert(err.message || err));
}

/* RECORDS */
let entriesData = [];
function renderEntries(filterText = "") {
  const q = (filterText || "").trim().toLowerCase();
  const body = qs("#entriesTable tbody");
  const rows = entriesData.filter(e => e.worker_name.toLowerCase().includes(q));
  body.innerHTML = rows.length ? rows.map(e => {
    return `<tr>
      <td class="mono">${escapeHtml(e.date)}</td>
      <td>${escapeHtml(e.worker_name)}</td>
      <td>${escapeHtml(e.sleep_text || "PENDIENTE")}</td>
      <td>${badgeHtml(e)}</td>
      <td>${escapeHtml(e.source || "—")}</td>
      <td>${fileLinks(e.image_url, e.pdf_url)}</td>
      <td class="mono">${escapeHtml(e.created_at || "—")}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="7" class="small">Sin resultados</td></tr>`;
}
async function refreshRecords() {
  const month = $("monthPicker").value;
  $("refreshBtn").disabled = true;
  try {
    const resp = await apiGet(`/api/entries?month=${encodeURIComponent(month)}`);
    entriesData = resp.entries || [];
    $("entriesMeta").textContent = `Mes: ${month} · Consolidados: ${resp.consolidated_count} (raw: ${resp.raw_count})`;
    renderEntries($("entryFilter").value);
  } finally { $("refreshBtn").disabled = false; }
}
function initRecords() {
  $("monthPicker").value = isoMonth();
  $("refreshBtn").addEventListener("click", refreshRecords);
  $("monthPicker").addEventListener("change", refreshRecords);
  $("entryFilter").addEventListener("input", () => renderEntries($("entryFilter").value));
  refreshRecords().catch(err => alert(err.message || err));
}

/* MEDIA */
let workersList = [];
async function loadWorkers() {
  const resp = await apiGet(`/api/workers`);
  workersList = resp.workers || [];
  const sel = $("workerSelect");
  sel.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = ""; optAll.textContent = "Todos";
  sel.appendChild(optAll);
  for (const w of workersList) {
    const opt = document.createElement("option");
    opt.value = w.worker_key;
    opt.textContent = w.worker_name;
    sel.appendChild(opt);
  }
}
function renderMediaTable(workerKeyFilter) {
  const body = qs("#mediaTable tbody");
  const rows = entriesData.filter(e => (e.image_url || e.pdf_url));
  const filtered = workerKeyFilter ? rows.filter(e => e.worker_key === workerKeyFilter) : rows;
  body.innerHTML = filtered.length ? filtered.map(e => {
    const r2path = `workers/${e.worker_key}/${e.date}/`;
    return `<tr>
      <td class="mono">${escapeHtml(e.date)}</td>
      <td>${escapeHtml(e.worker_name)}</td>
      <td>${escapeHtml(e.sleep_text || "PENDIENTE")}</td>
      <td>${badgeHtml(e)}</td>
      <td>${e.image_url ? `<a class="btn-mini" href="${escapeHtml(normalizeUrlForDisplay(e.image_url))}" target="_blank" rel="noopener">Descargar</a>` : `<span class="small">—</span>`}</td>
      <td>${e.pdf_url ? `<a class="btn-mini" href="${escapeHtml(normalizeUrlForDisplay(e.pdf_url))}" target="_blank" rel="noopener">Descargar</a>` : `<span class="small">—</span>`}</td>
      <td class="mono">${escapeHtml(r2path)}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="7" class="small">No hay archivos</td></tr>`;
}
async function refreshMedia() {
  const month = $("monthPicker").value;
  const workerKey = $("workerSelect").value;
  $("refreshBtn").disabled = true;
  try {
    const resp = await apiGet(`/api/entries?month=${encodeURIComponent(month)}`);
    entriesData = resp.entries || [];
    const total = entriesData.filter(e => e.image_url || e.pdf_url).length;
    $("mediaMeta").textContent = `Mes: ${month} · Con archivos: ${total}`;
    renderMediaTable(workerKey);
  } finally { $("refreshBtn").disabled = false; }
}
function initMedia() {
  $("monthPicker").value = isoMonth();
  $("refreshBtn").addEventListener("click", refreshMedia);
  $("monthPicker").addEventListener("change", refreshMedia);
  $("workerSelect").addEventListener("change", refreshMedia);
  loadWorkers().then(refreshMedia).catch(err => alert(err.message || err));
}

/* Init */
setActiveNav();

if (page === "home") {
  $("todayPicker").value = isoToday();
  $("refreshBtn").addEventListener("click", refreshHome);
  $("todayPicker").addEventListener("change", refreshHome);
  refreshHome().catch(err => alert(err.message || err));
}
if (page === "monthly") initMonthly();
if (page === "records") initRecords();
if (page === "media") initMedia();
