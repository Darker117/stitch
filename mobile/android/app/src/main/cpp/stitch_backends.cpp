#include "stitch_backends.h"

#include <android/log.h>
#include <dirent.h>
#include <dlfcn.h>
#include <unistd.h>

#include <mutex>
#include <sstream>

#include "ggml-backend.h"

#define TAG "StitchGgml"

namespace stitch {

static std::mutex g_mutex;
static std::string g_cpu_variant;

static std::string json_escape(const std::string & s) {
    std::string out;
    for (char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            default:
                if ((unsigned char) c < 0x20) out += ' ';
                else out += c;
        }
    }
    return out;
}

std::string load_cpu_backend(const std::string & lib_dir) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (ggml_backend_reg_by_name("CPU") != nullptr) return g_cpu_variant.empty() ? "cpu" : g_cpu_variant;

    // Same selection ggml_backend_load_best() makes, but only for the CPU: each variant scores itself for this CPU
    // (0 = unsupported instructions) and the highest wins. The GPU backend loads only when a model asks for it.
    std::string best_path, best_name;
    int best_score = 0;
    if (DIR * d = opendir(lib_dir.c_str())) {
        while (dirent * e = readdir(d)) {
            std::string name = e->d_name;
            if (name.rfind("libggml-cpu", 0) != 0 || name.size() < 3 || name.compare(name.size() - 3, 3, ".so") != 0) continue;
            std::string path = lib_dir + "/" + name;
            void * h = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
            if (!h) {
                __android_log_print(ANDROID_LOG_WARN, TAG, "can't open %s: %s", name.c_str(), dlerror());
                continue;
            }
            auto score_fn = (int (*)()) dlsym(h, "ggml_backend_score");
            int score = score_fn ? score_fn() : 1;
            dlclose(h);
            if (score > best_score) {
                best_score = score;
                best_path = path;
                best_name = name;
            }
        }
        closedir(d);
    }
    if (best_path.empty()) {
        __android_log_print(ANDROID_LOG_ERROR, TAG, "no usable ggml CPU backend in %s", lib_dir.c_str());
        return "";
    }
    if (ggml_backend_load(best_path.c_str()) == nullptr) {
        __android_log_print(ANDROID_LOG_ERROR, TAG, "loading %s failed", best_path.c_str());
        return "";
    }
    g_cpu_variant = best_name;
    __android_log_print(ANDROID_LOG_INFO, TAG, "CPU backend: %s (score %d)", best_name.c_str(), best_score);
    return best_name;
}

static ggml_backend_dev_t gpu_device() {
    for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
        ggml_backend_dev_t dev = ggml_backend_dev_get(i);
        auto type = ggml_backend_dev_type(dev);
        if (type == GGML_BACKEND_DEVICE_TYPE_GPU || type == GGML_BACKEND_DEVICE_TYPE_IGPU) return dev;
    }
    return nullptr;
}

std::string load_gpu_backend(const std::string & lib_dir) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (ggml_backend_reg_by_name("Vulkan") == nullptr) {
        std::string path = lib_dir + "/libggml-vulkan.so";
        if (access(path.c_str(), R_OK) != 0) return "";
        if (ggml_backend_load(path.c_str()) == nullptr) {
            __android_log_print(ANDROID_LOG_WARN, TAG, "Vulkan backend didn't load");
            return "";
        }
    }
    ggml_backend_dev_t dev = gpu_device();
    return dev ? ggml_backend_dev_description(dev) : "";
}

std::string backends_json() {
    std::lock_guard<std::mutex> lock(g_mutex);
    std::ostringstream o;
    o << "{\"cpuVariant\":\"" << json_escape(g_cpu_variant) << "\",\"cpuFeatures\":[";
    if (ggml_backend_reg_t cpu = ggml_backend_reg_by_name("CPU")) {
        auto get_features = (ggml_backend_get_features_t) ggml_backend_reg_get_proc_address(cpu, "ggml_backend_get_features");
        bool first = true;
        for (auto * f = get_features ? get_features(cpu) : nullptr; f && f->name; f++) {
            if (std::string(f->value) == "0") continue;
            o << (first ? "" : ",") << "\"" << json_escape(f->name) << "\"";
            first = false;
        }
    }
    o << "],\"devices\":[";
    for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
        ggml_backend_dev_t dev = ggml_backend_dev_get(i);
        size_t free = 0, total = 0;
        ggml_backend_dev_memory(dev, &free, &total);
        const char * type = "cpu";
        switch (ggml_backend_dev_type(dev)) {
            case GGML_BACKEND_DEVICE_TYPE_GPU: type = "gpu"; break;
            case GGML_BACKEND_DEVICE_TYPE_IGPU: type = "igpu"; break;
            case GGML_BACKEND_DEVICE_TYPE_ACCEL: type = "accel"; break;
            default: break;
        }
        o << (i ? "," : "") << "{\"name\":\"" << json_escape(ggml_backend_dev_name(dev)) << "\",\"description\":\""
          << json_escape(ggml_backend_dev_description(dev)) << "\",\"type\":\"" << type << "\",\"memory\":" << total << "}";
    }
    o << "]}";
    return o.str();
}

}  // namespace stitch
