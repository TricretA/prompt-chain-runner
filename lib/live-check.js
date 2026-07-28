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

// Polls until the URL serves a real 200 or the time budget runs out.
// Returns { live, evidence } where evidence is the observation history.
async function waitUntilLive(url, { timeoutMs = 10 * 60 * 1000, intervalMs = 15000, shouldStop, onAttempt } = {}) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  while (Date.now() < deadline) {
    if (shouldStop && shouldStop()) return { live: false, aborted: true, evidence: 'stopped before the site came up' };
    const r = await getOnce(url);
    seen.push(`${new Date().toISOString()} ${url} -> ${r.detail}`);
    if (onAttempt) { try { onAttempt(r); } catch { /* ignore */ } }
    if (r.ok) return { live: true, evidence: seen.join('\n') };
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  return { live: false, evidence: `URL never served HTTP 200 within ${Math.round(timeoutMs / 60000)} min:\n${seen.slice(-10).join('\n')}` };
}

module.exports = { waitUntilLive, getOnce };
