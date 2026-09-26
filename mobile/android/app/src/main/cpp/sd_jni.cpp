// JNI for device/image/SdNative.kt: stable-diffusion.cpp on the phone (SD 1.x / 2.x / SDXL / Turbo checkpoints as
// .safetensors / .ckpt / .gguf). One context = one loaded checkpoint (+ optional VAE / TAESD); LoRAs are applied per
// generation. Progress, previews and log lines go to a Kotlin sink; cancel is asynchronous (sd_cancel_generation).
#include <android/log.h>
#include <jni.h>

#include <pthread.h>

#include <cmath>
#include <mutex>
#include <string>
#include <vector>

#include "stable-diffusion.h"
#include "stitch_backends.h"

#define TAG "StitchSd"

namespace {

std::string g_lib_dir;
std::mutex g_err_mutex;
std::string g_last_error;

struct Callbacks {
    pthread_t thread{};  // JNIEnv is per thread: callbacks from any other thread are dropped
    JNIEnv * env = nullptr;
    jobject sink = nullptr;
    jmethodID on_progress = nullptr;
    jmethodID on_preview = nullptr;
};
Callbacks g_cb;  // the image engine runs one job at a time on one thread

std::string jstr(JNIEnv * env, jstring s) {
    if (!s) return "";
    const char * c = env->GetStringUTFChars(s, nullptr);
    std::string out(c ? c : "");
    if (c) env->ReleaseStringUTFChars(s, c);
    return out;
}

std::string jbytes(JNIEnv * env, jbyteArray a) {
    if (!a) return "";
    jsize n = env->GetArrayLength(a);
    std::string out((size_t) n, '\0');
    env->GetByteArrayRegion(a, 0, n, reinterpret_cast<jbyte *>(out.data()));
    return out;
}

void throw_java(JNIEnv * env, const std::string & msg) {
    env->ThrowNew(env->FindClass("java/lang/RuntimeException"), msg.c_str());
}

void log_cb(sd_log_level_t level, const char * text, void *) {
    int prio = level >= SD_LOG_ERROR ? ANDROID_LOG_ERROR : level >= SD_LOG_WARN ? ANDROID_LOG_WARN : level >= SD_LOG_INFO ? ANDROID_LOG_INFO : ANDROID_LOG_DEBUG;
    if (prio >= ANDROID_LOG_INFO) __android_log_print(prio, TAG, "%s", text);
    if (level >= SD_LOG_ERROR) {
        std::lock_guard<std::mutex> lock(g_err_mutex);
        g_last_error = text;
        while (!g_last_error.empty() && (g_last_error.back() == '\n' || g_last_error.back() == ' ')) g_last_error.pop_back();
    }
}

std::string take_error(const std::string & fallback) {
    std::lock_guard<std::mutex> lock(g_err_mutex);
    std::string e = g_last_error.empty() ? fallback : g_last_error;
    g_last_error.clear();
    return e;
}

void progress_cb(int step, int steps, float, void *) {
    if (!g_cb.env || !g_cb.sink || !pthread_equal(pthread_self(), g_cb.thread)) return;
    g_cb.env->CallVoidMethod(g_cb.sink, g_cb.on_progress, step, steps);
    if (g_cb.env->ExceptionCheck()) g_cb.env->ExceptionClear();
}

void preview_cb(int step, int frame_count, sd_image_t * frames, bool, void *) {
    if (!g_cb.env || !g_cb.sink || !pthread_equal(pthread_self(), g_cb.thread) || frame_count < 1 || !frames || !frames[0].data) return;
    const sd_image_t & img = frames[0];
    jsize n = (jsize) (img.width * img.height * img.channel);
    JNIEnv * env = g_cb.env;
    jbyteArray bytes = env->NewByteArray(n);
    env->SetByteArrayRegion(bytes, 0, n, reinterpret_cast<const jbyte *>(img.data));
    env->CallVoidMethod(g_cb.sink, g_cb.on_preview, step, bytes, (jint) img.width, (jint) img.height, (jint) img.channel);
    env->DeleteLocalRef(bytes);
    if (env->ExceptionCheck()) env->ExceptionClear();
}

const char * opt(const std::string & s) { return s.empty() ? nullptr : s.c_str(); }

}  // namespace

