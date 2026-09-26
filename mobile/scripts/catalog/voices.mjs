// Voice models for scripts/catalog.mjs: sherpa-onnx engines the phone runs (vits = Piper / Coqui / MeloTTS, kokoro,
// kitten). Sizes and commits are resolved by the generator; `espeak: true` adds the standard 355-file espeak-ng-data
// (ESPEAK_NG_DATA in src/device/catalog.ts) from the model's own repo, or from `espeakRepo`.
// Licences: only voices whose data allows use are listed. Most Piper "medium" voices were fine-tuned from the Lessac
// voice, whose Blizzard 2013 data is research-only; their licence line says so.

const LESSAC_NOTE = ' (fine-tuned from the research-licensed Lessac voice)'

/** [key after "vits-piper-", model file, language, voice, gender, sample rate, speakers | null, total speakers, data licence, Lessac lineage] */
const PIPER_TABLE = [
  ["en_US-joe-medium", "en_US-joe-medium.onnx", "English", "Joe", "male", 22050, null, 1, "CC0 (dataset: OHF-Voice/voice-datasets)", true],
  ["en_US-kristin-medium", "en_US-kristin-medium.onnx", "English", "Kristin", "female", 22050, null, 1, "Public domain (LibriVox recordings)", false],
  ["en_US-john-medium", "en_US-john-medium.onnx", "English", "John", "male", 22050, null, 1, "Public domain (LibriVox recordings)", false],
  ["en_US-norman-medium", "en_US-norman-medium.onnx", "English", "Norman", "male", 22050, null, 1, "Public domain (LibriVox recordings)", false],
  ["en_US-bryce-medium", "en_US-bryce-medium.onnx", "English", "Bryce", "male", 22050, null, 1, "Public domain (author's own voice)", false],
  ["en_US-ljspeech-medium", "en_US-ljspeech-medium.onnx", "English", "LJSpeech", "female", 22050, null, 1, "Public domain (LJ Speech)", false],
  ["en_US-libritts_r-medium", "en_US-libritts_r-medium.onnx", "English", "LibriTTS-R", null, 22050, [["0", "Speaker 3922"], ["1", "Speaker 8699"], ["2", "Speaker 4535"], ["3", "Speaker 6701"], ["4", "Speaker 3638"], ["5", "Speaker 922"], ["6", "Speaker 2531"], ["7", "Speaker 1638"], ["8", "Speaker 8848"], ["9", "Speaker 6544"], ["10", "Speaker 3615"], ["11", "Speaker 318"], ["12", "Speaker 6104"], ["13", "Speaker 5400"], ["14", "Speaker 5712"], ["15", "Speaker 1382"], ["16", "Speaker 2769"], ["17", "Speaker 2573"], ["18", "Speaker 1463"], ["19", "Speaker 6458"], ["20", "Speaker 4356"], ["21", "Speaker 3274"], ["22", "Speaker 8498"], ["23", "Speaker 5570"]], 904, "CC BY 4.0 (LibriTTS-R, OpenSLR 141)", true],
  ["en_GB-alba-medium", "en_GB-alba-medium.onnx", "English", "Alba", "female", 22050, null, 1, "CC BY 4.0", true],
  ["en_GB-cori-medium", "en_GB-cori-medium.onnx", "English", "Cori", "female", 22050, null, 1, "Public domain (LibriVox recordings)", false],
  ["en_GB-cori-high", "en_GB-cori-high.onnx", "English", "Cori", "female", 22050, null, 1, "Public domain (LibriVox recordings)", false],
  ["en_GB-northern_english_male-medium", "en_GB-northern_english_male-medium.onnx", "English", "Northern English Male", "male", 22050, null, 1, "CC BY-SA 4.0 (OpenSLR 83)", true],
  ["en_GB-jenny_dioco-medium", "en_GB-jenny_dioco-medium.onnx", "English", "Jenny Dioco", "female", 22050, null, 1, "Jenny (Dioco) custom licence: commercial use permitted; attribution required in apps - voice must be called \"Jenny\" / \"Jenny (Dioco)\" (verified in dioco-group/jenny-tts-dataset README)", true],
  ["en_GB-vctk-medium", "en_GB-vctk-medium.onnx", "English", "VCTK", null, 22050, [["0", "Speaker p239"], ["1", "Speaker p236"], ["2", "Speaker p264"], ["3", "Speaker p250"], ["4", "Speaker p259"], ["5", "Speaker p247"], ["6", "Speaker p261"], ["7", "Speaker p263"], ["8", "Speaker p283"], ["9", "Speaker p286"], ["10", "Speaker p274"], ["11", "Speaker p276"], ["12", "Speaker p270"], ["13", "Speaker p281"], ["14", "Speaker p277"], ["15", "Speaker p231"], ["16", "Speaker p271"], ["17", "Speaker p238"], ["18", "Speaker p257"], ["19", "Speaker p273"], ["20", "Speaker p284"], ["21", "Speaker p329"], ["22", "Speaker p361"], ["23", "Speaker p287"]], 109, "CC BY 4.0 (VCTK)", true],
  ["en_GB-aru-medium", "en_GB-aru-medium.onnx", "English", "ARU", null, 22050, [["0", "Speaker 03"], ["1", "Speaker 06"], ["2", "Speaker 10"], ["3", "Speaker 01"], ["4", "Speaker 09"], ["5", "Speaker 08"], ["6", "Speaker 11"], ["7", "Speaker 05"], ["8", "Speaker 12"], ["9", "Speaker 02"], ["10", "Speaker 07"], ["11", "Speaker 04"]], 12, "CC BY 4.0 (Liverpool ARU speech corpus)", true],
  ["de_DE-thorsten-medium", "de_DE-thorsten-medium.onnx", "German", "Thorsten", "male", 22050, null, 1, "CC0 (Thorsten-Voice)", true],
  ["de_DE-thorsten-high", "de_DE-thorsten-high.onnx", "German", "Thorsten", "male", 22050, null, 1, "CC0 (Thorsten-Voice)", true],
  ["de_DE-thorsten_emotional-medium", "de_DE-thorsten_emotional-medium.onnx", "German", "Thorsten (emotions)", "male", 22050, [["0", "Amused"], ["1", "Angry"], ["2", "Disgusted"], ["3", "Drunk"], ["4", "Neutral"], ["5", "Sleepy"], ["6", "Surprised"], ["7", "Whisper"]], 8, "CC0 (Thorsten-Voice emotional)", true],
  ["de_DE-kerstin-low", "de_DE-kerstin-low.onnx", "German", "Kerstin", "female", 16000, null, 1, "CC0 (rhasspy/dataset-voice-kerstin)", true],
  ["de_DE-eva_k-x_low", "de_DE-eva_k-x_low.onnx", "German", "Eva K", "female", 16000, null, 1, "M-AILABS licence (BSD-style, \"including any commercial use\", verified via web.archive.org copy of caito.de page)", false],
  ["fr_FR-siwis-medium", "fr_FR-siwis-medium.onnx", "French", "Siwis", "female", 22050, null, 1, "CC BY 4.0 (SIWIS)", true],
  ["fr_FR-upmc-medium", "fr_FR-upmc-medium.onnx", "French", "Upmc", null, 22050, [["0", "Jessica"], ["1", "Pierre"]], 2, "CC BY-SA 4.0 (MaryTTS UPMC data)", true],
  ["fr_FR-gilles-low", "fr_FR-gilles-low.onnx", "French", "Gilles", "male", 16000, null, 1, "CC0 (Kaggle French single speaker)", true],
  ["es_ES-davefx-medium", "es_ES-davefx-medium.onnx", "Spanish", "Davefx", "male", 22050, null, 1, "CC0 (OHF-Voice/voice-datasets)", true],
  ["es_ES-sharvard-medium", "es_ES-sharvard-medium.onnx", "Spanish", "Sharvard", null, 22050, [["0", "M"], ["1", "F"]], 2, "CC BY 3.0 (Sharvard corpus)", true],
  ["es_ES-carlfm-x_low", "es_ES-carlfm-x_low.onnx", "Spanish", "Carlfm", "male", 16000, null, 1, "Public domain (carlfm01/my-speech-datasets)", false],
  ["es_MX-ald-medium", "es_MX-ald-medium.onnx", "Spanish", "Ald", "male", 22050, null, 1, "Unlicense (public domain dedication)", true],
  ["es_MX-claude-high", "es_MX-claude-high.onnx", "Spanish", "Claude", null, 22050, null, 1, "Apache-2.0 (per card; training details \"see URL\" HirCoir/Piper-TTS-Spanish)", false],
  ["es_AR-daniela-high", "es_AR-daniela-high.onnx", "Spanish", "Daniela", "female", 22050, null, 1, "CC BY-SA 4.0 (OpenSLR 61)", true],
  ["it_IT-paola-medium", "it_IT-paola-medium.onnx", "Italian", "Paola", "female", 22050, null, 1, "CC0 (dataset paolapersico1/Voice-Dataset-Italian, per HF cardData; card says \"See URL\")", true],
  ["it_IT-riccardo-x_low", "it_IT-riccardo-x_low.onnx", "Italian", "Riccardo", "male", 16000, null, 1, "M-AILABS licence (BSD-style, commercial use allowed)", false],
  ["pt_BR-faber-medium", "pt_BR-faber-medium.onnx", "Portuguese", "Faber", "male", 22050, null, 1, "CC0 (OHF-Voice/voice-datasets)", true],
  ["pt_BR-cadu-medium", "pt_BR-cadu-medium.onnx", "Portuguese", "Cadu", "male", 22050, null, 1, "CC0 (OHF-Voice/voice-datasets)", true],
  ["pt_BR-jeff-medium", "pt_BR-jeff-medium.onnx", "Portuguese", "Jeff", "male", 22050, null, 1, "CC0 (OHF-Voice/voice-datasets)", true],
  ["pt_PT-tugao-medium", "pt_PT-tugao-medium.onnx", "Portuguese", "Tugao", "male", 22050, null, 1, "CC0 (NabuCasa/OHF voice-datasets)", true],
  ["nl_NL-alex-medium", "nl_NL-alex-medium.onnx", "Dutch", "Alex", "male", 22050, null, 1, "CC0 (OHF-Voice/voice-datasets)", false],
  ["nl_BE-nathalie-medium", "nl_BE-nathalie-medium.onnx", "Dutch", "Nathalie", "female", 22050, null, 1, "CC0 (rhasspy/dataset-voice-nathalie)", true],
  ["nl_BE-rdh-medium", "nl_BE-rdh-medium.onnx", "Dutch", "RDH", "male", 22050, null, 1, "CC0 1.0 (r-dh/dutch-vl-tts)", false],
  ["pl_PL-gosia-medium", "pl_PL-gosia-medium.onnx", "Polish", "Gosia", "female", 22050, null, 1, "CC0 (OHF-Voice/voice-datasets)", true],
  ["pl_PL-darkman-medium", "pl_PL-darkman-medium.onnx", "Polish", "Darkman", "male", 22050, null, 1, "CC0 (OHF-Voice/voice-datasets)", true],
  ["pl_PL-mc_speech-medium", "pl_PL-mc_speech-medium.onnx", "Polish", "MC Speech", "male", 22050, null, 1, "CC0 (MC Speech dataset)", true],
  ["pl_PL-bass-high", "pl_PL-bass-high.onnx", "Polish", "Bass", "male", 22050, null, 1, "Apache-2.0 (per card)", true],
  ["ru_RU-denis-medium", "ru_RU-denis-medium.onnx", "Russian", "Denis", "male", 22050, null, 1, "CC0 (OHF-Voice/voice-datasets)", true],
  ["ru_RU-dmitri-medium", "ru_RU-dmitri-medium.onnx", "Russian", "Dmitri", "male", 22050, null, 1, "CC0 (OHF-Voice/voice-datasets)", true],
  ["uk_UA-ukrainian_tts-medium", "uk_UA-ukrainian_tts-medium.onnx", "Ukrainian", "Ukrainian TTS", null, 22050, [["0", "Lada"], ["1", "Mykyta"], ["2", "Tetiana"]], 3, "CC0 (OHF-Voice/voice-datasets)", false],
  ["uk_UA-lada-x_low", "uk_UA-lada-x_low.onnx", "Ukrainian", "Lada", "female", 16000, null, 1, "Apache-2.0 (egorsmkv/ukrainian-tts-datasets)", false],
  ["sv_SE-nst-medium", "sv_SE-nst-medium.onnx", "Swedish", "NST", null, 22050, null, 1, "CC0 (NST via Sprakbanken)", false],
  ["sv_SE-alma-medium", "sv_SE-alma-medium.onnx", "Swedish", "Alma", "female", 22050, null, 1, "CC BY 4.0 (model weights, per card)", false],
  ["no_NO-talesyntese-medium", "no_NO-talesyntese-medium.onnx", "Norwegian", "Talesyntese", null, 22050, null, 1, "CC0 (Sprakbanken)", true],
  ["da_DK-talesyntese-medium", "da_DK-talesyntese-medium.onnx", "Danish", "Talesyntese", null, 22050, null, 1, "CC0 (Sprakbanken)", true],
  ["fi_FI-harri-medium", "fi_FI-harri-medium.onnx", "Finnish", "Harri", "male", 22050, null, 1, "CC0 (Kaggle Finnish single speaker)", true],
  ["cs_CZ-jirka-medium", "cs_CZ-jirka-medium.onnx", "Czech", "Jirka", "male", 22050, null, 1, "CC0 (OHF-Voice/voice-datasets)", true],
  ["el_GR-rapunzelina-low", "el_GR-rapunzelina-low.onnx", "Greek", "Rapunzelina", "female", 16000, null, 1, "CC0 (Kaggle Greek single speaker)", true],
  ["hu_HU-anna-medium", "hu_HU-anna-medium.onnx", "Hungarian", "Anna", "female", 22050, null, 1, "CC0 (OHF-Voice/voice-datasets)", true],
  ["hu_HU-imre-medium", "hu_HU-imre-medium.onnx", "Hungarian", "Imre", "male", 22050, null, 1, "CC0 (OHF-Voice/voice-datasets)", true],
  ["ro_RO-mihai-medium", "ro_RO-mihai-medium.onnx", "Romanian", "Mihai", "male", 22050, null, 1, "CC0 (OHF-Voice/voice-datasets)", true],
  ["vi_VN-vais1000-medium", "vi_VN-vais1000-medium.onnx", "Vietnamese", "VAIS-1000", "female", 22050, null, 1, "CC BY 4.0 (VAIS-1000)", true],
  ["ca_ES-upc_ona-medium", "ca_ES-upc_ona-medium.onnx", "Catalan", "UPC Ona", "female", 22050, null, 1, "CC BY-SA 3.0 ES (UPC Festcat)", true],
  ["ca_ES-upc_pau-x_low", "ca_ES-upc_pau-x_low.onnx", "Catalan", "UPC Pau", "male", 16000, null, 1, "CC BY-SA 3.0 ES (UPC Festcat)", false],
  ["fa_IR-amir-medium", "fa_IR-amir-medium.onnx", "Persian", "Amir", "male", 22050, null, 1, "CC0 (datacula)", true],
  ["fa_IR-ganji-medium", "fa_IR-ganji-medium.onnx", "Persian", "Ganji", "male", 22050, null, 1, "CC0 (datacula)", true],
  ["kk_KZ-issai-high", "kk_KZ-issai-high.onnx", "Kazakh", "ISSAI", null, 22050, [["0", "Issai Kazakhtts2 M2"], ["1", "Issai Kazakhtts M1 Iseke"], ["2", "Issai Kazakhtts2 F3"], ["3", "Issai Kazakhtts F1 Raya"], ["4", "Issai Kazakhtts2 F1"], ["5", "Issai Kazakhtts2 F2"]], 6, "CC BY 4.0 (ISSAI KazakhTTS)", false],
  ["kk_KZ-raya-x_low", "kk_KZ-raya-x_low.onnx", "Kazakh", "Raya", "female", 16000, null, 1, "CC BY 4.0 (ISSAI KazakhTTS)", false],
  ["ne_NP-chitwan-medium", "ne_NP-chitwan-medium.onnx", "Nepali", "Chitwan", null, 22050, null, 1, "CC0 (OHF-Voice/voice-datasets)", true],
  ["ne_NP-google-medium", "ne_NP-google-medium.onnx", "Nepali", "Google", null, 22050, [["0", "Speaker 0546"], ["1", "Speaker 3614"], ["2", "Speaker 2099"], ["3", "Speaker 3960"], ["4", "Speaker 6834"], ["5", "Speaker 7957"], ["6", "Speaker 6329"], ["7", "Speaker 9407"], ["8", "Speaker 6587"], ["9", "Speaker 0258"], ["10", "Speaker 2139"], ["11", "Speaker 5687"], ["12", "Speaker 0283"], ["13", "Speaker 3997"], ["14", "Speaker 3154"], ["15", "Speaker 0883"], ["16", "Speaker 2027"], ["17", "Speaker 0649"]], 18, "CC BY-SA 4.0 (OpenSLR 43)", true],
  ["cy_GB-bu_tts-medium", "cy_GB-bu_tts-medium.onnx", "Welsh", "BU-TTS", null, 22050, [["0", "Benyw-de-pro"], ["1", "Benyw-gogledd-pro"], ["2", "Gwryw-gogledd-pro"], ["3", "Gwryw-gogledd-2"], ["4", "Gwryw-de-1"], ["5", "Gwryw-gogledd-1"], ["6", "Benyw-gogledd-1"]], 7, "CC-BY per MODEL_CARD; dataset techiaith/bu-tts-cy-en is tagged cc0-1.0 on HF", true],
  ["is_IS-ugla-medium", "is_IS-ugla-medium.onnx", "Icelandic", "Ugla", "female", 22050, null, 1, "CC BY 4.0 (Talromur, verified on hdl.handle.net/20.500.12537/104)", false],
  ["is_IS-bui-medium", "is_IS-bui-medium.onnx", "Icelandic", "Bui", "male", 22050, null, 1, "CC BY 4.0 (Talromur)", false],
  ["sk_SK-lili-medium", "sk_SK-lili-medium.onnx", "Slovak", "Lili", "female", 22050, null, 1, "CC0 (OHF-Voice/voice-datasets)", true],
  ["sl_SI-artur-medium", "sl_SI-artur-medium.onnx", "Slovenian", "Artur", "male", 22050, null, 1, "CC BY 4.0 (ppisljar/artur_studio_tts)", false],
  ["lv_LV-aivars-medium", "lv_LV-aivars-medium.onnx", "Latvian", "Aivars", "male", 22050, null, 1, "CC0 1.0", false],
  ["eu_ES-antton-medium", "eu_ES-antton-medium.onnx", "Basque", "Antton", "male", 22050, null, 1, "CC BY 4.0 (itzune/antton-dataset)", true],
  ["eu_ES-maider-medium", "eu_ES-maider-medium.onnx", "Basque", "Maider", "female", 22050, null, 1, "CC BY 4.0 (itzune/maider-dataset)", true],
  ["sq_AL-edon-medium", "sq_AL-edon-medium.onnx", "Albanian", "Edon", "male", 22050, null, 1, "CC0 (edonseki/folsh.ai)", true],
  ["ur_PK-fasih-medium", "ur_PK-fasih-medium.onnx", "Urdu", "Fasih", "male", 22050, null, 1, "MIT (per card)", true],
]

