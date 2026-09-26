package com.stitch.mobile.device.image

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtException
import ai.onnxruntime.OrtSession
import android.app.ActivityManager
import android.content.Context
import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import com.stitch.mobile.device.DeviceException
import com.stitch.mobile.device.Errors
import com.stitch.mobile.device.SocInfo
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.roundToInt

data class ImageRequest(
    val jobId: String,
    val modelId: String,
    val backend: String,
    val dir: String,
    val prompt: String,
    val negativePrompt: String?,
    val steps: Int,
    val guidance: Double,
    val seed: Long,
    val width: Int,
    val height: Int,
    val scheduler: String,
    val config: Map<String, Any?>,
)

data class ImageProgress(val jobId: String, val step: Int, val steps: Int, val preview: String?, val phase: String)

data class ImageResult(val path: String, val width: Int, val height: Int, val seed: Long, val backend: String, val seconds: Double)

/**
 * Stable Diffusion (1.x / 2.x / Turbo / LCM) on ONNX Runtime: CLIP tokenizer → text encoder → UNet denoising loop
 * (Euler, Euler-ancestral, LCM, Turbo; classifier-free guidance as two batch-1 passes) → VAE decoder → PNG.
 * Batch 1 everywhere keeps a single static-shape graph per model, which is what QNN needs.
 */
class ImageEngine(private val context: Context) {
    private val jobs = ConcurrentHashMap<String, Job>()
    private var pipeline: Pipeline? = null
    private var tokenizerCache: Pair<String, ClipTokenizer>? = null

    private class Job {
        @Volatile var canceled = false
        val runOptions = OrtSession.RunOptions()
    }

    /** Sessions for one model folder + backend + resolution. The text encoder / VAE may be loaded on demand. */
    private class Pipeline(val key: String, val files: SdFiles, val backend: String) : Closeable {
        var textEncoder: Loaded? = null
        var unet: Loaded? = null
        var vae: Loaded? = null
        override fun close() {
            textEncoder?.close(); textEncoder = null
            unet?.close(); unet = null
            vae?.close(); vae = null
        }
    }

    private class Loaded(val session: OrtSession, val info: OnnxGraphInfo) : Closeable {
        override fun close() = try { session.close() } catch (_: Exception) {}
        fun input(name: String): OnnxValueInfo? = info.inputs.firstOrNull { it.name == name }
    }

    private data class SdFiles(val dir: File, val textEncoder: File, val unet: File, val vae: File, val vocab: File, val merges: File)

    /** Cancels that arrived while the job was still queued. */
    private val earlyCancels = ConcurrentHashMap.newKeySet<String>()

    /** Folder of the loaded pipeline, if any. */
    fun loadedDir(): String? = pipeline?.files?.dir?.absolutePath

    fun cancel(jobId: String) {
        val job = jobs[jobId] ?: run { earlyCancels += jobId; return }
        job.canceled = true
        try { job.runOptions.setTerminate(true) } catch (_: Exception) {}
    }

    @Synchronized
    fun unload() {
        pipeline?.close()
        pipeline = null
        tokenizerCache = null
    }

    /** Blocking; call from a worker thread. */
    @Synchronized
    fun generate(req: ImageRequest, soc: SocInfo, onProgress: (ImageProgress) -> Unit): ImageResult {
        if (earlyCancels.remove(req.jobId)) throw Errors.canceled("Image canceled")
        val job = Job()
        jobs[req.jobId] = job
        val started = SystemClock.elapsedRealtime()
        try {
            checkBackend(req.backend, soc)
            return run(req, soc, job, onProgress, started)
        } catch (e: OrtException) {
            if (job.canceled) throw Errors.canceled("Image canceled")
            throw Errors.friendly(e, req.backend)
        } catch (e: OutOfMemoryError) {
            unload()
            throw Errors.outOfMemory(req.backend)
        } catch (e: DeviceException) {
            if (job.canceled && e.code != Errors.CANCELED) throw Errors.canceled("Image canceled")
            throw e
        } finally {
            jobs.remove(req.jobId)
            try { job.runOptions.close() } catch (_: Exception) {}
        }
    }

