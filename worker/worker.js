// ─────────────────────────────────────────────
// 지도 조각 대모험 — 랭킹·이용 현황 창구 (Cloudflare Worker + D1)
//   POST /hit    {dev, kind}         게임 열기(open)·새 게임(start)·엔딩(ending)·접속 중 알림(ping)
//   GET  /stats                      지금 탐험 중 · 오늘 · 누적
//   POST /score  {dev, nick, region, parts, total, play, sig}   엔딩 점수 올리기 (점수 다시 계산해 검사)
//   GET  /rank?region=경남&dev=…&nick=…   전국(또는 시도) TOP 50 + 내 순위
//   POST /rate   {dev, stars}        별점 1~5
// 개인 정보(이름·학교)는 받지 않는다. dev 는 기기마다 만든 무작위 번호.
// ─────────────────────────────────────────────

// 게임의 HG.Score.W 와 같아야 함
const W = { animal: 20, alien: 30, photo: 3, passport: 15, quiz: 40, secret: 30, road: 50, piece: 30 };
// 항목별 최댓값 (게임에 있는 개수보다 조금 넉넉하게 — 게임에 동물·문제를 늘리면 같이 늘린다)
const CAP = { animal: 50, alien: 12, photo: 60, passport: 30, quiz: 120, secret: 16, road: 12, piece: 10 };
const REGIONS = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주', '그 밖에'];
const BAD = ['시발', '씨발', 'ㅅㅂ', '병신', 'ㅂㅅ', '개새', '새끼', '좆', '존나', 'ㅈㄴ', '미친', '닥쳐', '꺼져', '등신', '애미', '느금', 'fuck', 'shit', 'sex', '섹스', '야동', '보지', '자지'];
const LIVE_SEC = 300;   // 최근 5분 안에 알림을 보낸 기기 = 지금 탐험 중

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (o, st = 200, extra = {}) => new Response(JSON.stringify(o), { status: st, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS, extra) });
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const now = () => Math.floor(Date.now() / 1000);
const okDev = d => typeof d === 'string' && /^[a-z0-9]{8,24}$/.test(d);

// 같은 IP 에서 너무 자주 올리지 못하게 (창구 하나 안에서만 세는 가벼운 막이)
const hits = new Map();
function tooMany(ip, key, max, sec) {
  const k = ip + '|' + key, t = Date.now(), a = (hits.get(k) || []).filter(x => t - x < sec * 1000);
  a.push(t); hits.set(k, a);
  if (hits.size > 5000) hits.clear();
  return a.length > max;
}

// 게임과 같은 방식의 간단한 검사값 (장난으로 주소창에서 점수를 바꾸는 것을 막는 정도)
function sig(o) {
  const s = [o.dev, o.nick, o.region, o.total, ...Object.keys(W).map(k => o.parts[k])].join('|') + '|jido-map-pieces';
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}

function cleanNick(n) {
  if (typeof n !== 'string') return null;
  n = n.trim().replace(/\s+/g, '');
  if (!/^[가-힣a-zA-Z0-9]{2,8}$/.test(n)) return null;
  const low = n.toLowerCase();
  if (BAD.some(b => low.includes(b))) return null;
  return n;
}

