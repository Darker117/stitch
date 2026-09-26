// On-device model catalog: what the phone can download and run, with verified file lists.
// Every size is the Hugging Face API size of that exact revision; URLs are pinned to a commit so sizes can't drift
// (a changed file on `main` would otherwise fail the download's size check). Checked 2026-09-25.
// Measured on a Pixel 8a (Tensor G3, CPU/GPU): Qwen3 0.6B CPU ≈21 tok/s, GPU ≈36 tok/s; SDXS 512 px ≈6 s (CPU);
// LCM int8 384 px 4 steps ≈10 s (CPU); Piper RTF ≈0.08, Kitten ≈0.35, Kokoro ≈1.4 (CPU).
import type { DeviceBackend, DeviceFile, DeviceFormat, DeviceTask } from './plugin'

export interface CatalogVoice {
  id: string
  name: string
  gender?: 'female' | 'male'
  language?: string
}

export interface CatalogModel {
  id: string
  task: DeviceTask
  format: DeviceFormat
  name: string
  /** Short family label shown on cards, e.g. "Gemma 3", "SD 1.5". */
  family: string
  description: string
  /** Total download size in bytes. */
  sizeBytes: number
  /** Backends this build can run on. */
  backends: DeviceBackend[]
  /** NPU builds are chip-specific: only offer on these SoC models (Build.SOC_MODEL, e.g. "SM8650"). */
  socs?: string[]
  files: DeviceFile[]
  /** File inside the model folder that is loaded (text: the .litertlm bundle). */
  entry?: string
  license: string
  homepage: string
  /** Needs a Hugging Face token with the license accepted. */
  gated?: boolean
  recommended?: boolean
  /** Rough RAM needed to run, GB. */
  minRamGb?: number
  // text
  contextLength?: number
  // image
  resolution?: number
  steps?: number
  guidance?: number
  scheduler?: string
  // voice
  voices?: CatalogVoice[]
  /** Runtime facts handed to the native engine (latent channels, TTS engine kind …). */
  config?: Record<string, unknown>
}

/** Hugging Face download URL for a file at a pinned revision (path segments URL-encoded). */
const hf = (repo: string, rev: string, path: string) =>
  `https://huggingface.co/${repo}/resolve/${rev}/${path.split('/').map(encodeURIComponent).join('/')}`

const file = (repo: string, rev: string, path: string, size: number, as = path): DeviceFile => ({
  url: hf(repo, rev, path),
  path: as,
  size,
})

const total = (files: DeviceFile[]) => files.reduce((n, f) => n + (f.size ?? 0), 0)

// --- Text (LiteRT-LM .litertlm) ---------------------------------------------------------------------------------------

const QWEN3_06B = ['litert-community/Qwen3-0.6B', 'a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76'] as const
const LFM_230M = ['litert-community/LFM2.5-230M', 'bd9c98b7627e2c4b745bd77aa948a4094dcb382b'] as const
const LFM_12B = ['litert-community/LFM2.5-1.2B-Instruct', '4ef1641b562b70ffca66ce4fee7bef4446b374b6'] as const
const GEMMA4_E2B = ['litert-community/gemma-4-E2B-it-litert-lm', 'b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1'] as const
const GEMMA3_1B = ['litert-community/Gemma3-1B-IT', 'a6306a4e292016480083b73b8dc6f3f939ae04c3'] as const
const GEMMA3_1B_G4 = ['litert-community/Gemma3-1B-IT-Tensor-G4-NPU', '4175f2d82f9f7c26a691b15015ed9a0090a196fe'] as const

type TextFields = Omit<CatalogModel, 'task' | 'format' | 'files' | 'entry' | 'sizeBytes' | 'homepage'> & { homepage?: string }

function litertlm(src: readonly [string, string], path: string, size: number, m: TextFields): CatalogModel {
  return {
    task: 'text',
    format: 'litertlm',
    files: [file(src[0], src[1], path, size)],
    entry: path,
    sizeBytes: size,
    homepage: `https://huggingface.co/${src[0]}`,
    ...m,
  }
}

/** Gemma 3 1B compiled ahead of time for one NPU (KV cache fixed at 1280 tokens). Gated: needs the Gemma license. */
const gemma3Npu = (soc: string, chip: string, path: string, size: number, note: string): CatalogModel =>
  litertlm(GEMMA3_1B, path, size, {
    id: `gemma3-1b-it-npu-${soc.toLowerCase().replace(/\s+/g, '-')}`,
    name: `Gemma 3 1B (${chip} NPU)`,
    family: 'Gemma 3',
    description: `Gemma 3 1B instruction model compiled ahead of time for the ${chip} NPU. ${note}`,
    backends: ['npu'],
    socs: [soc],
    license: 'gemma',
    gated: true,
    minRamGb: 6,
    contextLength: 1280,
    config: { sampler: null },
  })

