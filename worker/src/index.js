/**
 * Registro iSleep – RB&RD
 * Cloudflare Worker + D1
 *
 * Auth:
 *  - Protected endpoints require header: X-API-KEY == env.API_KEY (secret)
 *
 * Notes:
 *  - OCR failure should send { status: "PENDING", image_url/pdf_url }.
 *  - We store: sleep_text = "PENDIENTE", duration_min = NULL, sleep_h/sleep_m = 0.
 */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN || "*";
  const allowOrigin = allowed === "*" ? "*" : origin;

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Vary": allowed === "*" ? "Origin" : "Origin",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-KEY",
  };
}

function isAuthorized(env, request) {
  const key = request.headers.get("X-API-KEY") || "";
  return Boolean(env.API_KEY) && key === env.API_KEY;
}

function badRequest(msg) { return json({ ok: false, error: msg }, 400); }
function unauthorized() { return json({ ok: false, error: "Unauthorized" }, 401); }

function parseJSON(request) {
  return request.json().catch(() => null);
}

function slugify(input) {
  return String(input || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function isIsoMonth(s) {
  return typeof s === "string" && /^\d{4}-\d{2}$/.test(s);
}
function monthRange(month) {
  // month: YYYY-MM
  const [y, m] = month.split("-").map(Number);
  const start = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
  const next = new Date(Date.UTC(y, m, 1)); // next month
  const end_exclusive = next.toISOString().slice(0, 10);
  return { start, end_exclusive };
}

function toMinutes(h, m) {
  if (h == null || m == null) return null;
  return (Number(h) * 60) + Number(m);
}
function fmtDuration(h, m) {
  return `${Number(h)} h ${Number(m)} min`;
}
function fmtDurationFromMinutes(totalMin) {
  if (totalMin == null) return null;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h} h ${m} min`;
}

// Easter (Anonymous Gregorian algorithm) for moveable holidays
function easterDate(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=Mar, 4=Apr
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.toISOString().slice(0, 10);
}

function addDays(isoDateStr, delta) {
  const [y,m,d] = isoDateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m-1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0,10);
}

function peruvianHolidaysForYear(year) {
  // Fixed-date holidays commonly observed (may change by law; editable in DB via dashboard)
  const fixed = [
    ["01-01", "Año Nuevo"],
    ["05-01", "Día del Trabajo"],
    ["06-29", "San Pedro y San Pablo"],
    ["07-28", "Fiestas Patrias"],
    ["07-29", "Fiestas Patrias"],
    ["08-30", "Santa Rosa de Lima"],
    ["10-08", "Combate de Angamos"],
    ["11-01", "Todos los Santos"],
    ["12-08", "Inmaculada Concepción"],
    ["12-25", "Navidad"],
  ];
  // Moveable: Maundy Thursday & Good Friday (based on Easter Sunday)
  const easter = easterDate(year);
  const holyThu = addDays(easter, -3);
  const goodFri = addDays(easter, -2);

  const list = fixed.map(([md, name]) => ({
    date: `${year}-${md}`,
    name,
    is_required: 0,
    country_code: "PE",
  }));

  list.push({ date: holyThu, name: "Jueves Santo", is_required: 0, country_code: "PE" });
  list.push({ date: goodFri, name: "Viernes Santo", is_required: 0, country_code: "PE" });

  return list;
}

async function ensureWorker(env, worker_name) {
  const worker_key = slugify(worker_name);
  if (!worker_key) throw new Error("worker_name inválido");

  const existing = await env.DB.prepare(
    `SELECT id, worker_name, worker_key, country_code, timezone, required_schedule, exclude_holidays
     FROM workers WHERE worker_key = ?`
  ).bind(worker_key).first();

  if (existing) return existing;

  await env.DB.prepare(
    `INSERT INTO workers (worker_name, worker_key, country_code, timezone, required_schedule, exclude_holidays)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    worker_name,
    worker_key,
    env.DEFAULT_COUNTRY || "PE",
    env.DEFAULT_TIMEZONE || "America/Lima",
    env.DEFAULT_REQUIRED_SCHEDULE || "MON_FRI",
    Number(env.DEFAULT_EXCLUDE_HOLIDAYS || "1")
  ).run();

  return await env.DB.prepare(
    `SELECT id, worker_name, worker_key, country_code, timezone, required_schedule, exclude_holidays
     FROM workers WHERE worker_key = ?`
  ).bind(worker_key).first();
}

