// Text models for scripts/catalog.mjs: llama.cpp GGUF files and LiteRT-LM bundles. Only metadata lives here; the
// generator pins each repo to its current commit and reads every file's exact size from the Hugging Face API.
//
// GGUF quant choice: Q4_0 wherever the repo has it — llama.cpp repacks Q4_0 for ARM's dotprod/i8mm kernels at load
// time, and on a Pixel 8a it measured 40% faster at reading prompts and 17% faster at generating than Q4_K_M
// (Qwen3 1.7B: 87 / 21 tok/s vs 50 / 17 on 4 threads). Repos without Q4_0 get Q4_K_M. Vision projectors (mmproj) are
// not listed: the phone runtime is text-only.
// contextLength is what the phone allocates (KV cache), not the model's trained maximum: 8192 for ≤ 2B, else 4096.

const gguf = (id, repo, file, m) => ({ id, task: 'text', format: 'gguf', repo, file, backends: ['gpu', 'cpu'], ...m })
const litert = (id, repo, file, m) => ({ id, task: 'text', format: 'litertlm', repo, file, ...m })

const QWEN_SAMPLING = { temperature: 0.7, topP: 0.8, topK: 20, minP: 0 }
const QWEN_THINK_SAMPLING = { temperature: 0.6, topP: 0.95, topK: 20, minP: 0 }
const GEMMA_SAMPLING = { temperature: 1.0, topP: 0.95, topK: 64, minP: 0 }
const LLAMA_SAMPLING = { temperature: 0.7, topP: 0.9, topK: 40, minP: 0.05 }
const R1_SAMPLING = { temperature: 0.6, topP: 0.95, topK: 40, minP: 0 }

const nothink = (sampling) => ({ enableThinking: false, sampling })
const think = (sampling) => ({ enableThinking: true, sampling })

