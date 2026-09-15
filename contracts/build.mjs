/* Compiles src/*.sol with solc (optimizer 200 runs, via IR) into artifacts/<Name>.json { abi, bytecode, deployedSize }. */
import solc from 'solc';
import fs from 'node:fs';
import path from 'node:path';
const dir = path.dirname(new URL(import.meta.url).pathname);
const sources = {};
for (const f of fs.readdirSync(path.join(dir, 'src')).filter(f => f.endsWith('.sol'))) sources[f] = { content: fs.readFileSync(path.join(dir, 'src', f), 'utf8') };
const input = { language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', viaIR: true,
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
let failed = false;
for (const e of out.errors || []) { if (e.severity === 'error') failed = true; console.log(e.severity.toUpperCase(), e.formattedMessage.trim()); }
if (failed) process.exit(1);
fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
fs.mkdirSync(path.join(dir, '..', 'lib', 'abi'), { recursive: true });
for (const [, contracts] of Object.entries(out.contracts)) for (const [name, c] of Object.entries(contracts)) {
  if (!c.evm.bytecode.object) continue;
  const art = { contractName: name, compiler: solc.version(), abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedSize: c.evm.deployedBytecode.object.length / 2 };
  fs.writeFileSync(path.join(dir, 'artifacts', name + '.json'), JSON.stringify(art, null, 2));
  fs.writeFileSync(path.join(dir, '..', 'lib', 'abi', name + '.json'), JSON.stringify({ contractName: name, compiler: art.compiler, abi: art.abi, bytecode: art.bytecode }));
  console.log(name, 'runtime', art.deployedSize, 'bytes', art.deployedSize > 24576 ? 'OVER 24KB LIMIT' : 'ok');
}
