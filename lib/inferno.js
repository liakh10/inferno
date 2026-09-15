/* Inferno data layer. A launch is a normal Pons V2 launch on Robinhood Chain whose description starts with
   "Model: <openrouter id>". Prompts are paid in ETH into the InfernoVault; the vault turns that ETH into buys of the
   same token that go straight to the dead address. */
import { pubs, state as wallet, send } from './wallet.js';
import { MODELS, modelOf, priceWei } from './models.js';
import { VAULT } from './addresses.js';
import { parseAbi, keccak256, toBytes, decodeEventLog, zeroAddress } from 'https://cdn.jsdelivr.net/npm/viem@2.21.55/+esm';

export { MODELS, modelOf, priceWei, VAULT };
export const CHAIN = 4663;
export const PONS = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
export const LAB = '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948';
export const DEAD = '0x000000000000000000000000000000000000dEaD';
const DUMMY = '0x000000000000000000000000000000000000bEEF';

const PARAMS = '(string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt)';
const LAUNCHED = '(address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists)';
export const PONS_ABI = parseAbi([
  'function launchFee() view returns (uint256)',
  'function launchEnabled() view returns (bool)',
  'function maxCreatorTaxBps() view returns (uint256)',
  'function previewLaunchEconomics(uint256,address) view returns (bytes32)',
  'function getLaunchConfig(uint256) view returns ((uint256 supply,uint256 curveFeeBps,uint256 phantomQuote,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,bool enabled))',
  `function getLaunchedToken(address) view returns (${LAUNCHED})`,
  `function launchToken(${PARAMS} params,uint256 launchConfigId,address pairToken,address[] snipeTaxExemptions) payable returns (address token,address curve)`,
  'event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)'
]);
export const LAB_ABI = parseAbi([
  `function launchAndBuy(${PARAMS} params,uint256 launchConfigId,address pairToken,uint256 quoteIn,uint256 minTokensOut,address recipient,address[] snipeTaxExemptions) payable returns (address token,address curve,uint256 tokensOut)`
]);
export const CURVE_ABI = parseAbi([
  'function getReserves() view returns (uint256,uint256)',
  'function realQuoteReserve() view returns (uint256)',
  'function buy(uint256 quoteIn,uint256 minTokensOut,address recipient) payable returns (uint256)'
]);

const pub = () => pubs[CHAIN];
const read = (functionName, args = []) => pub().readContract({ address: PONS, abi: PONS_ABI, functionName, args });

let VA = null;
export async function vaultAbi() {
  if (VA) return VA;
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch('/lib/abi/InfernoVault.json?v=1'); if (r.ok) { VA = (await r.json()).abi; return VA; } } catch {}
    await new Promise(r => setTimeout(r, 400 * (i + 1)));
  }
  throw Error('Could not load the vault interface');
}

// ---------------------------------------------------------------- formatting

export const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
export const eth = wei => Number(wei || 0n) / 1e18;
export const fmtEth = v => {
  v = Number(v || 0);
  if (v === 0) return '0';
  const s = v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v >= 0.0001 ? v.toFixed(5) : v >= 0.000001 ? v.toFixed(6) : '<0.000001';
  return s.includes('.') && !s.startsWith('<') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};
export const fmtTok = wei => { const n = Number(wei || 0n) / 1e18; return n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2); };
export const promptId = text => keccak256(toBytes(text));
const randomSalt = () => { const b = new Uint8Array(32); crypto.getRandomValues(b); return '0x' + [...b].map(x => x.toString(16).padStart(2, '0')).join(''); };

// ---------------------------------------------------------------- launch

export async function launchTerms() {
  const [fee, enabled, maxTax, econ, cfg] = await Promise.all([
    read('launchFee'), read('launchEnabled'), read('maxCreatorTaxBps'), read('previewLaunchEconomics', [0n, zeroAddress]), read('getLaunchConfig', [0n])
  ]);
  return { fee, enabled, maxTax, econ, cfg };
}

export const describe = (modelId, text) => (`Model: ${modelId}\n` + String(text || '').trim()).trim().slice(0, 500);

/* opening buy on a fresh curve: tokensOut = supply * net / (phantomQuote + net), net = quoteIn minus fee and tax */
export function quoteOpening(cfg, quoteIn, taxBps = 0) {
  const net = quoteIn - quoteIn * cfg.curveFeeBps / 10000n - quoteIn * BigInt(taxBps) / 10000n;
  return net > 0n ? cfg.supply * net / (cfg.phantomQuote + net) : 0n;
}

