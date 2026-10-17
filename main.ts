// ============================================================
// Canlitv Proxy — Deno Deploy v2
// Master + nested playlist + hash refresh fix
// ============================================================

const CANLITV_BASE = "https://www.canlitv.you";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const SESSION_COOKIE = "clv_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const HASH_CACHE_MS = 50 * 60 * 1000;
const MANIFEST_CACHE_MS = 1500;

const DEFAULT_CHANNELS = [
  { id: "12013", name: "Kanal 12013", tvgId: "", group: "Canlitv" },
  { id: "12044", name: "Yaban TV", tvgId: "", group: "Canlitv" },
  { id: "12045", name: "Kanal 12045", tvgId: "", group: "Canlitv" },
];

const hashCache: Record<string, any> = {};
const manifestCache: Record<string, any> = {};
const pendingFetch: Record<string, Promise<any> | null> = {};

// ------------------------------------------------------------
// Deno KV
// ------------------------------------------------------------
let kvReady: Promise<Deno.Kv> | null = null;
async function getKv(): Promise<Deno.Kv | null> {
  if (!kvReady) {
    try { kvReady = Deno.openKv(); }
    catch (e) { console.error("KV open failed:", e); return null; }
  }
  try { return await kvReady; }
  catch (e) { console.error("KV await failed:", e); return null; }
}

async function getChannels(): Promise<any[]> {
  const kv = await getKv();
  if (!kv) return DEFAULT_CHANNELS;
  try {
    const r = await kv.get(["channels"]);
    if (Array.isArray(r.value)) return r.value as any[];
    await kv.set(["channels"], DEFAULT_CHANNELS);
    return DEFAULT_CHANNELS;
  } catch (e) {
    console.error("KV get error:", e);
    return DEFAULT_CHANNELS;
  }
}

async function saveChannels(channels: any[]): Promise<void> {
  const kv = await getKv();
  if (!kv) throw new Error("Deno KV kullanılamıyor");
  await kv.set(["channels"], channels);
}

// ------------------------------------------------------------
// Auth
// ------------------------------------------------------------
function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return match ? match[1] : null;
}

async function hmacSign(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function createSession(secret: string): Promise<string> {
  const payload = btoa(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS }));
  const sig = await hmacSign(payload, secret);
  return payload + "." + sig;
}

async function verifySession(cookie: string | null, secret: string): Promise<boolean> {
  if (!cookie || !cookie.includes(".")) return false;
  const [payload, sig] = cookie.split(".");
  try {
    const expected = await hmacSign(payload, secret);
    if (!timingSafeEqual(sig, expected)) return false;
    const data = JSON.parse(atob(payload));
    return typeof data.exp === "number" && data.exp > Date.now();
  } catch { return false; }
}