/** Newer conversions live under csukuangfj2. */
const PIPER_ORG2 = new Set(['nl_NL-alex-medium', 'pl_PL-bass-high', 'sv_SE-alma-medium', 'eu_ES-antton-medium', 'eu_ES-maider-medium', 'sq_AL-edon-medium', 'ur_PK-fasih-medium'])

const piper = ([key, model, language, voice, gender, sampleRate, speakers, total, license, lineage]) => {
  const repo = `${PIPER_ORG2.has(key) ? 'csukuangfj2' : 'csukuangfj'}/vits-piper-${key}`
  const locale = key.split('-')[0].replace('_', '-')
  const quality = key.split('-').pop()
  const multi = total > 1
  return {
    id: `vits-piper-${key}`,
    task: 'voice',
    format: 'tts-onnx',
    files: [{ repo, path: model }, { repo, path: 'tokens.txt' }],
    espeak: true,
    name: `Piper ${voice}${multi ? ` (${total} voices)` : ''}`,
    family: 'Piper',
    description: `${language} (${locale})${gender ? ` ${gender}` : ''} ${multi ? `multi-speaker model with ${total} voices${speakers.length < total ? ` (${speakers.length} listed)` : ''}` : 'voice'}, Piper ${quality.replace('_', '-')} quality, ${sampleRate / 1000} kHz.`,
    backends: ['cpu'],
    license: `MIT (Piper); voice data: ${license}${lineage ? LESSAC_NOTE : ''}`,
    homepage: 'https://huggingface.co/rhasspy/piper-voices',
    minRamGb: 2,
    variant: 'standard',
    tags: [language.toLowerCase(), ...(quality === 'high' ? ['quality'] : quality === 'low' || quality === 'x_low' ? ['fast'] : []), ...(multi ? ['multi-speaker'] : [])],
    voices: (speakers ?? [['0', voice]]).map(([id, name]) => ({ id, name, ...(gender && !multi ? { gender } : {}), language: locale })),
    config: { engine: 'vits', model, tokens: 'tokens.txt', dataDir: 'espeak-ng-data', sampleRate, noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 }
  }
}

