// Image models for scripts/catalog.mjs. Sizes and commits are resolved by the generator.
//
// stable-diffusion.cpp ('sd-cpp') on a Pixel 8a CPU (5 threads, OpenMP, flash attention): SD 1.5 per UNet step ≈ 5 s
// (Q8_0) / ≈ 11 s (fp16) at 384 px and ≈ 10 / ≈ 20 s at 512 px, + ≈ 5 s TAESD decode; SD-Turbo Q8 at 512 px in 2 steps
// ≈ 27 s per image. ggml's Vulkan backend was 2× slower on the Mali GPU. So SD 1.5 finetunes ship with the LCM-LoRA
// (4–8 steps) and TAESD (tiny decoder). Every checkpoint here carries its own VAE; TAESD replaces it for speed.
// Licences: CreativeML OpenRAIL-M / OpenRAIL++ / Stability community licences only.
// variant: 'uncensored' = the model card advertises NSFW-capable output; 'standard' = base or SFW-focused (neither
// runtime filters output).

const TAESD = { repo: 'madebyollin/taesd', path: 'diffusion_pytorch_model.safetensors', as: 'taesd.safetensors' }
const TAESDXL = { repo: 'madebyollin/taesdxl', path: 'diffusion_pytorch_model.safetensors', as: 'taesdxl.safetensors' }
const LCM_LORA = { repo: 'latent-consistency/lcm-lora-sdv1-5', path: 'pytorch_lora_weights.safetensors', as: 'lcm-lora-sdv1-5.safetensors' }

/** SD 1.5 finetune + LCM-LoRA + TAESD: 4 steps at CFG 1.5 with the LCM sampler (≈ 1½ min at 512 px on a Pixel 8a). */
const sd15Lcm = (id, repo, path, m) => ({
  id,
  task: 'image',
  format: 'sd-cpp',
  files: [{ repo, path }, LCM_LORA, TAESD],
  entry: path,
  backends: ['gpu', 'cpu'],
  resolution: 512,
  steps: 4,
  guidance: 1.5,
  scheduler: 'lcm',
  minRamGb: 6,
  ...m,
  config: { taesd: 'taesd.safetensors', loras: [{ path: 'lcm-lora-sdv1-5.safetensors', scale: 1 }], ...m.config },
  tags: ['lcm', ...(m.tags ?? [])]
})

const sdcpp = (id, m) => ({ id, task: 'image', format: 'sd-cpp', backends: ['gpu', 'cpu'], ...m })

/** SD 1.x ONNX exports with int8 UNet + text encoder (latentdivergence), same layout as the LCM int8 pipeline. */
const onnxInt8 = (id, repo, m) => ({
  id,
  task: 'image',
  format: 'sd-onnx',
  files: [
    { repo, path: 'tokenizer/vocab.json' },
    { repo, path: 'tokenizer/merges.txt' },
    { repo, path: 'text_encoder/model.onnx' },
    { repo, path: 'text_encoder/model_int8.onnx.data' },
    { repo, path: 'unet/model.onnx' },
    { repo, path: 'unet/model_int8.onnx.data' },
    { repo, path: 'vae_decoder/model.onnx' }
  ],
  backends: ['cpu'],
  resolution: 384,
  steps: 20,
  guidance: 7,
  scheduler: 'euler-a',
  minRamGb: 8,
  ...m,
  config: {
    prediction: 'epsilon', betaStart: 0.00085, betaEnd: 0.012, betaSchedule: 'scaled_linear', trainSteps: 1000, latentChannels: 4,
    padTokenId: 49407, dtype: 'float32', weightDtype: 'int8', vaeScale: 0.18215, vaeOutputRange: [-1, 1], textDim: 768, ...m.config
  }
})

