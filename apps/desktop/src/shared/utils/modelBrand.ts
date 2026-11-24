//! Recognizes the maker behind a model id or an API address; each brand names a logo in `assets/brand-icons/`.

/** A word of a model name: at its start or after a separator, so `o3` matches but `gpt-4o3` does not as `o3`. */
const word = (pattern: string) => new RegExp(`(^|[/_.: -])(?:${pattern})`, "i");

// The family wins over the relay: `meta-llama/…` on OpenRouter is Meta's. OpenAI last, its `o\d` is the most general.
const modelBrands: [RegExp, string][] = [
  [word("claude|anthropic"), "claude"],
  [word("gemini"), "gemini"],
  [word("gemma"), "google"],
  [word("deepseek"), "deepseek"],
  [word("qwen|qwq|qvq"), "qwen"],
  [word("glm|chatglm|codegeex|cogview|zhipu"), "zhipu"],
  [word("kimi|moonshot"), "kimi"],
  [word("minimax|abab"), "minimax"],
  [word("doubao"), "doubao"],
  [word("seed"), "bytedance"],
  [word("hunyuan"), "hunyuan"],
  [word("ernie|wenxin"), "wenxin"],
  [word("step-"), "stepfun"],
  [word("baichuan"), "baichuan"],
  [word("yi-"), "yi"],
  [word("grok|xai"), "xai"],
  [word("mistral|mixtral|codestral|devstral|magistral|ministral|pixtral"), "mistral"],
  [word("llama"), "meta"],
  [word("phi-"), "microsoft"],
  [word("nemotron|nvidia"), "nvidia"],
  [word("sonar|perplexity"), "perplexity"],
  [word("gpt|chatgpt|codex|openai|o\\d+(?:$|[-_.: ])"), "openai"],
];

const hostBrands: [string[], string][] = [
  [["anthropic.com", "claude.ai"], "claude"],
  [["openai.com", "chatgpt.com"], "openai"],
  [["generativelanguage.googleapis.com"], "gemini"],
  [["aiplatform.googleapis.com"], "vertexai"],
  [["deepseek.com"], "deepseek"],
  [["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"], "qwen"],
  [["bigmodel.cn", "z.ai"], "zhipu"],
  [["moonshot.cn", "moonshot.ai", "kimi.com"], "moonshot"],
  [["minimax.io", "minimaxi.com", "minimax.chat"], "minimax"],
  [["volces.com", "volcengine.com"], "volcengine"],
  [["hunyuan.cloud.tencent.com", "hunyuan.tencentcloudapi.com"], "hunyuan"],
  [["qianfan.baidubce.com"], "wenxin"],
  [["stepfun.com"], "stepfun"],
  [["baichuan-ai.com"], "baichuan"],
  [["lingyiwanwu.com", "01.ai"], "yi"],
  [["x.ai"], "xai"],
  [["mistral.ai"], "mistral"],
  [["perplexity.ai"], "perplexity"],
  [["nvidia.com"], "nvidia"],
  [["githubcopilot.com"], "githubcopilot"],
  [["openrouter.ai"], "openrouter"],
  [["siliconflow.cn", "siliconflow.com"], "siliconflow"],
  [["together.xyz", "together.ai"], "together"],
  [["fireworks.ai"], "fireworks"],
  [["huggingface.co"], "huggingface"],
  [["ollama.com"], "ollama"],
  [["azure.com"], "azure"],
  [["amazonaws.com"], "bedrock"],
  [["cloudflare.com"], "cloudflare"],
  [["vercel.sh"], "vercel"],
];

/** The maker of model [id] as its name says (`claude-sonnet-4-5`, `deepseek-ai/DeepSeek-V3`, `openai/gpt-5`). */
export function modelBrand(id: string): string | null {
  return modelBrands.find(([pattern]) => pattern.test(id))?.[1] ?? null;
}

/** The provider behind API address [baseUrl]; null for a relay that belongs to no maker. */
export function providerBrand(baseUrl: string): string | null {
  const url = parseUrl(baseUrl);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1") {
    return url.port === "11434" ? "ollama" : url.port === "1234" ? "lmstudio" : null;
  }
  return hostBrands.find(([domains]) => domains.some(domain => host === domain || host.endsWith(`.${domain}`)))?.[1] ?? null;
}

function parseUrl(value: string) {
  const text = value.trim();
  if (!text) return null;
  try { return new URL(text); } catch { /* a bare host such as `api.deepseek.com` */ }
  try { return new URL(`https://${text}`); } catch { return null; }
}