const KITTEN_VOICES = ['Jasper', 'Bella', 'Bruno', 'Luna', 'Hugo', 'Rosie', 'Leo', 'Kiki'].map((name, i) => ({ id: String(i), name, gender: i % 2 ? 'female' : 'male', language: 'en-US' }))
const kitten = (id, repo, model, m) => ({
  id,
  task: 'voice',
  format: 'tts-onnx',
  files: [{ repo, path: model }, { repo, path: 'voices.bin' }, { repo, path: 'tokens.txt' }],
  espeak: true,
  family: 'Kitten TTS',
  backends: ['cpu'],
  license: 'apache-2.0',
  homepage: 'https://huggingface.co/KittenML',
  variant: 'standard',
  voices: KITTEN_VOICES,
  config: { engine: 'kitten', model, voices: 'voices.bin', tokens: 'tokens.txt', dataDir: 'espeak-ng-data', sampleRate: 24000, lengthScale: 1.0 },
  ...m
})

/** Coqui character-based VITS (no phonemizer): languages Piper has no usable voice for. */
const coqui = (lang, language, locale) => ({
  id: `vits-coqui-${lang}-cv`,
  task: 'voice',
  format: 'tts-onnx',
  files: [{ repo: `csukuangfj/vits-coqui-${lang}-cv`, path: 'model.onnx' }, { repo: `csukuangfj/vits-coqui-${lang}-cv`, path: 'tokens.txt' }],
  name: `Coqui ${language}`,
  family: 'Coqui VITS',
  backends: ['cpu'],
  license: 'bsd-3-clause (Coqui TTS; Common Voice data)',
  description: `${language} voice from Coqui TTS (VITS trained on Common Voice), 22 kHz. It reads letters directly, so pronunciation is simpler than Piper's.`,
  homepage: 'https://github.com/coqui-ai/TTS',
  minRamGb: 2,
  variant: 'standard',
  tags: [language.toLowerCase()],
  voices: [{ id: '0', name: language, language: locale }],
  config: { engine: 'vits', model: 'model.onnx', tokens: 'tokens.txt', sampleRate: 22050, noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 }
})