export const TEXT_MODELS: CatalogModel[] = [
  litertlm(QWEN3_06B, 'Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm', 344671744, {
    id: 'qwen3-0.6b-int4',
    name: 'Qwen3 0.6B',
    family: 'Qwen3',
    description: 'Small, fast chat model (INT4). Runs on any recent phone: about 21 tok/s on CPU and 36 tok/s on GPU on a Pixel 8a.',
    backends: ['gpu', 'cpu'],
    license: 'apache-2.0',
    recommended: true,
    minRamGb: 4,
    contextLength: 4096,
    config: { enableThinking: false },
  }),
  litertlm(LFM_230M, 'LFM2.5-230M_int8.litertlm', 266053344, {
    id: 'lfm2.5-230m-int8',
    name: 'LFM2.5 230M',
    family: 'LFM2.5',
    description: 'Tiny hybrid (conv + attention) model for low-memory phones: very fast, simple replies.',
    backends: ['cpu', 'gpu'],
    license: 'lfm1.0',
    minRamGb: 3,
    contextLength: 4096,
    config: { enableThinking: false },
  }),
  litertlm(LFM_12B, 'LFM2.5-1.2B-Instruct_int4_gpu.litertlm', 736220768, {
    id: 'lfm2.5-1.2b-instruct-int4',
    name: 'LFM2.5 1.2B Instruct',
    family: 'LFM2.5',
    description: 'Balanced 1.2B chat model (INT4, GPU-optimised export); about 21 tok/s on a Pixel 8a GPU.',
    backends: ['gpu', 'cpu'],
    license: 'lfm1.0',
    minRamGb: 4,
    contextLength: 4096,
    config: { enableThinking: false },
  }),
  litertlm(GEMMA4_E2B, 'gemma-4-E2B-it.litertlm', 2588147712, {
    id: 'gemma-4-e2b-it',
    name: 'Gemma 4 E2B',
    family: 'Gemma 4',
    description: 'Strongest small model: effective 2B parameters, mixed 2/4/8-bit weights with memory-mapped embeddings. Needs an 8 GB phone.',
    backends: ['gpu', 'cpu'],
    license: 'apache-2.0',
    minRamGb: 8,
    contextLength: 8192,
    config: { sampling: { temperature: 1.0, topK: 64, topP: 0.95 } },
  }),
  // Snapdragon NPU builds (Qualcomm HTP through LiteRT's QNN dispatch library).
  gemma3Npu('SM8550', 'Snapdragon 8 Gen 2', 'Gemma3-1B-IT_q4_ekv1280_sm8550.litertlm', 690143232, 'Hexagon v73.'),
  gemma3Npu('SM8650', 'Snapdragon 8 Gen 3', 'Gemma3-1B-IT_q4_ekv1280_sm8650.litertlm', 690094080, 'Hexagon v75.'),
  gemma3Npu('SM8750', 'Snapdragon 8 Elite', 'Gemma3-1B-IT_q4_ekv1280_sm8750.litertlm', 689291264, 'Hexagon v79; Google measured about 85 tok/s decode on a Galaxy S25 Ultra.'),
  gemma3Npu('SM8850', 'Snapdragon 8 Elite Gen 5', 'Gemma3-1B-IT_q4_ekv1280_sm8850.litertlm', 693747712, 'Hexagon v81.'),
  litertlm(GEMMA4_E2B, 'gemma-4-E2B-it_qualcomm_sm8750.litertlm', 3016294400, {
    id: 'gemma-4-e2b-it-npu-sm8750',
    name: 'Gemma 4 E2B (Snapdragon 8 Elite NPU)',
    family: 'Gemma 4',
    description: 'Gemma 4 E2B compiled ahead of time for the Snapdragon 8 Elite NPU (Hexagon v79); KV cache fixed at 4096 tokens.',
    backends: ['npu'],
    socs: ['SM8750'],
    license: 'apache-2.0',
    minRamGb: 8,
    contextLength: 4096,
    config: { sampler: null },
  }),
  // Google Tensor NPU builds (LiteRT's Tensor dispatch → the phone's edgetpu runtime). None exist for Tensor G3.
  litertlm(GEMMA3_1B_G4, 'Gemma3-1B-IT_int4hadamard_aot_ekv4096_G4.litertlm', 874631968, {
    id: 'gemma3-1b-it-npu-tensor-g4',
    name: 'Gemma 3 1B (Tensor G4 NPU)',
    family: 'Gemma 3',
    description: 'Community int4 build compiled for the Tensor G4 TPU (Pixel 9); about 16 tok/s decode.',
    backends: ['npu'],
    socs: ['Tensor G4'],
    license: 'gemma',
    minRamGb: 6,
    contextLength: 4096,
    config: { sampler: null },
  }),
  gemma3Npu('Tensor G5', 'Tensor G5', 'Gemma3-1B-IT_q8_ekv1280_Google_Tensor_G5.litertlm', 1678542365, 'Pixel 10.'),
  gemma3Npu('Tensor G6', 'Tensor G6', 'Gemma3-1B-IT_q8_ekv1280_Google_Tensor_G6.litertlm', 2043971366, 'Pixel 11.'),
  litertlm(GEMMA4_E2B, 'gemma-4-E2B-it_Google_Tensor_G5.litertlm', 3113545589, {
    id: 'gemma-4-e2b-it-npu-tensor-g5',
    name: 'Gemma 4 E2B (Tensor G5 NPU)',
    family: 'Gemma 4',
    description: 'Gemma 4 E2B compiled ahead of time for the Tensor G5 TPU; KV cache fixed at 4096 tokens.',
    backends: ['npu'],
    socs: ['Tensor G5'],
    license: 'apache-2.0',
    minRamGb: 8,
    contextLength: 4096,
    config: { sampler: null },
  }),
  litertlm(GEMMA4_E2B, 'gemma-4-E2B-it_Google_Tensor_G6.litertlm', 3313938293, {
    id: 'gemma-4-e2b-it-npu-tensor-g6',
    name: 'Gemma 4 E2B (Tensor G6 NPU)',
    family: 'Gemma 4',
    description: 'Gemma 4 E2B compiled ahead of time for the Tensor G6 TPU; KV cache fixed at 4096 tokens.',
    backends: ['npu'],
    socs: ['Tensor G6'],
    license: 'apache-2.0',
    minRamGb: 8,
    contextLength: 4096,
    config: { sampler: null },
  }),
]

