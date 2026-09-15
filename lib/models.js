/* Models an Inferno token can be bound to. Ids are OpenRouter model ids; prices are OpenRouter list prices in USD per
   million tokens and are only used to set the ETH price of one prompt. Shared by the site and the API. */
export const MODELS = [
  { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', lab: 'Anthropic', ctx: '1M', inUsd: 5, outUsd: 25 },
  { id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol', lab: 'OpenAI', ctx: '1.05M', inUsd: 2, outUsd: 10 },
  { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', lab: 'Google', ctx: '1M', inUsd: 0.75, outUsd: 3.75 },
  { id: 'x-ai/grok-4.6', name: 'Grok 4.6', lab: 'xAI', ctx: '500K', inUsd: 2, outUsd: 6 },
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', lab: 'Anthropic', ctx: '1M', inUsd: 2, outUsd: 10 },
  { id: 'deepseek/deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro', lab: 'DeepSeek', ctx: '1M', inUsd: 0.66, outUsd: 1.98 },
  { id: 'qwen/qwen3.8-max-0902', name: 'Qwen3.8 Max', lab: 'Qwen', ctx: '1M', inUsd: 2, outUsd: 6 },
  { id: 'moonshotai/kimi-k3', name: 'Kimi K3', lab: 'Moonshot', ctx: '1M', inUsd: 2.65, outUsd: 13.28 }
];

export const MAX_OUT = 800;          // answer tokens per prompt
export const MAX_IN_CHARS = 4000;    // prompt length
export const MARKUP = 1.2;           // user pays the model cost plus 20%
export const ETH_USD_FLOOR = 2000;   // conservative ETH price, so a prompt never costs less than the model
const MIN_WEI = 10n ** 13n;          // 0.00001 ETH

export const modelOf = id => MODELS.find(m => m.id === id) || null;

/* ETH for one prompt: a full 1,000-token prompt plus a full answer at list price, with the markup */
export function priceWei(m) {
  const usd = (1000 * m.inUsd + MAX_OUT * m.outUsd) / 1e6 * MARKUP;
  const wei = BigInt(Math.ceil(usd / ETH_USD_FLOOR * 1e18));
  return wei < MIN_WEI ? MIN_WEI : wei;
}