    private fun checkBackend(backend: String, soc: SocInfo) {
        OrtSupport.unavailableReason(backend, soc.qualcomm)?.let { throw DeviceException(it, Errors.BACKEND_UNAVAILABLE) }
        if (backend == "npu") {
            if (!soc.qualcomm) throw DeviceException("The NPU backend uses Qualcomm QNN and needs a Snapdragon chip.", Errors.BACKEND_UNAVAILABLE)
            val v = soc.htpVersion
            if (v == null) throw DeviceException("This Snapdragon's Hexagon NPU isn't recognised (${soc.model}). Try GPU or CPU.", Errors.BACKEND_UNAVAILABLE)
            if (v < 69) throw DeviceException("Hexagon ${soc.htpArch} has no fp16 support; the NPU needs a quantized model. Try GPU or CPU.", Errors.BACKEND_UNAVAILABLE)
        }
    }

    private fun run(req: ImageRequest, soc: SocInfo, job: Job, onProgress: (ImageProgress) -> Unit, started: Long): ImageResult {
        val cfg = req.config
        val files = resolveFiles(File(req.dir), cfg)
        val fixed = cfg.int("fixedResolution")
        val width = fixed ?: roundTo64(req.width)
        val height = fixed ?: roundTo64(req.height)
        val latentChannels = cfg.int("latentChannels") ?: 4
        val lh = height / 8
        val lw = width / 8
        val steps = req.steps.coerceIn(1, 100)
        val textLen = cfg.int("textLength") ?: 77
        val lowMemory = totalRamGb() < 10.0

        onProgress(ImageProgress(req.jobId, 0, steps, null, "loading"))
        val tokenizer = tokenizer(files, cfg.string("padToken"), cfg.int("padTokenId"), textLen)
        val key = "${files.dir.absolutePath}|${req.backend}|${width}x$height"
        val pipe = pipeline?.takeIf { it.key == key } ?: run {
            unload()
            Pipeline(key, files, req.backend).also { pipeline = it }
        }
        val tag = cacheTag(req.backend, soc, width, height)
        // fp32 I/O + fp32 weights may use XNNPACK on the CPU. fp16 (or int8) weights keep ORT at BASIC graph
        // optimisation on the CPU: the extended/layout passes would materialise fp32 copies of every fp16 weight
        // and roughly double the memory.
        val weightDtype = cfg.string("weightDtype") ?: cfg.string("dtype")
        val fp32 = weightDtype == "float32"
        val basicOpt = req.backend == "cpu" && weightDtype != null && weightDtype != "float32"
        fun load(file: File, dims: (OnnxGraphInfo) -> Map<String, Long>): Loaded {
            if (job.canceled) throw Errors.canceled("Image canceled")
            val info = OnnxInspector.inspect(file)
            val started = SystemClock.elapsedRealtime()
            val session = OrtSupport.createSession(file, req.backend, dims(info), tag, soc.qualcomm, fp32, basicOpt)
            Log.i(TAG, "Loaded ${file.parentFile?.name}/${file.name} on ${req.backend} in ${SystemClock.elapsedRealtime() - started} ms")
            return Loaded(session, info)
        }

        // --- text encoder ----------------------------------------------------------------------------------------
        onProgress(ImageProgress(req.jobId, 0, steps, null, "encoding"))
        val te = pipe.textEncoder ?: load(files.textEncoder) { info -> StaticDims.textEncoder(info, textLen) }.also { pipe.textEncoder = it }
        val condIds = tokenizer.encode(req.prompt)
        val cond = encodeText(te, condIds, job)
        val textDim = cond.size / textLen
        val negativeIds = tokenizer.encode(req.negativePrompt ?: "")
        var uncond: FloatArray? = if (req.guidance > 1.0) encodeText(te, negativeIds, job) else null
        if (lowMemory) { te.close(); pipe.textEncoder = null }

        // --- UNet ------------------------------------------------------------------------------------------------
        val unet = pipe.unet ?: load(files.unet) { info -> StaticDims.unet(info, latentChannels, lh, lw, textLen, textDim) }.also { pipe.unet = it }
        val sampleIn = unet.info.inputs.firstOrNull { it.name == (cfg.string("unetSample") ?: "sample") }
            ?: unet.info.inputs.first { it.rank == 4 }
        val timestepIn = unet.info.inputs.firstOrNull { it.name == (cfg.string("unetTimestep") ?: "timestep") }
            ?: unet.info.inputs.firstOrNull { it.rank <= 1 }
            ?: throw DeviceException("UNet has no timestep input", Errors.BAD_REQUEST)
        val hiddenIn = unet.info.inputs.firstOrNull { it.name == (cfg.string("unetHidden") ?: "encoder_hidden_states") }
            ?: unet.info.inputs.first { it.rank == 3 }
        val condIn = unet.info.inputs.firstOrNull { it.name == "timestep_cond" }
        // LCM with a guidance embedding (w = guidance - 1) is guidance-distilled: no unconditional pass.
        val useCfg = condIn == null && req.guidance > 1.0 && uncond != null
        if (!useCfg) uncond = null
        val wEmbedding = condIn?.let {
            val dim = it.dims.getOrNull(1)?.value?.toInt() ?: cfg.int("timeCondDim") ?: 256
            LcmScheduler.guidanceEmbedding(maxOf(0.0, req.guidance - 1.0), dim)
        }

        val schedule = NoiseSchedule(
            trainSteps = cfg.int("trainSteps") ?: 1000,
            betaStart = cfg.double("betaStart") ?: 0.00085,
            betaEnd = cfg.double("betaEnd") ?: 0.012,
            betaSchedule = cfg.string("betaSchedule") ?: "scaled_linear",
            prediction = cfg.string("prediction") ?: "epsilon",
            timestepSpacing = cfg.string("timestepSpacing") ?: "leading",
            stepsOffset = cfg.int("stepsOffset") ?: 1,
        )
        val scheduler = Scheduler.create(req.scheduler, steps, schedule, cfg.int("originalInferenceSteps") ?: 50)
        val actualSteps = scheduler.timesteps.size
        val noise = GaussianNoise(req.seed)
        val latentSize = latentChannels * lh * lw
        val init = scheduler.initNoiseSigma.toFloat()
        var latents = FloatArray(latentSize) { noise.next() * init }
        val sampleShape = longArrayOf(1, latentChannels.toLong(), lh.toLong(), lw.toLong())
        val hiddenShape = longArrayOf(1, textLen.toLong(), textDim.toLong())
        val timestepShape = if (timestepIn.rank == 0) LongArray(0) else longArrayOf(1)
        val previewEvery = if (actualSteps <= 10) 1 else 2

        onProgress(ImageProgress(req.jobId, 0, actualSteps, null, "denoising"))
        for (i in 0 until actualSteps) {
            if (job.canceled) throw Errors.canceled("Image canceled")
            val x = scheduler.scaleModelInput(latents, i)
            val t = scheduler.timesteps[i]
            val epsCond = runUnet(unet, job, x, sampleIn, sampleShape, t, timestepIn, timestepShape, cond, hiddenIn, hiddenShape, condIn, wEmbedding)
            val eps = if (useCfg) {
                val epsUncond = runUnet(unet, job, x, sampleIn, sampleShape, t, timestepIn, timestepShape, uncond!!, hiddenIn, hiddenShape, condIn, wEmbedding)
                val g = req.guidance.toFloat()
                FloatArray(epsCond.size) { epsUncond[it] + g * (epsCond[it] - epsUncond[it]) }
            } else epsCond
            val res = scheduler.step(eps, i, latents, noise)
            latents = res.prevSample
            val preview = if (i < actualSteps - 1 && (i + 1) % previewEvery == 0) previewDataUrl(res.predictedOriginal, latentChannels, lh, lw) else null
            onProgress(ImageProgress(req.jobId, i + 1, actualSteps, preview, "denoising"))
        }

        // --- VAE decoder -----------------------------------------------------------------------------------------
        if (job.canceled) throw Errors.canceled("Image canceled")
        onProgress(ImageProgress(req.jobId, actualSteps, actualSteps, null, "decoding"))
        if (lowMemory && availableRamMb() < 1200) { pipe.unet?.close(); pipe.unet = null }
        val vae = pipe.vae ?: load(files.vae) { info -> StaticDims.vae(info, latentChannels, lh, lw) }.also { pipe.vae = it }
        val vaeScale = (cfg.double("vaeScale") ?: 0.18215).toFloat()
        val vaeShift = (cfg.double("vaeShift") ?: 0.0).toFloat()
        val scaled = FloatArray(latents.size) { latents[it] / vaeScale + vaeShift }
        val vaeIn = vae.info.inputs.first()
        val pixels = OrtSupport.floatTensor(scaled, sampleShape, vaeIn.elemType).use { input ->
            vae.session.run(mapOf(vaeIn.name to input), job.runOptions).use { out -> OrtSupport.readFloats(out.get(0) as OnnxTensor) }
        }
        if (lowMemory) { vae.close(); pipe.vae = null }
        val outH = pixels.size / 3 / width
        val zeroToOne = when (val r = cfg["vaeOutputRange"]) {
            is String -> r.replace(" ", "").startsWith("0,")
            is List<*> -> (r.firstOrNull() as? Number)?.toDouble() == 0.0
            else -> false
        }
        val file = savePng(pixels, width, outH, zeroToOne, req.jobId)
        val seconds = (SystemClock.elapsedRealtime() - started) / 1000.0
        Log.i(TAG, "Image ${req.jobId}: ${width}x$outH, $actualSteps steps on ${req.backend} in ${"%.1f".format(seconds)} s")
        return ImageResult(file.absolutePath, width, outH, req.seed, req.backend, seconds)
    }