async function requireAuth(req: Request): Promise<boolean> {
  const pass = Deno.env.get("ADMIN_PASSWORD");
  if (!pass) return false;
  const cookie = getCookie(req, SESSION_COOKIE);
  return await verifySession(cookie, pass);
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function isNumericId(s: string): boolean {
  if (typeof s !== "string" || s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function charCodes(s: string): string {
  const r: number[] = [];
  for (let i = 0; i < s.length; i++) r.push(s.charCodeAt(i));
  return r.join(",");
}

function isPlaylistUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname.endsWith(".m3u8") || u.pathname.endsWith(".m3u");
  } catch { return false; }
}

function cacheKeyForUrl(url: string): string {
  try {
    const u = new URL(url);
    return "u:" + u.pathname + "|" + u.search.slice(0, 60);
  } catch { return "u:" + url.slice(0, 100); }
}

function jsonResp(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ------------------------------------------------------------
// Hash scrape
// ------------------------------------------------------------
async function fetchFreshHash(channelId: string) {
  const embedUrl = CANLITV_BASE + "/embed/?id=" + channelId;
  const resp = await fetch(embedUrl, {
    headers: {
      "User-Agent": UA,
      "Referer": CANLITV_BASE + "/",
      "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
    },
  });
  if (!resp.ok) throw new Error("Embed HTTP " + resp.status);
  const html = await resp.text();

  let m3u8Url: string | null = null;
  let m = html.match(/file\s*:\s*"([^"]+\.m3u8[^"]*)"/i);
  if (m) m3u8Url = m[1];
  if (!m3u8Url) {
    m = html.match(/(?:file|src|url|source)\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i);
    if (m) m3u8Url = m[1];
  }
  if (!m3u8Url) {
    m = html.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
    if (m) m3u8Url = m[1];
  }

  if (!m3u8Url) throw new Error("HTML'de m3u8 bulunamadı: " + embedUrl);
  m3u8Url = m3u8Url.replace(/\\\//g, "/");

  let hash: string | null = null;
  let streamOrigin: string | null = null;
  try {
    const u = new URL(m3u8Url);
    hash = u.searchParams.get("hash");
    streamOrigin = u.origin;
  } catch { /* ignore */ }

  hashCache[channelId] = {
    streamUrl: m3u8Url,
    streamOrigin,
    hash,
    expiresAt: Date.now() + HASH_CACHE_MS,
  };
  return hashCache[channelId];
}

async function getHash(channelId: string, force = false) {
  const cache = hashCache[channelId];
  if (!force && cache && cache.expiresAt > Date.now()) return cache;
  if (pendingFetch[channelId]) return await pendingFetch[channelId];
  pendingFetch[channelId] = (async () => {
    try { return await fetchFreshHash(channelId); }
    finally { pendingFetch[channelId] = null; }
  })();
  return await pendingFetch[channelId];
}

// ------------------------------------------------------------
// URL hash replacement helper
// ------------------------------------------------------------
function replaceHashInUrl(originalUrl: string, freshHashUrl: string): string {
  try {
    const orig = new URL(originalUrl);
    const fresh = new URL(freshHashUrl);
    const newHash = fresh.searchParams.get("hash");
    const newToken = fresh.searchParams.get("t");
    const oldHash = orig.searchParams.get("hash");
    const oldToken = orig.searchParams.get("t");
    if (newHash && oldHash) orig.searchParams.set("hash", newHash);
    if (newToken && oldToken) orig.searchParams.set("t", newToken);
    return orig.href;
  } catch {
    return originalUrl;
  }
}

// ------------------------------------------------------------
// Manifest proxy — supports master + nested playlists
// ------------------------------------------------------------
async function proxyM3U8(streamUrl: string, channelId: string, baseOrigin: string, cacheKey?: string): Promise<Response> {
  const key = cacheKey || channelId;
  const cached = manifestCache[key];
  if (cached && cached.expiresAt > Date.now()) {
    return new Response(cached.body, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      },
    });
  }

  // Hash'i güncelle (iç playlist'ler için de)
  let fetchUrl = streamUrl;
  try {
    const cache = await getHash(channelId);
    fetchUrl = replaceHashInUrl(streamUrl, cache.streamUrl);
  } catch { /* ignore */ }

  let resp = await fetch(fetchUrl, {
    headers: { "Accept": "*/*" },
  });

  // 403 → hash yenile ve tekrar dene
  if (!resp.ok && (resp.status === 403 || resp.status === 401)) {
    try {
      await getHash(channelId, true);
      const c2 = hashCache[channelId];
      const retryUrl = replaceHashInUrl(streamUrl, c2.streamUrl);
      resp = await fetch(retryUrl, { headers: { "Accept": "*/*" } });
    } catch { /* ignore */ }
  }

  if (!resp.ok) {
    throw new Error("Upstream " + resp.status + " (manifest) | url=" + streamUrl.slice(0, 140));
  }

  const text = await resp.text();
  const baseUrl = new URL(streamUrl);
  const out: string[] = [];
  let hasStart = false, hasIndependent = false;

  for (const line of text.split("\n")) {
    const tr = line.trim();
    if (!tr) { out.push(line); continue; }
    if (tr.startsWith("#EXT-X-START")) hasStart = true;
    if (tr.startsWith("#EXT-X-INDEPENDENT-SEGMENTS")) hasIndependent = true;

    if (tr.startsWith("#") && tr.includes('URI="')) {
      out.push(tr.replace(/URI="([^"]+)"/g, (_: string, u: string) => {
        try {
          const abs = new URL(u, baseUrl).href;
          return 'URI="' + baseOrigin + "/seg?c=" + channelId + "&u=" + encodeURIComponent(abs) + '"';
        } catch { return 'URI="' + u + '"'; }
      }));
      continue;
    }
    if (tr.startsWith("#")) { out.push(line); continue; }

    try {
      const abs = new URL(tr, baseUrl).href;
      out.push(baseOrigin + "/seg?c=" + channelId + "&u=" + encodeURIComponent(abs));
    } catch { out.push(line); }
  }

  const extras: string[] = [];
  if (!hasIndependent) extras.push("#EXT-X-INDEPENDENT-SEGMENTS");
  if (!hasStart) extras.push("#EXT-X-START:TIME-OFFSET=-6.0,PRECISE=YES");

  if (extras.length) {
    const idx = out.findIndex((l) => l.trim().startsWith("#EXTM3U"));
    out.splice(idx >= 0 ? idx + 1 : 0, 0, ...extras);
  }

  const finalBody = out.join("\n");
  manifestCache[key] = { body: finalBody, expiresAt: Date.now() + MANIFEST_CACHE_MS };

  return new Response(finalBody, {
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    },
  });
}