export async function launch({ modelId, name, symbol, description, logo, x, telegram, website, devEth = 0n }, onStep) {
  const me = wallet().address;
  if (!me) throw Error('Connect a wallet first');
  if (!modelOf(modelId)) throw Error('Pick a model');
  onStep && onStep('Reading Pons terms');
  const t = await launchTerms();
  if (!t.enabled) throw Error('Pons launches are paused right now');
  const params = {
    name, symbol, logo, description: describe(modelId, description),
    socials: { twitter: x || '', telegram: telegram || '', discord: '', website: website || '', farcaster: '' },
    creatorFeeRecipient: me, creatorTaxBps: 0, buybackEnabled: false, expectedEconomics: t.econ, salt: randomSalt()
  };
  const call = devEth > 0n
    ? { address: LAB, abi: LAB_ABI, functionName: 'launchAndBuy', args: [params, 0n, zeroAddress, devEth, quoteOpening(t.cfg, devEth) * 90n / 100n, me, []], value: t.fee + devEth }
    : { address: PONS, abi: PONS_ABI, functionName: 'launchToken', args: [params, 0n, zeroAddress, []], value: t.fee };
  onStep && onStep('Confirm the launch in your wallet');
  const tx = await send(CHAIN, call);
  onStep && onStep('Waiting for Robinhood Chain');
  const rc = await tx.wait();
  if (rc.status !== 'success') throw Error('The launch reverted');
  let token = null, curve = null;
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== PONS.toLowerCase()) continue;
    try { const d = decodeEventLog({ abi: PONS_ABI, data: l.data, topics: l.topics }); if (d.eventName === 'TokenLaunched') { token = d.args.token; curve = d.args.curve; } } catch {}
  }
  return { hash: tx.hash, token, curve };
}

async function api(path, init) {
  const r = await fetch(path, init);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}
const post = (path, data) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

/* lists the launch on Inferno; the API reads the transaction itself, so nothing here can be faked */
export async function register(hash) {
  for (let i = 0; i < 5; i++) {
    const r = await post('/api/launch', { tx: hash });
    if (r.ok) return r.j.token;
    if (r.status !== 425) throw Error(r.j.error || 'Could not list the launch');
    await new Promise(res => setTimeout(res, 1500 * (i + 1)));
  }
  throw Error('The launch is live, listing is still pending. Refresh in a minute');
}

export async function uploadLogo(dataUrl) {
  const r = await post('/api/logo', { image: dataUrl });
  if (!r.ok) throw Error(r.j.error || 'Logo upload failed');
  return r.j.url;
}

export const status = async () => (await api('/api/infer')).j;

// ---------------------------------------------------------------- reads

export async function listTokens() {
  const r = await api('/api/launch');
  if (!r.ok) return { tokens: [], error: r.j.error || 'Listing is not connected yet' };
  const rows = r.j.tokens || [];
  if (!rows.length) return { tokens: [] };
  const VAB = VAULT ? await vaultAbi() : null;
  const per = VAB ? 7 : 3;
  const res = await pub().multicall({
    allowFailure: true,
    contracts: rows.flatMap(t => [
      { address: PONS, abi: PONS_ABI, functionName: 'getLaunchedToken', args: [t.token] },
      { address: t.curve, abi: CURVE_ABI, functionName: 'getReserves' },
      { address: t.curve, abi: CURVE_ABI, functionName: 'realQuoteReserve' },
      ...(VAB ? ['fuel', 'burnedTokens', 'burnedEth', 'fedTotal'].map(functionName => ({ address: VAULT, abi: VAB, functionName, args: [t.token] })) : [])
    ])
  });
  rows.forEach((t, i) => {
    const g = k => res[i * per + k] && res[i * per + k].result;
    const lt = g(0), rv = g(1), real = g(2);
    t.graduated = lt ? Number(lt.phase) !== 0 : false;
    t.priceEth = rv && rv[1] > 0n ? Number(rv[0]) / Number(rv[1]) : 0;
    t.mcapEth = t.priceEth * 1e9;
    t.progress = lt && real != null && lt.graduationThreshold > 0n ? Math.min(1, Number(real) / Number(lt.graduationThreshold)) : (t.graduated ? 1 : 0);
    t.fuel = VAB ? g(3) || 0n : 0n;
    t.burnedTokens = VAB ? g(4) || 0n : 0n;
    t.burnedEth = VAB ? g(5) || 0n : 0n;
    t.fedTotal = VAB ? g(6) || 0n : 0n;
    t.m = modelOf(t.model);
  });
  return { tokens: rows };
}