// --- Images (Stable Diffusion as ONNX) --------------------------------------------------------------------------------
// Stored in the layout the native pipeline expects: tokenizer/{vocab.json,merges.txt}, text_encoder/model.onnx,
// unet/model.onnx (+ its external data file next to it), vae_decoder/model.onnx.

const SDXS = ['skillsafeai/sdxs-512-dreamshaper-onnx-webgpu', 'b23bf8f4f809a0beb6d095bf52b5854e0b66caef'] as const
const TAESD = ['julienkay/taesd', 'c8a437fd0201c21c3bcd298fcf3181b063bcc1eb'] as const
const LCM16 = ['jdp8/lcm-dreamshaper-v7-onnx-latest', '40766987b5ed7d2ab4152c08ec8619a5356ad81a'] as const
const LCM8 = ['latentdivergence/lcm-dreamshaper-int8-onnx', '3175a0f73c6aa9e522a52f0dd2784d795bdba290'] as const
const TURBO16 = ['microsoft/sd-turbo-webnn', 'fceebfa9e757b581955a0322710a09f828218fc6'] as const
const SDTURBO = ['stabilityai/sd-turbo', 'b261bac6fd2cf515557d5d0707481eafa0485ec2'] as const

/** SD 1.x / 2.x noise schedule: scaled_linear 0.00085 → 0.012 over 1000 steps, epsilon prediction, 4 latent channels. */
const SD_SCHEDULE = {
  prediction: 'epsilon',
  betaStart: 0.00085,
  betaEnd: 0.012,
  betaSchedule: 'scaled_linear',
  trainSteps: 1000,
  latentChannels: 4,
}

const sdxsFiles = [
  file(...SDXS, 'tokenizer/vocab.json', 1059962),
  file(...SDXS, 'tokenizer/merges.txt', 524619),
  file(...SDXS, 'text_encoder.onnx', 246275486, 'text_encoder/model.onnx'),
  file(...SDXS, 'unet.onnx', 631766742, 'unet/model.onnx'),
  file(...SDXS, 'vae_decoder.onnx', 2467568, 'vae_decoder/model.onnx'),
]
const lcmInt8Files = [
  file(...LCM16, 'tokenizer/vocab.json', 1059962),
  file(...LCM16, 'tokenizer/merges.txt', 524619),
  file(...LCM16, 'text_encoder/model.onnx', 246368598),
  file(...LCM8, 'unet/model.onnx', 3049494),
  file(...LCM8, 'unet/model_int8.onnx.data', 860934400),
  file(...TAESD, 'vae_decoder/model.onnx', 4912312),
]
const lcmFp16Files = [
  file(...LCM16, 'tokenizer/vocab.json', 1059962),
  file(...LCM16, 'tokenizer/merges.txt', 524619),
  file(...LCM16, 'text_encoder/model.onnx', 246368598),
  file(...LCM16, 'unet/model.onnx', 1720309542),
  file(...LCM16, 'vae_decoder/model.onnx', 99093873),
]
const turboFp16Files = [
  file(...SDTURBO, 'tokenizer/vocab.json', 1059962),
  file(...SDTURBO, 'tokenizer/merges.txt', 524619),
  file(...TURBO16, 'text_encoder/model.onnx', 681393086),
  file(...TURBO16, 'unet/model.onnx', 1732687681),
  file(...TURBO16, 'vae_decoder/model.onnx', 99124482),
]

