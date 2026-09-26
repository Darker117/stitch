package com.stitch.mobile.device.image

import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import com.stitch.mobile.device.CpuInfo
import com.stitch.mobile.device.DeviceException
import com.stitch.mobile.device.Errors
import com.stitch.mobile.device.ModelStore
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.ConcurrentHashMap

/**
 * stable-diffusion.cpp (format 'sd-cpp'): one checkpoint file (.safetensors / .ckpt / .gguf; SD 1.x, 2.x, SDXL, Turbo,
 * LCM merges …) with an optional VAE / TAESD next to it and per-image LoRAs, all named in the catalog `config`:
 *   vae, taesd: file paths inside the model folder
 *   loras: [{ path, scale }]          e.g. LCM-LoRA so any SD 1.5 finetune runs in 4–8 steps
 *   sampler: stable-diffusion.cpp sample method ("euler_a", "lcm", "dpm++2m" …); default from the request's scheduler
 *   schedule: its sigma schedule ("karras", "discrete", "sgm_uniform" …); default = the model's
 *   clipSkip, flashAttn (default true), previews (default true)
 * The context (model weights) stays loaded between images of the same model and backend. Runs on the image executor.
 */
class SdCppEngine(private val cacheDir: File, private val gpuAllowed: () -> Boolean) {
    private data class Key(val model: String, val vae: String?, val taesd: String?, val backend: String, val threads: Int, val flashAttn: Boolean)

    @Volatile private var handle = 0L
    private var key: Key? = null
    @Volatile private var loadedDir: String? = null
    @Volatile private var runningJob: String? = null
    @Volatile private var canceled = false
    private val earlyCancels = ConcurrentHashMap.newKeySet<String>()

    fun loadedDir(): String? = loadedDir

    fun cancel(jobId: String) {
        if (runningJob == jobId) {
            canceled = true
            val h = handle
            if (h != 0L) SdNative.cancel(h)
        } else {
            earlyCancels += jobId
        }
    }

    @Synchronized
    fun unload() {
        if (handle != 0L) {
            try { SdNative.free(handle) } catch (t: Throwable) { Log.w(TAG, "free failed", t) }
        }
        handle = 0L
        key = null
        loadedDir = null
    }

    /** Blocking; call from the image executor. */
    @Synchronized
    fun generate(req: ImageRequest, file: String?, onProgress: (ImageProgress) -> Unit): ImageResult {
        if (earlyCancels.remove(req.jobId)) throw Errors.canceled("Image canceled")
        val started = SystemClock.elapsedRealtime()
        val dir = File(req.dir)
        if (!dir.isDirectory) throw DeviceException("Model folder not found: ${req.dir}. Download the model first.", Errors.MODEL_MISSING)
        val cfg = req.config
        val model = resolveCheckpoint(dir, file ?: cfg.string("checkpoint"))
        fun inside(key: String): File? = cfg.string(key)?.let { p ->
            ModelStore.resolveInside(dir, p).takeIf { it.isFile } ?: throw DeviceException("Model file missing: $p", Errors.MODEL_MISSING)
        }
        val vae = inside("vae")
        val taesd = inside("taesd")
        @Suppress("UNCHECKED_CAST")
        val loras = (cfg["loras"] as? List<Map<String, Any?>>).orEmpty().mapNotNull { l ->
            val p = l["path"] as? String ?: return@mapNotNull null
            val f = ModelStore.resolveInside(dir, p)
            if (!f.isFile) throw DeviceException("LoRA file missing: $p", Errors.MODEL_MISSING)
            f.absolutePath to ((l["scale"] as? Number)?.toFloat() ?: 1f)
        }

        runningJob = req.jobId
        canceled = false
        try {
            SdNative.ensure()
            val gpu = req.backend == "gpu" && gpuAllowed() && SdNative.loadGpu().isNotEmpty()
            val backend = if (gpu) "vulkan0" else "cpu"
            val flashAttn = cfg["flashAttn"] != false
            val want = Key(model.absolutePath, vae?.absolutePath, taesd?.absolutePath, backend, CpuInfo.sdThreads(), flashAttn)
            val steps = req.steps.coerceIn(1, 100)
            onProgress(ImageProgress(req.jobId, 0, steps, null, "loading"))
            val h = ensureContext(want, dir)
            if (canceled) throw Errors.canceled("Image canceled")

            val width = roundTo64(req.width)
            val height = roundTo64(req.height)
            val sampler = cfg.string("sampler") ?: samplerFor(req.scheduler)
            val schedule = cfg.string("schedule") ?: ""
            var phase = "encoding"
            onProgress(ImageProgress(req.jobId, 0, steps, null, phase))
            val previews = cfg["previews"] != false
            val sink = object : SdNative.Sink {
                override fun onProgress(step: Int, steps2: Int) {
                    // Tensor loading reports progress too; only sampling steps count.
                    if (steps2 != steps) return
                    phase = if (step >= steps) "decoding" else "denoising"
                    onProgress(ImageProgress(req.jobId, step, steps, null, phase))
                }

                override fun onPreview(step: Int, pixels: ByteArray, width: Int, height: Int, channels: Int) {
                    if (step >= steps) return
                    previewDataUrl(pixels, width, height, channels)?.let { onProgress(ImageProgress(req.jobId, step, steps, it, "denoising")) }
                }
            }
            val out = try {
                SdNative.generate(
                    h, req.prompt.toByteArray(Charsets.UTF_8), (req.negativePrompt ?: "").toByteArray(Charsets.UTF_8),
                    width, height, steps, req.guidance.toFloat(), req.seed, sampler, schedule, cfg.int("clipSkip") ?: -1,
                    loras.map { it.first }.toTypedArray().takeIf { it.isNotEmpty() }, loras.map { it.second }.toFloatArray(),
                    previews, sink,
                )
            } catch (e: RuntimeException) {
                if (canceled) throw Errors.canceled("Image canceled")
                throw Errors.friendly(e, backendOf(gpu))
            }
            if (canceled) throw Errors.canceled("Image canceled")
            val w = le32(out, 0)
            val hgt = le32(out, 4)
            val png = savePng(out, w, hgt, req.jobId)
            val seconds = (SystemClock.elapsedRealtime() - started) / 1000.0
            Log.i(TAG, "Image ${req.jobId}: ${w}x$hgt, $steps steps ($sampler${if (loras.isEmpty()) "" else " + ${loras.size} LoRA"}) on $backend in ${"%.1f".format(seconds)} s")
            return ImageResult(png.absolutePath, w, hgt, req.seed, backendOf(gpu), seconds)
        } catch (e: OutOfMemoryError) {
            unload()
            throw Errors.outOfMemory(req.backend)
        } finally {
            runningJob = null
        }
    }