export async function tokenRow(token) {
  const { tokens, error } = await listTokens();
  return { row: tokens.find(t => t.token.toLowerCase() === token.toLowerCase()) || null, error };
}

export async function sinkStats() {
  if (!VAULT) return null;
  const VAB = await vaultAbi();
  const r = await pub().multicall({ allowFailure: true, contracts: ['sinkFuel', 'totalFed', 'inferno'].map(functionName => ({ address: VAULT, abi: VAB, functionName })) });
  const inferno = r[2].result || zeroAddress;
  const burned = inferno !== zeroAddress ? await pub().readContract({ address: VAULT, abi: VAB, functionName: 'burnedTokens', args: [inferno] }).catch(() => 0n) : 0n;
  return { sinkFuel: r[0].result || 0n, totalFed: r[1].result || 0n, inferno, burned };
}

export async function balanceOf(token, who) {
  if (!who) return 0n;
  return pub().readContract({ address: token, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [who] }).catch(() => 0n);
}

// ---------------------------------------------------------------- prompts and burns

export async function ask(token, modelId, prompt, onStep) {
  if (!VAULT) throw Error('Prompts open once the vault is deployed');
  const m = modelOf(modelId);
  if (!m) throw Error('Unknown model');
  const VAB = await vaultAbi();
  onStep && onStep('Pay for the prompt in your wallet');
  const tx = await send(CHAIN, { address: VAULT, abi: VAB, functionName: 'feed', args: [token, promptId(prompt)], value: priceWei(m) });
  try { localStorage.setItem('inferno:last', JSON.stringify({ token, hash: tx.hash, prompt })); } catch {}
  onStep && onStep('Waiting for Robinhood Chain');
  const rc = await tx.wait();
  if (rc.status !== 'success') throw Error('The payment reverted');
  return answer(token, tx.hash, prompt, onStep, m);
}

/* asks the API for the answer to a paid prompt; safe to call again with the same transaction */
export async function answer(token, hash, prompt, onStep, m = null) {
  onStep && onStep(`${m ? m.name : 'The model'} is thinking`);
  for (let i = 0; i < 4; i++) {
    const r = await post('/api/infer', { token, tx: hash, prompt });
    if (r.ok) { try { localStorage.removeItem('inferno:last'); } catch {} return { ...r.j, hash }; }
    if (![425, 502].includes(r.status)) throw Error(r.j.error || 'The model did not answer');
    await new Promise(res => setTimeout(res, 1500 * (i + 1)));
  }
  throw Error('The model did not answer. The payment is kept, press Retry to ask again with the same transaction');
}

export async function burnQuote(token) {
  if (!VAULT) return { fuel: 0n, out: 0n };
  const VAB = await vaultAbi();
  const fuel = await pub().readContract({ address: VAULT, abi: VAB, functionName: 'fuel', args: [token] }).catch(() => 0n);
  if (!fuel) return { fuel: 0n, out: 0n };
  try {
    const sim = await pub().simulateContract({ account: DUMMY, address: VAULT, abi: VAB, functionName: 'burn', args: [token, fuel, 1n] });
    return { fuel, out: sim.result[1] };
  } catch (e) {
    return { fuel, out: 0n, error: /Graduated/i.test(e.message || '') ? 'This token graduated, its fuel burns through the keeper' : (e.shortMessage || e.message) };
  }
}

export async function burn(token, onStep) {
  const q = await burnQuote(token);
  if (!q.fuel) throw Error('No fuel to burn yet');
  if (!q.out) throw Error(q.error || 'Nothing to burn right now');
  const VAB = await vaultAbi();
  onStep && onStep('Confirm the burn in your wallet');
  const tx = await send(CHAIN, { address: VAULT, abi: VAB, functionName: 'burn', args: [token, q.fuel, q.out * 97n / 100n] });
  onStep && onStep('Waiting for Robinhood Chain');
  const rc = await tx.wait();
  if (rc.status !== 'success') throw Error('The burn reverted');
  return rc;
}

export function toWebp(file, size = 320) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(Error('Pick an image file'));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const x = c.getContext('2d'), s = Math.min(img.width, img.height);
      x.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/webp', 0.88));
    };
    img.onerror = () => reject(Error('That image could not be read'));
    img.src = URL.createObjectURL(file);
  });
}