export const IMAGE_MODELS: CatalogModel[] = [
  {
    id: 'sdxs-512-dreamshaper',
    task: 'image',
    format: 'sd-onnx',
    name: 'SDXS DreamShaper',
    family: 'SD 1.5 · 1 step',
    description: 'One-step 512 px text-to-image distilled from DreamShaper, with a tiny (TAESD) decoder. Smallest and fastest: about 6 s per image on a Pixel 8a CPU.',
    sizeBytes: total(sdxsFiles),
    backends: ['npu', 'gpu', 'cpu'],
    files: sdxsFiles,
    license: 'openrail++',
    homepage: 'https://huggingface.co/IDKiro/sdxs-512-dreamshaper',
    recommended: true,
    minRamGb: 6,
    resolution: 512,
    steps: 1,
    guidance: 0,
    scheduler: 'euler',
    config: {
      ...SD_SCHEDULE,
      timestepSpacing: 'trailing',
      stepsOffset: 1,
      fixedResolution: 512,
      padTokenId: 49407,
      dtype: 'float32',
      weightDtype: 'float16',
      vaeScale: 1.0, // TAESD decodes UNet-space latents directly
      vaeOutputRange: [-1, 1],
      textDim: 768,
    },
  },
  {
    id: 'lcm-dreamshaper-v7-int8',
    task: 'image',
    format: 'sd-onnx',
    name: 'LCM DreamShaper v7 (INT8)',
    family: 'SD 1.5 · LCM',
    description: '4-step Latent Consistency Model with an int8 UNet and the TAESD decoder. CPU only; 384 px keeps it inside 8 GB phones (about 10 s per image on a Pixel 8a).',
    sizeBytes: total(lcmInt8Files),
    backends: ['cpu'],
    files: lcmInt8Files,
    license: 'mit',
    homepage: 'https://huggingface.co/SimianLuo/LCM_Dreamshaper_v7',
    minRamGb: 8,
    resolution: 384,
    steps: 4,
    guidance: 8,
    scheduler: 'lcm',
    config: {
      ...SD_SCHEDULE,
      originalInferenceSteps: 50,
      padTokenId: 49407,
      dtype: 'float32',
      weightDtype: 'int8',
      // Guidance feeds the UNet's w-embedding (timestep_cond, w = guidance - 1); there is no unconditional pass.
      guidanceEmbedding: true,
      vaeScale: 1.0,
      vaeOutputRange: [-1, 1],
      textDim: 768,
    },
  },
  {
    id: 'lcm-dreamshaper-v7-fp16',
    task: 'image',
    format: 'sd-onnx',
    name: 'LCM DreamShaper v7 (fp16)',
    family: 'SD 1.5 · LCM',
    description: '4-step Latent Consistency Model in fp16 with the full VAE. For the Snapdragon NPU/GPU (the first NPU run compiles and caches the graph) or 12 GB+ phones on CPU.',
    sizeBytes: total(lcmFp16Files),
    backends: ['npu', 'gpu', 'cpu'],
    files: lcmFp16Files,
    license: 'mit',
    homepage: 'https://huggingface.co/SimianLuo/LCM_Dreamshaper_v7',
    minRamGb: 12,
    resolution: 512,
    steps: 4,
    guidance: 8,
    scheduler: 'lcm',
    config: {
      ...SD_SCHEDULE,
      originalInferenceSteps: 50,
      padTokenId: 49407,
      dtype: 'float16',
      weightDtype: 'float16',
      guidanceEmbedding: true,
      vaeScale: 0.18215,
      vaeOutputRange: [-1, 1],
      textDim: 768,
    },
  },
  {
    id: 'sd-turbo-fp16',
    task: 'image',
    format: 'sd-onnx',
    name: 'SD-Turbo (fp16)',
    family: 'SD 2.1 · Turbo',
    description: 'Stability SD-Turbo, 1–4 steps at 512 px, fp16 with static shapes. Best candidate for the Snapdragon NPU/GPU; too big for CPU on 8 GB phones. Non-commercial research license.',
    sizeBytes: total(turboFp16Files),
    backends: ['npu', 'gpu', 'cpu'],
    files: turboFp16Files,
    license: 'Stability AI Non-Commercial Research Community License',
    homepage: 'https://huggingface.co/stabilityai/sd-turbo',
    minRamGb: 12,
    resolution: 512,
    steps: 1,
    guidance: 0,
    scheduler: 'turbo',
    config: {
      ...SD_SCHEDULE,
      timestepSpacing: 'trailing',
      stepsOffset: 1,
      fixedResolution: 512,
      padTokenId: 0, // the SD 2.x tokenizer pads with "!"
      dtype: 'float16',
      weightDtype: 'float16',
      vaeScale: 0.18215,
      vaeOutputRange: [-1, 1],
      textDim: 1024,
    },
  },
]

// --- Voice (sherpa-onnx TTS + Android's system voice) -----------------------------------------------------------------