const inflect = (size, mb) => ({
  id: `vits-inflect-en-${size}-v2`,
  task: 'voice',
  format: 'tts-onnx',
  files: [{ repo: `csukuangfj/vits-inflect-en-${size}-v2`, path: 'model.onnx' }, { repo: `csukuangfj/vits-inflect-en-${size}-v2`, path: 'tokens.txt' }],
  espeak: true,
  name: `Inflect ${size === 'nano' ? 'Nano' : 'Micro'}`,
  family: 'Inflect',
  backends: ['cpu'],
  license: 'apache-2.0',
  homepage: `https://huggingface.co/owensong/Inflect-${size === 'nano' ? 'Nano' : 'Micro'}-v2`,
  description: `${mb} MB English voice (2026) that holds up against much bigger models${size === 'nano' ? ': the smallest good-sounding voice here' : '; clearer than Nano'}. 24 kHz.`,
  minRamGb: 2,
  variant: 'standard',
  recommended: size === 'nano',
  tags: ['english', size === 'nano' ? 'fast' : 'quality'],
  voices: [{ id: '0', name: 'Inflect', gender: 'female', language: 'en-US' }],
  config: { engine: 'vits', model: 'model.onnx', tokens: 'tokens.txt', dataDir: 'espeak-ng-data', sampleRate: 24000, noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 }
})

