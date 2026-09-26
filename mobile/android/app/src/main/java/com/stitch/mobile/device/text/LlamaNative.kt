package com.stitch.mobile.device.text

import com.stitch.mobile.device.NativeRuntime
import org.json.JSONObject

/** JNI bindings of libstitch_llama.so (src/main/cpp/llama_jni.cpp). Text crosses as UTF-8 byte arrays. */
object LlamaNative {
    fun interface ByteSink {
        /** A chunk of UTF-8 (never split inside a character). Return false to stop generating. */
        fun onBytes(bytes: ByteArray): Boolean
    }

    @Volatile private var backends: JSONObject? = null

    /** Loads the library and registers the best ggml CPU backend for this phone (once). */
    @Synchronized
    fun ensure(): JSONObject {
        backends?.let { return it }
        System.loadLibrary("stitch_llama")
        return JSONObject(init(NativeRuntime.nativeLibDir)).also { backends = it }
    }

    @JvmStatic external fun init(libDir: String): String
    /** Registers the Vulkan backend; returns the GPU's name, or "" when there is none. */
    @JvmStatic external fun loadGpu(): String
    @JvmStatic external fun systemInfo(): String
    @JvmStatic external fun load(path: String, gpu: Boolean, nCtx: Int, nThreads: Int, nBatch: Int): Long
    @JvmStatic external fun free(handle: Long)
    @JvmStatic external fun describe(handle: Long): String
    @JvmStatic external fun render(handle: Long, messages: ByteArray, enableThinking: Boolean): String
    @JvmStatic external fun generate(
        handle: Long,
        prompt: ByteArray,
        maxTokens: Int,
        temperature: Float,
        topP: Float,
        topK: Int,
        minP: Float,
        repeatPenalty: Float,
        seed: Int,
        sink: ByteSink,
    ): String
    @JvmStatic external fun abort(handle: Long)
}