/** espeak-ng-data (sherpa-onnx's phonemizer data): 355 files, 17,991,651 bytes, identical in every sherpa-onnx TTS repo. */
const ESPEAK_NG_DATA: readonly (readonly [string, number])[] = [
  ["af_dict",121473],["am_dict",63878],["an_dict",6691],["ar_dict",478165],["as_dict",5005],["az_dict",43773],
  ["ba_dict",2098],["be_dict",2652],["bg_dict",87051],["bn_dict",89979],["bpy_dict",5226],["bs_dict",47068],
  ["ca_dict",45566],["chr_dict",2859],["cmn_dict",1566335],["cs_dict",49645],["cv_dict",1344],["cy_dict",43130],
  ["da_dict",245287],["de_dict",68276],["el_dict",72841],["en_dict",166944],["eo_dict",4666],["es_dict",49252],
  ["et_dict",44263],["eu_dict",48841],["fa_dict",292423],["fi_dict",43928],["fr_dict",63727],["ga_dict",52673],
  ["gd_dict",49121],["gn_dict",3248],["grc_dict",3433],["gu_dict",82480],["hak_dict",3335],["haw_dict",2443],
  ["he_dict",6963],["hi_dict",92143],["hr_dict",49388],["ht_dict",1803],["hu_dict",153785],["hy_dict",62263],
  ["ia_dict",331275],["id_dict",43458],["intonations",2040],["io_dict",2165],["is_dict",44354],["it_dict",152889],
  ["ja_dict",47652],["jbo_dict",2243],["ka_dict",87775],["kk_dict",1859],["kl_dict",2838],["kn_dict",87828],
  ["ko_dict",47523],["kok_dict",6394],["ku_dict",2265],["ky_dict",64977],["la_dict",3806],["lang/aav/vi",111],
  ["lang/aav/vi-VN-x-central",143],["lang/aav/vi-VN-x-south",142],["lang/art/eo",41],["lang/art/ia",29],["lang/art/io",50],["lang/art/jbo",69],
  ["lang/art/lfn",135],["lang/art/piqd",56],["lang/art/py",140],["lang/art/qdb",57],["lang/art/qya",173],["lang/art/sjn",175],
  ["lang/azc/nci",114],["lang/bat/lt",28],["lang/bat/ltg",312],["lang/bat/lv",229],["lang/bnt/sw",41],["lang/bnt/tn",42],
  ["lang/ccs/ka",124],["lang/cel/cy",37],["lang/cel/ga",66],["lang/cel/gd",51],["lang/cus/om",39],["lang/dra/kn",55],
  ["lang/dra/ml",57],["lang/dra/ta",51],["lang/dra/te",70],["lang/esx/kl",30],["lang/eu",54],["lang/gmq/da",43],
  ["lang/gmq/is",27],["lang/gmq/nb",87],["lang/gmq/sv",25],["lang/gmw/af",123],["lang/gmw/de",42],["lang/gmw/en",140],
  ["lang/gmw/en-029",335],["lang/gmw/en-GB-scotland",295],["lang/gmw/en-GB-x-gbclan",238],["lang/gmw/en-GB-x-gbcwmd",188],["lang/gmw/en-GB-x-rp",249],["lang/gmw/en-US",257],
  ["lang/gmw/en-US-nyc",271],["lang/gmw/lb",31],["lang/gmw/nl",23],["lang/grk/el",23],["lang/grk/grc",99],["lang/inc/as",42],
  ["lang/inc/bn",25],["lang/inc/bpy",39],["lang/inc/gu",42],["lang/inc/hi",23],["lang/inc/kok",26],["lang/inc/mr",41],
  ["lang/inc/ne",37],["lang/inc/or",39],["lang/inc/pa",25],["lang/inc/sd",66],["lang/inc/si",55],["lang/inc/ur",94],
  ["lang/ine/hy",61],["lang/ine/hyw",365],["lang/ine/sq",103],["lang/ira/fa",90],["lang/ira/fa-Latn",269],["lang/ira/ku",40],
  ["lang/iro/chr",569],["lang/itc/la",297],["lang/jpx/ja",52],["lang/ko",51],["lang/map/haw",42],["lang/miz/mto",183],
  ["lang/myn/quc",210],["lang/poz/id",134],["lang/poz/mi",367],["lang/poz/ms",430],["lang/qu",88],["lang/roa/an",27],
  ["lang/roa/ca",25],["lang/roa/es",63],["lang/roa/es-419",167],["lang/roa/fr",79],["lang/roa/fr-BE",84],["lang/roa/fr-CH",86],
  ["lang/roa/ht",140],["lang/roa/it",109],["lang/roa/pap",62],["lang/roa/pt",95],["lang/roa/pt-BR",109],["lang/roa/ro",26],
  ["lang/sai/gn",47],["lang/sem/am",41],["lang/sem/ar",50],["lang/sem/he",40],["lang/sem/mt",41],["lang/sit/cmn",686],
  ["lang/sit/cmn-Latn-pinyin",161],["lang/sit/hak",128],["lang/sit/my",56],["lang/sit/yue",194],["lang/sit/yue-Latn-jyutping",213],["lang/tai/shn",92],
  ["lang/tai/th",37],["lang/trk/az",45],["lang/trk/ba",25],["lang/trk/cv",40],["lang/trk/kk",40],["lang/trk/ky",43],
  ["lang/trk/nog",39],["lang/trk/tk",25],["lang/trk/tr",25],["lang/trk/tt",23],["lang/trk/ug",24],["lang/trk/uz",39],
  ["lang/urj/et",237],["lang/urj/fi",237],["lang/urj/hu",73],["lang/urj/smj",45],["lang/zle/be",52],["lang/zle/ru",57],
  ["lang/zle/ru-LV",280],["lang/zle/ru-cl",91],["lang/zle/uk",97],["lang/zls/bg",111],["lang/zls/bs",230],["lang/zls/hr",262],
  ["lang/zls/mk",28],["lang/zls/sl",43],["lang/zls/sr",250],["lang/zlw/cs",23],["lang/zlw/pl",38],["lang/zlw/sk",24],
  ["lb_dict",687931],["lfn_dict",2793],["lt_dict",49890],["lv_dict",66337],["mi_dict",1346],["mk_dict",63859],
  ["ml_dict",92345],["mr_dict",87391],["ms_dict",53541],["mt_dict",4384],["mto_dict",3960],["my_dict",95948],
  ["nci_dict",1534],["ne_dict",95377],["nl_dict",65979],["no_dict",4178],["nog_dict",3294],["om_dict",2302],
  ["or_dict",89246],["pa_dict",79953],["pap_dict",2128],["phondata",550424],["phondata-manifest",21821],["phonindex",39074],
  ["phontab",55796],["piqd_dict",1710],["pl_dict",76730],["pt_dict",67817],["py_dict",2409],["qdb_dict",3028],
  ["qu_dict",1919],["quc_dict",1450],["qya_dict",1939],["ro_dict",68538],["ru_dict",8532392],["sd_dict",59928],
  ["shn_dict",88172],["si_dict",85384],["sjn_dict",1783],["sk_dict",50002],["sl_dict",45047],["smj_dict",35095],
  ["sq_dict",45003],["sr_dict",46832],["sv_dict",47836],["sw_dict",47804],["ta_dict",209553],["te_dict",94837],
  ["th_dict",2301],["tk_dict",20868],["tn_dict",3072],["tr_dict",46793],["tt_dict",2121],["ug_dict",2070],
  ["uk_dict",3492],["ur_dict",133556],["uz_dict",2540],["vi_dict",52608],["voices/!v/Alex",128],["voices/!v/Alicia",474],
  ["voices/!v/Andrea",357],["voices/!v/Andy",320],["voices/!v/Annie",315],["voices/!v/AnxiousAndy",361],["voices/!v/Demonic",3858],["voices/!v/Denis",305],
  ["voices/!v/Diogo",379],["voices/!v/Gene",281],["voices/!v/Gene2",283],["voices/!v/Henrique",381],["voices/!v/Hugo",378],["voices/!v/Jacky",267],
  ["voices/!v/Lee",338],["voices/!v/Marco",467],["voices/!v/Mario",270],["voices/!v/Michael",270],["voices/!v/Mike",112],["voices/!v/Mr serious",3193],
  ["voices/!v/Nguyen",280],["voices/!v/Reed",202],["voices/!v/RicishayMax",233],["voices/!v/RicishayMax2",435],["voices/!v/RicishayMax3",435],["voices/!v/Storm",420],
  ["voices/!v/Tweaky",3189],["voices/!v/UniRobot",417],["voices/!v/adam",75],["voices/!v/anika",493],["voices/!v/anikaRobot",512],["voices/!v/announcer",300],
  ["voices/!v/antonio",381],["voices/!v/aunty",358],["voices/!v/belinda",340],["voices/!v/benjamin",201],["voices/!v/boris",224],["voices/!v/caleb",57],
  ["voices/!v/croak",93],["voices/!v/david",112],["voices/!v/ed",287],["voices/!v/edward",151],["voices/!v/edward2",152],["voices/!v/f1",324],
  ["voices/!v/f2",357],["voices/!v/f3",375],["voices/!v/f4",350],["voices/!v/f5",432],["voices/!v/fast",149],["voices/!v/grandma",263],
  ["voices/!v/grandpa",256],["voices/!v/gustave",253],["voices/!v/ian",3168],["voices/!v/iven",261],["voices/!v/iven2",279],["voices/!v/iven3",262],
  ["voices/!v/iven4",261],["voices/!v/john",3186],["voices/!v/kaukovalta",361],["voices/!v/klatt",38],["voices/!v/klatt2",38],["voices/!v/klatt3",39],
  ["voices/!v/klatt4",39],["voices/!v/klatt5",39],["voices/!v/klatt6",39],["voices/!v/linda",350],["voices/!v/m1",335],["voices/!v/m2",264],
  ["voices/!v/m3",300],["voices/!v/m4",290],["voices/!v/m5",262],["voices/!v/m6",188],["voices/!v/m7",254],["voices/!v/m8",284],
  ["voices/!v/marcelo",251],["voices/!v/max",225],["voices/!v/michel",404],["voices/!v/miguel",382],["voices/!v/mike2",188],["voices/!v/norbert",3189],
  ["voices/!v/pablo",3142],["voices/!v/paul",284],["voices/!v/pedro",352],["voices/!v/quincy",354],["voices/!v/rob",265],["voices/!v/robert",274],
  ["voices/!v/robosoft",451],["voices/!v/robosoft2",454],["voices/!v/robosoft3",455],["voices/!v/robosoft4",447],["voices/!v/robosoft5",445],["voices/!v/robosoft6",287],
  ["voices/!v/robosoft7",410],["voices/!v/robosoft8",243],["voices/!v/sandro",530],["voices/!v/shelby",280],["voices/!v/steph",364],["voices/!v/steph2",367],
  ["voices/!v/steph3",377],["voices/!v/travis",383],["voices/!v/victor",253],["voices/!v/whisper",186],["voices/!v/whisperf",392],["voices/!v/zac",275],
  ["yue_dict",563571],
]

