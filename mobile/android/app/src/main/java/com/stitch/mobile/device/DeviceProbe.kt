package com.stitch.mobile.device

import ai.onnxruntime.OrtProvider
import android.app.ActivityManager
import android.content.Context
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.GLES20
import android.os.Build
import android.os.StatFs
import android.util.Log
import com.stitch.mobile.device.image.OrtSupport
import java.io.File

data class BackendSupport(val id: String, val available: Boolean, val note: String?)

data class DeviceInfo(
    val manufacturer: String,
    val model: String,
    val soc: SocInfo,
    val androidVersion: String,
    val sdk: Int,
    val abi: String,
    val ramBytes: Long,
    val freeStorageBytes: Long,
    val gpu: String?,
    val backends: Map<String, List<BackendSupport>>,
    /** Per model format (litertlm, gguf, sd-onnx, sd-cpp, tts-onnx, tts-system): the backends that runtime can use here. */
    val runtimes: Map<String, List<BackendSupport>>,
)

/** Chip, memory and per-task backend availability. */
class DeviceProbe(private val context: Context) {
    @Volatile private var gpuRenderer: String? = null
    @Volatile private var gpuProbed = false
    @Volatile private var socCache: SocInfo? = null

    fun soc(): SocInfo {
        socCache?.let { return it }
        val socModel = if (Build.VERSION.SDK_INT >= 31) Build.SOC_MODEL else null
        val socMaker = if (Build.VERSION.SDK_INT >= 31) Build.SOC_MANUFACTURER else null
        val info = SocTable.resolve(socModel, socMaker, Build.BOARD, Build.HARDWARE, cpuinfoHardware())
        socCache = info
        return info
    }

    fun info(): DeviceInfo {
        val soc = soc()
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mi = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        val free = try { StatFs(context.filesDir.absolutePath).availableBytes } catch (_: Exception) { 0L }
        val gpu = SocTable.friendlyGpu(gpu())
        val backends = backends(soc, gpu)
        return DeviceInfo(
            manufacturer = Build.MANUFACTURER ?: "",
            model = Build.MODEL ?: "",
            soc = soc,
            androidVersion = Build.VERSION.RELEASE ?: "",
            sdk = Build.VERSION.SDK_INT,
            abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "",
            ramBytes = mi.totalMem,
            freeStorageBytes = free,
            gpu = gpu,
            backends = backends,
            runtimes = runtimes(backends, gpu),
        )
    }

    /**
     * Backends per runtime. LiteRT-LM, the ONNX pipeline and the voices match their task's list; llama.cpp ('gguf') and
     * stable-diffusion.cpp ('sd-cpp') have their own: GPU (ggml's Vulkan, available only where it's offered) and CPU.
     * They have no NPU path at all, so it isn't listed (custom models take their backends from this list).
     */
    private fun runtimes(backends: Map<String, List<BackendSupport>>, gpu: String?): Map<String, List<BackendSupport>> {
        fun ggml(runtime: String, lib: String, threads: Int) = listOf(
            GgmlSupport.gpu(context, gpu, lib),
            GgmlSupport.cpu(runtime, lib, threads),
        )
        return mapOf(
            "litertlm" to backends.getValue("text"),
            "gguf" to ggml("llama.cpp", "libstitch_llama.so", CpuInfo.ggmlThreads()),
            "sd-onnx" to backends.getValue("image"),
            "sd-cpp" to ggml("stable-diffusion.cpp", "libstitch_sd.so", CpuInfo.sdThreads()),
            "tts-onnx" to backends.getValue("voice"),
            "tts-system" to listOf(BackendSupport("cpu", true, "Android text-to-speech")),
        )
    }

