package com.stitch.mobile.device.image

import com.stitch.mobile.device.NativeRuntime
import org.json.JSONObject

/** JNI bindings of libstitch_sd.so (src/main/cpp/sd_jni.cpp). */
object SdNative {
    interface Sink {
        fun onProgress(step: Int, steps: Int)
        /** Denoised-latent preview (a linear projection, latent-sized). */
        fun onPreview(step: Int, pixels: ByteArray, width: Int, height: Int, channels: Int)
    }

    @Volatile private var backends: JSONObject? = null

    /** Loads the library and registers the best ggml CPU backend for this phone (once). */
    @Synchronized
    fun ensure(): JSONObject {
        backends?.let { return it }
        System.loadLibrary("stitch_sd")
        return JSONObject(init(NativeRuntime.nativeLibDir)).also { backends = it }
    }

    @JvmStatic external fun init(libDir: String): String
    /** Registers the Vulkan backend; returns the GPU's name, or "" when there is none. */
    @JvmStatic external fun loadGpu(): String
    @JvmStatic external fun load(model: String, vae: String?, taesd: String?, backend: String, nThreads: Int, flashAttn: Boolean, vaeConvDirect: Boolean): Long
    @JvmStatic external fun modelVersion(handle: Long): String
    @JvmStatic external fun free(handle: Long)
    @JvmStatic external fun cancel(handle: Long)
    /** Returns [width u32 LE][height u32 LE][RGB bytes]. */
    @JvmStatic external fun generate(
        handle: Long,
        prompt: ByteArray,
        negative: ByteArray,
        width: Int,
        height: Int,
        steps: Int,
        cfg: Float,
        seed: Long,
        sampler: String,
        scheduler: String,
        clipSkip: Int,
        loraPaths: Array<String>?,
        loraScales: FloatArray?,
        previews: Boolean,
        sink: Sink,
    ): ByteArray
}