    private fun ensureContext(want: Key, dir: File): Long {
        if (handle != 0L && key == want) return handle
        unload()
        val started = SystemClock.elapsedRealtime()
        val h = try {
            SdNative.load(want.model, want.vae, want.taesd, want.backend, want.threads, want.flashAttn, false)
        } catch (e: RuntimeException) {
            val msg = e.message ?: "stable-diffusion.cpp couldn't load the model"
            if (msg.contains("memory", true) || msg.contains("alloc", true)) throw Errors.outOfMemory(backendOf(want.backend != "cpu"))
            throw DeviceException(msg, if (want.backend != "cpu") Errors.BACKEND_INIT else "ERROR", e)
        }
        Log.i(TAG, "stable-diffusion.cpp ready (${SdNative.modelVersion(h)}) on ${want.backend} in ${SystemClock.elapsedRealtime() - started} ms")
        handle = h
        key = want
        loadedDir = dir.absolutePath
        return h
    }

    private fun resolveCheckpoint(dir: File, file: String?): File {
        if (!file.isNullOrBlank()) {
            val f = ModelStore.resolveInside(dir, file)
            if (!f.isFile) throw DeviceException("Checkpoint not found: $file. Download the model first.", Errors.MODEL_MISSING)
            return f
        }
        return dir.listFiles()?.filter { it.isFile && it.extension.lowercase() in CHECKPOINT_EXTENSIONS }?.maxByOrNull { it.length() }
            ?: throw DeviceException("No checkpoint (.safetensors / .ckpt / .gguf) in ${dir.name}", Errors.MODEL_MISSING)
    }

    private fun previewDataUrl(pixels: ByteArray, w: Int, h: Int, channels: Int): String? = try {
        val argb = IntArray(w * h) { i ->
            val o = i * channels
            val r = pixels[o].toInt() and 0xff
            val g = if (channels > 1) pixels[o + 1].toInt() and 0xff else r
            val b = if (channels > 2) pixels[o + 2].toInt() and 0xff else r
            (0xff shl 24) or (r shl 16) or (g shl 8) or b
        }
        val bmp = Bitmap.createBitmap(argb, w, h, Bitmap.Config.ARGB_8888)
        val bos = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 70, bos)
        bmp.recycle()
        "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
    } catch (e: Exception) {
        null
    }

    private fun savePng(out: ByteArray, w: Int, h: Int, jobId: String): File {
        val argb = IntArray(w * h) { i ->
            val o = 8 + i * 3
            (0xff shl 24) or ((out[o].toInt() and 0xff) shl 16) or ((out[o + 1].toInt() and 0xff) shl 8) or (out[o + 2].toInt() and 0xff)
        }
        val bmp = Bitmap.createBitmap(argb, w, h, Bitmap.Config.ARGB_8888)
        val dir = File(cacheDir, "stitch-out").apply { mkdirs() }
        val safe = jobId.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80)
        val file = File(dir, "img-$safe-${System.currentTimeMillis()}.png")
        FileOutputStream(file).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bmp.recycle()
        return file
    }

    companion object {
        private const val TAG = "StitchSdCpp"
        val CHECKPOINT_EXTENSIONS = setOf("safetensors", "ckpt", "gguf", "sft", "pt", "pth")

        fun backendOf(gpu: Boolean) = if (gpu) "gpu" else "cpu"

        fun roundTo64(v: Int): Int = ((v.coerceIn(256, 1536) + 32) / 64 * 64).coerceIn(256, 1536)

        /** The app's scheduler names → stable-diffusion.cpp sample methods ("" = the model's default). */
        fun samplerFor(scheduler: String): String = when (scheduler.lowercase()) {
            "euler" -> "euler"
            "euler-a", "euler_a" -> "euler_a"
            "lcm" -> "lcm"
            "turbo", "", "default" -> ""
            else -> scheduler
        }

        private fun le32(b: ByteArray, at: Int): Int =
            (b[at].toInt() and 0xff) or ((b[at + 1].toInt() and 0xff) shl 8) or ((b[at + 2].toInt() and 0xff) shl 16) or ((b[at + 3].toInt() and 0xff) shl 24)
    }
}