const withEspeak = (src: readonly [string, string], own: [string, number][]): DeviceFile[] => [
  ...own.map(([path, size]) => file(src[0], src[1], path, size)),
  ...ESPEAK_NG_DATA.map(([p, size]) => file(src[0], src[1], `espeak-ng-data/${p}`, size)),
]

const KITTEN = ['csukuangfj2/kitten-nano-en-v0_8-int8', '90dfe12687f7822a90e5afc5931b536ba6caf22a'] as const
const KOKORO = ['csukuangfj/kokoro-int8-multi-lang-v1_0', '2a360693d79b88b49b88e29aec2b53577f41f206'] as const
const PIPER = ['csukuangfj/vits-piper-en_US-lessac-medium', '83f7470750b36549037551ef7007fa3b4b8697e0'] as const

const kittenFiles = withEspeak(KITTEN, [
  ['model.int8.onnx', 24370878],
  ['voices.bin', 3276800],
  ['tokens.txt', 1064],
])
const kokoroFiles = withEspeak(KOKORO, [
  ['model.int8.onnx', 114203756],
  ['voices.bin', 28200960],
  ['tokens.txt', 687],
  ['lexicon-us-en.txt', 5956885],
  ['lexicon-zh.txt', 2365182],
])
const piperFiles = withEspeak(PIPER, [
  ['en_US-lessac-medium.onnx', 63201425],
  ['tokens.txt', 921],
])