export const TEXT = [
  // ─── Qwen3.5 (hybrid Gated-DeltaNet; natively multimodal, used here for text) ────────────────────────────────────
  gguf('qwen3.5-0.8b-gguf', 'unsloth/Qwen3.5-0.8B-GGUF', 'Qwen3.5-0.8B-Q4_0.gguf', {
    name: 'Qwen3.5 0.8B', family: 'Qwen3.5', params: 0.8, variant: 'standard', license: 'apache-2.0',
    description: 'Newest tiny Qwen: fast chat in 100+ languages with optional thinking; a good first download for any phone.',
    tags: ['fast', 'multilingual', 'thinking', 'tools'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('qwen3.5-2b-gguf', 'unsloth/Qwen3.5-2B-GGUF', 'Qwen3.5-2B-Q4_0.gguf', {
    name: 'Qwen3.5 2B', family: 'Qwen3.5', params: 2, variant: 'standard', license: 'apache-2.0', recommended: true,
    description: 'Best all-round size for 8 GB phones: strong multilingual chat, tools and optional step-by-step thinking.',
    tags: ['multilingual', 'thinking', 'tools'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('qwen3.5-4b-gguf', 'unsloth/Qwen3.5-4B-GGUF', 'Qwen3.5-4B-Q4_0.gguf', {
    name: 'Qwen3.5 4B', family: 'Qwen3.5', params: 4, variant: 'standard', license: 'apache-2.0',
    description: 'The strongest Qwen that fits an 8 GB phone; slower, noticeably smarter. Thinks by default unless turned off.',
    tags: ['quality', 'multilingual', 'thinking', 'tools'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('qwen3.5-9b-gguf', 'unsloth/Qwen3.5-9B-GGUF', 'Qwen3.5-9B-Q4_0.gguf', {
    name: 'Qwen3.5 9B', family: 'Qwen3.5', params: 9, variant: 'standard', license: 'apache-2.0',
    description: 'Desktop-class quality for 12 GB+ phones; a few tokens per second on the CPU.',
    tags: ['quality', 'multilingual', 'thinking', 'tools'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('qwen3.5-0.8b-abliterated-gguf', 'mradermacher/Huihui-Qwen3.5-0.8B-abliterated-GGUF', 'Huihui-Qwen3.5-0.8B-abliterated.Q4_K_M.gguf', {
    name: 'Qwen3.5 0.8B Abliterated', family: 'Qwen3.5', params: 0.8, variant: 'abliterated', license: 'apache-2.0',
    description: "huihui-ai's abliterated Qwen3.5 0.8B (refusal direction removed): tiny and fast, answers without refusing.",
    tags: ['fast', 'multilingual', 'thinking'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('qwen3.5-2b-abliterated-gguf', 'mradermacher/Huihui-Qwen3.5-2B-abliterated-GGUF', 'Huihui-Qwen3.5-2B-abliterated.Q4_K_M.gguf', {
    name: 'Qwen3.5 2B Abliterated', family: 'Qwen3.5', params: 2, variant: 'abliterated', license: 'apache-2.0', recommended: true,
    description: "huihui-ai's abliterated Qwen3.5 2B: the standard 2B's quality without refusals.",
    tags: ['multilingual', 'thinking'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('qwen3.5-4b-abliterated-gguf', 'mradermacher/Huihui-Qwen3.5-4B-abliterated-GGUF', 'Huihui-Qwen3.5-4B-abliterated.Q4_K_M.gguf', {
    name: 'Qwen3.5 4B Abliterated', family: 'Qwen3.5', params: 4, variant: 'abliterated', license: 'apache-2.0',
    description: "huihui-ai's abliterated Qwen3.5 4B: uncensored and still sharp; needs an 8 GB phone.",
    tags: ['quality', 'multilingual', 'thinking'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('qwen3.5-9b-abliterated-gguf', 'mradermacher/Huihui-Qwen3.5-9B-abliterated-GGUF', 'Huihui-Qwen3.5-9B-abliterated.Q4_K_M.gguf', {
    name: 'Qwen3.5 9B Abliterated', family: 'Qwen3.5', params: 9, variant: 'abliterated', license: 'apache-2.0',
    description: "huihui-ai's abliterated Qwen3.5 9B for 12 GB+ phones.",
    tags: ['quality', 'multilingual', 'thinking'], config: nothink(QWEN_SAMPLING)
  }),

  // ─── Qwen3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  gguf('qwen3-0.6b-gguf', 'unsloth/Qwen3-0.6B-GGUF', 'Qwen3-0.6B-Q4_0.gguf', {
    name: 'Qwen3 0.6B (GGUF)', family: 'Qwen3', params: 0.6, variant: 'standard', license: 'apache-2.0',
    description: 'Tiny and very fast on llama.cpp (about 40–55 tok/s on a Pixel 8a CPU); simple chat, optional thinking.',
    tags: ['fast', 'multilingual', 'thinking'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('qwen3-1.7b-gguf', 'unsloth/Qwen3-1.7B-GGUF', 'Qwen3-1.7B-Q4_0.gguf', {
    name: 'Qwen3 1.7B', family: 'Qwen3', params: 1.7, variant: 'standard', license: 'apache-2.0', recommended: true,
    description: 'Balanced small model: about 20 tok/s on a Pixel 8a CPU, decent reasoning, 100+ languages.',
    tags: ['multilingual', 'thinking', 'tools'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('qwen3-4b-gguf', 'Qwen/Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf', {
    name: 'Qwen3 4B', family: 'Qwen3', params: 4, variant: 'standard', license: 'apache-2.0',
    description: "Qwen's official 4B build: hybrid thinking, tools, strong for its size.",
    tags: ['quality', 'multilingual', 'thinking', 'tools'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('qwen3-8b-gguf', 'Qwen/Qwen3-8B-GGUF', 'Qwen3-8B-Q4_K_M.gguf', {
    name: 'Qwen3 8B', family: 'Qwen3', params: 8, variant: 'standard', license: 'apache-2.0',
    description: "Qwen's official 8B build for 12 GB+ phones.",
    tags: ['quality', 'multilingual', 'thinking', 'tools'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('qwen3-4b-instruct-2507-gguf', 'unsloth/Qwen3-4B-Instruct-2507-GGUF', 'Qwen3-4B-Instruct-2507-Q4_0.gguf', {
    name: 'Qwen3 4B Instruct 2507', family: 'Qwen3', params: 4, variant: 'standard', license: 'apache-2.0',
    description: 'The July 2025 refresh without thinking: direct, fast answers and better instruction following.',
    tags: ['quality', 'multilingual', 'tools'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('qwen3-4b-thinking-2507-gguf', 'unsloth/Qwen3-4B-Thinking-2507-GGUF', 'Qwen3-4B-Thinking-2507-Q4_0.gguf', {
    name: 'Qwen3 4B Thinking 2507', family: 'Qwen3', params: 4, variant: 'standard', license: 'apache-2.0',
    description: 'Always reasons before answering (shown under "Show thinking"); best at math and logic among 4B models.',
    tags: ['thinking', 'quality'], config: think(QWEN_THINK_SAMPLING)
  }),
  gguf('qwen3-0.6b-abliterated-gguf', 'bartowski/mlabonne_Qwen3-0.6B-abliterated-GGUF', 'mlabonne_Qwen3-0.6B-abliterated-Q4_0.gguf', {
    name: 'Qwen3 0.6B Abliterated', family: 'Qwen3', params: 0.6, variant: 'abliterated', license: 'apache-2.0',
    description: "mlabonne's abliterated Qwen3 0.6B (bartowski quant): tiny, fast and without refusals.",
    tags: ['fast', 'multilingual', 'thinking'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('qwen3-1.7b-abliterated-gguf', 'bartowski/mlabonne_Qwen3-1.7B-abliterated-GGUF', 'mlabonne_Qwen3-1.7B-abliterated-Q4_0.gguf', {
    name: 'Qwen3 1.7B Abliterated', family: 'Qwen3', params: 1.7, variant: 'abliterated', license: 'apache-2.0',
    description: "mlabonne's abliterated Qwen3 1.7B (bartowski quant): same speed as the original, no refusals.",
    tags: ['multilingual', 'thinking'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('qwen3-4b-abliterated-gguf', 'bartowski/mlabonne_Qwen3-4B-abliterated-GGUF', 'mlabonne_Qwen3-4B-abliterated-Q4_0.gguf', {
    name: 'Qwen3 4B Abliterated', family: 'Qwen3', params: 4, variant: 'abliterated', license: 'apache-2.0',
    description: "mlabonne's abliterated Qwen3 4B (bartowski quant).",
    tags: ['quality', 'multilingual', 'thinking'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('qwen3-8b-abliterated-gguf', 'bartowski/mlabonne_Qwen3-8B-abliterated-GGUF', 'mlabonne_Qwen3-8B-abliterated-Q4_0.gguf', {
    name: 'Qwen3 8B Abliterated', family: 'Qwen3', params: 8, variant: 'abliterated', license: 'apache-2.0',
    description: "mlabonne's abliterated Qwen3 8B (bartowski quant) for 12 GB+ phones.",
    tags: ['quality', 'multilingual', 'thinking'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('qwen3-4b-instruct-2507-abliterated-gguf', 'mradermacher/Huihui-Qwen3-4B-Instruct-2507-abliterated-GGUF', 'Huihui-Qwen3-4B-Instruct-2507-abliterated.Q4_K_M.gguf', {
    name: 'Qwen3 4B Instruct 2507 Abliterated', family: 'Qwen3', params: 4, variant: 'abliterated', license: 'apache-2.0',
    description: "huihui-ai's abliterated Qwen3 4B Instruct 2507: direct answers, no thinking, no refusals.",
    tags: ['quality', 'multilingual'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('qwen3-4b-thinking-2507-abliterated-gguf', 'mradermacher/Huihui-Qwen3-4B-Thinking-2507-abliterated-GGUF', 'Huihui-Qwen3-4B-Thinking-2507-abliterated.Q4_K_M.gguf', {
    name: 'Qwen3 4B Thinking 2507 Abliterated', family: 'Qwen3', params: 4, variant: 'abliterated', license: 'apache-2.0',
    description: "huihui-ai's abliterated Qwen3 4B Thinking 2507: always reasons first, without refusals.",
    tags: ['thinking', 'quality'], config: think(QWEN_THINK_SAMPLING)
  }),

  // ─── Qwen2.5 Coder ──────────────────────────────────────────────────────────────────────────────────────────────
  gguf('qwen2.5-coder-1.5b-gguf', 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF', 'qwen2.5-coder-1.5b-instruct-q4_0.gguf', {
    name: 'Qwen2.5 Coder 1.5B', family: 'Qwen2.5 Coder', params: 1.5, variant: 'standard', license: 'apache-2.0',
    description: 'Small coding assistant: explains, writes and fixes code in dozens of languages.',
    tags: ['coding', 'fast'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('qwen2.5-coder-7b-gguf', 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', 'qwen2.5-coder-7b-instruct-q4_0.gguf', {
    name: 'Qwen2.5 Coder 7B', family: 'Qwen2.5 Coder', params: 7, variant: 'standard', license: 'apache-2.0',
    description: 'Much stronger coding model for 12 GB+ phones.',
    tags: ['coding', 'quality'], config: nothink(QWEN_SAMPLING)
  }),

  // ─── Gemma 4 ───────────────────────────────────────────────────────────────────────────────────────────────────────
  gguf('gemma-4-e2b-it-qat-gguf', 'google/gemma-4-E2B-it-qat-q4_0-gguf', 'gemma-4-E2B_q4_0-it.gguf', {
    name: 'Gemma 4 E2B (QAT)', family: 'Gemma 4', params: 2.3, variant: 'standard', license: 'apache-2.0', recommended: true,
    description: "Google's quantization-aware 4-bit build: near full-precision quality from an effective-2B model; much of the file is per-layer embeddings that are only paged in as needed.",
    tags: ['quality', 'multilingual', 'thinking'], config: nothink(GEMMA_SAMPLING)
  }),
  gguf('gemma-4-e4b-it-qat-gguf', 'google/gemma-4-E4B-it-qat-q4_0-gguf', 'gemma-4-E4B_q4_0-it.gguf', {
    name: 'Gemma 4 E4B (QAT)', family: 'Gemma 4', params: 4.5, variant: 'standard', license: 'apache-2.0',
    description: "Google's quantization-aware effective-4B model: the best Gemma for 12 GB phones.",
    tags: ['quality', 'multilingual', 'thinking'], config: nothink(GEMMA_SAMPLING)
  }),
  gguf('gemma-4-e2b-it-abliterated-gguf', 'mradermacher/Huihui-gemma-4-E2B-it-abliterated-GGUF', 'Huihui-gemma-4-E2B-it-abliterated.Q4_K_M.gguf', {
    name: 'Gemma 4 E2B Abliterated', family: 'Gemma 4', params: 2.3, variant: 'abliterated', license: 'apache-2.0',
    description: "huihui-ai's abliterated Gemma 4 E2B: Gemma's writing quality without its refusals.",
    tags: ['quality', 'multilingual', 'roleplay'], config: nothink(GEMMA_SAMPLING)
  }),
  gguf('gemma-4-e4b-it-abliterated-gguf', 'mradermacher/Huihui-gemma-4-E4B-it-abliterated-GGUF', 'Huihui-gemma-4-E4B-it-abliterated.Q4_K_M.gguf', {
    name: 'Gemma 4 E4B Abliterated', family: 'Gemma 4', params: 4.5, variant: 'abliterated', license: 'apache-2.0',
    description: "huihui-ai's abliterated Gemma 4 E4B for 12 GB phones.",
    tags: ['quality', 'multilingual', 'roleplay'], config: nothink(GEMMA_SAMPLING)
  }),

  // ─── Gemma 3 / 3n ─────────────────────────────────────────────────────────────────────────────────────────────────
  gguf('gemma-3-270m-it-gguf', 'unsloth/gemma-3-270m-it-GGUF', 'gemma-3-270m-it-Q4_0.gguf', {
    name: 'Gemma 3 270M', family: 'Gemma 3', params: 0.27, variant: 'standard', license: 'gemma',
    description: 'Tiny Gemma for very old or low-memory phones; fine for short, simple tasks.',
    tags: ['fast'], config: nothink(GEMMA_SAMPLING)
  }),
  gguf('gemma-3-1b-it-qat-gguf', 'google/gemma-3-1b-it-qat-q4_0-gguf', 'gemma-3-1b-it-q4_0.gguf', {
    name: 'Gemma 3 1B (QAT)', family: 'Gemma 3', params: 1, variant: 'standard', license: 'gemma', gated: true,
    description: "Google's quantization-aware 4-bit Gemma 3 1B (accept the Gemma license on Hugging Face first).",
    tags: ['fast', 'multilingual'], config: nothink(GEMMA_SAMPLING)
  }),
  gguf('gemma-3-4b-it-qat-gguf', 'google/gemma-3-4b-it-qat-q4_0-gguf', 'gemma-3-4b-it-q4_0.gguf', {
    name: 'Gemma 3 4B (QAT)', family: 'Gemma 3', params: 4, variant: 'standard', license: 'gemma', gated: true,
    description: "Google's quantization-aware 4-bit Gemma 3 4B: great writing quality per GB (needs the Gemma license accepted).",
    tags: ['quality', 'multilingual'], config: nothink(GEMMA_SAMPLING)
  }),
  gguf('gemma-3-1b-it-gguf', 'unsloth/gemma-3-1b-it-GGUF', 'gemma-3-1b-it-Q4_0.gguf', {
    name: 'Gemma 3 1B', family: 'Gemma 3', params: 1, variant: 'standard', license: 'gemma',
    description: 'Gemma 3 1B without the Hugging Face login step (unsloth quant).',
    tags: ['fast', 'multilingual'], config: nothink(GEMMA_SAMPLING)
  }),
  gguf('gemma-3-4b-it-gguf', 'unsloth/gemma-3-4b-it-GGUF', 'gemma-3-4b-it-Q4_0.gguf', {
    name: 'Gemma 3 4B', family: 'Gemma 3', params: 4, variant: 'standard', license: 'gemma',
    description: 'Gemma 3 4B without the Hugging Face login step (unsloth quant).',
    tags: ['quality', 'multilingual'], config: nothink(GEMMA_SAMPLING)
  }),
  gguf('gemma-3-1b-it-abliterated-gguf', 'mlabonne/gemma-3-1b-it-abliterated-v2-GGUF', 'gemma-3-1b-it-abliterated-v2.q4_k_m.gguf', {
    name: 'Gemma 3 1B Abliterated', family: 'Gemma 3', params: 1, variant: 'abliterated', license: 'gemma',
    description: "mlabonne's abliterated Gemma 3 1B (v2): quick and without refusals.",
    tags: ['fast', 'roleplay'], config: nothink(GEMMA_SAMPLING)
  }),
  gguf('gemma-3-4b-it-abliterated-gguf', 'mlabonne/gemma-3-4b-it-abliterated-v2-GGUF', 'gemma-3-4b-it-abliterated-v2.q4_k_m.gguf', {
    name: 'Gemma 3 4B Abliterated', family: 'Gemma 3', params: 4, variant: 'abliterated', license: 'gemma',
    description: "mlabonne's abliterated Gemma 3 4B (v2): a favourite for uncensored stories and roleplay.",
    tags: ['quality', 'roleplay', 'multilingual'], config: nothink(GEMMA_SAMPLING)
  }),
  gguf('gemma-3n-e2b-it-gguf', 'unsloth/gemma-3n-E2B-it-GGUF', 'gemma-3n-E2B-it-Q4_0.gguf', {
    name: 'Gemma 3n E2B', family: 'Gemma 3n', params: 2, variant: 'standard', license: 'gemma',
    description: 'Mobile-first Gemma with an effective 2B parameters; per-layer embeddings keep active memory low.',
    tags: ['multilingual'], config: nothink(GEMMA_SAMPLING)
  }),
  gguf('gemma-3n-e4b-it-gguf', 'unsloth/gemma-3n-E4B-it-GGUF', 'gemma-3n-E4B-it-Q4_0.gguf', {
    name: 'Gemma 3n E4B', family: 'Gemma 3n', params: 4, variant: 'standard', license: 'gemma',
    description: 'Larger mobile-first Gemma (effective 4B) for 12 GB phones.',
    tags: ['quality', 'multilingual'], config: nothink(GEMMA_SAMPLING)
  }),
  gguf('gemma-3n-e2b-it-abliterated-gguf', 'mradermacher/Huihui-gemma-3n-E2B-it-abliterated-GGUF', 'Huihui-gemma-3n-E2B-it-abliterated.Q4_K_M.gguf', {
    name: 'Gemma 3n E2B Abliterated', family: 'Gemma 3n', params: 2, variant: 'abliterated', license: 'gemma',
    description: "huihui-ai's abliterated Gemma 3n E2B.",
    tags: ['multilingual'], config: nothink(GEMMA_SAMPLING)
  }),
  gguf('gemma-3n-e4b-it-abliterated-gguf', 'bartowski/huihui-ai_Huihui-gemma-3n-E4B-it-abliterated-GGUF', 'huihui-ai_Huihui-gemma-3n-E4B-it-abliterated-Q4_0.gguf', {
    name: 'Gemma 3n E4B Abliterated', family: 'Gemma 3n', params: 4, variant: 'abliterated', license: 'gemma',
    description: "huihui-ai's abliterated Gemma 3n E4B (bartowski quant) for 12 GB phones.",
    tags: ['quality', 'multilingual'], config: nothink(GEMMA_SAMPLING)
  }),

  // ─── Llama 3.x ─────────────────────────────────────────────────────────────────────────────────────────────────────
  gguf('llama-3.2-1b-instruct-gguf', 'unsloth/Llama-3.2-1B-Instruct-GGUF', 'Llama-3.2-1B-Instruct-Q4_0.gguf', {
    name: 'Llama 3.2 1B', family: 'Llama 3.2', params: 1, variant: 'standard', license: 'llama3.2',
    description: "Meta's small Llama: quick, friendly chat and summaries.",
    tags: ['fast', 'tools'], config: nothink(LLAMA_SAMPLING)
  }),
  gguf('llama-3.2-3b-instruct-gguf', 'unsloth/Llama-3.2-3B-Instruct-GGUF', 'Llama-3.2-3B-Instruct-Q4_0.gguf', {
    name: 'Llama 3.2 3B', family: 'Llama 3.2', params: 3, variant: 'standard', license: 'llama3.2',
    description: "Meta's 3B Llama: solid general chat and writing on 6 GB+ phones.",
    tags: ['tools'], config: nothink(LLAMA_SAMPLING)
  }),
  gguf('llama-3.2-1b-instruct-abliterated-gguf', 'mradermacher/Llama-3.2-1B-Instruct-abliterated-GGUF', 'Llama-3.2-1B-Instruct-abliterated.Q4_K_M.gguf', {
    name: 'Llama 3.2 1B Abliterated', family: 'Llama 3.2', params: 1, variant: 'abliterated', license: 'llama3.2',
    description: 'Abliterated Llama 3.2 1B: small and without refusals.',
    tags: ['fast'], config: nothink(LLAMA_SAMPLING)
  }),
  gguf('llama-3.2-3b-instruct-abliterated-gguf', 'mradermacher/Llama-3.2-3B-Instruct-abliterated-GGUF', 'Llama-3.2-3B-Instruct-abliterated.Q4_K_M.gguf', {
    name: 'Llama 3.2 3B Abliterated', family: 'Llama 3.2', params: 3, variant: 'abliterated', license: 'llama3.2',
    description: 'Abliterated Llama 3.2 3B: uncensored general chat and stories.',
    tags: ['roleplay'], config: nothink(LLAMA_SAMPLING)
  }),
  gguf('hermes-3-llama-3.2-3b-gguf', 'NousResearch/Hermes-3-Llama-3.2-3B-GGUF', 'Hermes-3-Llama-3.2-3B.Q4_K_M.gguf', {
    name: 'Hermes 3 (Llama 3.2 3B)', family: 'Llama 3.2', params: 3, variant: 'uncensored', license: 'llama3.2',
    description: "Nous Research's neutrally aligned finetune: follows the system prompt closely; great for characters and roleplay.",
    tags: ['roleplay'], config: nothink(LLAMA_SAMPLING)
  }),
  gguf('dolphin-3.0-llama-3.2-1b-gguf', 'bartowski/Dolphin3.0-Llama3.2-1B-GGUF', 'Dolphin3.0-Llama3.2-1B-Q4_0.gguf', {
    name: 'Dolphin 3.0 (Llama 3.2 1B)', family: 'Llama 3.2', params: 1, variant: 'uncensored', license: 'llama3.2',
    description: "Eric Hartford's Dolphin: an uncensored, steerable assistant (you set the rules in the system prompt).",
    tags: ['fast', 'tools'], config: nothink(LLAMA_SAMPLING)
  }),
  gguf('dolphin-3.0-llama-3.2-3b-gguf', 'bartowski/Dolphin3.0-Llama3.2-3B-GGUF', 'Dolphin3.0-Llama3.2-3B-Q4_0.gguf', {
    name: 'Dolphin 3.0 (Llama 3.2 3B)', family: 'Llama 3.2', params: 3, variant: 'uncensored', license: 'llama3.2', recommended: true,
    description: 'Uncensored, steerable Dolphin assistant at 3B: coding, writing and roleplay without lectures.',
    tags: ['roleplay', 'coding', 'tools'], config: nothink(LLAMA_SAMPLING)
  }),
  gguf('impish-llama-3b-gguf', 'SicariusSicariiStuff/Impish_LLAMA_3B_GGUF', 'Impish_LLAMA_3B-Q4_K_M.gguf', {
    name: 'Impish Llama 3B', family: 'Llama 3.2', params: 3, variant: 'uncensored', license: 'llama3.2',
    description: 'Roleplay and creative-writing finetune of Llama 3.2 3B with a playful, uncensored voice.',
    tags: ['roleplay'], config: nothink({ temperature: 0.8, topP: 0.95, topK: 40, minP: 0.05 })
  }),
  gguf('llama-3.1-8b-instruct-gguf', 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', {
    name: 'Llama 3.1 8B', family: 'Llama 3.1', params: 8, variant: 'standard', license: 'llama3.1',
    description: "Meta's 8B Llama for 12 GB+ phones.",
    tags: ['quality', 'tools'], config: nothink(LLAMA_SAMPLING)
  }),
  gguf('llama-3.1-8b-instruct-abliterated-gguf', 'mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF', 'meta-llama-3.1-8b-instruct-abliterated.Q4_K_M.gguf', {
    name: 'Llama 3.1 8B Abliterated', family: 'Llama 3.1', params: 8, variant: 'abliterated', license: 'llama3.1',
    description: "mlabonne's abliterated Llama 3.1 8B, the model that popularised abliteration.",
    tags: ['quality', 'roleplay'], config: nothink(LLAMA_SAMPLING)
  }),
  gguf('hermes-3-llama-3.1-8b-gguf', 'NousResearch/Hermes-3-Llama-3.1-8B-GGUF', 'Hermes-3-Llama-3.1-8B.Q4_K_M.gguf', {
    name: 'Hermes 3 (Llama 3.1 8B)', family: 'Llama 3.1', params: 8, variant: 'uncensored', license: 'llama3.1',
    description: "Nous Research's neutrally aligned 8B: strong roleplay and long, coherent stories on 12 GB+ phones.",
    tags: ['roleplay', 'quality'], config: nothink(LLAMA_SAMPLING)
  }),
  gguf('dolphin-3.0-llama-3.1-8b-gguf', 'dphn/Dolphin3.0-Llama3.1-8B-GGUF', 'Dolphin3.0-Llama3.1-8B-Q4_0.gguf', {
    name: 'Dolphin 3.0 (Llama 3.1 8B)', family: 'Llama 3.1', params: 8, variant: 'uncensored', license: 'llama3.1',
    description: 'The 8B Dolphin: uncensored, steerable, good at code and writing (12 GB+ phones).',
    tags: ['roleplay', 'coding', 'quality'], config: nothink(LLAMA_SAMPLING)
  }),

  // ─── Phi-4 mini ─────────────────────────────────────────────────────────────────────────────────────────────────────
  gguf('phi-4-mini-instruct-gguf', 'bartowski/microsoft_Phi-4-mini-instruct-GGUF', 'microsoft_Phi-4-mini-instruct-Q4_0.gguf', {
    name: 'Phi-4 mini', family: 'Phi-4', params: 3.8, variant: 'standard', license: 'mit',
    description: "Microsoft's 3.8B model: strong at math, logic and following instructions.",
    tags: ['quality', 'tools', 'multilingual'], config: nothink({ temperature: 0.7, topP: 0.95, topK: 40, minP: 0 })
  }),
  gguf('phi-4-mini-reasoning-gguf', 'bartowski/microsoft_Phi-4-mini-reasoning-GGUF', 'microsoft_Phi-4-mini-reasoning-Q4_0.gguf', {
    name: 'Phi-4 mini Reasoning', family: 'Phi-4', params: 3.8, variant: 'standard', license: 'mit',
    description: 'Phi-4 mini trained to reason step by step; best for math problems.',
    tags: ['thinking', 'quality'], config: think({ temperature: 0.8, topP: 0.95, topK: 40, minP: 0 })
  }),
  gguf('phi-4-mini-instruct-abliterated-gguf', 'mradermacher/Phi-4-mini-instruct-abliterated-i1-GGUF', 'Phi-4-mini-instruct-abliterated.i1-Q4_0.gguf', {
    name: 'Phi-4 mini Abliterated', family: 'Phi-4', params: 3.8, variant: 'abliterated', license: 'mit',
    description: 'Abliterated Phi-4 mini (imatrix quant): Phi without refusals.',
    tags: ['quality'], config: nothink({ temperature: 0.7, topP: 0.95, topK: 40, minP: 0 })
  }),

  // ─── SmolLM3 ────────────────────────────────────────────────────────────────────────────────────────────────────────
  gguf('smollm3-3b-gguf', 'bartowski/HuggingFaceTB_SmolLM3-3B-GGUF', 'HuggingFaceTB_SmolLM3-3B-Q4_0.gguf', {
    name: 'SmolLM3 3B', family: 'SmolLM3', params: 3, variant: 'standard', license: 'apache-2.0',
    description: "Hugging Face's fully open 3B: hybrid thinking, six languages, long context.",
    tags: ['thinking', 'multilingual', 'tools'], config: nothink({ temperature: 0.6, topP: 0.95, topK: 40, minP: 0 })
  }),
  gguf('smollm3-3b-abliterated-gguf', 'mradermacher/Huihui-SmolLM3-3B-abliterated-i1-GGUF', 'Huihui-SmolLM3-3B-abliterated.i1-Q4_0.gguf', {
    name: 'SmolLM3 3B Abliterated', family: 'SmolLM3', params: 3, variant: 'abliterated', license: 'apache-2.0',
    description: "huihui-ai's abliterated SmolLM3 (imatrix quant).",
    tags: ['thinking', 'multilingual'], config: nothink({ temperature: 0.6, topP: 0.95, topK: 40, minP: 0 })
  }),

  // ─── LFM2.5 (Liquid; hybrid conv + attention, very fast on CPU) ─────────────────────────────────────────────────────
  gguf('lfm2.5-350m-gguf', 'LiquidAI/LFM2.5-350M-GGUF', 'LFM2.5-350M-QAD-Q4_0.gguf', {
    name: 'LFM2.5 350M', family: 'LFM2.5', params: 0.35, variant: 'standard', license: 'lfm1.0',
    description: 'Tiny hybrid model that answers almost instantly; for extraction, short replies and older phones.',
    tags: ['fast', 'multilingual'], config: nothink({ temperature: 0.3, topP: 0.95, topK: 40, minP: 0.15, repeatPenalty: 1.05 })
  }),
  gguf('lfm2.5-1.2b-instruct-gguf', 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF', 'LFM2.5-1.2B-Instruct-QAD-Q4_0.gguf', {
    name: 'LFM2.5 1.2B Instruct (GGUF)', family: 'LFM2.5', params: 1.2, variant: 'standard', license: 'lfm1.0',
    description: "Liquid's quantization-aware 4-bit build: one of the fastest good chat models on phone CPUs.",
    tags: ['fast', 'multilingual', 'tools'], config: nothink({ temperature: 0.3, topP: 0.95, topK: 40, minP: 0.15, repeatPenalty: 1.05 })
  }),
  gguf('lfm2.5-1.2b-thinking-gguf', 'LiquidAI/LFM2.5-1.2B-Thinking-GGUF', 'LFM2.5-1.2B-Thinking-Q4_0.gguf', {
    name: 'LFM2.5 1.2B Thinking', family: 'LFM2.5', params: 1.2, variant: 'standard', license: 'lfm1.0',
    description: 'The 1.2B LFM trained to think before answering: better at math and planning, still fast.',
    tags: ['thinking', 'fast'], config: think({ temperature: 0.3, topP: 0.95, topK: 40, minP: 0.15, repeatPenalty: 1.05 })
  }),
  gguf('lfm2.5-2.6b-gguf', 'LiquidAI/LFM2.5-2.6B-GGUF', 'LFM2.5-2.6B-QAD-Q4_0.gguf', {
    name: 'LFM2.5 2.6B', family: 'LFM2.5', params: 2.6, variant: 'standard', license: 'lfm1.0',
    description: 'Larger LFM with thinking and strong tool use; fast for its size on phone CPUs.',
    tags: ['thinking', 'tools', 'multilingual'], config: nothink({ temperature: 0.3, topP: 0.95, topK: 40, minP: 0.15, repeatPenalty: 1.05 })
  }),
  gguf('lfm2.5-8b-a1b-gguf', 'LiquidAI/LFM2.5-8B-A1B-GGUF', 'LFM2.5-8B-A1B-Q4_0.gguf', {
    name: 'LFM2.5 8B-A1B (MoE)', family: 'LFM2.5', params: 8.3, variant: 'standard', license: 'lfm1.0',
    description: 'Mixture of experts: 8.3B parameters but only 1.5B active per token, so it generates like a small model (12 GB phones).',
    tags: ['quality', 'fast', 'thinking'], config: nothink({ temperature: 0.3, topP: 0.95, topK: 40, minP: 0.15, repeatPenalty: 1.05 })
  }),
  gguf('lfm2.5-1.2b-instruct-abliterated-gguf', 'mradermacher/LFM2.5-1.2B-Instruct-Abliterated-GGUF', 'LFM2.5-1.2B-Instruct-Abliterated.Q4_K_M.gguf', {
    name: 'LFM2.5 1.2B Abliterated', family: 'LFM2.5', params: 1.2, variant: 'abliterated', license: 'lfm1.0',
    description: 'Abliterated LFM2.5 1.2B Instruct: fast and without refusals.',
    tags: ['fast'], config: nothink({ temperature: 0.3, topP: 0.95, topK: 40, minP: 0.15, repeatPenalty: 1.05 })
  }),
  gguf('lfm2.5-8b-a1b-abliterated-gguf', 'mradermacher/Huihui-LFM2.5-8B-A1B-abliterated-GGUF', 'Huihui-LFM2.5-8B-A1B-abliterated.Q4_K_M.gguf', {
    name: 'LFM2.5 8B-A1B Abliterated', family: 'LFM2.5', params: 8.3, variant: 'abliterated', license: 'lfm1.0',
    description: "huihui-ai's abliterated LFM2.5 MoE (1.5B active) for 12 GB phones.",
    tags: ['quality', 'fast'], config: nothink({ temperature: 0.3, topP: 0.95, topK: 40, minP: 0.15, repeatPenalty: 1.05 })
  }),

  // ─── Mistral: Ministral 3 ──────────────────────────────────────────────────────────────────────────────────────────
  gguf('ministral-3-3b-instruct-gguf', 'mistralai/Ministral-3-3B-Instruct-2512-GGUF', 'Ministral-3-3B-Instruct-2512-Q4_K_M.gguf', {
    name: 'Ministral 3 3B', family: 'Ministral 3', params: 3.4, variant: 'standard', license: 'apache-2.0',
    description: "Mistral's official 3B: crisp multilingual answers and function calling.",
    tags: ['multilingual', 'tools'], config: nothink({ temperature: 0.15, topP: 0.95, topK: 40, minP: 0 })
  }),
  gguf('ministral-3-3b-reasoning-gguf', 'unsloth/Ministral-3-3B-Reasoning-2512-GGUF', 'Ministral-3-3B-Reasoning-2512-Q4_0.gguf', {
    name: 'Ministral 3 3B Reasoning', family: 'Ministral 3', params: 3.4, variant: 'standard', license: 'apache-2.0',
    description: 'Ministral 3B tuned to think before it answers.',
    tags: ['thinking', 'multilingual'], config: think({ temperature: 0.7, topP: 0.95, topK: 40, minP: 0 })
  }),
  gguf('ministral-3-8b-instruct-gguf', 'mistralai/Ministral-3-8B-Instruct-2512-GGUF', 'Ministral-3-8B-Instruct-2512-Q4_K_M.gguf', {
    name: 'Ministral 3 8B', family: 'Ministral 3', params: 8.5, variant: 'standard', license: 'apache-2.0',
    description: "Mistral's official 8B for 12 GB+ phones.",
    tags: ['quality', 'multilingual', 'tools'], config: nothink({ temperature: 0.15, topP: 0.95, topK: 40, minP: 0 })
  }),
  gguf('ministral-3-8b-reasoning-gguf', 'unsloth/Ministral-3-8B-Reasoning-2512-GGUF', 'Ministral-3-8B-Reasoning-2512-Q4_0.gguf', {
    name: 'Ministral 3 8B Reasoning', family: 'Ministral 3', params: 8.5, variant: 'standard', license: 'apache-2.0',
    description: 'The reasoning Ministral 8B for 12 GB+ phones.',
    tags: ['thinking', 'quality'], config: think({ temperature: 0.7, topP: 0.95, topK: 40, minP: 0 })
  }),
  gguf('ministral-3-8b-instruct-abliterated-gguf', 'mradermacher/mistralai_Ministral-3-8B-Instruct-2512-abliterated-GGUF', 'mistralai_Ministral-3-8B-Instruct-2512-abliterated.Q4_K_M.gguf', {
    name: 'Ministral 3 8B Abliterated', family: 'Ministral 3', params: 8.5, variant: 'abliterated', license: 'apache-2.0',
    description: 'Abliterated Ministral 3 8B Instruct for 12 GB+ phones.',
    tags: ['quality', 'multilingual'], config: nothink({ temperature: 0.15, topP: 0.95, topK: 40, minP: 0 })
  }),
  gguf('ministral-3-8b-reasoning-abliterated-gguf', 'mradermacher/Huihui-Ministral-3-8B-Reasoning-2512-abliterated-GGUF', 'Huihui-Ministral-3-8B-Reasoning-2512-abliterated.Q4_K_M.gguf', {
    name: 'Ministral 3 8B Reasoning Abliterated', family: 'Ministral 3', params: 8.5, variant: 'abliterated', license: 'apache-2.0',
    description: "huihui-ai's abliterated Ministral 3 8B Reasoning.",
    tags: ['thinking', 'quality'], config: think({ temperature: 0.7, topP: 0.95, topK: 40, minP: 0 })
  }),

  // ─── DeepSeek-R1 distills ───────────────────────────────────────────────────────────────────────────────────────────
  gguf('deepseek-r1-distill-qwen-1.5b-gguf', 'bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF', 'DeepSeek-R1-Distill-Qwen-1.5B-Q4_0.gguf', {
    name: 'DeepSeek-R1 Distill 1.5B', family: 'DeepSeek-R1', params: 1.5, variant: 'standard', license: 'mit',
    description: 'Small reasoning model distilled from DeepSeek-R1: thinks at length, good at math, weak at chit-chat.',
    tags: ['thinking'], config: think(R1_SAMPLING)
  }),
  gguf('deepseek-r1-distill-qwen-7b-gguf', 'bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF', 'DeepSeek-R1-Distill-Qwen-7B-Q4_0.gguf', {
    name: 'DeepSeek-R1 Distill 7B', family: 'DeepSeek-R1', params: 7, variant: 'standard', license: 'mit',
    description: 'The 7B R1 distill: much stronger reasoning for 12 GB+ phones.',
    tags: ['thinking', 'quality'], config: think(R1_SAMPLING)
  }),
  gguf('deepseek-r1-0528-qwen3-8b-gguf', 'unsloth/DeepSeek-R1-0528-Qwen3-8B-GGUF', 'DeepSeek-R1-0528-Qwen3-8B-Q4_0.gguf', {
    name: 'DeepSeek-R1-0528 (Qwen3 8B)', family: 'DeepSeek-R1', params: 8, variant: 'standard', license: 'mit',
    description: "DeepSeek-R1-0528's reasoning distilled into Qwen3 8B: the strongest thinker that fits a 12 GB phone.",
    tags: ['thinking', 'quality'], config: think(R1_SAMPLING)
  }),
  gguf('deepseek-r1-distill-qwen-1.5b-abliterated-gguf', 'mradermacher/DeepSeek-R1-Distill-Qwen-1.5B-abliterated-GGUF', 'DeepSeek-R1-Distill-Qwen-1.5B-abliterated.Q4_K_M.gguf', {
    name: 'DeepSeek-R1 Distill 1.5B Abliterated', family: 'DeepSeek-R1', params: 1.5, variant: 'abliterated', license: 'mit',
    description: 'Abliterated R1 distill 1.5B: small reasoning model without refusals.',
    tags: ['thinking'], config: think(R1_SAMPLING)
  }),
  gguf('deepseek-r1-distill-qwen-7b-abliterated-gguf', 'mradermacher/DeepSeek-R1-Distill-Qwen-7B-abliterated-v2-GGUF', 'DeepSeek-R1-Distill-Qwen-7B-abliterated-v2.Q4_K_M.gguf', {
    name: 'DeepSeek-R1 Distill 7B Abliterated', family: 'DeepSeek-R1', params: 7, variant: 'abliterated', license: 'mit',
    description: 'Abliterated R1 distill 7B (v2) for 12 GB+ phones.',
    tags: ['thinking', 'quality'], config: think(R1_SAMPLING)
  }),
  gguf('deepseek-r1-0528-qwen3-8b-abliterated-gguf', 'mradermacher/Josiefied-DeepSeek-R1-0528-Qwen3-8B-abliterated-v1-i1-GGUF', 'Josiefied-DeepSeek-R1-0528-Qwen3-8B-abliterated-v1.i1-Q4_0.gguf', {
    name: 'DeepSeek-R1-0528 8B Abliterated (Josiefied)', family: 'DeepSeek-R1', params: 8, variant: 'abliterated', license: 'mit',
    description: "Goekdeniz-Guelmez's Josiefied abliteration of R1-0528 Qwen3 8B (imatrix quant).",
    tags: ['thinking', 'quality'], config: think(R1_SAMPLING)
  }),

  // ─── IBM Granite ────────────────────────────────────────────────────────────────────────────────────────────────────
  gguf('granite-4.0-h-350m-gguf', 'ibm-granite/granite-4.0-h-350m-GGUF', 'granite-4.0-h-350m-Q4_0.gguf', {
    name: 'Granite 4.0 H 350M', family: 'Granite', params: 0.35, variant: 'standard', license: 'apache-2.0',
    description: "IBM's tiny hybrid (Mamba + attention) model for quick tasks and tool calls.",
    tags: ['fast', 'tools'], config: nothink({ temperature: 0.0, topP: 1, topK: 0, minP: 0 })
  }),
  gguf('granite-4.0-h-1b-gguf', 'ibm-granite/granite-4.0-h-1b-GGUF', 'granite-4.0-h-1b-Q4_0.gguf', {
    name: 'Granite 4.0 H 1B', family: 'Granite', params: 1.5, variant: 'standard', license: 'apache-2.0',
    description: 'Hybrid Mamba Granite: low memory use even with long conversations.',
    tags: ['fast', 'tools', 'multilingual'], config: nothink({ temperature: 0.0, topP: 1, topK: 0, minP: 0 })
  }),
  gguf('granite-4.0-micro-gguf', 'ibm-granite/granite-4.0-micro-GGUF', 'granite-4.0-micro-Q4_0.gguf', {
    name: 'Granite 4.0 Micro', family: 'Granite', params: 3.4, variant: 'standard', license: 'apache-2.0',
    description: "IBM's 3B business assistant: reliable instruction following and tools.",
    tags: ['tools', 'multilingual'], config: nothink({ temperature: 0.0, topP: 1, topK: 0, minP: 0 })
  }),
  gguf('granite-4.0-h-tiny-gguf', 'ibm-granite/granite-4.0-h-tiny-GGUF', 'granite-4.0-h-tiny-Q4_0.gguf', {
    name: 'Granite 4.0 H Tiny (MoE)', family: 'Granite', params: 7, variant: 'standard', license: 'apache-2.0',
    description: 'Hybrid mixture of experts: 7B parameters, 1B active, so it runs at small-model speed on 8 GB+ phones.',
    tags: ['quality', 'tools', 'fast'], config: nothink({ temperature: 0.0, topP: 1, topK: 0, minP: 0 })
  }),
  gguf('granite-4.1-3b-gguf', 'ibm-granite/granite-4.1-3b-GGUF', 'granite-4.1-3b-Q4_0.gguf', {
    name: 'Granite 4.1 3B', family: 'Granite', params: 3.4, variant: 'standard', license: 'apache-2.0',
    description: 'Updated 3B Granite with better multilingual and tool use.',
    tags: ['tools', 'multilingual'], config: nothink({ temperature: 0.0, topP: 1, topK: 0, minP: 0 })
  }),
  gguf('granite-4.2-3b-gguf', 'ibm-granite/granite-4.2-3b-GGUF', 'granite-4.2-3b-Q4_0.gguf', {
    name: 'Granite 4.2 3B', family: 'Granite', params: 3.7, variant: 'standard', license: 'apache-2.0',
    description: 'Newest 3B Granite with optional thinking.',
    tags: ['thinking', 'tools', 'multilingual'], config: nothink({ temperature: 0.0, topP: 1, topK: 0, minP: 0 })
  }),
  gguf('granite-4.2-8b-gguf', 'ibm-granite/granite-4.2-8b-GGUF', 'granite-4.2-8b-Q4_0.gguf', {
    name: 'Granite 4.2 8B', family: 'Granite', params: 8.8, variant: 'standard', license: 'apache-2.0',
    description: 'The 8B Granite 4.2 for 12 GB+ phones.',
    tags: ['thinking', 'quality', 'tools'], config: nothink({ temperature: 0.0, topP: 1, topK: 0, minP: 0 })
  }),
  gguf('granite-3.3-2b-instruct-gguf', 'ibm-granite/granite-3.3-2b-instruct-GGUF', 'granite-3.3-2b-instruct-Q4_0.gguf', {
    name: 'Granite 3.3 2B', family: 'Granite', params: 2.5, variant: 'standard', license: 'apache-2.0',
    description: 'Compact Granite 3.3 with a thinking mode.',
    tags: ['thinking', 'tools'], config: nothink({ temperature: 0.0, topP: 1, topK: 0, minP: 0 })
  }),
  gguf('granite-4.2-3b-abliterated-gguf', 'mradermacher/granite-4.2-3b-heretic-abliterated-i1-GGUF', 'granite-4.2-3b-heretic-abliterated.i1-Q4_0.gguf', {
    name: 'Granite 4.2 3B Abliterated', family: 'Granite', params: 3.7, variant: 'abliterated', license: 'apache-2.0',
    description: 'Granite 4.2 3B abliterated with Heretic (imatrix quant).',
    tags: ['thinking'], config: nothink({ temperature: 0.0, topP: 1, topK: 0, minP: 0 })
  }),
  gguf('granite-4.1-3b-abliterated-gguf', 'mradermacher/Huihui-granite-4.1-3b-abliterated-GGUF', 'Huihui-granite-4.1-3b-abliterated.Q4_K_M.gguf', {
    name: 'Granite 4.1 3B Abliterated', family: 'Granite', params: 3.4, variant: 'abliterated', license: 'apache-2.0',
    description: "huihui-ai's abliterated Granite 4.1 3B.",
    tags: ['multilingual'], config: nothink({ temperature: 0.0, topP: 1, topK: 0, minP: 0 })
  }),
  gguf('granite-4.0-h-tiny-abliterated-gguf', 'mradermacher/Huihui-granite-4.0-h-tiny-abliterated-GGUF', 'Huihui-granite-4.0-h-tiny-abliterated.Q4_K_M.gguf', {
    name: 'Granite 4.0 H Tiny Abliterated', family: 'Granite', params: 7, variant: 'abliterated', license: 'apache-2.0',
    description: "huihui-ai's abliterated Granite MoE (1B active).",
    tags: ['fast'], config: nothink({ temperature: 0.0, topP: 1, topK: 0, minP: 0 })
  }),

  // ─── Others ────────────────────────────────────────────────────────────────────────────────────────────────────────
  gguf('nemotron-3-nano-4b-gguf', 'nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF', 'NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf', {
    name: 'Nemotron 3 Nano 4B', family: 'Nemotron', params: 4, variant: 'standard', license: 'nvidia-open-model',
    description: "NVIDIA's hybrid 4B reasoning model with tool calling.",
    tags: ['thinking', 'tools'], config: nothink({ temperature: 0.6, topP: 0.95, topK: 40, minP: 0 })
  }),
  gguf('minicpm5-1b-gguf', 'openbmb/MiniCPM5-1B-GGUF', 'MiniCPM5-1B-Q4_K_M.gguf', {
    name: 'MiniCPM5 1B', family: 'MiniCPM5', params: 1.1, variant: 'standard', license: 'apache-2.0',
    description: "OpenBMB's edge model with thinking; strong Chinese and English.",
    tags: ['thinking', 'fast', 'multilingual'], config: nothink({ temperature: 0.7, topP: 0.9, topK: 40, minP: 0 })
  }),
  gguf('minicpm5-2b-gguf', 'openbmb/MiniCPM5-2B-GGUF', 'MiniCPM5-2B-Q4_K_M.gguf', {
    name: 'MiniCPM5 2B', family: 'MiniCPM5', params: 2.5, variant: 'standard', license: 'apache-2.0',
    description: 'The 2B MiniCPM5 with thinking and tools.',
    tags: ['thinking', 'tools', 'multilingual'], config: nothink({ temperature: 0.7, topP: 0.9, topK: 40, minP: 0 })
  }),
  gguf('ornith-1.5-9b-gguf', 'ornith-ai/Ornith-1.5-9B-GGUF', 'Ornith-1.5-9B-Q4_K_M.gguf', {
    name: 'Ornith 1.5 9B', family: 'Ornith', params: 9, variant: 'standard', license: 'mit',
    description: 'Popular Qwen3.5-9B derivative tuned for reasoning and agents (12 GB+ phones).',
    tags: ['thinking', 'quality', 'tools'], config: nothink(QWEN_THINK_SAMPLING)
  }),
  gguf('ornith-1.5-9b-abliterated-gguf', 'mradermacher/Huihui-Ornith-1.5-9B-abliterated-i1-GGUF', 'Huihui-Ornith-1.5-9B-abliterated.i1-Q4_0.gguf', {
    name: 'Ornith 1.5 9B Abliterated', family: 'Ornith', params: 9, variant: 'abliterated', license: 'mit',
    description: "huihui-ai's abliterated Ornith 1.5 9B (imatrix quant).",
    tags: ['thinking', 'quality'], config: nothink(QWEN_THINK_SAMPLING)
  }),
  gguf('jan-v3.5-4b-gguf', 'janhq/Jan-v3.5-4B-gguf', 'Jan-v3.5-4B-Q4_0.gguf', {
    name: 'Jan v3.5 4B', family: 'Jan', params: 4, variant: 'standard', license: 'apache-2.0',
    description: "Jan's 4B assistant tuned for web search and tool use.",
    tags: ['tools', 'multilingual'], config: nothink(QWEN_SAMPLING)
  }),
  gguf('falcon-h1-1.5b-deep-gguf', 'tiiuae/Falcon-H1-1.5B-Deep-Instruct-GGUF', 'Falcon-H1-1.5B-Deep-Instruct-Q4_0.gguf', {
    name: 'Falcon-H1 1.5B Deep', family: 'Falcon-H1', params: 1.5, variant: 'standard', license: 'falcon-llm-license',
    description: "TII's hybrid (Mamba + attention) 1.5B: long context at low memory, 18 languages.",
    tags: ['multilingual', 'fast'], config: nothink({ temperature: 0.1, topP: 0.9, topK: 40, minP: 0 })
  }),
  gguf('falcon-h1r-7b-gguf', 'tiiuae/Falcon-H1R-7B-GGUF', 'Falcon-H1R-7B-Q4_0.gguf', {
    name: 'Falcon-H1R 7B', family: 'Falcon-H1', params: 7.6, variant: 'standard', license: 'falcon-llm-license',
    description: "TII's hybrid reasoning model for 12 GB+ phones.",
    tags: ['thinking', 'quality'], config: think({ temperature: 0.6, topP: 0.95, topK: 40, minP: 0 })
  }),
  gguf('olmo-3-7b-instruct-gguf', 'unsloth/Olmo-3-7B-Instruct-GGUF', 'Olmo-3-7B-Instruct-Q4_0.gguf', {
    name: 'OLMo 3 7B Instruct', family: 'OLMo', params: 7.3, variant: 'standard', license: 'apache-2.0',
    description: "Ai2's fully open 7B (open data and training code) for 12 GB+ phones.",
    tags: ['quality', 'tools'], config: nothink({ temperature: 0.6, topP: 0.95, topK: 40, minP: 0 })
  }),

  // ─── LiteRT-LM (CPU / GPU) ─────────────────────────────────────────────────────────────────────────────────────────
  litert('qwen3-1.7b-int4', 'litert-community/Qwen3-1.7B', 'Qwen3-1.7B_dynamic_wi4b32_afp32.litertlm', {
    name: 'Qwen3 1.7B (LiteRT)', family: 'Qwen3', params: 1.7, variant: 'standard', license: 'apache-2.0', backends: ['gpu', 'cpu'], contextLength: 4096,
    description: 'Qwen3 1.7B as a GPU-optimised LiteRT-LM bundle (INT4): fast on phone GPUs.',
    tags: ['multilingual', 'thinking'], config: { enableThinking: false }
  }),
  litert('qwen3-4b-thinking-2507-int4', 'litert-community/Qwen3-4B-Thinking-2507', 'Qwen3_4b_thinking_dynamic_wi4b32_afp32.litertlm', {
    name: 'Qwen3 4B Thinking 2507 (LiteRT)', family: 'Qwen3', params: 4, variant: 'standard', license: 'apache-2.0', backends: ['gpu', 'cpu'], contextLength: 4096,
    description: 'Reasoning Qwen3 4B as a GPU-optimised LiteRT-LM bundle; its thinking stays hidden.',
    tags: ['thinking', 'quality'], config: { enableThinking: true }
  }),
  litert('qwen3.5-0.8b-int8', 'litert-community/Qwen3.5-0.8B', 'Qwen3.5-0.8B_int8.litertlm', {
    name: 'Qwen3.5 0.8B (LiteRT)', family: 'Qwen3.5', params: 0.8, variant: 'standard', license: 'apache-2.0', backends: ['cpu'], contextLength: 4096,
    description: 'Qwen3.5 0.8B as a LiteRT-LM bundle (INT8, CPU).',
    tags: ['fast', 'multilingual'], config: { enableThinking: false }
  }),
  litert('qwen3.5-4b-int4', 'litert-community/Qwen3.5-4B', 'Qwen3.5-4B_mixed_int4.litertlm', {
    name: 'Qwen3.5 4B (LiteRT)', family: 'Qwen3.5', params: 4, variant: 'standard', license: 'apache-2.0', backends: ['cpu'], contextLength: 4096,
    description: 'Qwen3.5 4B as a mixed-INT4 LiteRT-LM bundle for the CPU (about 6 tok/s on a Pixel 8a).',
    tags: ['quality', 'multilingual'], config: { enableThinking: false }
  }),
  litert('gemma-4-e2b-it-gpu', 'litert-community/gemma-4-E2B-it-litert-lm', 'gemma-4-E2B-it-gpu.litertlm', {
    name: 'Gemma 4 E2B (GPU, text)', family: 'Gemma 4', params: 2.3, variant: 'standard', license: 'apache-2.0', backends: ['gpu'], contextLength: 4096,
    description: 'Text-only Gemma 4 E2B export for phone GPUs: smaller than the full multimodal bundle.',
    tags: ['quality', 'multilingual'], config: { sampling: { temperature: 1.0, topK: 64, topP: 0.95 } }
  }),
  litert('gemma-4-e4b-it', 'litert-community/gemma-4-E4B-it-litert-lm', 'gemma-4-E4B-it.litertlm', {
    name: 'Gemma 4 E4B', family: 'Gemma 4', params: 4.5, variant: 'standard', license: 'apache-2.0', backends: ['gpu', 'cpu'], contextLength: 4096,
    description: 'Gemma 4 E4B for 12 GB phones: the best LiteRT-LM model for writing quality.',
    tags: ['quality', 'multilingual'], config: { sampling: { temperature: 1.0, topK: 64, topP: 0.95 } }
  }),
  litert('gemma3-1b-it-int4', 'litert-community/Gemma3-1B-IT', 'gemma3-1b-it-int4.litertlm', {
    name: 'Gemma 3 1B (LiteRT)', family: 'Gemma 3', params: 1, variant: 'standard', license: 'gemma', gated: true, backends: ['gpu', 'cpu'], contextLength: 4096,
    description: "Google's INT4 Gemma 3 1B bundle for CPU and GPU (accept the Gemma license on Hugging Face first).",
    tags: ['fast', 'multilingual'], config: {}
  }),
  litert('gemma3-270m-it-q8', 'litert-community/gemma-3-270m-it', 'gemma3-270m-it-q8.litertlm', {
    name: 'Gemma 3 270M (LiteRT)', family: 'Gemma 3', params: 0.27, variant: 'standard', license: 'gemma', gated: true, backends: ['gpu', 'cpu'], contextLength: 4096,
    description: 'Tiny Gemma 3 bundle for simple tasks on any phone (Gemma license needed).',
    tags: ['fast'], config: {}
  }),
  litert('gemma-3n-e2b-it-int4', 'google/gemma-3n-E2B-it-litert-lm', 'gemma-3n-E2B-it-int4.litertlm', {
    name: 'Gemma 3n E2B (LiteRT)', family: 'Gemma 3n', params: 2, variant: 'standard', license: 'gemma', gated: true, backends: ['gpu', 'cpu'], contextLength: 4096,
    description: "Google's official Gemma 3n E2B bundle (Gemma license needed).",
    tags: ['multilingual'], config: {}
  }),
  litert('gemma-3n-e4b-it-int4', 'google/gemma-3n-E4B-it-litert-lm', 'gemma-3n-E4B-it-int4.litertlm', {
    name: 'Gemma 3n E4B (LiteRT)', family: 'Gemma 3n', params: 4, variant: 'standard', license: 'gemma', gated: true, backends: ['gpu', 'cpu'], contextLength: 4096,
    description: "Google's official Gemma 3n E4B bundle for 12 GB phones (Gemma license needed).",
    tags: ['quality', 'multilingual'], config: {}
  }),
  litert('lfm2.5-1.2b-thinking-int4', 'litert-community/LFM2.5-1.2B-Thinking', 'LFM2.5-1.2B-Thinking_int4_gpu.litertlm', {
    name: 'LFM2.5 1.2B Thinking (LiteRT)', family: 'LFM2.5', params: 1.2, variant: 'standard', license: 'lfm1.0', backends: ['gpu', 'cpu'], contextLength: 4096,
    description: 'Reasoning LFM2.5 as a GPU-optimised bundle: about 22 tok/s on a Pixel 8a GPU.',
    tags: ['thinking', 'fast'], config: { enableThinking: true }
  }),
  litert('lfm2.5-2.6b-int4', 'litert-community/LFM2.5-2.6B', 'LFM2.5-2.6B_int4.litertlm', {
    name: 'LFM2.5 2.6B (LiteRT)', family: 'LFM2.5', params: 2.6, variant: 'standard', license: 'lfm1.0', backends: ['gpu', 'cpu'], contextLength: 4096,
    description: 'Larger LFM2.5 bundle (INT4); about 11 tok/s on a Pixel 8a GPU.',
    tags: ['tools', 'multilingual'], config: { enableThinking: false }
  }),
  litert('llama-3.2-3b-int4-gpu', 'litert-community/Llama-3.2-3B', 'llama3_2_3b_mixed_int4_gpu.litertlm', {
    name: 'Llama 3.2 3B (LiteRT)', family: 'Llama 3.2', params: 3, variant: 'standard', license: 'llama3.2', gated: true, backends: ['gpu'], contextLength: 2048,
    description: "Meta's Llama 3.2 3B as a GPU bundle (accept Meta's license on Hugging Face first).",
    tags: [], config: {}
  }),
  litert('phi-4-mini-reasoning', 'litert-community/Phi-4-mini-reasoning', 'model.litertlm', {
    name: 'Phi-4 mini Reasoning (LiteRT)', family: 'Phi-4', params: 3.8, variant: 'standard', license: 'mit', backends: ['gpu', 'cpu'], contextLength: 4096,
    description: 'Phi-4 mini Reasoning bundle; about 7 tok/s on a Pixel 8a GPU.',
    tags: ['thinking', 'quality'], config: { enableThinking: true }
  }),
  litert('deepseek-r1-distill-qwen-1.5b-q8', 'litert-community/DeepSeek-R1-Distill-Qwen-1.5B', 'DeepSeek-R1-Distill-Qwen-1.5B_multi-prefill-seq_q8_ekv4096.litertlm', {
    name: 'DeepSeek-R1 Distill 1.5B (LiteRT)', family: 'DeepSeek-R1', params: 1.5, variant: 'standard', license: 'mit', backends: ['cpu'], contextLength: 4096,
    description: 'Small R1 reasoning distill as an INT8 LiteRT-LM bundle (CPU).',
    tags: ['thinking'], config: { enableThinking: true }
  }),
  litert('smollm3-3b-q4', 'litert-community/SmolLM3-3B', 'SmolLM3-3B_q4_block32_ekv4096.litertlm', {
    name: 'SmolLM3 3B (LiteRT)', family: 'SmolLM3', params: 3, variant: 'standard', license: 'apache-2.0', backends: ['cpu'], contextLength: 4096,
    description: 'SmolLM3 3B as an INT4 LiteRT-LM bundle (CPU; about 8 tok/s on a Pixel 8a).',
    tags: ['multilingual'], config: { enableThinking: false }
  }),
  litert('ministral-3-3b-instruct-q4', 'litert-community/Ministral-3-3B-Instruct-2512', 'Ministral-3-3B-Instruct-2512_q4_block32_ekv4096.litertlm', {
    name: 'Ministral 3 3B (LiteRT)', family: 'Ministral 3', params: 3.4, variant: 'standard', license: 'apache-2.0', backends: ['cpu'], contextLength: 4096,
    description: "Mistral's Ministral 3 3B as an INT4 LiteRT-LM bundle (CPU).",
    tags: ['multilingual'], config: {}
  }),
  litert('granite-4.2-3b-int4', 'litert-community/granite-4.2-3b', 'granite-4.2-3b_int4.litertlm', {
    name: 'Granite 4.2 3B (LiteRT)', family: 'Granite', params: 3.7, variant: 'standard', license: 'apache-2.0', backends: ['cpu'], contextLength: 4096,
    description: "IBM's Granite 4.2 3B as an INT4 LiteRT-LM bundle (CPU).",
    tags: ['tools'], config: { enableThinking: false }
  }),
  litert('minicpm5-2b-int4', 'litert-community/MiniCPM5-2B', 'MiniCPM5-2B_int4.litertlm', {
    name: 'MiniCPM5 2B (LiteRT)', family: 'MiniCPM5', params: 2.5, variant: 'standard', license: 'apache-2.0', backends: ['cpu'], contextLength: 4096,
    description: 'MiniCPM5 2B as an INT4 LiteRT-LM bundle (CPU).',
    tags: ['multilingual', 'thinking'], config: { enableThinking: false }
  }),
  litert('qwen2.5-coder-1.5b-int4', 'litert-community/Qwen2.5-Coder-1.5B-Instruct', 'Qwen2.5-Coder-1.5B-Instruct_int4.litertlm', {
    name: 'Qwen2.5 Coder 1.5B (LiteRT)', family: 'Qwen2.5 Coder', params: 1.5, variant: 'standard', license: 'apache-2.0', backends: ['cpu'], contextLength: 4096,
    description: 'Small coding assistant as an INT4 LiteRT-LM bundle (CPU).',
    tags: ['coding'], config: {}
  }),
  litert('olmo-2-1b-q4', 'litert-community/OLMo-2-1B-Instruct', 'OLMo-2-1B-Instruct_q4_block32_ekv4096.litertlm', {
    name: 'OLMo 2 1B (LiteRT)', family: 'OLMo', params: 1, variant: 'standard', license: 'apache-2.0', backends: ['cpu'], contextLength: 4096,
    description: "Ai2's fully open 1B as an INT4 LiteRT-LM bundle (CPU).",
    tags: ['fast'], config: {}
  }),
  litert('smollm2-360m', 'litert-community/SmolLM2-360M-Instruct', 'SmolLM2_360M_instruct.litertlm', {
    name: 'SmolLM2 360M (LiteRT)', family: 'SmolLM2', params: 0.36, variant: 'standard', license: 'apache-2.0', backends: ['cpu'], contextLength: 4096,
    description: 'Very small English chat model for low-memory phones.',
    tags: ['fast'], config: {}
  }),

  // ─── LiteRT-LM NPU builds (each only for its chip; KV cache fixed at compile time) ──────────────────────────────────
  ...['SM8550', 'SM8650', 'SM8750', 'SM8850'].map((soc) =>
    litert(`gemma3-270m-it-npu-${soc.toLowerCase()}`, 'litert-community/gemma-3-270m-it', `gemma3-270m-it-q8.qualcomm.${soc.toLowerCase()}.litertlm`, {
      name: `Gemma 3 270M (${{ SM8550: 'Snapdragon 8 Gen 2', SM8650: 'Snapdragon 8 Gen 3', SM8750: 'Snapdragon 8 Elite', SM8850: 'Snapdragon 8 Elite Gen 5' }[soc]} NPU)`,
      family: 'Gemma 3', params: 0.27, variant: 'standard', license: 'gemma', gated: true, backends: ['npu'], socs: [soc], contextLength: 4096,
      description: `Tiny Gemma 3 compiled for the ${soc} NPU: near-instant replies for simple tasks (Gemma license needed).`,
      tags: ['fast'], config: { sampler: null }
    })
  )
]
