// Replaces stable-diffusion.cpp's src/tokenizers/vocab/vocab.cpp in the phone build.
// Upstream compiles every tokenizer vocabulary into the library (CLIP, T5, UMT5, Qwen2, Mistral, Gemma: ~30 MB of
// data). The phone runs SD 1.x / 2.x / SDXL-class models, which only need CLIP's BPE merges, so only those are
// bundled; models that need another text encoder's tokenizer (SD3, Flux, Wan, Qwen-Image …) fail with a clear error.
#include "vocab.h"

#include <stdexcept>

#include "clip_merges.hpp"

std::string load_clip_merges() {
    return std::string(reinterpret_cast<const char*>(clip_merges_utf8_c_str), sizeof(clip_merges_utf8_c_str));
}

[[noreturn]] static void unsupported(const char* which) {
    throw std::runtime_error(std::string("This model needs the ") + which +
                             " tokenizer, which Stitch's phone build doesn't include (it runs SD 1.x, SD 2.x and SDXL models).");
}

std::string load_qwen2_merges() { unsupported("Qwen2"); }
std::string load_mistral_merges() { unsupported("Mistral"); }
std::string load_mistral_vocab_json() { unsupported("Mistral"); }
std::string load_t5_tokenizer_json() { unsupported("T5"); }
std::string load_umt5_tokenizer_json() { unsupported("UMT5"); }
std::string load_gemma_merges() { unsupported("Gemma"); }
std::string load_gemma_vocab_json() { unsupported("Gemma"); }
