package com.stitch.mobile.device

import android.content.Context
import android.system.Os
import android.util.Log
import java.io.File

/** Process-wide native setup shared by the QNN (ONNX Runtime) and LiteRT-LM NPU paths. */
object NativeRuntime {
    private const val TAG = "StitchDevice"

    @Volatile private var initialized = false
    lateinit var nativeLibDir: String
        private set

    fun init(context: Context) {
        if (initialized) return
        synchronized(this) {
            if (initialized) return
            nativeLibDir = context.applicationInfo.nativeLibraryDir
            // The Hexagon NPU runs a "skel" library that FastRPC loads onto the DSP from one of the directories in
            // ADSP_LIBRARY_PATH (';'-separated). Ours are extracted to nativeLibraryDir (useLegacyPackaging), so that
            // comes first, followed by the usual vendor/system locations.
            val adsp = listOf(
                nativeLibDir,
                "/vendor/dsp/cdsp",
                "/vendor/lib/rfsa/adsp",
                "/system/lib/rfsa/adsp",
                "/system/vendor/lib/rfsa/adsp",
                "/dsp",
            ).joinToString(";")
            try {
                Os.setenv("ADSP_LIBRARY_PATH", adsp, true)
            } catch (e: Exception) {
                Log.w(TAG, "Could not set ADSP_LIBRARY_PATH", e)
            }
            initialized = true
        }
    }

    fun hasBundledLib(name: String): Boolean = initialized && File(nativeLibDir, name).isFile

    /** Whether a vendor/system library exists (used for OpenCL / FastRPC / Tensor NPU probing). */
    fun hasSystemLib(name: String): Boolean = listOf(
        "/vendor/lib64/$name",
        "/system/vendor/lib64/$name",
        "/system/lib64/$name",
        "/odm/lib64/$name",
    ).any { File(it).exists() }
}
