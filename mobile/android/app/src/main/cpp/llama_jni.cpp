// JNI for device/text/LlamaNative.kt: llama.cpp chat on the phone.
// One Session = one loaded GGUF + its context. Chat templates come from the GGUF (Jinja, through llama.cpp's common
// chat code). The KV cache is reused across requests: a new prompt only evaluates what differs from the tokens already
// in the cache, so a chat's history isn't reprocessed every turn. Text streams back as UTF-8 byte chunks (never split
// inside a character); the Kotlin side handles stop strings and reasoning tags.
#include <android/log.h>
#include <jni.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

#include "chat.h"
#include "common.h"
#include "llama.h"
#include "stitch_backends.h"
#include <nlohmann/json.hpp>

#define TAG "StitchLlama"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, TAG, __VA_ARGS__)

using json = nlohmann::ordered_json;

namespace {

struct Session {
    llama_model * model = nullptr;
    llama_context * ctx = nullptr;
    const llama_vocab * vocab = nullptr;
    common_chat_templates_ptr tmpls;
    std::vector<llama_token> cached;  // tokens currently in the KV cache (sequence 0)
    std::atomic<bool> abort{false};
    int n_ctx = 0;
    int n_batch = 512;
    bool gpu = false;
    std::string device;

    ~Session() {
        if (ctx) llama_free(ctx);
        if (model) llama_model_free(model);
    }
};

std::string g_lib_dir;

std::string jstr(JNIEnv * env, jstring s) {
    if (!s) return "";
    const char * c = env->GetStringUTFChars(s, nullptr);
    std::string out(c ? c : "");
    if (c) env->ReleaseStringUTFChars(s, c);
    return out;
}

/** Kotlin passes text as UTF-8 byte arrays: JNI strings are "modified UTF-8", which mangles emoji. */
std::string jbytes(JNIEnv * env, jbyteArray a) {
    if (!a) return "";
    jsize n = env->GetArrayLength(a);
    std::string out((size_t) n, '\0');
    env->GetByteArrayRegion(a, 0, n, reinterpret_cast<jbyte *>(out.data()));
    return out;
}

/** JSON made pure ASCII (non-ASCII as \u escapes), so it's safe for NewStringUTF. */
jstring jjson(JNIEnv * env, const json & o) {
    return env->NewStringUTF(o.dump(-1, ' ', true, json::error_handler_t::replace).c_str());
}

void throw_java(JNIEnv * env, const std::string & msg) {
    jclass cls = env->FindClass("java/lang/RuntimeException");
    env->ThrowNew(cls, msg.c_str());
}

void log_cb(ggml_log_level level, const char * text, void *) {
    // Keep logcat quiet: warnings and errors only (CONT lines are the loader's progress dots).
    if (level < GGML_LOG_LEVEL_WARN || level == GGML_LOG_LEVEL_CONT) return;
    __android_log_print(level >= GGML_LOG_LEVEL_ERROR ? ANDROID_LOG_ERROR : ANDROID_LOG_WARN, TAG, "%s", text);
}

bool abort_cb(void * data) {
    return static_cast<Session *>(data)->abort.load();
}

/** Length of the longest prefix of `s` that doesn't end inside a UTF-8 sequence. */
size_t utf8_complete(const std::string & s) {
    size_t n = s.size();
    for (size_t back = 1; back <= 4 && back <= n; back++) {
        unsigned char c = (unsigned char) s[n - back];
        if ((c & 0xC0) == 0x80) continue;  // continuation byte: keep looking for the lead byte
        size_t need = (c & 0x80) == 0 ? 1 : (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 1;
        return back >= need ? n : n - back;
    }
    return n;
}

/** KV bytes per token for an f16 cache (rough: ignores SWA and hybrid layers, which only make it smaller). */
double kv_bytes_per_token(const llama_model * model) {
    int n_layer = llama_model_n_layer(model);
    int n_head = std::max(1, llama_model_n_head(model));
    int n_head_kv = std::max(1, llama_model_n_head_kv(model));
    int n_embd = llama_model_n_embd(model);
    double head_dim = (double) n_embd / n_head;
    return 2.0 /* K+V */ * n_layer * n_head_kv * head_dim * 2.0 /* f16 */;
}

}  // namespace

extern "C" {

JNIEXPORT jstring JNICALL Java_com_stitch_mobile_device_text_LlamaNative_init(JNIEnv * env, jclass, jstring lib_dir) {
    g_lib_dir = jstr(env, lib_dir);
    llama_log_set(log_cb, nullptr);
    std::string cpu = stitch::load_cpu_backend(g_lib_dir);
    if (cpu.empty()) {
        throw_java(env, "llama.cpp couldn't load a CPU backend for this phone");
        return nullptr;
    }
    llama_backend_init();
    return env->NewStringUTF(stitch::backends_json().c_str());
}

JNIEXPORT jstring JNICALL Java_com_stitch_mobile_device_text_LlamaNative_loadGpu(JNIEnv * env, jclass) {
    return env->NewStringUTF(stitch::load_gpu_backend(g_lib_dir).c_str());
}

JNIEXPORT jstring JNICALL Java_com_stitch_mobile_device_text_LlamaNative_systemInfo(JNIEnv * env, jclass) {
    return env->NewStringUTF(llama_print_system_info());
}

JNIEXPORT jlong JNICALL Java_com_stitch_mobile_device_text_LlamaNative_load(
        JNIEnv * env, jclass, jstring jpath, jboolean gpu, jint n_ctx, jint n_threads, jint n_batch) {
    std::string path = jstr(env, jpath);
    auto * s = new Session();
    try {
        llama_model_params mp = llama_model_default_params();
        mp.load_mode = LLAMA_LOAD_MODE_MMAP;
        ggml_backend_dev_t devices[2] = {nullptr, nullptr};
        if (gpu) {
            for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
                ggml_backend_dev_t dev = ggml_backend_dev_get(i);
                auto type = ggml_backend_dev_type(dev);
                if (type == GGML_BACKEND_DEVICE_TYPE_GPU || type == GGML_BACKEND_DEVICE_TYPE_IGPU) {
                    devices[0] = dev;
                    s->device = ggml_backend_dev_description(dev);
                    break;
                }
            }
            if (!devices[0]) throw std::runtime_error("No GPU device for llama.cpp on this phone");
            mp.n_gpu_layers = 999;
        } else {
            mp.n_gpu_layers = 0;
            s->device = "CPU";
        }
        mp.devices = devices;  // NULL-terminated; empty = CPU only
        s->model = llama_model_load_from_file(path.c_str(), mp);
        if (!s->model) throw std::runtime_error("llama.cpp couldn't load " + path.substr(path.find_last_of('/') + 1) +
                                                " (unsupported architecture, a damaged file, or not enough memory)");
        s->vocab = llama_model_get_vocab(s->model);
        s->gpu = gpu;

        int train = llama_model_n_ctx_train(s->model);
        int ctx_len = n_ctx > 0 ? n_ctx : 4096;
        if (train > 0) ctx_len = std::min(ctx_len, train);
        // Keep the KV cache within ~1.5 GB on the phone.
        double per_tok = kv_bytes_per_token(s->model);
        if (per_tok > 0) ctx_len = std::min(ctx_len, (int) std::max(1024.0, 1.5e9 / per_tok));
        ctx_len = std::max(512, ctx_len);

        llama_context_params cp = llama_context_default_params();
        cp.n_ctx = ctx_len;
        cp.n_batch = n_batch > 0 ? n_batch : 512;
        cp.n_ubatch = cp.n_batch;
        cp.n_threads = n_threads > 0 ? n_threads : 4;
        cp.n_threads_batch = cp.n_threads;
        cp.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_AUTO;
        cp.op_offload = gpu;
        cp.no_perf = true;
        s->ctx = llama_init_from_model(s->model, cp);
        if (!s->ctx) throw std::runtime_error("llama.cpp couldn't create a context of " + std::to_string(ctx_len) + " tokens (not enough memory?)");
        llama_set_abort_callback(s->ctx, abort_cb, s);
        s->n_ctx = (int) llama_n_ctx(s->ctx);
        s->n_batch = (int) cp.n_batch;
        try {
            s->tmpls = common_chat_templates_init(s->model, "");
        } catch (const std::exception & e) {
            LOGW("chat template failed to parse (%s); using chatml", e.what());
            s->tmpls = common_chat_templates_init(s->model, "chatml");
        }
        char desc[256] = {0};
        llama_model_desc(s->model, desc, sizeof(desc));
        LOGI("loaded %s on %s: n_ctx %d (trained %d), %d threads", desc, s->device.c_str(), s->n_ctx, train, cp.n_threads);
        return reinterpret_cast<jlong>(s);
    } catch (const std::exception & e) {
        delete s;
        throw_java(env, e.what());
    } catch (...) {
        delete s;
        throw_java(env, "llama.cpp failed to load the model");
    }
    return 0;
}

JNIEXPORT void JNICALL Java_com_stitch_mobile_device_text_LlamaNative_free(JNIEnv *, jclass, jlong handle) {
    delete reinterpret_cast<Session *>(handle);
}

JNIEXPORT jstring JNICALL Java_com_stitch_mobile_device_text_LlamaNative_describe(JNIEnv * env, jclass, jlong handle) {
    auto * s = reinterpret_cast<Session *>(handle);
    char desc[256] = {0};
    llama_model_desc(s->model, desc, sizeof(desc));
    json o = {{"desc", desc}, {"nCtx", s->n_ctx}, {"nCtxTrain", llama_model_n_ctx_train(s->model)}, {"device", s->device},
              {"sizeBytes", llama_model_size(s->model)}, {"params", llama_model_n_params(s->model)},
              {"template", common_chat_templates_source(s->tmpls.get()).size() > 0}};
    return jjson(env, o);
}

/**
 * Applies the model's chat template. `messages` is a JSON array of {role, content}. Returns JSON with the prompt and
 * what the template says about reasoning: its start/end tags and the generation prompt (which may already open a
 * reasoning block, e.g. Qwen3 "Thinking" models, so the reply starts mid-thought).
 */
JNIEXPORT jstring JNICALL Java_com_stitch_mobile_device_text_LlamaNative_render(
        JNIEnv * env, jclass, jlong handle, jbyteArray jmessages, jboolean enable_thinking) {
    auto * s = reinterpret_cast<Session *>(handle);
    try {
        json arr = json::parse(jbytes(env, jmessages));
        common_chat_templates_inputs in;
        for (auto & m : arr) {
            common_chat_msg msg;
            msg.role = m.value("role", "user");
            msg.content = m.value("content", "");
            in.messages.push_back(std::move(msg));
        }
        in.add_generation_prompt = true;
        in.use_jinja = true;
        in.enable_thinking = enable_thinking;
        in.add_bos = llama_vocab_get_add_bos(s->vocab);
        in.add_eos = llama_vocab_get_add_eos(s->vocab);
        common_chat_params p;
        try {
            p = common_chat_templates_apply(s->tmpls.get(), in);
        } catch (const std::exception & e) {
            LOGW("jinja template failed (%s); retrying with the legacy template engine", e.what());
            in.use_jinja = false;
            p = common_chat_templates_apply(s->tmpls.get(), in);
        }
        json o = {{"prompt", p.prompt},
                  {"generationPrompt", p.generation_prompt},
                  {"supportsThinking", p.supports_thinking},
                  {"thinkingStart", p.thinking_start_tag},
                  {"thinkingEnds", p.thinking_end_tags},
                  {"stops", p.additional_stops},
                  {"format", common_chat_format_name(p.format)}};
        return jjson(env, o);
    } catch (const std::exception & e) {
        throw_java(env, std::string("Chat template failed: ") + e.what());
    }
    return nullptr;
}

/**
 * Generates a reply to `prompt` (already templated). Pieces go to `sink.onBytes(byte[]): Boolean` (false = stop).
 * Returns JSON: {stop: "eog"|"length"|"abort"|"sink", promptTokens, reusedTokens, genTokens, promptMs, genMs}.
 */
JNIEXPORT jstring JNICALL Java_com_stitch_mobile_device_text_LlamaNative_generate(
        JNIEnv * env, jclass, jlong handle, jbyteArray jprompt, jint max_tokens, jfloat temperature, jfloat top_p, jint top_k,
        jfloat min_p, jfloat repeat_penalty, jint seed, jobject sink) {
    auto * s = reinterpret_cast<Session *>(handle);
    s->abort = false;
    jclass sink_cls = env->GetObjectClass(sink);
    jmethodID on_bytes = env->GetMethodID(sink_cls, "onBytes", "([B)Z");
    if (!on_bytes) return nullptr;  // NoSuchMethodError pending

    llama_sampler * smpl = nullptr;
    try {
        using clock = std::chrono::steady_clock;
        std::vector<llama_token> tokens = common_tokenize(s->vocab, jbytes(env, jprompt), true, true);
        if (tokens.empty()) throw std::runtime_error("Empty prompt");
        if ((int) tokens.size() >= s->n_ctx - 8) {
            throw std::runtime_error("The conversation is " + std::to_string(tokens.size()) + " tokens but this model's context on the phone is " +
                                     std::to_string(s->n_ctx) + ". Start a new chat or shorten the history.");
        }

        // Reuse the cached prefix; always evaluate at least the last prompt token (for its logits).
        size_t reuse = 0;
        while (reuse < s->cached.size() && reuse < tokens.size() && s->cached[reuse] == tokens[reuse]) reuse++;
        if (reuse == tokens.size()) reuse--;
        llama_memory_t mem = llama_get_memory(s->ctx);
        if (!llama_memory_seq_rm(mem, 0, (llama_pos) reuse, -1)) {
            llama_memory_clear(mem, false);
            reuse = 0;
        }
        s->cached.resize(reuse);

        auto t0 = clock::now();
        for (size_t i = reuse; i < tokens.size(); i += s->n_batch) {
            int n = (int) std::min<size_t>(s->n_batch, tokens.size() - i);
            int rc = llama_decode(s->ctx, llama_batch_get_one(tokens.data() + i, n));
            if (rc != 0) {
                llama_memory_clear(mem, false);
                s->cached.clear();
                if (s->abort) return jjson(env, {{"stop", "abort"}, {"promptTokens", tokens.size()}, {"reusedTokens", reuse}, {"genTokens", 0}, {"promptMs", 0}, {"genMs", 0}});
                throw std::runtime_error("llama_decode failed on the prompt (" + std::to_string(rc) + ")");
            }
            s->cached.insert(s->cached.end(), tokens.begin() + i, tokens.begin() + i + n);
        }
        auto t1 = clock::now();

        auto cp = llama_sampler_chain_default_params();
        smpl = llama_sampler_chain_init(cp);
        if (repeat_penalty > 0 && repeat_penalty != 1.0f) llama_sampler_chain_add(smpl, llama_sampler_init_penalties(0, 64, repeat_penalty, 0.0f, 0.0f));
        if (temperature <= 0) {
            llama_sampler_chain_add(smpl, llama_sampler_init_greedy());
        } else {
            if (top_k > 0) llama_sampler_chain_add(smpl, llama_sampler_init_top_k(top_k));
            if (top_p > 0 && top_p < 1) llama_sampler_chain_add(smpl, llama_sampler_init_top_p(top_p, 1));
            if (min_p > 0) llama_sampler_chain_add(smpl, llama_sampler_init_min_p(min_p, 1));
            llama_sampler_chain_add(smpl, llama_sampler_init_temp(temperature));
            llama_sampler_chain_add(smpl, llama_sampler_init_dist((uint32_t) seed));
        }

        std::string pending;
        std::string stop = "length";
        int gen = 0;
        int limit = max_tokens > 0 ? max_tokens : s->n_ctx;
        while (gen < limit) {
            if (s->abort) { stop = "abort"; break; }
            if ((int) s->cached.size() >= s->n_ctx - 1) { stop = "length"; break; }
            llama_token t = llama_sampler_sample(smpl, s->ctx, -1);
            if (llama_vocab_is_eog(s->vocab, t)) { stop = "eog"; break; }
            gen++;
            pending += common_token_to_piece(s->ctx, t, true);
            size_t ready = utf8_complete(pending);
            if (ready > 0) {
                jbyteArray bytes = env->NewByteArray((jsize) ready);
                env->SetByteArrayRegion(bytes, 0, (jsize) ready, reinterpret_cast<const jbyte *>(pending.data()));
                jboolean more = env->CallBooleanMethod(sink, on_bytes, bytes);
                env->DeleteLocalRef(bytes);
                pending.erase(0, ready);
                if (env->ExceptionCheck()) { stop = "abort"; break; }
                if (!more) { stop = "sink"; break; }
            }
            int rc = llama_decode(s->ctx, llama_batch_get_one(&t, 1));
            if (rc != 0) {
                if (s->abort) { stop = "abort"; break; }
                throw std::runtime_error("llama_decode failed while generating (" + std::to_string(rc) + ")");
            }
            s->cached.push_back(t);
        }
        if (!pending.empty() && !env->ExceptionCheck()) {
            jbyteArray bytes = env->NewByteArray((jsize) pending.size());
            env->SetByteArrayRegion(bytes, 0, (jsize) pending.size(), reinterpret_cast<const jbyte *>(pending.data()));
            env->CallBooleanMethod(sink, on_bytes, bytes);
            env->DeleteLocalRef(bytes);
        }
        auto t2 = clock::now();
        llama_sampler_free(smpl);
        smpl = nullptr;
        if (stop == "abort") {
            // An aborted decode can leave a partial batch in the cache: start clean next time.
            llama_memory_clear(mem, false);
            s->cached.clear();
        }
        using ms = std::chrono::milliseconds;
        json o = {{"stop", stop},
                  {"promptTokens", tokens.size()},
                  {"reusedTokens", reuse},
                  {"genTokens", gen},
                  {"promptMs", std::chrono::duration_cast<ms>(t1 - t0).count()},
                  {"genMs", std::chrono::duration_cast<ms>(t2 - t1).count()}};
        return jjson(env, o);
    } catch (const std::exception & e) {
        if (smpl) llama_sampler_free(smpl);
        if (!env->ExceptionCheck()) throw_java(env, e.what());
    }
    return nullptr;
}

JNIEXPORT void JNICALL Java_com_stitch_mobile_device_text_LlamaNative_abort(JNIEnv *, jclass, jlong handle) {
    if (handle) reinterpret_cast<Session *>(handle)->abort = true;
}

}  // extern "C"