const KOKORO_V11 = 'csukuangfj/kokoro-int8-multi-lang-v1_1'

export const VOICES = [
  ...PIPER_TABLE.map(piper),
  kitten('kitten-mini-en-v0_8', 'csukuangfj2/kitten-mini-en-v0_8', 'model.onnx', {
    name: 'Kitten Mini',
    minRamGb: 3,
    recommended: true,
    tags: ['english', 'expressive', 'quality'],
    description: 'Best-quality Kitten (80M parameters): the same 8 expressive voices as Nano with cleaner, more natural speech. 24 kHz.'
  }),
  kitten('kitten-micro-en-v0_8', 'csukuangfj2/kitten-micro-en-v0_8', 'model.onnx', {
    name: 'Kitten Micro',
    minRamGb: 2,
    tags: ['english', 'expressive'],
    description: 'Middle Kitten (40M parameters): 8 expressive English voices, between Nano and Mini in size and quality. 24 kHz.'
  }),
  inflect('nano', 16),
  inflect('micro', 38),
  {
    id: 'kokoro-int8-multi-lang-v1_1',
    task: 'voice',
    format: 'tts-onnx',
    files: ['model.int8.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt', 'lexicon-zh.txt', 'phone-zh.fst', 'date-zh.fst', 'number-zh.fst'].map((path) => ({ repo: KOKORO_V11, path })),
    espeak: true,
    name: 'Kokoro 82M v1.1 (Chinese)',
    family: 'Kokoro',
    backends: ['cpu'],
    license: 'apache-2.0',
    homepage: 'https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh',
    description: 'Kokoro v1.1-zh: 100 Mandarin voices (55 female, 45 male) plus 3 English ones, 24 kHz; reads mixed Chinese and English.',
    minRamGb: 4,
    variant: 'standard',
    tags: ['chinese', 'english', 'multi-speaker', 'quality'],
    voices: [
      { id: '0', name: 'Maple', gender: 'female', language: 'en-US' },
      { id: '1', name: 'Sol', gender: 'female', language: 'en-US' },
      { id: '2', name: 'Vale', gender: 'female', language: 'en-GB' },
      ...Array.from({ length: 55 }, (_, i) => ({ id: String(3 + i), name: `Female ${String(i + 1).padStart(2, '0')}`, gender: 'female', language: 'zh-CN' })),
      ...Array.from({ length: 45 }, (_, i) => ({ id: String(58 + i), name: `Male ${String(i + 1).padStart(2, '0')}`, gender: 'male', language: 'zh-CN' }))
    ],
    config: {
      engine: 'kokoro', model: 'model.int8.onnx', voices: 'voices.bin', tokens: 'tokens.txt', dataDir: 'espeak-ng-data',
      lexicon: 'lexicon-us-en.txt,lexicon-zh.txt', ruleFsts: 'phone-zh.fst,date-zh.fst,number-zh.fst', sampleRate: 24000, lengthScale: 1.0
    }
  },
  {
    id: 'vits-melo-tts-zh_en',
    task: 'voice',
    format: 'tts-onnx',
    files: ['model.int8.onnx', 'tokens.txt', 'lexicon.txt', 'phone.fst', 'date.fst', 'number.fst', 'new_heteronym.fst'].map((path) => ({ repo: 'csukuangfj/vits-melo-tts-zh_en', path })),
    name: 'MeloTTS Chinese + English',
    family: 'MeloTTS',
    backends: ['cpu'],
    license: 'mit',
    homepage: 'https://github.com/myshell-ai/MeloTTS',
    description: 'MeloTTS bilingual voice (INT8): natural Mandarin that switches to English mid-sentence, 44 kHz.',
    minRamGb: 3,
    variant: 'standard',
    tags: ['chinese', 'english'],
    voices: [{ id: '0', name: 'Melo', gender: 'female', language: 'zh-CN' }],
    config: { engine: 'vits', model: 'model.int8.onnx', tokens: 'tokens.txt', lexicon: 'lexicon.txt', ruleFsts: 'phone.fst,date.fst,number.fst,new_heteronym.fst', sampleRate: 44100, noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 }
  },
  {
    id: 'nabra-82m-ar',
    task: 'voice',
    format: 'tts-onnx',
    files: ['model.int8.onnx', 'voices.bin', 'tokens.txt'].map((path) => ({ repo: 'marwanelamami/nabra-82m-sherpa-onnx', path })),
    espeak: true,
    espeakRepo: 'csukuangfj/kokoro-int8-multi-lang-v1_0',
    name: 'Nabra 82M (Arabic)',
    family: 'Kokoro',
    backends: ['cpu'],
    license: 'apache-2.0',
    homepage: 'https://huggingface.co/marwanelamami/nabra-82m-sherpa-onnx',
    description: 'Arabic voice on the Kokoro architecture (INT8), 24 kHz.',
    minRamGb: 3,
    variant: 'standard',
    tags: ['arabic'],
    voices: [{ id: '0', name: 'Nabra', gender: 'male', language: 'ar' }],
    config: { engine: 'kokoro', model: 'model.int8.onnx', voices: 'voices.bin', tokens: 'tokens.txt', dataDir: 'espeak-ng-data', lang: 'ar', sampleRate: 24000, lengthScale: 1.0 }
  },
  coqui('bg', 'Bulgarian', 'bg-BG'),
  coqui('hr', 'Croatian', 'hr-HR'),
  coqui('et', 'Estonian', 'et-EE'),
  coqui('ga', 'Irish', 'ga-IE'),
  coqui('lt', 'Lithuanian', 'lt-LT'),
  coqui('mt', 'Maltese', 'mt-MT')
]
