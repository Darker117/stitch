package com.stitch.mobile.device

import java.io.File

/** CPU layout and ARM features, for thread counts and the llama.cpp / stable-diffusion.cpp backend notes. */
object CpuInfo {
    /** Cores that aren't in the slowest (efficiency) cluster, judged by each core's maximum frequency. */
    val performanceCores: Int by lazy {
        val freqs = (0 until Runtime.getRuntime().availableProcessors()).mapNotNull { i ->
            try {
                File("/sys/devices/system/cpu/cpu$i/cpufreq/cpuinfo_max_freq").readText().trim().toLongOrNull()
            } catch (_: Exception) {
                null
            }
        }
        val n = Runtime.getRuntime().availableProcessors()
        if (freqs.size < n || freqs.distinct().size <= 1) n else freqs.count { it > freqs.min() }
    }

    /**
     * Threads for llama.cpp / stable-diffusion.cpp. Token generation is memory-bound: past four or five fast cores more
     * threads only add contention (Pixel 8a, 1 + 4 + 4 cores: 4 threads beat 5 and 6). Big layouts keep one core spare.
     */
    fun ggmlThreads(): Int {
        val p = performanceCores
        return (if (p >= 5) p - 1 else p).coerceIn(2, 6)
    }

    /** stable-diffusion.cpp is compute-bound: every fast core helps (Pixel 8a: 5 threads beat 4 and 8). */
    fun sdThreads(): Int = performanceCores.coerceIn(2, 6)

    /** Lower-case feature flags from /proc/cpuinfo ("asimddp", "i8mm", "sve2" …). */
    val features: Set<String> by lazy {
        try {
            File("/proc/cpuinfo").readLines().firstOrNull { it.startsWith("Features", true) }
                ?.substringAfter(':')?.trim()?.split(Regex("\\s+"))?.map { it.lowercase() }?.toSet() ?: emptySet()
        } catch (_: Exception) {
            emptySet()
        }
    }

    /** Short description of the ARM features ggml's CPU kernels use, e.g. "i8mm · dotprod · fp16". */
    fun ggmlFeatureNote(): String {
        val f = features
        val parts = buildList {
            if ("i8mm" in f) add("i8mm")
            if ("asimddp" in f) add("dotprod")
            if ("asimdhp" in f) add("fp16")
            if ("sve2" in f) add("SVE2")
        }
        return if (parts.isEmpty()) "NEON" else parts.joinToString(" · ")
    }
}