export const VOICE_MODELS: CatalogModel[] = [
  {
    id: 'system-voice',
    task: 'voice',
    format: 'tts-system',
    name: 'Phone voice',
    family: 'Android TTS',
    description: "Android's built-in text-to-speech: nothing to download. Voices come from the phone's TTS engine (see systemVoices()).",
    sizeBytes: 0,
    backends: ['cpu'],
    files: [],
    license: 'system',
    homepage: 'https://developer.android.com/reference/android/speech/tts/TextToSpeech',
    config: { engine: 'system' },
  },
  {
    id: 'kitten-nano-en-v0_8-int8',
    task: 'voice',
    format: 'tts-onnx',
    name: 'Kitten Nano',
    family: 'Kitten TTS',
    description: 'Tiny 15M-parameter English TTS with 8 expressive voices, 24 kHz. About 3x faster than real time on a Pixel 8a CPU.',
    sizeBytes: total(kittenFiles),
    backends: ['cpu'],
    files: kittenFiles,
    license: 'apache-2.0',
    homepage: 'https://huggingface.co/KittenML/kitten-tts-nano-0.8-int8',
    recommended: true,
    minRamGb: 2,
    voices: [
      { id: '0', name: 'Jasper', gender: 'male', language: 'en-US' },
      { id: '1', name: 'Bella', gender: 'female', language: 'en-US' },
      { id: '2', name: 'Bruno', gender: 'male', language: 'en-US' },
      { id: '3', name: 'Luna', gender: 'female', language: 'en-US' },
      { id: '4', name: 'Hugo', gender: 'male', language: 'en-US' },
      { id: '5', name: 'Rosie', gender: 'female', language: 'en-US' },
      { id: '6', name: 'Leo', gender: 'male', language: 'en-US' },
      { id: '7', name: 'Kiki', gender: 'female', language: 'en-US' },
    ],
    config: {
      engine: 'kitten',
      model: 'model.int8.onnx',
      voices: 'voices.bin',
      tokens: 'tokens.txt',
      dataDir: 'espeak-ng-data',
      sampleRate: 24000,
      lengthScale: 1.0,
    },
  },
  {
    id: 'kokoro-int8-multi-lang-v1_0',
    task: 'voice',
    format: 'tts-onnx',
    name: 'Kokoro 82M',
    family: 'Kokoro',
    description: 'Best quality: 54 voices in US/UK English, Spanish, French, Hindi, Italian, Japanese, Portuguese and Chinese, 24 kHz. Heavier: a little slower than real time on a Pixel 8a CPU.',
    sizeBytes: total(kokoroFiles),
    backends: ['cpu'],
    files: kokoroFiles,
    license: 'apache-2.0',
    homepage: 'https://huggingface.co/hexgrad/Kokoro-82M',
    minRamGb: 4,
    voices: [
      { id: '0', name: 'Alloy', gender: 'female', language: 'en-US' }, // af_alloy
      { id: '1', name: 'Aoede', gender: 'female', language: 'en-US' }, // af_aoede
      { id: '2', name: 'Bella', gender: 'female', language: 'en-US' }, // af_bella
      { id: '3', name: 'Heart', gender: 'female', language: 'en-US' }, // af_heart
      { id: '4', name: 'Jessica', gender: 'female', language: 'en-US' }, // af_jessica
      { id: '5', name: 'Kore', gender: 'female', language: 'en-US' }, // af_kore
      { id: '6', name: 'Nicole', gender: 'female', language: 'en-US' }, // af_nicole
      { id: '7', name: 'Nova', gender: 'female', language: 'en-US' }, // af_nova
      { id: '8', name: 'River', gender: 'female', language: 'en-US' }, // af_river
      { id: '9', name: 'Sarah', gender: 'female', language: 'en-US' }, // af_sarah
      { id: '10', name: 'Sky', gender: 'female', language: 'en-US' }, // af_sky
      { id: '11', name: 'Adam', gender: 'male', language: 'en-US' }, // am_adam
      { id: '12', name: 'Echo', gender: 'male', language: 'en-US' }, // am_echo
      { id: '13', name: 'Eric', gender: 'male', language: 'en-US' }, // am_eric
      { id: '14', name: 'Fenrir', gender: 'male', language: 'en-US' }, // am_fenrir
      { id: '15', name: 'Liam', gender: 'male', language: 'en-US' }, // am_liam
      { id: '16', name: 'Michael', gender: 'male', language: 'en-US' }, // am_michael
      { id: '17', name: 'Onyx', gender: 'male', language: 'en-US' }, // am_onyx
      { id: '18', name: 'Puck', gender: 'male', language: 'en-US' }, // am_puck
      { id: '19', name: 'Santa', gender: 'male', language: 'en-US' }, // am_santa
      { id: '20', name: 'Alice', gender: 'female', language: 'en-GB' }, // bf_alice
      { id: '21', name: 'Emma', gender: 'female', language: 'en-GB' }, // bf_emma
      { id: '22', name: 'Isabella', gender: 'female', language: 'en-GB' }, // bf_isabella
      { id: '23', name: 'Lily', gender: 'female', language: 'en-GB' }, // bf_lily
      { id: '24', name: 'Daniel', gender: 'male', language: 'en-GB' }, // bm_daniel
      { id: '25', name: 'Fable', gender: 'male', language: 'en-GB' }, // bm_fable
      { id: '26', name: 'George', gender: 'male', language: 'en-GB' }, // bm_george
      { id: '27', name: 'Lewis', gender: 'male', language: 'en-GB' }, // bm_lewis
      { id: '28', name: 'Dora', gender: 'female', language: 'es' }, // ef_dora
      { id: '29', name: 'Alex', gender: 'male', language: 'es' }, // em_alex
      { id: '30', name: 'Siwis', gender: 'female', language: 'fr-FR' }, // ff_siwis
      { id: '31', name: 'Alpha', gender: 'female', language: 'hi' }, // hf_alpha
      { id: '32', name: 'Beta', gender: 'female', language: 'hi' }, // hf_beta
      { id: '33', name: 'Omega', gender: 'male', language: 'hi' }, // hm_omega
      { id: '34', name: 'Psi', gender: 'male', language: 'hi' }, // hm_psi
      { id: '35', name: 'Sara', gender: 'female', language: 'it' }, // if_sara
      { id: '36', name: 'Nicola', gender: 'male', language: 'it' }, // im_nicola
      { id: '37', name: 'Alpha', gender: 'female', language: 'ja' }, // jf_alpha
      { id: '38', name: 'Gongitsune', gender: 'female', language: 'ja' }, // jf_gongitsune
      { id: '39', name: 'Nezumi', gender: 'female', language: 'ja' }, // jf_nezumi
      { id: '40', name: 'Tebukuro', gender: 'female', language: 'ja' }, // jf_tebukuro
      { id: '41', name: 'Kumo', gender: 'male', language: 'ja' }, // jm_kumo
      { id: '42', name: 'Dora', gender: 'female', language: 'pt-BR' }, // pf_dora
      { id: '43', name: 'Alex', gender: 'male', language: 'pt-BR' }, // pm_alex
      { id: '44', name: 'Santa', gender: 'male', language: 'pt-BR' }, // pm_santa
      { id: '45', name: 'Xiaobei', gender: 'female', language: 'zh-CN' }, // zf_xiaobei
      { id: '46', name: 'Xiaoni', gender: 'female', language: 'zh-CN' }, // zf_xiaoni
      { id: '47', name: 'Xiaoxiao', gender: 'female', language: 'zh-CN' }, // zf_xiaoxiao
      { id: '48', name: 'Xiaoyi', gender: 'female', language: 'zh-CN' }, // zf_xiaoyi
      { id: '49', name: 'Yunjian', gender: 'male', language: 'zh-CN' }, // zm_yunjian
      { id: '50', name: 'Yunxi', gender: 'male', language: 'zh-CN' }, // zm_yunxi
      { id: '51', name: 'Yunxia', gender: 'male', language: 'zh-CN' }, // zm_yunxia
      { id: '52', name: 'Yunyang', gender: 'male', language: 'zh-CN' }, // zm_yunyang
      { id: '53', name: 'Santa', gender: 'male', language: 'es' }, // em_santa
    ],
    config: {
      engine: 'kokoro',
      model: 'model.int8.onnx',
      voices: 'voices.bin',
      tokens: 'tokens.txt',
      dataDir: 'espeak-ng-data',
      lexicon: 'lexicon-us-en.txt,lexicon-zh.txt',
      sampleRate: 24000,
      lengthScale: 1.0,
      // espeak-ng language per speaker id for the non-English, non-Chinese voices (those use the lexicons).
      langBySid: {
        '28': 'es', '29': 'es', '53': 'es',
        '30': 'fr',
        '31': 'hi', '32': 'hi', '33': 'hi', '34': 'hi',
        '35': 'it', '36': 'it',
        '37': 'ja', '38': 'ja', '39': 'ja', '40': 'ja', '41': 'ja',
        '42': 'pt-br', '43': 'pt-br', '44': 'pt-br',
      },
    },
  },
  {
    id: 'vits-piper-en_US-lessac-medium',
    task: 'voice',
    format: 'tts-onnx',
    name: 'Piper Lessac',
    family: 'Piper',
    description: 'Natural US-English narrator voice (Piper VITS, 22 kHz). Fastest neural voice: over 10x real time on a Pixel 8a CPU.',
    sizeBytes: total(piperFiles),
    backends: ['cpu'],
    files: piperFiles,
    license: 'MIT (Piper); Lessac voice data under a research license',
    homepage: 'https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/lessac/medium',
    minRamGb: 2,
    voices: [{ id: '0', name: 'Lessac', gender: 'female', language: 'en-US' }],
    config: {
      engine: 'vits',
      model: 'en_US-lessac-medium.onnx',
      tokens: 'tokens.txt',
      dataDir: 'espeak-ng-data',
      sampleRate: 22050,
      noiseScale: 0.667,
      noiseScaleW: 0.8,
      lengthScale: 1.0,
    },
  },
]

export const CATALOG: CatalogModel[] = [...TEXT_MODELS, ...IMAGE_MODELS, ...VOICE_MODELS]