function requiredBySchedule(required_schedule, isoDateStr) {
  // isoDateStr in UTC; day-of-week computed in UTC is OK for required schedule (business rule)
  const [y,m,d] = isoDateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y,m-1,d));
  const dow = dt.getUTCDay(); // 0=Sun..6=Sat

  if (required_schedule === "ALL_DAYS") return true;
  if (required_schedule === "MON_SAT") return dow >= 1 && dow <= 6;
  // default MON_FRI
  return dow >= 1 && dow <= 5;
}

async function isHoliday(env, isoDateStr, country_code) {
  const h = await env.DB.prepare(
    `SELECT date, name, is_required FROM holidays WHERE date = ? AND country_code = ?`
  ).bind(isoDateStr, country_code).first();
  return h || null;
}

async function getToday(env, date) {
  const workers = await env.DB.prepare(
    `SELECT worker_name, worker_key, country_code, required_schedule, exclude_holidays
     FROM workers WHERE is_active = 1 ORDER BY worker_name`
  ).all();
  const ws = workers.results || [];

  // Get best entry per worker for that date (prefer OK with max duration, then latest; else latest PENDING)
  const entries = await env.DB.prepare(
    `WITH ranked AS (
       SELECT worker_name, worker_key, date, sleep_text, duration_min, status, source, created_at, image_url, pdf_url,
              ROW_NUMBER() OVER (
                PARTITION BY worker_key, date
                ORDER BY (duration_min IS NULL) ASC, duration_min DESC, created_at DESC
              ) AS rn
       FROM workers_sleep_entries
       WHERE date = ?
     )
     SELECT worker_name, worker_key, date, sleep_text, duration_min, status, source, created_at, image_url, pdf_url
     FROM ranked WHERE rn = 1`
  ).bind(date).all();

  const best = new Map();
  for (const e of (entries.results || [])) best.set(e.worker_key, e);

  const holidayByCountry = new Map();
  for (const w of ws) {
    if (!holidayByCountry.has(w.country_code)) {
      const h = await isHoliday(env, date, w.country_code);
      holidayByCountry.set(w.country_code, h);
    }
  }

  const registered = [];
  const pending = [];
  const registered_not_required = [];
  const holiday_summary = [];

  for (const [country, h] of holidayByCountry.entries()) {
    if (h) holiday_summary.push({ country_code: country, name: h.name, is_required: Boolean(h.is_required) });
  }

  for (const w of ws) {
    const h = holidayByCountry.get(w.country_code) || null;
    const schedule_required = requiredBySchedule(w.required_schedule, date);
    const required_today = schedule_required && !(w.exclude_holidays && h && !h.is_required);

    const e = best.get(w.worker_key);
    if (e) {
      const item = {
        worker_name: w.worker_name,
        worker_key: w.worker_key,
        sleep_text: e.sleep_text,
        duration_min: e.duration_min,
        status: e.status,
        source: e.source,
        created_at: e.created_at,
        image_url: e.image_url,
        pdf_url: e.pdf_url,
        required_today,
        is_holiday: Boolean(h),
        holiday_name: h?.name || "",
      };
      registered.push(item);
      if (!required_today) registered_not_required.push(item);
    } else {
      if (required_today) pending.push({ worker_name: w.worker_name, worker_key: w.worker_key });
    }
  }

  return {
    ok: true,
    date,
    registered_count: registered.length,
    pending_count: pending.length,
    registered,
    pending,
    registered_not_required,
    holiday_summary,
  };
}