// ------------------------------------------------------------
// Segment proxy
// ------------------------------------------------------------
async function fetchSegment(url: string): Promise<Response> {
  return await fetch(url, { headers: { "Accept": "*/*" } });
}

async function handleSegment(channelId: string, originalUrl: string): Promise<Response> {
  const cache = await getHash(channelId);

  // Hash güncelle
  let url = replaceHashInUrl(originalUrl, cache.streamUrl);

  let resp = await fetchSegment(url);

  if (!resp.ok && (resp.status === 403 || resp.status === 401 || resp.status === 404)) {
    try {
      await getHash(channelId, true);
      const c2 = hashCache[channelId];
      url = replaceHashInUrl(originalUrl, c2.streamUrl);
      resp = await fetchSegment(url);
    } catch { /* ignore */ }
  }

  if (!resp.ok) return new Response("Segment " + resp.status, { status: resp.status });

  return new Response(resp.body, {
    headers: {
      "Content-Type": resp.headers.get("Content-Type") || "video/mp2t",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    },
  });
}

// ------------------------------------------------------------
// M3U builder
// ------------------------------------------------------------
function buildM3U(channels: any[], baseOrigin: string): string {
  const lines: string[] = ["#EXTM3U"];
  for (const ch of channels) {
    lines.push(
      '#EXTINF:-1 tvg-id="' + (ch.tvgId || ch.id) + '" tvg-name="' + ch.name + '" group-title="' + (ch.group || "Genel") + '",' + ch.name
    );
    lines.push(baseOrigin + "/play/" + ch.id);
  }
  lines.push("");
  return lines.join("\n");
}

// ------------------------------------------------------------
// Admin
// ------------------------------------------------------------
async function handleLogin(req: Request): Promise<Response> {
  const pass = Deno.env.get("ADMIN_PASSWORD");
  if (!pass) return jsonResp({ error: "ADMIN_PASSWORD ayarlanmamış" }, 500);
  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const password = body.password || "";
  if (!timingSafeEqual(password, pass)) return jsonResp({ error: "Yanlış şifre" }, 401);
  const session = await createSession(pass);
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": SESSION_COOKIE + "=" + session + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + maxAge,
    },
  });
}

function handleLogout(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": SESSION_COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
    },
  });
}

async function handleListChannels(): Promise<Response> {
  return jsonResp(await getChannels());
}

