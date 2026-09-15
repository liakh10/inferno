/* InfernoVault against a fork of Robinhood Chain mainnet (ethereumjs VM + RPCStateManager): real Pons V2 factory and a
   real bonding curve that is still trading. Checks the fee split, that fuel only leaves as a burn of the same token,
   that burned tokens land on the dead address, and the owner/keeper gates. No keys are involved. */
import fs from 'node:fs';
import path from 'node:path';
import { VM } from '@ethereumjs/vm';
import { RPCStateManager } from '@ethereumjs/statemanager';
import { Common, Hardfork } from '@ethereumjs/common';
import { Block } from '@ethereumjs/block';
import { Address, Account, bytesToHex, hexToBytes } from '@ethereumjs/util';
import { encodeFunctionData, decodeFunctionResult, decodeErrorResult, decodeEventLog, parseAbi, formatEther, getAddress, keccak256, toBytes } from 'viem';

const RPC = 'https://robinhood-rpc.publicnode.com';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith(RPC)) return realFetch(url, opts);
  let last;
  for (let i = 0; i < 8; i++) {
    try { const text = await (await realFetch(url, opts)).text(); const j = JSON.parse(text); if (j.result !== undefined) return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } }); last = JSON.stringify(j.error || j); } catch (e) { last = e.message; }
    await new Promise(r => setTimeout(r, 250 * 2 ** i));
  }
  throw Error('RPC failed: ' + last);
};

const dir = path.dirname(new URL(import.meta.url).pathname);
const V = JSON.parse(fs.readFileSync(path.join(dir, 'artifacts', 'InfernoVault.json'), 'utf8'));
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const PONS = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', DEAD = '0x000000000000000000000000000000000000dEaD';
const PF = parseAbi(['function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))']);
const E = n => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const addr = n => getAddress('0x' + n.toString(16).padStart(40, '0'));
let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { if (c) pass++; else { fail++; console.log('  FAIL', label, extra); } };

class ForkState extends RPCStateManager {
  constructor(o) { super(o); this._codeStack = []; }
  async checkpoint() { await super.checkpoint(); this._codeStack.push(new Map(this._contractCache)); }
  async commit() { this._accountCache.commit(); this._storageCache.commit(); this._codeStack.pop(); }
  async revert() { this._accountCache.revert(); this._storageCache.revert(); const snap = this._codeStack.pop(); if (snap) this._contractCache = snap; }
}
const head = (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }) })).json()).result;
const common = Common.custom({ chainId: 4663, networkId: 4663 }, { hardfork: Hardfork.Cancun });
const stateManager = new ForkState({ provider: RPC, blockTag: BigInt(head.number) });
stateManager._blockTag = 'latest';
const vm = await VM.create({ common, stateManager });
const now = BigInt(Math.floor(Date.now() / 1000)) + 600n;
const block = () => Block.fromBlockData({ header: { number: BigInt(head.number) + 1n, timestamp: now, gasLimit: 30_000_000n, baseFeePerGas: 0n } }, { common });
const ALL = [...V.abi, ...PF];
async function exec(from, to, data, value = 0n) {
  const r = await vm.evm.runCall({ caller: Address.fromString(from), to: to ? Address.fromString(to) : undefined, data: hexToBytes(data), gasLimit: 30_000_000n, value, block: block() });
  const e = r.execResult; let reason = null;
  if (e.exceptionError) { try { const d = decodeErrorResult({ abi: ALL, data: bytesToHex(e.returnValue) }); reason = d.args ? String(d.args[0]) : d.errorName; } catch { reason = e.exceptionError.error + ' ' + bytesToHex(e.returnValue).slice(0, 80); } }
  const logs = (e.logs || []).map(([a, topics, d]) => { try { return { address: getAddress(bytesToHex(a)), ...decodeEventLog({ abi: V.abi, topics: topics.map(bytesToHex), data: bytesToHex(d) }) }; } catch { return null; } }).filter(Boolean);
  return { reverted: !!e.exceptionError, reason, logs, ret: bytesToHex(e.returnValue), gas: e.executionGasUsed, created: r.createdAddress };
}
async function tx(from, to, abi, functionName, args = [], value = 0n) {
  const r = await exec(from, to, encodeFunctionData({ abi, functionName, args }), value);
  if (!r.reverted) try { r.result = decodeFunctionResult({ abi, functionName, data: r.ret }); } catch {}
  return r;
}
const must = async (from, to, fn, args, label, value = 0n) => { const r = await tx(from, to, V.abi, fn, args, value); ok(!r.reverted, label, r.reason || ''); return r; };
const reverts = async (from, to, fn, args, expect, label, value = 0n) => { const r = await tx(from, to, V.abi, fn, args, value); ok(r.reverted && (!expect || String(r.reason).includes(expect)), label, `reverted=${r.reverted} reason=${r.reason}`); };
const view = async (to, abi, fn, args = []) => { const r = await tx(addr(1), to, abi, fn, args); if (r.reverted) throw Error(fn + ' reverted: ' + r.reason); return r.result; };
const giveEth = async (who, wei) => { const a = Address.fromString(who), acct = (await vm.stateManager.getAccount(a)) ?? new Account(); acct.balance = wei; await vm.stateManager.putAccount(a, acct); };
const ethBal = async who => (await vm.stateManager.getAccount(Address.fromString(who)))?.balance ?? 0n;

const owner = addr(0xd0), alice = addr(0xa1), eve = addr(0xee);
for (const w of [owner, alice, eve]) await giveEth(w, E(5));
console.log('fork block', Number(head.number), '· vault runtime', V.deployedSize, 'bytes');