extern "C" {

JNIEXPORT jstring JNICALL Java_com_stitch_mobile_device_image_SdNative_init(JNIEnv * env, jclass, jstring lib_dir) {
    g_lib_dir = jstr(env, lib_dir);
    sd_set_log_callback(log_cb, nullptr);
    std::string cpu = stitch::load_cpu_backend(g_lib_dir);
    if (cpu.empty()) {
        throw_java(env, "stable-diffusion.cpp couldn't load a CPU backend for this phone");
        return nullptr;
    }
    return env->NewStringUTF(stitch::backends_json().c_str());
}

JNIEXPORT jstring JNICALL Java_com_stitch_mobile_device_image_SdNative_loadGpu(JNIEnv * env, jclass) {
    return env->NewStringUTF(stitch::load_gpu_backend(g_lib_dir).c_str());
}

/**
 * Loads a checkpoint. `backend` is a stable-diffusion.cpp backend assignment ("cpu", "vulkan0", or per-module rules).
 * Paths may be empty. Returns the context handle.
 */
JNIEXPORT jlong JNICALL Java_com_stitch_mobile_device_image_SdNative_load(
        JNIEnv * env, jclass, jstring jmodel, jstring jvae, jstring jtaesd, jstring jbackend, jint n_threads,
        jboolean flash_attn, jboolean vae_conv_direct) {
    std::string model = jstr(env, jmodel), vae = jstr(env, jvae), taesd = jstr(env, jtaesd), backend = jstr(env, jbackend);
    sd_ctx_params_t p;
    sd_ctx_params_init(&p);
    p.model_path = model.c_str();
    p.vae_path = opt(vae);
    p.taesd_path = opt(taesd);
    p.n_threads = n_threads > 0 ? n_threads : 4;
    p.enable_mmap = true;
    p.diffusion_flash_attn = flash_attn;
    p.vae_conv_direct = vae_conv_direct;
    p.rng_type = CPU_RNG;  // same image for a seed on CPU and GPU
    p.backend = opt(backend);
    p.conditioning_cache_size = 2;
    take_error("");
    sd_ctx_t * ctx = nullptr;
    try {
        ctx = new_sd_ctx(&p);
    } catch (const std::exception & e) {
        throw_java(env, e.what());
        return 0;
    }
    if (!ctx) {
        throw_java(env, take_error("stable-diffusion.cpp couldn't load this checkpoint (unsupported model or not enough memory)"));
        return 0;
    }
    __android_log_print(ANDROID_LOG_INFO, TAG, "loaded %s (%s) on %s", model.c_str(), sd_get_model_version_name(ctx), backend.empty() ? "default" : backend.c_str());
    return reinterpret_cast<jlong>(ctx);
}

JNIEXPORT jstring JNICALL Java_com_stitch_mobile_device_image_SdNative_modelVersion(JNIEnv * env, jclass, jlong handle) {
    return env->NewStringUTF(sd_get_model_version_name(reinterpret_cast<sd_ctx_t *>(handle)));
}

JNIEXPORT void JNICALL Java_com_stitch_mobile_device_image_SdNative_free(JNIEnv *, jclass, jlong handle) {
    if (handle) free_sd_ctx(reinterpret_cast<sd_ctx_t *>(handle));
}

JNIEXPORT void JNICALL Java_com_stitch_mobile_device_image_SdNative_cancel(JNIEnv *, jclass, jlong handle) {
    if (handle) sd_cancel_generation(reinterpret_cast<sd_ctx_t *>(handle), SD_CANCEL_ALL);
}

/**
 * Generates one image; returns its pixels as RGB bytes (width × height × 3). `sampler` / `scheduler` are
 * stable-diffusion.cpp names ("euler_a", "lcm", "dpm++2m" …; "karras", "discrete" …) or "" for the model's default.
 * `loraPaths` / `loraScales` are applied for this image only. The sink receives onProgress(step, steps) and, when
 * previews are on, onPreview(step, rgb, width, height, channels).
 */
JNIEXPORT jbyteArray JNICALL Java_com_stitch_mobile_device_image_SdNative_generate(
        JNIEnv * env, jclass, jlong handle, jbyteArray jprompt, jbyteArray jnegative, jint width, jint height, jint steps,
        jfloat cfg, jlong seed, jstring jsampler, jstring jscheduler, jint clip_skip, jobjectArray lora_paths,
        jfloatArray lora_scales, jboolean previews, jobject sink) {
    auto * ctx = reinterpret_cast<sd_ctx_t *>(handle);
    std::string prompt = jbytes(env, jprompt), negative = jbytes(env, jnegative);
    std::string sampler = jstr(env, jsampler), scheduler = jstr(env, jscheduler);

    std::vector<std::string> lora_path_strs;
    std::vector<sd_lora_t> loras;
    if (lora_paths) {
        jsize n = env->GetArrayLength(lora_paths);
        std::vector<float> scales((size_t) n, 1.0f);
        if (lora_scales && env->GetArrayLength(lora_scales) >= n) env->GetFloatArrayRegion(lora_scales, 0, n, scales.data());
        lora_path_strs.reserve((size_t) n);
        for (jsize i = 0; i < n; i++) {
            auto js = (jstring) env->GetObjectArrayElement(lora_paths, i);
            lora_path_strs.push_back(jstr(env, js));
            env->DeleteLocalRef(js);
        }
        for (jsize i = 0; i < n; i++) loras.push_back(sd_lora_t{false, scales[(size_t) i], lora_path_strs[(size_t) i].c_str()});
    }

    sd_img_gen_params_t g;
    sd_img_gen_params_init(&g);
    g.prompt = prompt.c_str();
    g.negative_prompt = negative.c_str();
    g.width = width;
    g.height = height;
    g.seed = seed;
    g.batch_count = 1;
    g.clip_skip = clip_skip;
    g.loras = loras.empty() ? nullptr : loras.data();
    g.lora_count = (uint32_t) loras.size();
    g.sample_params.sample_steps = steps;
    g.sample_params.guidance.txt_cfg = cfg;
    if (!sampler.empty()) {
        auto m = str_to_sample_method(sampler.c_str());
        if (m != SAMPLE_METHOD_COUNT) g.sample_params.sample_method = m;
    }
    if (!scheduler.empty()) {
        auto s = str_to_scheduler(scheduler.c_str());
        if (s != SCHEDULER_COUNT) g.sample_params.scheduler = s;
    }

    jclass cls = env->GetObjectClass(sink);
    g_cb.thread = pthread_self();
    g_cb.env = env;
    g_cb.sink = sink;
    g_cb.on_progress = env->GetMethodID(cls, "onProgress", "(II)V");
    g_cb.on_preview = env->GetMethodID(cls, "onPreview", "(I[BIII)V");
    sd_set_progress_callback(progress_cb, nullptr);
    sd_set_preview_callback(previews ? preview_cb : nullptr, previews ? PREVIEW_PROJ : PREVIEW_NONE, 1, true, false, nullptr);

    sd_image_t * images = nullptr;
    int count = 0;
    bool ok = false;
    take_error("");
    try {
        sd_cancel_generation(ctx, SD_CANCEL_RESET);
        ok = generate_image(ctx, &g, &images, &count);
    } catch (const std::exception & e) {
        std::lock_guard<std::mutex> lock(g_err_mutex);
        g_last_error = e.what();
        ok = false;
    }
    sd_set_progress_callback(nullptr, nullptr);
    sd_set_preview_callback(nullptr, PREVIEW_NONE, 1, true, false, nullptr);
    g_cb = Callbacks{};

    if (!ok || count < 1 || !images || !images[0].data) {
        if (images) free_sd_images(images, count);
        throw_java(env, take_error("Image generation failed"));
        return nullptr;
    }
    // [width u32 LE][height u32 LE][RGB bytes]
    const sd_image_t & img = images[0];
    uint32_t w = img.width, h = img.height;
    std::vector<uint8_t> out(8 + (size_t) w * h * 3);
    for (int b = 0; b < 4; b++) {
        out[b] = (uint8_t) (w >> (8 * b));
        out[4 + b] = (uint8_t) (h >> (8 * b));
    }
    for (size_t i = 0, n = (size_t) w * h; i < n; i++) {
        const uint8_t * px = img.data + i * img.channel;
        uint8_t * o = out.data() + 8 + i * 3;
        o[0] = px[0];
        o[1] = img.channel > 1 ? px[1] : px[0];
        o[2] = img.channel > 2 ? px[2] : px[0];
    }
    free_sd_images(images, count);
    jbyteArray arr = env->NewByteArray((jsize) out.size());
    env->SetByteArrayRegion(arr, 0, (jsize) out.size(), reinterpret_cast<const jbyte *>(out.data()));
    return arr;
}

}  // extern "C"
