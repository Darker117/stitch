package com.stitch.mobile.device

import android.app.Activity
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import androidx.activity.result.ActivityResult
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.stitch.mobile.device.image.ImageEngine
import com.stitch.mobile.device.image.ImageRequest
import com.stitch.mobile.device.image.SdCppEngine
import com.stitch.mobile.device.text.ChatTurn
import com.stitch.mobile.device.text.GgufEngine
import com.stitch.mobile.device.text.TextEngine
import com.stitch.mobile.device.text.TextRequest
import com.stitch.mobile.device.voice.SpeakRequest
import com.stitch.mobile.device.voice.VoiceEngine
import com.stitch.mobile.device.web.WebEngine
import com.stitch.mobile.device.web.WebState
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory
import java.util.concurrent.atomic.AtomicInteger

/**
 * `StitchDevice`: on-device text (LiteRT-LM, or llama.cpp for GGUF models), images (ONNX Runtime Stable Diffusion, or
 * stable-diffusion.cpp for .safetensors / .ckpt / .gguf checkpoints) and voice (sherpa-onnx / Android TTS) on the
 * Qualcomm NPU (QNN), the GPU or the CPU, plus web search (SearXNG on Chaquopy's Python) and model import (SAF).
 * Contract: src/device/plugin.ts.
 * Capacitor runs plugin methods on its shared plugin thread; everything slow here runs on our own executors.
 */
@CapacitorPlugin(name = "StitchDevice")
class StitchDevicePlugin : Plugin() {
    private lateinit var probe: DeviceProbe
    private lateinit var store: ModelStore
    private lateinit var text: TextEngine
    private lateinit var gguf: GgufEngine
    private lateinit var image: ImageEngine
    private lateinit var sdcpp: SdCppEngine
    private lateinit var voice: VoiceEngine
    private lateinit var web: WebEngine
    private var insets: InsetsWatcher? = null
    private val main = Handler(Looper.getMainLooper())

    private val io: ExecutorService = Executors.newCachedThreadPool(named("stitch-io"))
    private val textExec: ExecutorService = Executors.newSingleThreadExecutor(named("stitch-text"))
    private val imageExec: ExecutorService = Executors.newSingleThreadExecutor(named("stitch-image"))
    private val voiceExec: ExecutorService = Executors.newSingleThreadExecutor(named("stitch-voice"))

    override fun load() {
        val ctx = context.applicationContext
        NativeRuntime.init(ctx)
        probe = DeviceProbe(ctx)
        store = ModelStore(ctx)
        text = TextEngine(ctx)
        gguf = GgufEngine { ggmlGpu("libstitch_llama.so") }
        image = ImageEngine(ctx)
        sdcpp = SdCppEngine(ctx.cacheDir) { ggmlGpu("libstitch_sd.so") }
        voice = VoiceEngine(ctx)
        web = WebEngine(ctx) { s -> notifyListeners("webStatus", s.toJs()) }
        val act = activity
        if (act != null) {
            val watcher = InsetsWatcher(act) { v -> notifyListeners("insets", v.toJs()) }
            insets = watcher
            // Posted so it runs after Capacitor's SystemBars plugin has installed (and styled) its own listener.
            main.post { watcher.attach() }
        }
        io.execute { try { probe.gpu() } catch (_: Throwable) {} }
    }

    override fun handleOnConfigurationChanged(newConfig: Configuration?) {
        super.handleOnConfigurationChanged(newConfig)
        insets?.let { w -> main.post { w.applyStyle() } }
    }