    private fun backends(soc: SocInfo, gpu: String?): Map<String, List<BackendSupport>> {
        val arm64 = Build.SUPPORTED_ABIS.firstOrNull() == "arm64-v8a"
        val adreno = gpu?.contains("Adreno", true) == true
        val openCl = NativeRuntime.hasSystemLib("libOpenCL.so") || NativeRuntime.hasSystemLib("libOpenCL-pixel.so")
        val htp = soc.htpVersion
        val ortProviders = OrtSupport.availableProviders()

        // --- text (LiteRT-LM) -------------------------------------------------------------------------------------
        val textCpu = BackendSupport("cpu", arm64, if (arm64) "LiteRT-LM on ${Runtime.getRuntime().availableProcessors()} cores" else "Needs a 64-bit ARM phone")
        val textGpu = when {
            !arm64 -> BackendSupport("gpu", false, "Needs a 64-bit ARM phone")
            openCl -> BackendSupport("gpu", true, gpu ?: "OpenCL GPU")
            else -> BackendSupport("gpu", false, "No OpenCL driver for ${gpu ?: "this GPU"}")
        }
        val textNpu = when {
            soc.qualcomm && htp != null && htp >= 69 && Build.VERSION.SDK_INT >= 31 && NativeRuntime.hasBundledLib("libLiteRtDispatch_Qualcomm.so") ->
                BackendSupport("npu", true, "Hexagon ${soc.htpArch} · needs a model built for ${soc.model}")
            soc.qualcomm && Build.VERSION.SDK_INT < 31 -> BackendSupport("npu", false, "LiteRT NPU needs Android 12 or newer")
            soc.qualcomm && htp != null && htp < 69 -> BackendSupport("npu", false, "Hexagon ${soc.htpArch} is older than LiteRT-LM's NPU runtime supports (v69+)")
            soc.qualcomm -> BackendSupport("npu", false, "Unrecognised Snapdragon (${soc.model ?: "unknown SoC"}); NPU not verified")
            soc.googleTensor -> tensorNpu(soc)
            else -> BackendSupport("npu", false, "No supported NPU (QNN needs a Snapdragon chip)")
        }

        // --- image (ONNX Runtime) ---------------------------------------------------------------------------------
        val imageCpu = BackendSupport("cpu", arm64, "ONNX Runtime CPU" + if (OrtProvider.XNNPACK in ortProviders) " + XNNPACK" else "")
        val imageGpu = when {
            soc.qualcomm && adreno && openCl && NativeRuntime.hasBundledLib("libQnnGpu.so") -> BackendSupport("gpu", true, "QNN GPU · ${gpu}")
            OrtProvider.NNAPI in ortProviders && !soc.qualcomm -> BackendSupport("gpu", true, "NNAPI · ${gpu ?: "GPU"}")
            else -> BackendSupport("gpu", false, "ONNX Runtime's GPU path is Qualcomm QNN (Adreno); ${gpu ?: "this GPU"} isn't supported")
        }
        val imageNpu = when {
            !soc.qualcomm -> BackendSupport("npu", false, "QNN needs a Snapdragon chip")
            htp == null -> BackendSupport("npu", false, "Unrecognised Snapdragon (${soc.model ?: "unknown SoC"}); Hexagon version unknown")
            htp < 69 -> BackendSupport("npu", false, "Hexagon ${soc.htpArch} has no fp16; needs quantized models")
            !NativeRuntime.hasBundledLib("libQnnHtp.so") -> BackendSupport("npu", false, "QNN HTP runtime missing from this build")
            else -> BackendSupport("npu", true, "QNN HTP · Hexagon ${soc.htpArch} (first run compiles, then cached)")
        }

        // --- voice (sherpa-onnx / system) -------------------------------------------------------------------------
        val voiceCpu = BackendSupport("cpu", true, "sherpa-onnx CPU · system voices")
        val voiceGpu = BackendSupport("gpu", false, "On-device voices run on the CPU")
        val voiceNpu = BackendSupport("npu", false, "On-device voices run on the CPU")

        return mapOf(
            "text" to listOf(textNpu, textGpu, textCpu),
            "image" to listOf(imageNpu, imageGpu, imageCpu),
            "voice" to listOf(voiceNpu, voiceGpu, voiceCpu),
        )
    }

    private fun tensorNpu(soc: SocInfo): BackendSupport {
        val gen = Regex("G(\\d+)", RegexOption.IGNORE_CASE).find(soc.model ?: "")?.groupValues?.get(1)?.toIntOrNull()
        val hasRuntime = NativeRuntime.hasSystemLib("libedgetpu_litert.so") && NativeRuntime.hasBundledLib("libLiteRtDispatch_GoogleTensor.so")
        return when {
            !hasRuntime -> BackendSupport("npu", false, "Google Tensor TPU runtime not found on this phone")
            gen != null && gen >= 4 -> BackendSupport("npu", true, "Google Tensor TPU · needs a model built for ${soc.model}")
            else -> BackendSupport("npu", false, "No LiteRT NPU models are built for ${soc.model ?: "this Tensor chip"} (G4 and newer)")
        }
    }

    /** GL_RENDERER from a throwaway offscreen EGL context (cached). */
    fun gpu(): String? {
        if (gpuProbed) return gpuRenderer
        synchronized(this) {
            if (gpuProbed) return gpuRenderer
            gpuRenderer = try { probeGlRenderer() } catch (t: Throwable) { Log.w(TAG, "GL probe failed", t); null }
            gpuProbed = true
            return gpuRenderer
        }
    }

    private fun probeGlRenderer(): String? {
        val display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        if (display == EGL14.EGL_NO_DISPLAY) return null
        val version = IntArray(2)
        if (!EGL14.eglInitialize(display, version, 0, version, 1)) return null
        try {
            val attribs = intArrayOf(
                EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                EGL14.EGL_SURFACE_TYPE, EGL14.EGL_PBUFFER_BIT,
                EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8,
                EGL14.EGL_NONE,
            )
            val configs = arrayOfNulls<EGLConfig>(1)
            val count = IntArray(1)
            if (!EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, count, 0) || count[0] == 0) return null
            val ctx = EGL14.eglCreateContext(display, configs[0], EGL14.EGL_NO_CONTEXT, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
            if (ctx == EGL14.EGL_NO_CONTEXT) return null
            val surface = EGL14.eglCreatePbufferSurface(display, configs[0], intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0)
            try {
                if (!EGL14.eglMakeCurrent(display, surface, surface, ctx)) return null
                return GLES20.glGetString(GLES20.GL_RENDERER)
            } finally {
                EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
                if (surface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, surface)
                EGL14.eglDestroyContext(display, ctx)
            }
        } finally {
            // No eglTerminate: the default display is shared with the UI renderer (HWUI / WebView).
        }
    }

    private fun cpuinfoHardware(): String? = try {
        File("/proc/cpuinfo").readLines().firstOrNull { it.startsWith("Hardware", true) }?.substringAfter(':')?.trim()
    } catch (_: Exception) {
        null
    }

    companion object {
        private const val TAG = "StitchDevice"
    }
}