async function handleSaveChannels(req: Request): Promise<Response> {
  try {
    let channels: any;
    try { channels = await req.json(); } catch (e: any) {
      return jsonResp({ error: "JSON parse hatası", detail: e.message }, 400);
    }
    if (!Array.isArray(channels)) return jsonResp({ error: "Dizi bekleniyor" }, 400);

    const idMap = new Map<string, number[]>();
    for (let i = 0; i < channels.length; i++) {
      const c = channels[i];
      const id = String((c && c.id) || "").trim();
      if (!isNumericId(id)) {
        return jsonResp({
          error: "Satır " + (i + 1) + ": ID sayısal olmalı",
          detail: 'Gelen: "' + id + '" | kodlar: ' + charCodes(id),
        }, 400);
      }
      const name = String((c && c.name) || "").trim();
      if (!name) return jsonResp({ error: "Satır " + (i + 1) + ": İsim zorunlu" }, 400);
      if (!idMap.has(id)) idMap.set(id, []);
      idMap.get(id)!.push(i + 1);
    }
    const dupes = [...idMap.entries()].filter(([_, rows]) => rows.length > 1);
    if (dupes.length) {
      const detail = dupes.map(([id, rows]) => '"' + id + '" (satır ' + rows.join(", ") + ")").join(" | ");
      return jsonResp({ error: "Tekrarlanan ID: " + detail }, 400);
    }

    const cleaned = channels.map((c: any) => ({
      id: String((c && c.id) || "").trim(),
      name: String((c && c.name) || "").trim(),
      tvgId: (c && c.tvgId) ? String(c.tvgId).trim() : "",
      group: (c && c.group) ? String(c.group).trim() : "Genel",
    }));

    await saveChannels(cleaned);
    for (const id of idMap.keys()) { delete hashCache[id]; }
    return jsonResp({ ok: true, count: cleaned.length });
  } catch (e: any) {
    return jsonResp({ error: "Sunucu hatası: " + e.message }, 500);
  }
}