async function getEntries(env, month) {
  const { start, end_exclusive } = monthRange(month);

  // Raw count
  const rawCount = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM workers_sleep_entries WHERE date >= ? AND date < ?`
  ).bind(start, end_exclusive).first();

  // Consolidated: best per worker/day (same rule as today)
  const res = await env.DB.prepare(
    `WITH ranked AS (
       SELECT id, worker_id, worker_name, worker_key, date, sleep_h, sleep_m, sleep_text, duration_min, status,
              source, chat_id, file_id, notes, raw_text, image_url, pdf_url, created_at,
              ROW_NUMBER() OVER (
                PARTITION BY worker_key, date
                ORDER BY (duration_min IS NULL) ASC, duration_min DESC, created_at DESC
              ) AS rn
       FROM workers_sleep_entries
       WHERE date >= ? AND date < ?
     )
     SELECT * FROM ranked WHERE rn = 1
     ORDER BY date DESC, worker_name ASC`
  ).bind(start, end_exclusive).all();

  return json({
    ok: true,
    month,
    range: { start, end_exclusive },
    raw_count: rawCount?.c || 0,
    consolidated_count: (res.results || []).length,
    entries: res.results || [],
  });
}

async function getRanking(env, month) {
  const { start, end_exclusive } = monthRange(month);

  const workers = await env.DB.prepare(
    `SELECT worker_name, worker_key, country_code, required_schedule, exclude_holidays
     FROM workers WHERE is_active = 1 ORDER BY worker_name`
  ).all();
  const ws = workers.results || [];

  // Consolidated entries per day (best)
  const cons = await env.DB.prepare(
    `WITH ranked AS (
       SELECT worker_key, worker_name, date, duration_min, sleep_text, status, created_at,
              ROW_NUMBER() OVER (
                PARTITION BY worker_key, date
                ORDER BY (duration_min IS NULL) ASC, duration_min DESC, created_at DESC
              ) AS rn
       FROM workers_sleep_entries
       WHERE date >= ? AND date < ?
     )
     SELECT worker_key, worker_name, date, duration_min, sleep_text, status
     FROM ranked WHERE rn = 1`
  ).bind(start, end_exclusive).all();
  const entries = cons.results || [];

  const byWorker = new Map();
  for (const w of ws) byWorker.set(w.worker_key, { w, days: new Set(), durations: [] });

  for (const e of entries) {
    const o = byWorker.get(e.worker_key);
    if (!o) continue;
    o.days.add(e.date);
    if (typeof e.duration_min === "number") o.durations.push(e.duration_min);
  }

  // Preload holidays for involved years/month range
  const year = Number(month.slice(0, 4));
  const holidays = await env.DB.prepare(
    `SELECT date, country_code, name, is_required FROM holidays WHERE date >= ? AND date < ?`
  ).bind(start, end_exclusive).all();
  const hs = holidays.results || [];

  const holidaySet = new Map(); // key country_code|date => {is_required,name}
  for (const h of hs) holidaySet.set(`${h.country_code}|${h.date}`, { is_required: Boolean(h.is_required), name: h.name });

  // Compute required days for each worker
  function daysInMonthRange() {
    const dates = [];
    let cur = start;
    while (cur < end_exclusive) {
      dates.push(cur);
      cur = addDays(cur, 1);
    }
    return dates;
  }
  const allDates = daysInMonthRange();

  const rows = [];
  for (const { w, days, durations } of byWorker.values()) {
    let required = 0;
    for (const d of allDates) {
      const schedule_required = requiredBySchedule(w.required_schedule, d);
      if (!schedule_required) continue;

      const h = holidaySet.get(`${w.country_code}|${d}`) || null;
      const required_today = schedule_required && !(w.exclude_holidays && h && !h.is_required);
      if (required_today) required++;
    }

    const dias_con_registro = days.size;
    const dias_requeridos = required;
    const cumplimiento_pct = dias_requeridos > 0 ? (dias_con_registro / dias_requeridos) * 100 : null;

    let avgMin = null, maxMin = null, minMin = null;
    if (durations.length) {
      const sum = durations.reduce((a, b) => a + b, 0);
      avgMin = Math.round(sum / durations.length);
      maxMin = Math.max(...durations);
      minMin = Math.min(...durations);
    }

    rows.push({
      worker_name: w.worker_name,
      worker_key: w.worker_key,
      country_code: w.country_code,
      required_schedule: w.required_schedule,
      exclude_holidays: Boolean(w.exclude_holidays),

      dias_con_registro,
      dias_requeridos,
      cumplimiento_pct: cumplimiento_pct == null ? null : Number(cumplimiento_pct.toFixed(1)),

      promedio_sueno: fmtDurationFromMinutes(avgMin),
      max_sueno: fmtDurationFromMinutes(maxMin),
      min_sueno: fmtDurationFromMinutes(minMin),

      total_registros: dias_con_registro,
    });
  }

  // KPI
  const withReq = rows.filter(r => r.dias_requeridos > 0);
  const cumplimiento_promedio_pct = withReq.length
    ? Number((withReq.reduce((a, r) => a + (r.cumplimiento_pct || 0), 0) / withReq.length).toFixed(1))
    : null;

  // Avg sleep across workers (average of their avg minutes)
  const avgMinutes = rows
    .map(r => r.promedio_sueno ? r : null)
    .filter(Boolean)
    .map(r => r.promedio_sueno)
    .length ? null : null;

  // Compute average-of-averages using durations list (more stable):
  const allDur = [];
  for (const { durations } of byWorker.values()) allDur.push(...durations);
  const promMes = allDur.length ? fmtDurationFromMinutes(Math.round(allDur.reduce((a,b)=>a+b,0)/allDur.length)) : null;

  const sorted = [...rows].sort((a, b) => (b.cumplimiento_pct || 0) - (a.cumplimiento_pct || 0));
  const top3 = sorted.slice(0, 3);
  const bottom3 = [...sorted].reverse().slice(0, 3);

  return json({
    ok: true,
    month,
    range: { start, end_exclusive },
    kpi: {
      cumplimiento_promedio_pct,
      promedio_sueno_mes: promMes,
      top3,
      bottom3,
    },
    ranking: sorted,
  });
}

async function getHolidays(env, year, country) {
  const start = `${year}-01-01`;
  const end = `${year+1}-01-01`;
  const res = await env.DB.prepare(
    `SELECT date, country_code, name, is_required
     FROM holidays WHERE country_code = ? AND date >= ? AND date < ?
     ORDER BY date`
  ).bind(country, start, end).all();
  return json({ ok: true, year, country, holidays: res.results || [] });
}

async function addHoliday(env, body) {
  const date = body?.date;
  const country_code = (body?.country_code || "PE").toUpperCase();
  const name = body?.name;
  const is_required = Number(body?.is_required || 0);

  if (!isIsoDate(date)) return badRequest("date inválido (YYYY-MM-DD)");
  if (!name || String(name).trim().length < 2) return badRequest("name requerido");
  await env.DB.prepare(
    `INSERT INTO holidays(date, country_code, name, is_required)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(date, country_code) DO UPDATE SET name=excluded.name, is_required=excluded.is_required`
  ).bind(date, country_code, String(name).trim(), is_required ? 1 : 0).run();

  return json({ ok: true });
}

async function deleteHoliday(env, url) {
  const date = url.searchParams.get("date") || "";
  const country = (url.searchParams.get("country") || "PE").toUpperCase();
  if (!isIsoDate(date)) return badRequest("date inválido");
  await env.DB.prepare(`DELETE FROM holidays WHERE date = ? AND country_code = ?`).bind(date, country).run();
  return json({ ok: true });
}

async function seedHolidays(env, body) {
  const country = (body?.country_code || "PE").toUpperCase();
  const start_year = Number(body?.start_year || 2026);
  const years = Math.min(10, Math.max(1, Number(body?.years || 5)));

  if (country !== "PE") return badRequest("Solo PE implementado por ahora.");
  for (let y = start_year; y < start_year + years; y++) {
    const list = peruvianHolidaysForYear(y);
    for (const h of list) {
      await env.DB.prepare(
        `INSERT INTO holidays(date, country_code, name, is_required)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(date, country_code) DO UPDATE SET name=excluded.name, is_required=excluded.is_required`
      ).bind(h.date, h.country_code, h.name, h.is_required ? 1 : 0).run();
    }
  }
  return json({ ok: true, seeded_years: years, start_year });
}

async function createEntry(env, request) {
  const body = await parseJSON(request);
  if (!body) return badRequest("JSON inválido");

  const worker_name = body.worker_name;
  const date = body.date;
  const source = body.source || "manual";
  const chat_id = body.chat_id || null;
  const file_id = body.file_id || null;
  const notes = body.notes || null;
  const raw_text = body.raw_text || null;
  const image_url = body.image_url || null;
  const pdf_url = body.pdf_url || null;

  const status = String(body.status || "OK").toUpperCase(); // OK | PENDING
  if (!worker_name || String(worker_name).trim().length < 2) return badRequest("worker_name requerido");
  if (!isIsoDate(date)) return badRequest("date inválido (YYYY-MM-DD)");

  let sleep_h = body.sleep_h;
  let sleep_m = body.sleep_m;

  let sleep_text = null;
  let duration_min = null;
  let finalStatus = status;

  if (finalStatus === "PENDING") {
    sleep_h = 0;
    sleep_m = 0;
    sleep_text = "PENDIENTE";
    duration_min = null;
  } else {
    if (sleep_h == null || sleep_m == null) {
      return badRequest("sleep_h y sleep_m requeridos o status=PENDING");
    }
    sleep_h = Number(sleep_h);
    sleep_m = Number(sleep_m);

    if (!Number.isInteger(sleep_h) || sleep_h < 0 || sleep_h > 24) return badRequest("sleep_h inválido (0..24)");
    if (!Number.isInteger(sleep_m) || sleep_m < 0 || sleep_m > 59) return badRequest("sleep_m inválido (0..59)");

    duration_min = toMinutes(sleep_h, sleep_m);
    sleep_text = fmtDuration(sleep_h, sleep_m);
    finalStatus = "OK";
  }

  const worker = await ensureWorker(env, String(worker_name).trim());
  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO workers_sleep_entries
      (id, worker_id, worker_name, worker_key, date, sleep_h, sleep_m, sleep_text, duration_min, status,
       source, chat_id, file_id, notes, raw_text, image_url, pdf_url)
     VALUES
      (?,  ?,        ?,          ?,         ?,    ?,       ?,       ?,         ?,           ?,
       ?,      ?,      ?,       ?,      ?,        ?,         ?)`
  ).bind(
    id,
    worker.id,
    worker.worker_name,
    worker.worker_key,
    date,
    sleep_h,
    sleep_m,
    sleep_text,
    duration_min,
    finalStatus,
    source,
    chat_id,
    file_id,
    notes,
    raw_text,
    image_url,
    pdf_url
  ).run();

  return json({
    ok: true,
    id,
    worker_name: worker.worker_name,
    worker_key: worker.worker_key,
    date,
    sleep_h,
    sleep_m,
    sleep_text,
    duration_min,
    status: finalStatus,
    source,
  }, 201);
}

