/* Server-side chain access for the Inferno API. */
import { createPublicClient, http, fallback, parseAbi } from 'viem';

const RPC = ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'];
export const chain = { id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: RPC } } };
export const pub = createPublicClient({ chain, transport: fallback(RPC.map(u => http(u, { timeout: 15000 }))) });

export const PONS = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
export const LAB = '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948';
const PARAMS = '(string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt)';
export const LAUNCH_ABI = parseAbi([
  `function launchToken(${PARAMS} params,uint256 launchConfigId,address pairToken) payable returns (address token,address curve)`,
  `function launchToken(${PARAMS} params,uint256 launchConfigId,address pairToken,address[] snipeTaxExemptions) payable returns (address token,address curve)`,
  `function launchAndBuy(${PARAMS} params,uint256 launchConfigId,address pairToken,uint256 quoteIn,uint256 minTokensOut,address recipient,address[] snipeTaxExemptions) payable returns (address token,address curve,uint256 tokensOut)`,
  'event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)'
]);
export const VAULT_EVENTS = parseAbi(['event Fed(address indexed token, address indexed payer, uint256 amount, bytes32 indexed promptId)']);

export const hostOf = req => String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
export const isHash = v => /^0x[0-9a-fA-F]{64}$/.test(v || '');
export const isAddr = v => /^0x[0-9a-fA-F]{40}$/.test(v || '');

export async function limit(R, key, max, seconds) {
  const n = await R.incr(key);
  if (n === 1) await R.expire(key, seconds);
  return n <= max;
}