// ------------------------------------------------------------
// Admin HTML
// ------------------------------------------------------------
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Canlitv Proxy — Yönetim</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:20px;background:#0f0f1a;color:#e5e7eb;min-height:100vh}
.hidden{display:none!important}
#login-view{max-width:400px;margin:100px auto;background:#1a1a2e;padding:40px;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.5)}
#login-view h1{margin:0 0 24px;text-align:center;font-size:22px}
input,button{font-family:inherit;font-size:14px}
input[type=password],input[type=text]{width:100%;padding:12px;margin-bottom:16px;background:#0f0f1a;border:1px solid #333;border-radius:8px;color:#e5e7eb}
input:focus{outline:none;border-color:#6366f1}
button{background:#6366f1;color:#fff;border:none;padding:12px 20px;border-radius:8px;cursor:pointer;font-weight:600}
button:hover{background:#4f46e5}
button:disabled{opacity:.4;cursor:not-allowed}
button.danger{background:#dc2626}
button.danger:hover{background:#b91c1c}
button.secondary{background:#374151}
button.secondary:hover{background:#4b5563}
#admin-view{max-width:1200px;margin:0 auto}
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:30px;padding-bottom:20px;border-bottom:1px solid #333}
header h1{margin:0;font-size:20px}
#channel-count{font-size:14px;color:#9ca3af;font-weight:400}
.toolbar{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;align-items:center}
table{width:100%;border-collapse:collapse;background:#1a1a2e;border-radius:8px;overflow:hidden}
th,td{padding:12px;text-align:left;border-bottom:1px solid #333}
th{background:#16162a;font-weight:600;font-size:12px;text-transform:uppercase;color:#9ca3af;letter-spacing:.5px}
tr:hover{background:#1e1e33}
td input{width:100%;padding:6px 8px;margin:0;background:#0f0f1a;border:1px solid #333;border-radius:4px;color:#e5e7eb;font-size:13px;font-family:monospace}
td input:focus{outline:none;border-color:#6366f1}
td input.invalid{border-color:#dc2626;background:#2a0f0f}
.status-msg{position:fixed;top:20px;right:20px;padding:14px 24px;border-radius:8px;font-weight:500;z-index:100;animation:slideIn .3s;max-width:600px;box-shadow:0 10px 30px rgba(0,0,0,.5);word-break:break-word}
.status-msg.success{background:#059669;color:#fff}
.status-msg.error{background:#dc2626;color:#fff}
@keyframes slideIn{from{transform:translateX(400px);opacity:0}to{transform:translateX(0);opacity:1}}
.empty{text-align:center;padding:40px;color:#6b7280}
.actions{display:flex;gap:6px}
.actions button{padding:6px 12px;font-size:13px}
#dirty-indicator{color:#f59e0b;font-size:14px;font-weight:500}
</style>
</head>
<body>

<div id="login-view">
  <h1>🔒 Yönetim Girişi</h1>
  <form id="login-form">
    <input type="password" id="password-input" placeholder="Şifre" required autofocus>
    <button type="submit" style="width:100%">Giriş Yap</button>
  </form>
</div>

<div id="admin-view" class="hidden">
  <header>
    <h1>📺 Canlitv Proxy <span id="channel-count"></span></h1>
    <button id="logout-btn" class="secondary">Çıkış</button>
  </header>
  <div class="toolbar">
    <button id="add-btn">+ Yeni Kanal</button>
    <button id="save-btn" disabled>💾 Kaydet</button>
    <span id="dirty-indicator"></span>
  </div>
  <table>
    <thead><tr>
      <th style="width:110px">ID</th>
      <th>İsim</th>
      <th style="width:150px">TVG ID</th>
      <th style="width:130px">Grup</th>
      <th style="width:80px">İşlem</th>
    </tr></thead>
    <tbody id="channels-body"></tbody>
  </table>
</div>

<script>
var channels = [];
var el = function(id) { return document.getElementById(id); };
var esc = function(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); };
function isNumericId(s){if(typeof s!=='string'||s.length===0)return false;for(var i=0;i<s.length;i++){var c=s.charCodeAt(i);if(c<48||c>57)return false;}return true;}
function charCodes(s){var r=[];for(var i=0;i<s.length;i++)r.push(s.charCodeAt(i));return r.join(',');}
function setDirty(v){el('save-btn').disabled=!v;el('dirty-indicator').textContent=v?'⚠ Kaydedilmemiş değişiklikler':'';}
function msg(text,type,duration){type=type||'success';duration=duration||5000;var d=document.createElement('div');d.className='status-msg '+type;d.textContent=text;document.body.appendChild(d);setTimeout(function(){d.remove();},duration);}
function updateCount(){var c=el('channel-count');if(c)c.textContent=channels.length?'('+channels.length+' kanal)':'(boş)';}
function findDuplicates(){var map={};channels.forEach(function(c,i){var id=String(c.id||'').trim();if(!id)return;if(!map[id])map[id]=[];map[id].push(i);});var result=[];for(var id in map){if(map[id].length>1)result.push([id,map[id]]);}return result;}
function render(){
  var tb=el('channels-body');tb.innerHTML='';updateCount();
  if(!channels.length){tb.innerHTML='<tr><td colspan="5" class="empty">Henüz kanal yok.</td></tr>';return;}
  var dupes=findDuplicates();var dupeIds={};dupes.forEach(function(d){dupeIds[d[0]]=true;});
  channels.forEach(function(ch,i){
    var tr=document.createElement('tr');
    var isDupe=dupeIds[String(ch.id||'').trim()]===true;
    tr.innerHTML='<td><input type="text" value="'+esc(ch.id)+'" data-f="id" data-i="'+i+'"'+(isDupe?' class="invalid"':'')+'></td>'+
      '<td><input type="text" value="'+esc(ch.name)+'" data-f="name" data-i="'+i+'"></td>'+
      '<td><input type="text" value="'+esc(ch.tvgId||'')+'" data-f="tvgId" data-i="'+i+'"></td>'+
      '<td><input type="text" value="'+esc(ch.group||'')+'" data-f="group" data-i="'+i+'"></td>'+
      '<td class="actions"><button class="danger" data-del="'+i+'">Sil</button></td>';
    if(isDupe)tr.style.background='rgba(127,29,29,0.4)';
    tb.appendChild(tr);
  });
  tb.querySelectorAll('input').forEach(function(inp){
    inp.addEventListener('input',function(e){var i=+e.target.dataset.i,f=e.target.dataset.f;channels[i][f]=e.target.value;setDirty(true);});
    inp.addEventListener('blur',function(e){var i=+e.target.dataset.i,f=e.target.dataset.f;var t=String(e.target.value||'').trim();if(t!==e.target.value){e.target.value=t;channels[i][f]=t;}});
  });
  tb.querySelectorAll('[data-del]').forEach(function(b){
    b.addEventListener('click',function(){var i=+b.dataset.del;if(confirm('"'+channels[i].name+'" silinsin mi?')){channels.splice(i,1);render();setDirty(true);}});
  });
}
async function load(){
  var r=await fetch('/api/admin/channels');
  if(r.status===401){showLogin();return;}
  if(!r.ok){msg('Kanallar yüklenemedi','error');return;}
  channels=await r.json();render();setDirty(false);showAdmin();
}
function showLogin(){el('login-view').classList.remove('hidden');el('admin-view').classList.add('hidden');}
function showAdmin(){el('login-view').classList.add('hidden');el('admin-view').classList.remove('hidden');}
el('login-form').addEventListener('submit',async function(e){
  e.preventDefault();
  var pw=el('password-input').value;
  var r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
  if(r.ok){el('password-input').value='';await load();msg('Hoş geldiniz!');}
  else{var j=await r.json().catch(function(){return {};});msg(j.error||'Yanlış şifre','error');}
});
el('logout-btn').addEventListener('click',async function(){await fetch('/api/admin/logout',{method:'POST'});channels=[];showLogin();});
el('add-btn').addEventListener('click',function(){channels.push({id:'',name:'Yeni Kanal',tvgId:'',group:'Canlitv'});render();setDirty(true);});
el('save-btn').addEventListener('click',async function(){
  channels=channels.map(function(c){return{id:String(c.id||'').trim(),name:String(c.name||'').trim(),tvgId:String(c.tvgId||'').trim(),group:String(c.group||'').trim()};});
  for(var i=0;i<channels.length;i++){
    if(!channels[i].id){msg('Satır '+(i+1)+': ID boş','error');return;}
    if(!isNumericId(channels[i].id)){msg('Satır '+(i+1)+': ID sayısal olmalı. Gelen: "'+channels[i].id+'" (kodlar: '+charCodes(channels[i].id)+')','error',12000);return;}
    if(!channels[i].name){msg('Satır '+(i+1)+': İsim boş','error');return;}
  }
  var dupes=findDuplicates();
  if(dupes.length){var detail=dupes.map(function(d){return '"'+d[0]+'" → satır '+d[1].map(function(i){return i+1;}).join(', ');}).join(' | ');msg('Tekrarlanan ID: '+detail,'error',10000);return;}
  try{
    var r=await fetch('/api/admin/channels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(channels)});
    var txt=await r.text();var j={};try{j=JSON.parse(txt);}catch(_){}
    if(r.ok){render();setDirty(false);msg('✅ Kaydedildi! ('+channels.length+' kanal)');}
    else{msg('HTTP '+r.status+' | '+(j.error||'Kaydetme başarısız')+(j.detail?(' — '+j.detail):''),'error',15000);}
  }catch(e){msg('Ağ hatası: '+e.message,'error',15000);}
});
fetch('/api/admin/channels').then(function(r){if(r.status===401)showLogin();else if(r.ok)return r.json().then(function(d){channels=d;render();showAdmin();});}).catch(function(){showLogin();});
</script>
</body>
</html>`;

// ============================================================
// ANA HANDLER
// ============================================================
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const baseOrigin = url.origin;

  // Debug
  if (path === "/api/admin/debug") {
    const kv = await getKv();
    const result: any = {
      ADMIN_PASSWORD_set: !!Deno.env.get("ADMIN_PASSWORD"),
      ADMIN_PASSWORD_length: (Deno.env.get("ADMIN_PASSWORD") || "").length,
      KV_available: !!kv,
    };
    if (kv) {
      try {
        const r = await kv.get(["channels"]);
        result.kv_read_ok = true;
        result.kv_channel_count = Array.isArray(r.value) ? (r.value as any[]).length : "NOT_ARRAY";
        await kv.set(["_test_" + Date.now()], "ok");
        result.kv_write_ok = true;
      } catch (e: any) {
        result.kv_error = e.message;
      }
    }
    return jsonResp(result);
  }

  // Admin UI
  if (path === "/admin" || path === "/admin/") {
    return new Response(ADMIN_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  // Admin API
  if (path === "/api/admin/login" && req.method === "POST") return await handleLogin(req);
  if (path === "/api/admin/logout") return handleLogout();
  if (path === "/api/admin/channels") {
    const ok = await requireAuth(req);
    if (!ok) return jsonResp({ error: "Unauthorized" }, 401);
    if (req.method === "GET") return await handleListChannels();
    if (req.method === "POST") return await handleSaveChannels(req);
    return new Response("Method not allowed", { status: 405 });
  }

  // Public
  const channels = await getChannels();

  if (path === "/playlist.m3u" || path === "/playlist") {
    return new Response(buildM3U(channels, baseOrigin), {
      headers: { "Content-Type": "audio/x-mpegurl; charset=utf-8", "Cache-Control": "no-cache" },
    });
  }

  const playMatch = path.match(/^\/play\/(\d+)$/);
  if (playMatch || path === "/play") {
    const channelId = playMatch ? playMatch[1] : (channels[0] && channels[0].id);
    if (!channelId) return new Response("Kanal yok", { status: 400 });
    try {
      const t = await getHash(channelId);
      return await proxyM3U8(t.streamUrl, channelId, baseOrigin);
    } catch (e: any) {
      return jsonResp({ error: e.message }, 502);
    }
  }

  // ⭐ KRİTİK: /seg — eğer URL m3u8 ise nested manifest olarak işle
  if (path === "/seg") {
    const c = url.searchParams.get("c");
    const u = url.searchParams.get("u");
    if (!c || !u) return new Response("Missing params", { status: 400 });

    if (isPlaylistUrl(u)) {
      // Nested playlist → manifest olarak proxy'le (kendi cache key ile)
      try {
        return await proxyM3U8(u, c, baseOrigin, cacheKeyForUrl(u));
      } catch (e: any) {
        return new Response("Nested manifest error: " + e.message, { status: 502 });
      }
    }

    // Normal segment (.ts, .aac, .key vb.)
    try { return await handleSegment(c, u); }
    catch (e: any) { return new Response("Segment error: " + e.message, { status: 502 }); }
  }

  if (path === "/status") {
    const result: any = {};
    for (const ch of channels) {
      const cache = hashCache[ch.id];
      result[ch.id] = {
        name: ch.name,
        hasHash: !!(cache && cache.streamUrl),
        hash: cache && cache.hash ? cache.hash.slice(0, 8) + "..." : null,
        streamOrigin: cache && cache.streamOrigin ? cache.streamOrigin : null,
        expiresInMin: cache ? (Math.max(0, cache.expiresAt - Date.now()) / 60000).toFixed(1) : "0",
      };
    }
    return jsonResp(result);
  }

  if (path === "/refresh") {
    const c = url.searchParams.get("c") || (channels[0] && channels[0].id);
    try {
      await getHash(c, true);
      // İlgili manifest cache'leri temizle
      for (const k of Object.keys(manifestCache)) delete manifestCache[k];
      return jsonResp({
        ok: true,
        channelId: c,
        streamUrl: hashCache[c].streamUrl,
        streamOrigin: hashCache[c].streamOrigin,
      });
    } catch (e: any) {
      return jsonResp({ error: e.message }, 500);
    }
  }

  return new Response(
    "Canlitv Proxy (Deno) v2\n\nPublic:\n- /playlist.m3u\n- /play/<id>\n- /status\n- /refresh?c=<id>\n\nAdmin:\n- /admin\n- /api/admin/debug\n",
    { status: 404, headers: { "Content-Type": "text/plain" } }
  );
}

Deno.serve(handler);