async function getWorkers(env) {
  const res = await env.DB.prepare(
    `SELECT worker_name, worker_key, country_code, required_schedule, exclude_holidays
     FROM workers WHERE is_active = 1 ORDER BY worker_name`
  ).all();
  return json({ ok: true, workers: res.results || [] });
}

async function seedDemo(env) {
  // 3 demo workers + entries (links point to Pages static /media/example/*)
  const demoDate = "2026-01-10";
  const items = [
    {
      worker_name: "Juan Perez",
      date: demoDate,
      sleep_h: 7,
      sleep_m: 15,
      status: "OK",
      image_url: "/media/example/juan_ok.jpg",
      pdf_url: "/media/example/juan_ok.pdf",
    },
    {
      worker_name: "Carlos Diaz",
      date: demoDate,
      sleep_h: 4,
      sleep_m: 30,
      status: "OK",
      image_url: "/media/example/carlos_low.jpg",
      pdf_url: "/media/example/carlos_low.pdf",
    },
    {
      worker_name: "Luis Gomez",
      date: demoDate,
      status: "PENDING",
      image_url: "/media/example/luis_fail.jpg",
      pdf_url: "/media/example/luis_fail.pdf",
      notes: "OCR falló (demo)",
    },
  ];

  for (const it of items) {
    await createEntry(env, new Request("http://internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...it, source: "demo" })
    }));
  }
  return json({ ok: true });
}