    private fun encodeText(te: Loaded, ids: IntArray, job: Job): FloatArray {
        val input = te.info.inputs.first()
        val tensor = OrtSupport.intTensor(ids, longArrayOf(1, ids.size.toLong()), input.elemType)
        return tensor.use { t ->
            te.session.run(mapOf(input.name to t), job.runOptions).use { out ->
                val v = out.get("last_hidden_state").orElse(out.get(0)) as OnnxTensor
                OrtSupport.readFloats(v)
            }
        }
    }

    private fun runUnet(
        unet: Loaded,
        job: Job,
        sample: FloatArray,
        sampleIn: OnnxValueInfo,
        sampleShape: LongArray,
        t: Double,
        timestepIn: OnnxValueInfo,
        timestepShape: LongArray,
        hidden: FloatArray,
        hiddenIn: OnnxValueInfo,
        hiddenShape: LongArray,
        condIn: OnnxValueInfo?,
        wEmbedding: FloatArray?,
    ): FloatArray {
        val inputs = LinkedHashMap<String, OnnxTensor>()
        try {
            inputs[sampleIn.name] = OrtSupport.floatTensor(sample, sampleShape, sampleIn.elemType)
            inputs[timestepIn.name] = OrtSupport.scalarTensor(t, timestepShape, timestepIn.elemType)
            inputs[hiddenIn.name] = OrtSupport.floatTensor(hidden, hiddenShape, hiddenIn.elemType)
            if (condIn != null && wEmbedding != null) {
                inputs[condIn.name] = OrtSupport.floatTensor(wEmbedding, longArrayOf(1, wEmbedding.size.toLong()), condIn.elemType)
            }
            return unet.session.run(inputs, job.runOptions).use { out -> OrtSupport.readFloats(out.get(0) as OnnxTensor) }
        } finally {
            inputs.values.forEach { it.close() }
        }
    }

