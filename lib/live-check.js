'use strict';
// The orchestrator's own proof that the site is live. The Deployer agent says
// "live: true" — this module is why we don't have to take its word for it.

const https = require('https');
const http = require('http');

function getOnce(url, redirectsLeft = 5) {
  return new Promise((resolve) => {
    let mod;
    try {
      mod = url.startsWith('https:') ? https : url.startsWith('http:') ? http : null;
    } catch { mod = null; }
    if (!mod) return resolve({ ok: false, status: null, detail: `not an http(s) url: ${url}` });
    // Every failure here must resolve to evidence, never throw — a deployer
    // agent can hand us any malformed string and the deploy retry loop (not a
    // runner crash) is the designed response.
    let req;
    try {
      req = mod.get(url, { timeout: 20000, headers: { 'User-Agent': 'prompt-chain-runner-live-check' } }, (res) => {
      const { statusCode } = res;
      if (statusCode >= 300 && statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        let next;
        try {
          next = new URL(res.headers.location, url).toString();
        } catch {
          return resolve({ ok: false, status: statusCode, detail: `unparseable redirect location: ${res.headers.location}` });
        }
        return resolve(getOnce(next, redirectsLeft - 1));
      }
      let bytes = 0;
      res.on('data', (d) => { bytes += d.length; if (bytes > 65536) res.destroy(); });
      res.on('end', () => resolve({ ok: statusCode === 200 && bytes > 0, status: statusCode, detail: `HTTP ${statusCode}, ${bytes} bytes` }));
      res.on('close', () => resolve({ ok: statusCode === 200 && bytes > 0, status: statusCode, detail: `HTTP ${statusCode}, ${bytes}+ bytes` }));
      });
    } catch (err) {
      return resolve({ ok: false, status: null, detail: `invalid url: ${err.message} (${url})` });
    }
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: null, detail: 'request timed out' }); });
    req.on('error', (err) => resolve({ ok: false, status: null, detail: err.message }));
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Fetch a page's body (small cap — we only need the markup, not media).
function getBody(url) {
  return new Promise((resolve) => {
    let mod;
    try { mod = url.startsWith('https:') ? https : url.startsWith('http:') ? http : null; } catch { mod = null; }
    if (!mod) return resolve({ ok: false, body: '' });
    let req;
    try {
      req = mod.get(url, { timeout: 20000, headers: { 'User-Agent': 'prompt-chain-runner-live-check' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let next;
          try { next = new URL(res.headers.location, url).toString(); } catch { return resolve({ ok: false, body: '' }); }
          return resolve(getBody(next));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; if (body.length > 512 * 1024) res.destroy(); });
        res.on('end', () => resolve({ ok: res.statusCode === 200, body }));
        res.on('close', () => resolve({ ok: res.statusCode === 200, body }));
      });
    } catch { return resolve({ ok: false, body: '' }); }
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, body: '' }); });
    req.on('error', () => resolve({ ok: false, body: '' }));
  });
}

// The assets a browser would actually request for this page. Data URIs and
// cross-origin CDN links are skipped — we are proving OUR deploy is intact,
// not auditing the whole internet.
function extractAssets(html, pageUrl) {
  const urls = new Set();
  const patterns = [
    /<link[^>]+rel=["'][^"']*stylesheet[^"']*["'][^>]*href=["']([^"']+)["']/gi,
    /<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*stylesheet[^"']*["']/gi,
    /<script[^>]+src=["']([^"']+)["']/gi,
    /<img[^>]+src=["']([^"']+)["']/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const raw = m[1];
      if (!raw || /^(data:|#|mailto:|tel:|javascript:)/i.test(raw)) continue;
      let abs;
      try { abs = new URL(raw, pageUrl); } catch { continue; }
      if (abs.origin !== new URL(pageUrl).origin) continue; // third-party CDN is not our deploy
      urls.add(abs.toString());
    }
  }
  return [...urls].slice(0, 25);
}

// The difference between "the server answered" and "the site works". A page
// that returns 200 while every stylesheet 404s is the classic sub-path deploy
// failure — it must never be reported as live.
async function verifyDeployment(url, { checkAssets = true } = {}) {
  const page = await getOnce(url);
  if (!page.ok) return { ok: false, evidence: `page: ${url} -> ${page.detail}` };
  if (!checkAssets) return { ok: true, evidence: `page: ${url} -> ${page.detail}` };

  const { body } = await getBody(url);
  const assets = extractAssets(body || '', url);
  if (!assets.length) return { ok: true, evidence: `page: ${url} -> ${page.detail}; no local assets referenced` };

  const results = await Promise.all(assets.map(async (a) => ({ url: a, res: await getOnce(a) })));
  const broken = results.filter((r) => !r.res.ok);
  const lines = [
    `page: ${url} -> ${page.detail}`,
    ...results.map((r) => `  asset ${r.url} -> ${r.res.detail}`),
  ];
  if (broken.length) {
    return {
      ok: false,
      evidence: `The page loads but ${broken.length} of its own ${results.length} assets do not — a visitor sees a broken site. This is usually a base-path problem when the site is served from a sub-path.\n${lines.join('\n')}`,
    };
  }
  return { ok: true, evidence: `${lines.length - 1} assets verified\n${lines.join('\n')}` };
}

// Polls until the URL serves a real 200 or the time budget runs out.
// Returns { live, evidence } where evidence is the observation history.
async function waitUntilLive(url, { timeoutMs = 10 * 60 * 1000, intervalMs = 15000, shouldStop, onAttempt, checkAssets = true } = {}) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  while (Date.now() < deadline) {
    if (shouldStop && shouldStop()) return { live: false, aborted: true, evidence: 'stopped before the site came up' };
    const r = await getOnce(url);
    seen.push(`${new Date().toISOString()} ${url} -> ${r.detail}`);
    if (onAttempt) { try { onAttempt(r); } catch { /* ignore */ } }
    if (r.ok) {
      // The page is up — now prove the whole site is, not just the HTML.
      const deep = await verifyDeployment(url, { checkAssets });
      if (deep.ok) return { live: true, evidence: `${seen.join('\n')}\n${deep.evidence}` };
      return { live: false, evidence: `${seen.join('\n')}\n${deep.evidence}` };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  return { live: false, evidence: `URL never served HTTP 200 within ${Math.round(timeoutMs / 60000)} min:\n${seen.slice(-10).join('\n')}` };
}

module.exports = { waitUntilLive, getOnce, verifyDeployment, extractAssets };