/* a Pons token that is still on its curve */
const CANDIDATES = process.argv.slice(2).join(" ").split(/\s+/).filter(Boolean);
let T = null, lt = null;
for (const c of CANDIDATES) { const l = await view(PONS, PF, 'getLaunchedToken', [getAddress(c)]); if (l.exists && Number(l.phase) === 0 && l.pairToken === '0x0000000000000000000000000000000000000000') { T = getAddress(c); lt = l; break; } }
if (!T) { console.log('no candidate token is still on its curve'); process.exit(2); }
const T2 = getAddress(CANDIDATES.find(c => getAddress(c) !== T));
console.log('token', T, 'curve', lt.curve);

const dep = await vm.evm.runCall({ caller: Address.fromString(owner), data: hexToBytes(V.bytecode), gasLimit: 30_000_000n, block: block() });
ok(!dep.execResult.exceptionError, 'vault deploys');
const VA = getAddress(dep.createdAddress.toString());
ok((await view(VA, V.abi, 'owner')) === owner && (await view(VA, V.abi, 'keeper')) === owner, 'owner and keeper are the deployer');

const pid = keccak256(toBytes('hello model'));
await reverts(alice, VA, 'feed', [T, pid], 'zero', 'feed needs ETH');
await reverts(alice, VA, 'feed', [addr(0x1234), pid], '', 'feed rejects a token that is not a Pons launch', E(0.01));
const fed = await must(alice, VA, 'feed', [T, pid], 'alice pays 0.01 ETH for a prompt', E(0.01));
const ev = fed.logs.find(l => l.eventName === 'Fed');
ok(ev && ev.args.token === T && ev.args.payer === alice && ev.args.amount === E(0.01) && ev.args.promptId === pid, 'Fed event carries token, payer, amount and prompt id');
ok((await view(VA, V.abi, 'fuel', [T])) === E(0.008), '80% becomes fuel', formatEther(await view(VA, V.abi, 'fuel', [T])));
ok((await view(VA, V.abi, 'sinkFuel')) === E(0.002), '20% goes to the sink');
ok((await ethBal(VA)) === E(0.01), 'vault holds the ETH');

await reverts(eve, VA, 'burn', [T, E(0.008), 0n], 'min out', 'burn needs a minimum output');
await reverts(eve, VA, 'burn', [T, E(0.009), 1n], 'fuel', 'burn cannot spend more than the fuel');
await reverts(eve, VA, 'burn', [T2, E(0.001), 1n], 'fuel', 'fuel of one token cannot burn another');
const deadBefore = await view(T, ERC20, 'balanceOf', [DEAD]);
const b = await must(eve, VA, 'burn', [T, E(0.008), 1n], 'anyone burns the fuel on the curve');
const bev = b.logs.find(l => l.eventName === 'Burned');
const deadAfter = await view(T, ERC20, 'balanceOf', [DEAD]);
console.log(`  burn gas ${b.gas} · ${bev ? formatEther(bev.args.tokensOut) : '?'} tokens for ${bev ? formatEther(bev.args.ethIn) : '?'} ETH`);
ok(bev && deadAfter - deadBefore === bev.args.tokensOut && bev.args.tokensOut > 0n, 'bought tokens land on the dead address');
ok((await view(T, ERC20, 'balanceOf', [VA])) === 0n, 'vault keeps no tokens');
ok((await view(VA, V.abi, 'fuel', [T])) === E(0.008) - bev.args.ethIn, 'fuel drops by what was spent');
ok((await view(VA, V.abi, 'burnedTokens', [T])) === bev.args.tokensOut && (await view(VA, V.abi, 'burnedEth', [T])) === bev.args.ethIn, 'burn totals recorded');
ok((await ethBal(VA)) === E(0.01) - bev.args.ethIn, 'only the spent ETH left the vault');

await reverts(eve, VA, 'burnSink', [E(0.001), 1n], 'inferno not set', 'sink waits for $INFERNO');
await reverts(eve, VA, 'setInferno', [T2], 'owner', 'only the owner sets $INFERNO');
await reverts(owner, VA, 'setInferno', [addr(0x1234)], '', '$INFERNO must be a Pons launch');
await must(owner, VA, 'setInferno', [T2], 'owner sets $INFERNO');
await reverts(owner, VA, 'setInferno', [T], 'set', '$INFERNO is set once');
const s = await tx(eve, VA, V.abi, 'burnSink', [E(0.002), 1n]);
if (s.reverted && String(s.reason).includes('CurveGraduated')) console.log('  (second token already graduated, sink burn on curve skipped)');
else ok(!s.reverted && (await view(VA, V.abi, 'sinkFuel')) < E(0.002), 'anyone burns the sink into $INFERNO', s.reason || '');

await reverts(eve, VA, 'burnVia', [T, addr(0x99), '0x', 1n, 1n], 'keeper', 'burnVia is keeper only');
await reverts(owner, VA, 'burnVia', [T, addr(0x99), '0x', 1n, 1n], 'target', 'burnVia needs an allowed target');
await reverts(eve, VA, 'setTarget', [addr(0x99), true], 'owner', 'only the owner allows targets');
await reverts(eve, VA, 'setKeeper', [eve], 'owner', 'only the owner sets the keeper');
await must(owner, VA, 'transferOwnership', [alice], 'owner starts a handover');
await reverts(eve, VA, 'acceptOwnership', [], 'pending', 'only the pending owner accepts');
await must(alice, VA, 'acceptOwnership', [], 'alice accepts');
ok((await view(VA, V.abi, 'owner')) === alice, 'ownership moved');
ok(!V.abi.some(x => x.type === 'function' && /withdraw|rescue|sweep/i.test(x.name)), 'there is no way to take ETH out');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