async function clearDemo(env) {
  await env.DB.prepare(`DELETE FROM workers_sleep_entries WHERE source = 'demo'`).run();
  // Keep workers; optional cleanup:
  // await env.DB.prepare(`DELETE FROM workers WHERE worker_key IN ('juan_perez','carlos_diaz','luis_gomez')`).run();
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(env, request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    // Health
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "sleep-dashboard-api" }, 200, headers);
    }

    // Public GETs
    if (request.method === "GET" && url.pathname === "/api/workers") {
      return getWorkers(env).then(r => new Response(r.body, { status: r.status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } }));
    }

    if (request.method === "GET" && url.pathname === "/api/entries") {
      const month = url.searchParams.get("month") || "";
      if (!isIsoMonth(month)) return badRequest("month inválido (YYYY-MM)").then(r => new Response(r.body, { status: r.status, headers }));
      return getEntries(env, month).then(r => new Response(r.body, { status: r.status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } }));
    }

    if (request.method === "GET" && url.pathname === "/api/ranking") {
      const month = url.searchParams.get("month") || "";
      if (!isIsoMonth(month)) return badRequest("month inválido (YYYY-MM)").then(r => new Response(r.body, { status: r.status, headers }));
      return getRanking(env, month).then(r => new Response(r.body, { status: r.status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } }));
    }

    if (request.method === "GET" && url.pathname === "/api/today") {
      const date = url.searchParams.get("date") || "";
      if (!isIsoDate(date)) return badRequest("date inválido (YYYY-MM-DD)").then(r => new Response(r.body, { status: r.status, headers }));
      const out = await getToday(env, date);
      return json(out, 200, headers);
    }

    if (request.method === "GET" && url.pathname === "/api/holidays") {
      const year = Number(url.searchParams.get("year") || "");
      const country = (url.searchParams.get("country") || "PE").toUpperCase();
      if (!Number.isInteger(year) || year < 2000 || year > 2100) return json({ ok: false, error: "year inválido" }, 400, headers);
      const res = await getHolidays(env, year, country);
      return new Response(res.body, { status: res.status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
    }

    // Protected routes
    const protectedPaths = [
      "/api/entries",
      "/api/holidays",
      "/api/holidays/seed",
      "/api/demo/seed",
      "/api/demo/clear",
    ];
    if (["POST", "DELETE"].includes(request.method) && protectedPaths.some(p => url.pathname === p || url.pathname.startsWith(p))) {
      if (!isAuthorized(env, request)) return new Response(unauthorized().body, { status: 401, headers });
    }

    if (request.method === "POST" && url.pathname === "/api/entries") {
      const res = await createEntry(env, request);
      return new Response(res.body, { status: res.status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
    }

    if (request.method === "POST" && url.pathname === "/api/holidays") {
      const body = await parseJSON(request);
      if (!body) return new Response(badRequest("JSON inválido").body, { status: 400, headers });
      const res = await addHoliday(env, body);
      return new Response(res.body, { status: res.status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
    }

    if (request.method === "DELETE" && url.pathname === "/api/holidays") {
      const res = await deleteHoliday(env, url);
      return new Response(res.body, { status: res.status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
    }

    if (request.method === "POST" && url.pathname === "/api/holidays/seed") {
      const body = await parseJSON(request);
      const res = await seedHolidays(env, body || {});
      return new Response(res.body, { status: res.status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
    }

    if (request.method === "POST" && url.pathname === "/api/demo/seed") {
      const res = await seedDemo(env);
      return new Response(res.body, { status: res.status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
    }

    if (request.method === "DELETE" && url.pathname === "/api/demo/clear") {
      const res = await clearDemo(env);
      return new Response(res.body, { status: res.status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
    }

    return json({ ok: false, error: "Not found" }, 404, headers);
  }
};