    private fun tokenizer(files: SdFiles, padToken: String?, padTokenId: Int?, maxLength: Int): ClipTokenizer {
        val cacheKey = files.vocab.absolutePath + "|" + padToken + "|" + padTokenId + "|" + maxLength
        tokenizerCache?.let { if (it.first == cacheKey) return it.second }
        if (!files.vocab.isFile || !files.merges.isFile) throw DeviceException("Tokenizer files missing in ${files.dir}", Errors.MODEL_MISSING)
        return ClipTokenizer.load(files.vocab, files.merges, padToken, maxLength, padTokenId).also { tokenizerCache = cacheKey to it }
    }

    private fun resolveFiles(dir: File, cfg: Map<String, Any?>): SdFiles {
        if (!dir.isDirectory) throw DeviceException("Model folder not found: $dir. Download the model first.", Errors.MODEL_MISSING)
        fun f(key: String, def: String) = File(dir, cfg.string(key) ?: def)
        return SdFiles(
            dir,
            f("textEncoder", "text_encoder/model.onnx"),
            f("unet", "unet/model.onnx"),
            f("vaeDecoder", "vae_decoder/model.onnx"),
            f("vocab", "tokenizer/vocab.json"),
            f("merges", "tokenizer/merges.txt"),
        )
    }

