// ggml backend loading shared by libstitch_llama.so and libstitch_sd.so (both use the same libggml.so registry).
#pragma once

#include <string>

namespace stitch {

// Registers the best CPU backend variant found in `lib_dir` (libggml-cpu-android_*.so, scored by the variants
// themselves for this CPU). Idempotent. Returns the loaded variant's file name, or "" on failure.
std::string load_cpu_backend(const std::string & lib_dir);

// Registers ggml's Vulkan backend (libggml-vulkan.so) if it is bundled. Idempotent. Returns the GPU device name
// (e.g. "Mali-G715"), or "" when there is no usable Vulkan device.
std::string load_gpu_backend(const std::string & lib_dir);

// JSON with the registered devices and the CPU features ggml sees.
std::string backends_json();

}  // namespace stitch
