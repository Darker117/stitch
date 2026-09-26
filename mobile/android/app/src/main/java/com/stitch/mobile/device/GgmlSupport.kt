package com.stitch.mobile.device

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

/**
 * Which backends the ggml runtimes (llama.cpp for 'gguf', stable-diffusion.cpp for 'sd-cpp') can use on this phone.
 * Measure-then-offer: the GPU (ggml's Vulkan backend, bundled as libggml-vulkan.so) is only offered on GPU families
 * listed in [MEASURED_FASTER] after benchmarking it against the CPU there. On a Pixel 8a (Mali-G715) it was much slower,
 * so Mali is reported unavailable with the numbers; Adreno and Xclipse haven't been measured yet (add them to
 * [MEASURED_FASTER] once a phone shows the GPU winning — nothing else changes).
 */
object GgmlSupport {
    /** Pixel 8a numbers behind the Mali verdict (llama.cpp v0.5.0, ggml Vulkan vs CPU). */
    private const val MALI_NOTE = "ggml's Vulkan backend is slower than the CPU on Mali GPUs (Pixel 8a, Mali-G715: Qwen3 1.7B " +
        "generates 14 tok/s on the GPU vs 21 on the CPU and reads prompts 8× slower; SD 1.5 steps take twice as long)"

    /** GPU families where ggml's Vulkan backend measured faster than the CPU (none yet). */
    private val MEASURED_FASTER: List<Regex> = emptyList()

    private fun abi64() = Build.SUPPORTED_ABIS.firstOrNull() == "arm64-v8a"

    fun cpu(runtime: String, lib: String, threads: Int): BackendSupport = when {
        !abi64() -> BackendSupport("cpu", false, "Needs a 64-bit ARM phone")
        !NativeRuntime.hasBundledLib(lib) -> BackendSupport("cpu", false, "$runtime isn't included in this build")
        else -> BackendSupport("cpu", true, "$runtime · $threads threads · ${CpuInfo.ggmlFeatureNote()}")
    }

    fun gpu(context: Context, gpuName: String?, lib: String): BackendSupport {
        val name = gpuName ?: "this GPU"
        return when {
            !abi64() || !NativeRuntime.hasBundledLib(lib) -> BackendSupport("gpu", false, "This build has no GPU backend")
            !NativeRuntime.hasBundledLib("libggml-vulkan.so") -> BackendSupport("gpu", false, "This build has no Vulkan GPU backend")
            !vulkan12(context) -> BackendSupport("gpu", false, "Needs Vulkan 1.2, which $name doesn't report")
            gpuName == null -> BackendSupport("gpu", false, "GPU not identified")
            gpuName.contains("Mali", true) || gpuName.contains("Immortalis", true) -> BackendSupport("gpu", false, MALI_NOTE)
            MEASURED_FASTER.any { it.containsMatchIn(gpuName) } -> BackendSupport("gpu", true, "Vulkan · $gpuName")
            else -> BackendSupport("gpu", false, "ggml's Vulkan backend hasn't been measured on $name yet, so the CPU is used")
        }
    }

    /** Vulkan 1.2 hardware support (ggml-vulkan's minimum). */
    private fun vulkan12(context: Context): Boolean =
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_VULKAN_HARDWARE_VERSION, 0x402000)
}
