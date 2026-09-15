/* Answers paid prompts. GET reports whether prompts are open. POST { token, tx, prompt } checks on Robinhood Chain that
   `tx` paid the InfernoVault for this token with a Fed event whose promptId is keccak256(prompt) and whose amount covers
   the model's price, uses each payment once, then asks the token's model through OpenRouter. A payment that fails to get
   an answer can be retried with the same transaction. */
import { decodeEventLog, keccak256, toBytes } from 'viem';
import { redis } from '../lib/store.js';
import { json, ipOf, body } from '../lib/http.js';
import { modelOf, priceWei, MAX_OUT, MAX_IN_CHARS } from '../lib/models.js';
import { VAULT } from '../lib/addresses.js';
import { pub, VAULT_EVENTS, hostOf, isHash, isAddr, limit } from '../lib/server.js';

const MAX_AGE = 3600;

export default async function handler(req, res) {
  const key = process.env.OPENROUTER_API_KEY;
  if (req.method === 'GET') {
    let storage = true;
    try { redis(); } catch { storage = false; }
    return json(res, 200, { prompts: !!(key && VAULT && storage), vault: VAULT || null, storage, model: !!key });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  if (!VAULT) return json(res, 503, { error: 'Prompts open once the vault is deployed' });
  let R;
  try { R = redis(); } catch { return json(res, 503, { error: 'Prompts are not connected yet' }); }
  try {
    if (!(await limit(R, 'inf:rl:infer:' + ipOf(req), 40, 600))) return json(res, 429, { error: 'Too many prompts, try again in a few minutes' });
    const { token, tx, prompt } = body(req);
    if (!isAddr(token) || !isHash(tx)) return json(res, 400, { error: 'Bad request' });
    const text = String(prompt || '');
    if (!text.trim() || text.length > MAX_IN_CHARS) return json(res, 400, { error: `Prompts are 1 to ${MAX_IN_CHARS} characters` });

    const cached = await R.get('inf:ans:' + tx);
    if (cached) return json(res, 200, JSON.parse(cached));

    const rowRaw = await R.get('inf:t:' + token.toLowerCase());
    if (!rowRaw) return json(res, 404, { error: 'This token is not listed on Inferno' });
    const model = modelOf(JSON.parse(rowRaw).model);
    if (!model) return json(res, 400, { error: 'Unknown model' });

    const rc = await pub.getTransactionReceipt({ hash: tx }).catch(() => null);
    if (!rc) return json(res, 425, { error: 'Payment not found yet' });
    if (rc.status !== 'success') return json(res, 400, { error: 'Payment reverted' });
    let fed = null;
    for (const l of rc.logs) {
      if (l.address.toLowerCase() !== VAULT.toLowerCase()) continue;
      try { const d = decodeEventLog({ abi: VAULT_EVENTS, data: l.data, topics: l.topics }); if (d.eventName === 'Fed') fed = d.args; } catch {}
    }
    if (!fed) return json(res, 400, { error: 'This transaction did not pay the vault' });
    if (fed.token.toLowerCase() !== token.toLowerCase()) return json(res, 400, { error: 'This payment is for another token' });
    if (fed.promptId !== keccak256(toBytes(text))) return json(res, 400, { error: 'This payment is for another prompt' });
    if (fed.amount < priceWei(model)) return json(res, 400, { error: 'The payment is below the prompt price' });
    const block = await pub.getBlock({ blockNumber: rc.blockNumber });
    if (Date.now() / 1000 - Number(block.timestamp) > MAX_AGE) return json(res, 400, { error: 'This payment is older than an hour' });

    if (!key) return json(res, 503, { error: 'The model connection is not set up yet. The payment is kept, retry later' });
    if (!(await R.set('inf:lock:' + tx, '1', { nx: true, ex: 90 }))) return json(res, 425, { error: 'Already answering this payment' });

    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 50_000);
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', signal: ctl.signal,
        headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', 'HTTP-Referer': 'https://' + hostOf(req), 'X-Title': 'Inferno' },
        body: JSON.stringify({ model: model.id, max_tokens: MAX_OUT, messages: [{ role: 'user', content: text }] })
      }).finally(() => clearTimeout(timer));
      const j = await r.json().catch(() => ({}));
      const answer = j && j.choices && j.choices[0] && j.choices[0].message ? String(j.choices[0].message.content || '') : '';
      if (!r.ok || !answer) return json(res, 502, { error: (j.error && j.error.message) || 'The model did not answer' });
      const out = { answer, model: model.id, usage: j.usage || null, payer: fed.payer, paid: String(fed.amount) };
      await R.set('inf:ans:' + tx, JSON.stringify(out), { ex: 7 * 86400 });
      await R.incr('inf:prompts:' + token.toLowerCase());
      return json(res, 200, out);
    } finally {
      await R.del('inf:lock:' + tx);
    }
  } catch (e) {
    return json(res, e.name === 'AbortError' ? 502 : 500, { error: e.name === 'AbortError' ? 'The model took too long' : (e.message || 'Server error') });
  }
}