async function cached(req, ctx, sec, make) {
  const cache = caches.default, key = new Request(req.url, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await make();
  if (res.status === 200) { res.headers.set('Cache-Control', 'public, max-age=' + sec); ctx.waitUntil(cache.put(key, res.clone())); }
  return res;
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '') || '/';
    const ip = req.headers.get('CF-Connecting-IP') || 'x';
    const DB = env.DB;
    try {
      if (path === '/' && req.method === 'GET') return json({ ok: true, name: '지도 조각 대모험 랭킹' });

      // ── 이용 현황 숫자 올리기
      if (path === '/hit' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        if (!okDev(b.dev) || !['open', 'start', 'ending', 'ping'].includes(b.kind)) return json({ ok: false }, 400);
        if (tooMany(ip, 'hit', 60, 60)) return json({ ok: false, why: 'busy' }, 429);
        const day = kstDay(), stm = [DB.prepare('INSERT INTO live (dev, seen) VALUES (?1, ?2) ON CONFLICT(dev) DO UPDATE SET seen = ?2').bind(b.dev, now())];
        if (b.kind !== 'ping') {
          const col = { open: 'opens', start: 'starts', ending: 'endings' }[b.kind];
          stm.push(DB.prepare(`INSERT INTO visits (day, ${col}) VALUES (?1, 1) ON CONFLICT(day) DO UPDATE SET ${col} = ${col} + 1`).bind(day));
        }
        await DB.batch(stm);
        return json({ ok: true });
      }

      // ── 지금 탐험 중 · 오늘 · 누적 (30초 동안 같은 답을 돌려줌)
      if (path === '/stats' && req.method === 'GET') {
        return cached(req, ctx, 30, async () => {
          const t = now();
          const [live, today, all, ranked] = await DB.batch([
            DB.prepare('SELECT COUNT(*) AS n FROM live WHERE seen > ?1').bind(t - LIVE_SEC),
            DB.prepare('SELECT opens, starts, endings FROM visits WHERE day = ?1').bind(kstDay()),
            DB.prepare('SELECT SUM(opens) AS opens, SUM(starts) AS starts, SUM(endings) AS endings FROM visits'),
            DB.prepare('SELECT COUNT(*) AS n FROM scores')
          ]);
          ctx.waitUntil(DB.prepare('DELETE FROM live WHERE seen < ?1').bind(t - 3600).run());
          const z = r => ({ opens: (r && r.opens) || 0, starts: (r && r.starts) || 0, endings: (r && r.endings) || 0 });
          return json({ live: live.results[0].n, today: z(today.results[0]), total: z(all.results[0]), ranked: ranked.results[0].n });
        });
      }

      // ── 점수 올리기
      if (path === '/score' && req.method === 'POST') {
        const b = await req.json().catch(() => null);
        if (!b || !okDev(b.dev) || typeof b.parts !== 'object') return json({ ok: false, why: '잘못된 기록' }, 400);
        if (tooMany(ip, 'score', 3, 60)) return json({ ok: false, why: '잠시 뒤에 다시 올려 주세요' }, 429);
        const nick = cleanNick(b.nick);
        if (!nick) return json({ ok: false, why: '별명은 2~8글자 한글·영어·숫자로, 바른 말로 지어 주세요' }, 400);
        if (!REGIONS.includes(b.region)) return json({ ok: false, why: '시도를 골라 주세요' }, 400);
        const p = {};
        for (const k of Object.keys(W)) {
          const n = Number(b.parts[k]);
          if (!Number.isInteger(n) || n < 0 || n > CAP[k]) return json({ ok: false, why: '이상한 점수' }, 400);
          p[k] = n;
        }
        const total = Object.keys(W).reduce((t, k) => t + p[k] * W[k], 0);
        if (total !== Number(b.total) || p.piece < CAP.piece) return json({ ok: false, why: '이상한 점수' }, 400);
        if (b.sig !== sig({ dev: b.dev, nick: b.nick, region: b.region, total: b.total, parts: b.parts })) return json({ ok: false, why: '이상한 점수' }, 400);
        const play = Math.max(0, Math.min(100000, Math.floor(Number(b.play) || 0)));
        const ts = new Date().toISOString();
        // 같은 기기·같은 별명이면 더 높은 점수만 남김
        await DB.prepare(`INSERT INTO scores (dev, nick, region, total, animal, alien, photo, passport, quiz, secret, road, piece, play, created, updated)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)
          ON CONFLICT(dev, nick) DO UPDATE SET region = ?3, updated = ?14,
            total = MAX(total, ?4), animal = CASE WHEN ?4 > total THEN ?5 ELSE animal END, alien = CASE WHEN ?4 > total THEN ?6 ELSE alien END,
            photo = CASE WHEN ?4 > total THEN ?7 ELSE photo END, passport = CASE WHEN ?4 > total THEN ?8 ELSE passport END,
            quiz = CASE WHEN ?4 > total THEN ?9 ELSE quiz END, secret = CASE WHEN ?4 > total THEN ?10 ELSE secret END,
            road = CASE WHEN ?4 > total THEN ?11 ELSE road END, piece = CASE WHEN ?4 > total THEN ?12 ELSE piece END,
            play = CASE WHEN ?4 > total THEN ?13 ELSE play END`)
          .bind(b.dev, nick, b.region, total, p.animal, p.alien, p.photo, p.passport, p.quiz, p.secret, p.road, p.piece, play, ts).run();
        return json({ ok: true, nick, total });
      }

      // ── 순위표
      if (path === '/rank' && req.method === 'GET') {
        const region = url.searchParams.get('region');
        if (region && !REGIONS.includes(region)) return json({ ok: false }, 400);
        const dev = url.searchParams.get('dev'), nick = url.searchParams.get('nick');
        const where = region ? 'WHERE region = ?1' : '';
        const top = await DB.prepare(`SELECT nick, region, total FROM scores ${where} ORDER BY total DESC, updated ASC LIMIT 50`).bind(...(region ? [region] : [])).all();
        const cnt = await DB.prepare(`SELECT COUNT(*) AS n FROM scores ${where}`).bind(...(region ? [region] : [])).first();
        let me = null;
        if (okDev(dev) && nick) {
          const row = await DB.prepare('SELECT nick, region, total, updated FROM scores WHERE dev = ?1 AND nick = ?2').bind(dev, nick).first();
          if (row && (!region || row.region === region)) {
            // 같은 점수면 먼저 올린 사람이 위 (순위표 순서와 같게)
            const above = await DB.prepare(`SELECT COUNT(*) AS n FROM scores WHERE (total > ?1 OR (total = ?1 AND updated < ?2)) ${region ? 'AND region = ?3' : ''}`).bind(...(region ? [row.total, row.updated, region] : [row.total, row.updated])).first();
            me = { nick: row.nick, region: row.region, total: row.total, rank: above.n + 1 };
          }
        }
        return json({ ok: true, top: top.results, count: cnt.n, me });
      }

      // ── 별점
      if (path === '/rate' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const st = Number(b.stars);
        if (!okDev(b.dev) || !Number.isInteger(st) || st < 1 || st > 5) return json({ ok: false }, 400);
        if (tooMany(ip, 'rate', 5, 60)) return json({ ok: false }, 429);
        await DB.prepare('INSERT INTO ratings (dev, stars, created) VALUES (?1, ?2, ?3) ON CONFLICT(dev) DO UPDATE SET stars = ?2, created = ?3').bind(b.dev, st, new Date().toISOString()).run();
        return json({ ok: true });
      }

      return json({ ok: false, why: 'not found' }, 404);
    } catch (e) {
      return json({ ok: false, why: 'server' }, 500);
    }
  }
};