    override fun handleOnResume() {
        super.handleOnResume()
        insets?.let { w -> main.post { w.applyStyle() } }
    }

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        io.execute {
            try { text.unload() } catch (_: Throwable) {}
            try { gguf.unload() } catch (_: Throwable) {}
            try { image.unload() } catch (_: Throwable) {}
            try { sdcpp.unload() } catch (_: Throwable) {}
            try { voice.shutdown() } catch (_: Throwable) {}
        }
    }

    // --- device -------------------------------------------------------------------------------------------------------

    @PluginMethod
    fun info(call: PluginCall) = work(io, call) {
        call.resolve(probe.info().toJs())
    }

    @PluginMethod
    fun insets(call: PluginCall) {
        val w = insets ?: return call.resolve(SafeInsets(0.0, 0.0, 0.0, 0.0, 0.0).toJs())
        main.post { call.resolve(w.snapshot().toJs()) }
    }

    // --- models -------------------------------------------------------------------------------------------------------

    @PluginMethod
    fun download(call: PluginCall) = work(io, call) {
        val id = call.getString("id") ?: throw bad("id is required")
        val files = parseFiles(call.getArray("files") ?: throw bad("files is required"))
        val headers = HashMap<String, String>()
        call.getObject("headers")?.let { h -> h.keys().forEach { k -> h.getString(k)?.let { headers[k] = it } } }
        store.download(id, files, headers,
            onEvent = { e -> notifyListeners("download", e.toJs()) },
            onFinish = { err -> if (err == null) call.resolve() else reject(call, err) },
        )
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) = work(io, call) {
        store.cancel(call.getString("id") ?: throw bad("id is required"))
        call.resolve()
    }

    /**
     * Pick model files with the system picker (Storage Access Framework) and copy them into model `id`'s folder.
     * The copy runs natively with `download` events for `id`; `cancelDownload` stops it. Rejects with CANCELED when
     * the picker is dismissed.
     */
    @PluginMethod
    fun importFiles(call: PluginCall) {
        val id = call.getString("id") ?: return reject(call, bad("id is required"))
        try {
            store.dirFor(id)
            if (store.isDownloading(id)) throw DeviceException("$id is busy downloading", Errors.BAD_REQUEST)
        } catch (t: Throwable) {
            return reject(call, t)
        }
        val mimes = call.getArray("mimeTypes")?.let { a -> (0 until a.length()).map { a.getString(it) } }?.filter { it.isNotBlank() }.orEmpty()
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = if (mimes.size == 1) mimes[0] else "*/*"
            if (mimes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, mimes.toTypedArray())
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, call.getBoolean("multiple", false) == true)
        }
        startActivityForResult(call, intent, "importPicked")
    }

    @ActivityCallback
    fun importPicked(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val done = { bridge.releaseCall(call) }
        val data = result.data
        val uris = ArrayList<Uri>()
        if (result.resultCode == Activity.RESULT_OK && data != null) {
            val clip = data.clipData
            if (clip != null) for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris += it }
            else data.data?.let { uris += it }
        }
        if (uris.isEmpty()) {
            call.reject("No file picked", Errors.CANCELED)
            done()
            return
        }
        val id = call.getString("id") ?: return
        try {
            store.importFiles(id, uris, context.contentResolver,
                onEvent = { e -> notifyListeners("download", e.toJs()) },
                onFinish = { files, err ->
                    if (err != null || files == null) {
                        reject(call, err ?: DeviceException("Import failed", "ERROR"))
                    } else {
                        val arr = JSArray()
                        for (f in files) arr.put(JSObject().put("path", f.path).put("name", f.name).put("size", f.size))
                        call.resolve(JSObject().put("files", arr))
                    }
                    done()
                },
            )
        } catch (t: Throwable) {
            reject(call, t)
            done()
        }
    }

    @PluginMethod
    fun status(call: PluginCall) = work(io, call) {
        val ids = call.getArray("ids")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: throw bad("ids is required")
        val filesById = call.getObject("files")
        val out = JSArray()
        for (id in ids) {
            val files = filesById?.optJSONArray(id)?.let { parseFiles(it) }
            out.put(store.status(id, files).toJs())
        }
        call.resolve(JSObject().put("models", out))
    }

    @PluginMethod
    fun deleteModel(call: PluginCall) = work(io, call) {
        val id = call.getString("id") ?: throw bad("id is required")
        val dir = store.dirFor(id).absolutePath
        // Release anything loaded from this folder first.
        fun inside(path: String?) = path != null && (path == dir || path.startsWith(dir + File.separator))
        if (inside(text.loadedModelPath())) textExec.submit { text.unload() }.get()
        if (inside(gguf.loadedModelPath())) textExec.submit { gguf.unload() }.get()
        if (inside(image.loadedDir())) imageExec.submit { image.unload() }.get()
        if (inside(sdcpp.loadedDir())) imageExec.submit { sdcpp.unload() }.get()
        if (inside(voice.loadedDir())) voiceExec.submit { voice.unload() }.get()
        store.delete(id)
        call.resolve()
    }

    // --- text -----------------------------------------------------------------------------------------------------------

    @PluginMethod
    fun textGenerate(call: PluginCall) {
        val format = call.getString("format") ?: "litertlm"
        val req = try {
            if (format != "litertlm" && format != "gguf") throw bad("Unknown text format \"$format\"")
            val requestId = call.getString("requestId") ?: throw bad("requestId is required")
            val dir = call.getString("dir") ?: throw bad("dir is required")
            val file = call.getString("file") ?: throw bad("file is required")
            val messages = call.getArray("messages")?.let { arr ->
                (0 until arr.length()).map { i ->
                    val m = arr.getJSONObject(i)
                    ChatTurn(m.optString("role", "user"), m.optString("content", ""))
                }
            } ?: throw bad("messages is required")
            val stop = call.getArray("stop")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
            TextRequest(
                requestId = requestId,
                modelPath = ModelStore.resolveInside(File(dir), file).absolutePath,
                backend = backendOf(call),
                system = call.getString("system"),
                messages = messages,
                maxTokens = call.int("maxTokens"),
                temperature = call.double("temperature"),
                topP = call.double("topP"),
                topK = call.int("topK"),
                stop = stop,
                contextLength = call.int("contextLength"),
                config = call.getObject("config")?.let { toMap(it) } ?: emptyMap(),
            )
        } catch (t: Throwable) {
            return reject(call, t)
        }
        work(textExec, call) {
            val onDelta = { delta: String -> notifyListeners("text", JSObject().put("requestId", req.requestId).put("delta", delta)) }
            // One text model in memory at a time: switching runtimes frees the other one.
            val result = if (format == "gguf") {
                text.unload()
                gguf.generate(req, onDelta)
            } else {
                gguf.unload()
                text.generate(req, onDelta)
            }
            val out = JSObject()
                .put("text", result.text)
                .put("stopReason", result.stopReason)
                .put("backend", result.backend)
            result.tokensPerSecond?.let { out.put("tokensPerSecond", Math.round(it * 10) / 10.0) }
            call.resolve(out)
        }
    }

    @PluginMethod
    fun textAbort(call: PluginCall) {
        call.getString("requestId")?.let { text.abort(it); gguf.abort(it) }
        call.resolve()
    }

    // --- image ----------------------------------------------------------------------------------------------------------

    @PluginMethod
    fun imageGenerate(call: PluginCall) {
        val format = call.getString("format") ?: "sd-onnx"
        val file = call.getString("file")
        val req = try {
            if (format != "sd-onnx" && format != "sd-cpp") throw bad("Unknown image format \"$format\"")
            ImageRequest(
                jobId = call.getString("jobId") ?: throw bad("jobId is required"),
                modelId = call.getString("modelId") ?: "",
                backend = backendOf(call),
                dir = call.getString("dir") ?: throw bad("dir is required"),
                prompt = call.getString("prompt") ?: throw bad("prompt is required"),
                negativePrompt = call.getString("negativePrompt"),
                steps = call.int("steps") ?: 4,
                guidance = call.double("guidance") ?: 1.0,
                seed = call.long("seed") ?: System.currentTimeMillis(),
                width = call.int("width") ?: 512,
                height = call.int("height") ?: 512,
                scheduler = call.getString("scheduler") ?: "euler",
                config = call.getObject("config")?.let { toMap(it) } ?: emptyMap(),
            )
        } catch (t: Throwable) {
            return reject(call, t)
        }
        work(imageExec, call) {
            val onProgress = { p: com.stitch.mobile.device.image.ImageProgress ->
                val e = JSObject().put("jobId", p.jobId).put("step", p.step).put("steps", p.steps).put("phase", p.phase)
                p.preview?.let { e.put("preview", it) }
                notifyListeners("image", e)
            }
            // One image model in memory at a time: switching runtimes frees the other one.
            val result = if (format == "sd-cpp") {
                image.unload()
                sdcpp.generate(req, file, onProgress)
            } else {
                sdcpp.unload()
                image.generate(req, probe.soc(), onProgress)
            }
            call.resolve(
                JSObject()
                    .put("path", result.path)
                    .put("width", result.width)
                    .put("height", result.height)
                    .put("seed", result.seed)
                    .put("backend", result.backend)
                    .put("seconds", Math.round(result.seconds * 100) / 100.0),
            )
        }
    }

    @PluginMethod
    fun imageCancel(call: PluginCall) {
        call.getString("jobId")?.let { image.cancel(it); sdcpp.cancel(it) }
        call.resolve()
    }

    // --- voice ----------------------------------------------------------------------------------------------------------

    @PluginMethod
    fun speak(call: PluginCall) {
        val req = try {
            SpeakRequest(
                modelId = call.getString("modelId") ?: "",
                backend = backendOf(call),
                dir = call.getString("dir") ?: "",
                format = call.getString("format") ?: "tts-onnx",
                text = call.getString("text") ?: throw bad("text is required"),
                voice = call.getString("voice"),
                speed = call.double("speed") ?: 1.0,
                config = call.getObject("config")?.let { toMap(it) } ?: emptyMap(),
            )
        } catch (t: Throwable) {
            return reject(call, t)
        }
        work(voiceExec, call) {
            val r = voice.speak(req)
            call.resolve(
                JSObject()
                    .put("path", r.path)
                    .put("sampleRate", r.sampleRate)
                    .put("duration", Math.round(r.duration * 1000) / 1000.0)
                    .put("backend", r.backend),
            )
        }
    }

    @PluginMethod
    fun systemVoices(call: PluginCall) = work(io, call) {
        val arr = JSArray()
        for (v in voice.systemVoices()) {
            arr.put(
                JSObject().put("id", v.id).put("name", v.name).put("language", v.language)
                    .put("quality", v.quality).put("network", v.network),
            )
        }
        call.resolve(JSObject().put("voices", arr))
    }

    // --- web search ---------------------------------------------------------------------------------------------------
    // SearXNG loads lazily (first webStart / webSearch / webPage); everything runs on the web engine's one thread.

    @PluginMethod
    fun webStatus(call: PluginCall) {
        call.resolve(web.state().toJs())
    }

    @PluginMethod
    fun webStart(call: PluginCall) = work(web.executor, call) {
        call.resolve(web.start(call.int("safeSearch") ?: 1).toJs())
    }

    @PluginMethod
    fun webStop(call: PluginCall) {
        call.resolve(web.stop().toJs())
    }

    @PluginMethod
    fun webSearch(call: PluginCall) {
        val req = call.getObject("req") ?: return reject(call, bad("req is required"))
        val safe = (req.opt("safeSearch") as? Number)?.toInt() ?: 1
        work(web.executor, call) {
            call.resolve(JSObject.fromJSONObject(web.search(req.toString(), safe)))
        }
    }

    @PluginMethod
    fun webPage(call: PluginCall) {
        val url = call.getString("url") ?: return reject(call, bad("url is required"))
        val maxChars = call.int("maxChars") ?: 12000
        work(web.executor, call) {
            call.resolve(JSObject.fromJSONObject(web.page(url, maxChars, call.int("safeSearch") ?: 1)))
        }
    }

    // --- housekeeping -------------------------------------------------------------------------------------------------

    @PluginMethod
    fun unload(call: PluginCall) = work(io, call) {
        val task = call.getString("task")
        if (task == null || task == "text") textExec.submit { text.unload(); gguf.unload() }.get()
        if (task == null || task == "image") imageExec.submit { image.unload(); sdcpp.unload() }.get()
        if (task == null || task == "voice") voiceExec.submit { voice.unload() }.get()
        call.resolve()
    }

    @PluginMethod
    fun deleteFile(call: PluginCall) = work(io, call) {
        val path = call.getString("path") ?: throw bad("path is required")
        val file = File(path).canonicalFile
        val allowed = listOfNotNull(context.cacheDir, context.filesDir, context.externalCacheDir).map { it.canonicalPath + File.separator }
        if (allowed.none { file.path.startsWith(it) }) throw DeviceException("Refusing to delete a file outside the app's folders", Errors.BAD_REQUEST)
        if (file.isFile && !file.delete()) throw DeviceException("Couldn't delete $path", Errors.STORAGE)
        call.resolve()
    }

    // --- helpers ----------------------------------------------------------------------------------------------------------

    private fun work(exec: ExecutorService, call: PluginCall, block: () -> Unit) {
        try {
            exec.execute {
                try {
                    block()
                } catch (t: Throwable) {
                    reject(call, t)
                }
            }
        } catch (t: Throwable) {
            reject(call, t)
        }
    }

    private fun reject(call: PluginCall, t: Throwable) {
        val e = Errors.friendly(t, call.getString("backend"))
        if (e.code != Errors.CANCELED) Log.w(TAG, "${call.methodName} failed: ${e.message}", t)
        call.reject(e.message ?: "Error", e.code)
    }

    private fun bad(msg: String) = DeviceException(msg, Errors.BAD_REQUEST)

    /** Whether ggml's GPU backend is offered on this phone's GPU (see GgmlSupport). */
    private fun ggmlGpu(lib: String): Boolean = GgmlSupport.gpu(context, SocTable.friendlyGpu(probe.gpu()), lib).available

    // Capacitor's getInt/getDouble/getLong only accept one boxed type; JSON numbers may arrive as any of them.
    private fun PluginCall.num(name: String): Number? = (data.opt(name) as? Number)?.takeUnless { it is Double && it.isNaN() }
    private fun PluginCall.int(name: String): Int? = num(name)?.let { Math.round(it.toDouble()).toInt() }
    private fun PluginCall.long(name: String): Long? = num(name)?.let { if (it is Long || it is Int) it.toLong() else Math.round(it.toDouble()) }
    private fun PluginCall.double(name: String): Double? = num(name)?.toDouble()

    private fun backendOf(call: PluginCall): String = when (val b = call.getString("backend") ?: "cpu") {
        "npu", "gpu", "cpu" -> b
        else -> throw bad("Unknown backend \"$b\"")
    }

    private fun parseFiles(arr: JSONArray): List<com.stitch.mobile.device.ModelFile> = (0 until arr.length()).map { i ->
        val o = arr.getJSONObject(i)
        com.stitch.mobile.device.ModelFile(
            // Imported files have no URL: only their path and size are checked.
            url = o.optString("url", ""),
            path = o.getString("path"),
            size = if (o.has("size") && !o.isNull("size")) o.getLong("size") else null,
        )
    }

    companion object {
        private const val TAG = "StitchDevice"

        private fun named(prefix: String): ThreadFactory {
            val n = AtomicInteger()
            return ThreadFactory { r -> Thread(r, "$prefix-${n.incrementAndGet()}").apply { isDaemon = true } }
        }

        fun toMap(o: JSONObject): Map<String, Any?> {
            val out = LinkedHashMap<String, Any?>()
            for (k in o.keys()) out[k] = unwrap(o.opt(k))
            return out
        }

        private fun unwrap(v: Any?): Any? = when (v) {
            null, JSONObject.NULL -> null
            is JSONObject -> toMap(v)
            is JSONArray -> (0 until v.length()).map { unwrap(v.opt(it)) }
            else -> v
        }
    }
}