export const IMAGES = [
  // ─── stable-diffusion.cpp: fast / distilled ──────────────────────────────────────────────────────────────────────
  sdcpp('dreamshaper-8-lcm', {
    files: [{ repo: 'Lykon/dreamshaper-8-lcm', path: 'DreamShaper8_LCM.safetensors' }, TAESD], entry: 'DreamShaper8_LCM.safetensors',
    name: 'DreamShaper 8 LCM', family: 'SD 1.5 · LCM', license: 'creativeml-openrail-m', variant: 'uncensored', recommended: true,
    description: "Lykon's DreamShaper 8 with LCM baked in: versatile art, portraits and scenes in 4–6 steps (about 1½ min at 512 px on a Pixel 8a CPU).",
    tags: ['lcm', 'artistic', 'realistic'], resolution: 512, steps: 4, guidance: 1.5, scheduler: 'lcm', minRamGb: 6,
    config: { taesd: 'taesd.safetensors' }
  }),
  sdcpp('aam-anylora-animemix-lcm', {
    files: [{ repo: 'Lykon/AAM_AnyLora_AnimeMix-LCM', path: 'LCM_AAM_AnyLoRA_AnimeMix.safetensors' }, TAESD], entry: 'LCM_AAM_AnyLoRA_AnimeMix.safetensors',
    name: 'AAM AnyLoRA Anime Mix LCM', family: 'SD 1.5 · LCM', license: 'creativeml-openrail-m', variant: 'standard', recommended: true,
    description: "Lykon's anime mix with LCM baked in: clean anime characters in 4–6 steps; pairs well with character LoRAs.",
    tags: ['lcm', 'anime'], resolution: 512, steps: 4, guidance: 1.5, scheduler: 'lcm', minRamGb: 6,
    config: { taesd: 'taesd.safetensors', clipSkip: 2 }
  }),
  sdcpp('sd-turbo-gguf', {
    files: [{ repo: 'Green-Sky/SD-Turbo-GGUF', path: 'sd_turbo-f16-q8_0.gguf' }, TAESD], entry: 'sd_turbo-f16-q8_0.gguf',
    name: 'SD-Turbo (Q8)', family: 'SD 2.1 · Turbo', license: 'stabilityai-community', variant: 'standard',
    description: "Stability's SD-Turbo for stable-diffusion.cpp: a 512 px image in 1–2 steps, about 30 s on a Pixel 8a CPU (Stability community licence).",
    tags: ['turbo', 'fast'], resolution: 512, steps: 2, guidance: 1, scheduler: 'turbo', minRamGb: 6,
    config: { taesd: 'taesd.safetensors' }
  }),
  sdcpp('realistic-vision-v51-hyper-q8', {
    files: [{ repo: 'second-state/Realistic_Vision_V6.0_B1-GGUF', path: 'realisticVisionV60B1_v51HyperVAE-Q8_0.gguf' }, TAESD], entry: 'realisticVisionV60B1_v51HyperVAE-Q8_0.gguf',
    name: 'Realistic Vision Hyper (Q8)', family: 'SD 1.5 · Hyper', license: 'creativeml-openrail-m', variant: 'uncensored', recommended: true,
    description: 'Realistic Vision (V5.1 Hyper build) as a Q8 GGUF: photoreal people and places in 6 steps, no LoRA needed.',
    tags: ['realistic', 'fast'], resolution: 512, steps: 6, guidance: 2, scheduler: 'euler-a', minRamGb: 6,
    config: { taesd: 'taesd.safetensors', schedule: 'karras', sampler: 'dpm++2s_a' }
  }),
  sdcpp('sdxl-turbo-q8', {
    files: [{ repo: 'OlegSkutte/sdxl-turbo-GGUF', path: 'sd_xl_turbo_1.0.q8_0.gguf' }, TAESDXL], entry: 'sd_xl_turbo_1.0.q8_0.gguf',
    name: 'SDXL-Turbo (Q8)', family: 'SDXL · Turbo', license: 'sai-nc-community', variant: 'standard',
    description: "Stability's SDXL-Turbo: SDXL quality in a single step at 512 px, for 12 GB phones (non-commercial licence).",
    tags: ['turbo', 'quality'], resolution: 512, steps: 1, guidance: 1, scheduler: 'turbo', minRamGb: 12,
    config: { taesd: 'taesdxl.safetensors' }
  }),

  // ─── stable-diffusion.cpp: SD 1.5 finetunes (+ LCM-LoRA) ─────────────────────────────────────────────────────────
  sd15Lcm('sd15-lcm', 'Comfy-Org/stable-diffusion-v1-5-archive', 'v1-5-pruned-emaonly-fp16.safetensors', {
    name: 'Stable Diffusion 1.5 (LCM)', family: 'SD 1.5', license: 'creativeml-openrail-m', variant: 'standard',
    description: 'The original Stable Diffusion 1.5 with the LCM-LoRA for 4-step images: the base most LoRAs are made for.',
    tags: ['general']
  }),
  sd15Lcm('realistic-vision-v51-lcm', 'SG161222/Realistic_Vision_V5.1_noVAE', 'Realistic_Vision_V5.1_fp16-no-ema.safetensors', {
    name: 'Realistic Vision 5.1 (LCM)', family: 'SD 1.5', license: 'creativeml-openrail-m', variant: 'uncensored',
    description: "SG161222's Realistic Vision 5.1 with the LCM-LoRA: the classic photoreal SD 1.5 finetune.",
    tags: ['realistic']
  }),
  sd15Lcm('cyberrealistic-lcm', 'cyberdelia/CyberRealistic', 'CyberRealistic_FINAL_FP16.safetensors', {
    name: 'CyberRealistic (LCM)', family: 'SD 1.5', license: 'creativeml-openrail-m', variant: 'standard',
    description: "Cyberdelia's CyberRealistic (final release) with the LCM-LoRA: natural skin and lighting.",
    tags: ['realistic']
  }),
  sd15Lcm('epicphotogasm-lcm', 'Yntec/epiCPhotoGasm', 'epicphotogasm_v1.safetensors', {
    name: 'epiCPhotoGasm (LCM)', family: 'SD 1.5', license: 'creativeml-openrail-m', variant: 'standard',
    description: 'epiCPhotoGasm with the LCM-LoRA: punchy, cinematic photographs.',
    tags: ['realistic']
  }),
  sd15Lcm('revanimated-lcm', 'Yntec/ReVAnimated', 'revAnimated_v121.safetensors', {
    name: 'ReV Animated (LCM)', family: 'SD 1.5', license: 'creativeml-openrail-m', variant: 'standard',
    description: 'ReV Animated 1.2.1 with the LCM-LoRA: fantasy, 2.5D and illustration styles.',
    tags: ['artistic'], config: { clipSkip: 2 }
  }),
  sd15Lcm('anything-v5-lcm', 'genai-archive/anything-v5', 'anything-v5.safetensors', {
    name: 'Anything V5 (LCM)', family: 'SD 1.5', license: 'creativeml-openrail-m', variant: 'standard',
    description: 'Anything V5 with the LCM-LoRA: bright, classic anime illustrations.',
    tags: ['anime'], config: { clipSkip: 2 }
  }),
  sd15Lcm('counterfeit-v25-lcm', 'gsdf/Counterfeit-V2.5', 'Counterfeit-V2.5_fp16.safetensors', {
    name: 'Counterfeit V2.5 (LCM)', family: 'SD 1.5', license: 'creativeml-openrail-m', variant: 'standard',
    description: 'Counterfeit V2.5 with the LCM-LoRA: detailed anime scenes and backgrounds.',
    tags: ['anime']
  }),
  sd15Lcm('meinamix-v12-lcm', 'andro-flock/MeinaMix-V12_-Final', 'original_sd_checkpoint.safetensors', {
    name: 'MeinaMix V12 (LCM)', family: 'SD 1.5', license: 'creativeml-openrail-m', variant: 'standard',
    description: 'MeinaMix V12 (final) with the LCM-LoRA: soft, colourful anime portraits.',
    tags: ['anime'], config: { clipSkip: 2 }
  }),
  sd15Lcm('hassaku-v13-lcm', 'andro-flock/Hassaku_SD1-5_v1-3', 'original_sd_checkpoint.safetensors', {
    name: 'Hassaku V1.3 (LCM)', family: 'SD 1.5', license: 'creativeml-openrail-m', variant: 'uncensored',
    description: 'Hassaku V1.3 with the LCM-LoRA: an anime model built for unfiltered (NSFW-capable) art.',
    tags: ['anime'], config: { clipSkip: 2 }
  }),

  // ─── ONNX Runtime (int8, CPU) ─────────────────────────────────────────────────────────────────────────────────────
  onnxInt8('dreamshaper-8-int8', 'latentdivergence/dreamshaper-8-int8-onnx', {
    name: 'DreamShaper 8 (INT8)', family: 'SD 1.5 · ONNX', license: 'creativeml-openrail-m', variant: 'uncensored',
    description: 'DreamShaper 8 for the ONNX pipeline with an int8 UNet: 20 Euler-a steps at 384 px on the CPU.',
    tags: ['artistic', 'realistic']
  }),
  onnxInt8('epicrealism-int8', 'latentdivergence/epicrealism-int8-onnx', {
    name: 'epiCRealism (INT8)', family: 'SD 1.5 · ONNX', license: 'creativeml-openrail-m', variant: 'standard',
    description: 'epiCRealism for the ONNX pipeline with an int8 UNet: natural photos at 384 px on the CPU.',
    tags: ['realistic']
  }),
  onnxInt8('anything-v5-int8', 'latentdivergence/anything-v5-int8-onnx', {
    name: 'Anything V5 (INT8)', family: 'SD 1.5 · ONNX', license: 'creativeml-openrail-m', variant: 'standard',
    description: 'Anything V5 for the ONNX pipeline with an int8 UNet: anime illustrations at 384 px on the CPU.',
    tags: ['anime']
  })
]