    private fun previewDataUrl(latents: FloatArray, channels: Int, h: Int, w: Int): String? = try {
        val argb = LatentPreview.argb(latents, channels, h, w)
        val bmp = Bitmap.createBitmap(argb, w, h, Bitmap.Config.ARGB_8888)
        val bos = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 70, bos)
        bmp.recycle()
        "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
    } catch (e: Exception) {
        null
    }

    private fun savePng(pixels: FloatArray, width: Int, height: Int, zeroToOne: Boolean, jobId: String): File {
        val plane = width * height
        val argb = IntArray(plane)
        fun px(v: Float): Int {
            val n = if (zeroToOne) v else v * 0.5f + 0.5f
            return (n * 255f).roundToInt().coerceIn(0, 255)
        }
        for (p in 0 until plane) {
            argb[p] = (0xff shl 24) or (px(pixels[p]) shl 16) or (px(pixels[plane + p]) shl 8) or px(pixels[2 * plane + p])
        }
        val bmp = Bitmap.createBitmap(argb, width, height, Bitmap.Config.ARGB_8888)
        val dir = File(context.cacheDir, "stitch-out").apply { mkdirs() }
        val safe = jobId.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80)
        val file = File(dir, "img-$safe-${System.currentTimeMillis()}.png")
        FileOutputStream(file).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bmp.recycle()
        return file
    }

    private fun totalRamGb(): Double {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mi = ActivityManager.MemoryInfo()
        am.getMemoryInfo(mi)
        return mi.totalMem / 1e9
    }

    private fun availableRamMb(): Long {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mi = ActivityManager.MemoryInfo()
        am.getMemoryInfo(mi)
        return mi.availMem / (1024 * 1024)
    }

    companion object {
        private const val TAG = "StitchImage"

        fun roundTo64(v: Int): Int = ((v.coerceIn(256, 1024) + 32) / 64 * 64).coerceIn(256, 1024)

        fun cacheTag(backend: String, soc: SocInfo, w: Int, h: Int): String =
            "$backend-${(soc.model ?: "soc").replace(Regex("[^A-Za-z0-9]"), "")}-${soc.htpArch ?: "x"}-${w}x$h-qnn${QNN_TAG}"

        /** Bump when the bundled QNN runtime changes so stale compiled contexts are rebuilt. */
        const val QNN_TAG = "250"
    }
}

/** Pins symbolic dims (by position) for the SD graphs: batch 1, fixed resolution and sequence length. */
object StaticDims {
    fun textEncoder(info: OnnxGraphInfo, textLen: Int): Map<String, Long> {
        val out = HashMap<String, Long>()
        for (input in info.inputs) assign(out, input, listOf(1L, textLen.toLong()))
        return out
    }

    fun unet(info: OnnxGraphInfo, channels: Int, lh: Int, lw: Int, textLen: Int, textDim: Int): Map<String, Long> {
        val out = HashMap<String, Long>()
        for (input in info.inputs) {
            val values: List<Long?> = when {
                input.rank == 4 -> listOf(1, channels.toLong(), lh.toLong(), lw.toLong())
                input.rank == 3 -> listOf(1, textLen.toLong(), textDim.toLong())
                input.rank == 2 -> listOf(1, null)
                input.rank == 1 -> listOf(1)
                else -> emptyList()
            }
            assign(out, input, values)
        }
        return out
    }

    fun vae(info: OnnxGraphInfo, channels: Int, lh: Int, lw: Int): Map<String, Long> {
        val out = HashMap<String, Long>()
        for (input in info.inputs) {
            if (input.rank == 4) assign(out, input, listOf(1, channels.toLong(), lh.toLong(), lw.toLong()))
        }
        return out
    }

    private fun assign(out: MutableMap<String, Long>, input: OnnxValueInfo, values: List<Long?>) {
        input.dims.forEachIndexed { i, d ->
            val p = d.param ?: return@forEachIndexed
            val v = values.getOrNull(i) ?: return@forEachIndexed
            val prev = out[p]
            if (prev == null) out[p] = v
            else if (prev != v) Log.w("StitchImage", "Symbolic dim $p used with $prev and $v; leaving the first")
        }
    }
}

internal fun Map<String, Any?>.string(key: String): String? = (this[key] as? String)?.takeIf { it.isNotEmpty() }
internal fun Map<String, Any?>.int(key: String): Int? = when (val v = this[key]) {
    is Number -> v.toInt()
    is String -> v.toIntOrNull()
    else -> null
}
internal fun Map<String, Any?>.double(key: String): Double? = when (val v = this[key]) {
    is Number -> v.toDouble()
    is String -> v.toDoubleOrNull()
    else -> null
}