// --- JS mappings ---------------------------------------------------------------------------------------------------------

internal fun DeviceInfo.toJs(): JSObject {
    fun list(items: List<BackendSupport>): JSArray {
        val arr = JSArray()
        for (b in items) {
            val o = JSObject().put("id", b.id).put("available", b.available)
            b.note?.let { o.put("note", it) }
            arr.put(o)
        }
        return arr
    }
    val backends = JSObject()
    for ((task, items) in this.backends) backends.put(task, list(items))
    val runtimes = JSObject()
    for ((format, items) in this.runtimes) runtimes.put(format, list(items))
    val o = JSObject()
        .put("manufacturer", manufacturer)
        .put("model", model)
        .put("androidVersion", androidVersion)
        .put("sdk", sdk)
        .put("abi", abi)
        .put("ramBytes", ramBytes)
        .put("freeStorageBytes", freeStorageBytes)
        .put("qualcomm", soc.qualcomm)
        .put("backends", backends)
        .put("runtimes", runtimes)
    soc.model?.let { o.put("soc", it) }
    soc.name?.let { o.put("socName", it) }
    soc.htpArch?.let { o.put("htpArch", it) }
    gpu?.let { o.put("gpu", it) }
    return o
}

internal fun DownloadProgress.toJs(): JSObject {
    val o = JSObject().put("id", id).put("state", state).put("receivedBytes", receivedBytes).put("totalBytes", totalBytes)
    file?.let { o.put("file", it) }
    error?.let { o.put("error", it) }
    return o
}

internal fun ModelStatus.toJs(): JSObject =
    JSObject().put("id", id).put("ready", ready).put("sizeBytes", sizeBytes).put("dir", dir).put("downloading", downloading)

internal fun WebState.toJs(): JSObject {
    val o = JSObject().put("where", "phone").put("state", state).put("version", version)
    error?.let { o.put("error", it) }
    engines?.let { o.put("engines", it) }
    loadMs?.let { o.put("loadMs", it) }
    return o
}

internal fun SafeInsets.toJs(): JSObject =
    JSObject().put("top", top).put("bottom", bottom).put("left", left).put("right", right).put("ime", ime)
