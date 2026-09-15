/* Inferno listing. POST { tx } reads a Pons V2 launch transaction from Robinhood Chain, checks that its description
   starts with "Model: <id>" for a model Inferno supports and stores the token once. GET returns the list, newest first.
   The API never takes token data from the browser, only a transaction hash. */
import { decodeEventLog, decodeFunctionData } from 'viem';
import { redis } from '../lib/store.js';
import { json, ipOf, body } from '../lib/http.js';
import { modelOf } from '../lib/models.js';
import { pub, PONS, LAB, LAUNCH_ABI, isHash, limit } from '../lib/server.js';

export default async function handler(req, res) {
  let R;
  try { R = redis(); } catch (e) { return json(res, 503, { error: 'Listing is not connected yet' }); }
  try {
    if (req.method === 'GET') {
      const ids = await R.lrange('inf:launches', 0, 199);
      const rows = ids.length ? await R.mget(...ids.map(t => 'inf:t:' + t)) : [];
      res.setHeader('cache-control', 'public, max-age=5');
      return json(res, 200, { tokens: rows.filter(Boolean).map(s => JSON.parse(s)) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    if (!(await limit(R, 'inf:rl:launch:' + ipOf(req), 30, 600))) return json(res, 429, { error: 'Too many requests, try again in a few minutes' });

    const { tx } = body(req);
    if (!isHash(tx)) return json(res, 400, { error: 'Bad transaction hash' });
    const [t, rc] = await Promise.all([pub.getTransaction({ hash: tx }).catch(() => null), pub.getTransactionReceipt({ hash: tx }).catch(() => null)]);
    if (!t || !rc) return json(res, 425, { error: 'Transaction not found yet' });
    if (rc.status !== 'success') return json(res, 400, { error: 'Transaction reverted' });
    const to = String(t.to || '').toLowerCase();
    if (to !== PONS.toLowerCase() && to !== LAB.toLowerCase()) return json(res, 400, { error: 'Not a Pons launch' });

    let launched = null;
    for (const l of rc.logs) {
      if (l.address.toLowerCase() !== PONS.toLowerCase()) continue;
      try { const d = decodeEventLog({ abi: LAUNCH_ABI, data: l.data, topics: l.topics }); if (d.eventName === 'TokenLaunched') launched = d.args; } catch {}
    }
    if (!launched) return json(res, 400, { error: 'No launch in this transaction' });

    const call = decodeFunctionData({ abi: LAUNCH_ABI, data: t.input });
    const p = call.args[0];
    const m = /^Model:\s*(\S+)/.exec(p.description || '');
    const model = m && modelOf(m[1]);
    if (!model) return json(res, 400, { error: 'This launch is not bound to an Inferno model' });

    const key = launched.token.toLowerCase();
    const existing = await R.get('inf:t:' + key);
    if (existing) return json(res, 200, { token: JSON.parse(existing) });
    const block = await pub.getBlock({ blockNumber: rc.blockNumber });
    const row = {
      token: launched.token, curve: launched.curve, name: p.name, symbol: p.symbol, logo: p.logo,
      description: String(p.description || '').replace(/^Model:[^\n]*\n?/, ''), model: model.id, creator: t.from,
      x: p.socials.twitter, telegram: p.socials.telegram, website: p.socials.website, tx, createdAt: Number(block.timestamp)
    };
    if (await R.set('inf:t:' + key, JSON.stringify(row), { nx: true })) {
      await R.lpush('inf:launches', key);
      await R.ltrim('inf:launches', 0, 999);
    }
    return json(res, 200, { token: row });
  } catch (e) {
    return json(res, 500, { error: e.shortMessage || e.message || 'Server error' });
  }
}
