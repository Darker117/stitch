package com.stitch.mobile.device.text

import android.os.SystemClock
import android.util.Log
import com.stitch.mobile.device.CpuInfo
import com.stitch.mobile.device.DeviceException
import com.stitch.mobile.device.Errors
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlin.random.Random

/**
 * llama.cpp chat for GGUF models (format 'gguf'). One model stays loaded (memory-mapped) until another model, backend
 * or context size is asked for; the KV cache is kept between requests so a growing chat only evaluates its new turns.
 * The chat template is the model's own (GGUF metadata, Jinja). Reasoning comes back inside `<think>…</think>` whatever
 * markers the model uses (the app's thinking splitter handles that), including templates that open the reasoning block
 * in the prompt. Requests are serialized by the caller (the text executor).
 */
class GgufEngine(private val gpuAllowed: () -> Boolean) {
    private data class Key(val path: String, val gpu: Boolean, val nCtx: Int)

    private var handle = 0L
    private var key: Key? = null
    private val running = ConcurrentHashMap<String, Running>()
    private val earlyAborts = ConcurrentHashMap.newKeySet<String>()

    private class Running {
        @Volatile var aborted = false
        @Volatile var handle = 0L
    }

    @Synchronized
    fun loadedModelPath(): String? = key?.path

    /** Blocking; call from the text executor. */
    fun generate(req: TextRequest, onDelta: (String) -> Unit): TextResult {
        val file = File(req.modelPath)
        if (!file.isFile) throw DeviceException("Model file not found: ${req.modelPath}. Download the model first.", Errors.MODEL_MISSING)
        if (earlyAborts.remove(req.requestId)) return TextResult("", "abort", req.backend, null)
        val run = Running()
        running[req.requestId] = run
        try {
            LlamaNative.ensure()
            // GPU only where ggml's Vulkan backend is offered for this GPU family (see GgmlSupport); else the CPU.
            val gpu = req.backend == "gpu" && gpuAllowed() && LlamaNative.loadGpu().isNotEmpty()
            val h = ensureModel(req, gpu)
            run.handle = h
            if (run.aborted) return TextResult("", "abort", backendOf(gpu), null)
            return chat(h, req, run, gpu, onDelta)
        } finally {
            running.remove(req.requestId)
        }
    }

    fun abort(requestId: String) {
        val run = running[requestId] ?: run { earlyAborts += requestId; return }
        run.aborted = true
        if (run.handle != 0L) LlamaNative.abort(run.handle)
    }

    @Synchronized
    fun unload() {
        if (handle != 0L) {
            try { LlamaNative.free(handle) } catch (t: Throwable) { Log.w(TAG, "free failed", t) }
        }
        handle = 0L
        key = null
    }

    // ---------------------------------------------------------------------------------------------------------------

    @Synchronized
    private fun ensureModel(req: TextRequest, gpu: Boolean): Long {
        val nCtx = (req.contextLength?.takeIf { it > 0 } ?: DEFAULT_CTX).coerceIn(512, MAX_CTX)
        val want = Key(req.modelPath, gpu, nCtx)
        if (handle != 0L && key == want) return handle
        // Keep a loaded model when a request just doesn't say how much context it wants.
        if (handle != 0L && key?.path == want.path && key?.gpu == gpu && req.contextLength == null) return handle
        unload()
        val started = SystemClock.elapsedRealtime()
        val h = try {
            LlamaNative.load(req.modelPath, gpu, nCtx, CpuInfo.ggmlThreads(), if (gpu) 512 else 256)
        } catch (e: OutOfMemoryError) {
            throw Errors.outOfMemory(backendOf(gpu))
        } catch (e: RuntimeException) {
            val msg = e.message ?: "llama.cpp couldn't load the model"
            if (msg.contains("memory", true)) throw Errors.outOfMemory(backendOf(gpu))
            throw DeviceException(msg, if (gpu) Errors.BACKEND_INIT else "ERROR", e)
        }
        Log.i(TAG, "llama.cpp ready on ${backendOf(gpu)} in ${SystemClock.elapsedRealtime() - started} ms: ${LlamaNative.describe(h)}")
        handle = h
        key = want
        return h
    }

    private fun chat(h: Long, req: TextRequest, run: Running, gpu: Boolean, onDelta: (String) -> Unit): TextResult {
        val thinking = req.config["enableThinking"] == true
        val rendered = try {
            JSONObject(LlamaNative.render(h, messagesJson(req.system, req.messages).toString().toByteArray(Charsets.UTF_8), thinking))
        } catch (e: RuntimeException) {
            throw DeviceException(e.message ?: "Chat template failed", "ERROR", e)
        }
        val prompt = rendered.getString("prompt")

        // Reasoning markers → <think> / </think>; a template may already have opened the block in the prompt.
        val start = rendered.optString("thinkingStart", "")
        val ends = rendered.optJSONArray("thinkingEnds")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
        val replacements = LinkedHashMap<String, String>()
        if (start.isNotBlank() && start.trim() != THINK_OPEN) replacements[start.trim()] = THINK_OPEN
        for (e in ends) if (e.isNotBlank() && e.trim() != THINK_CLOSE) replacements[e.trim()] = THINK_CLOSE
        val rewriter = TagRewriter(replacements)
        val forcedOpen = start.isNotBlank() && rendered.optString("generationPrompt", "").trimEnd().endsWith(start.trim())

        val stops = req.stop + (rendered.optJSONArray("stops")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList())
        val matcher = StopMatcher(stops)
        fun emit(text: String) {
            if (text.isEmpty() || matcher.stopped) return
            val out = matcher.feed(text)
            if (out.isNotEmpty()) onDelta(out)
        }
        if (forcedOpen) emit(THINK_OPEN)

        val cfg = req.config
        @Suppress("UNCHECKED_CAST") val sampling = cfg["sampling"] as? Map<String, Any?> ?: emptyMap()
        fun num(key: String): Double? = (sampling[key] as? Number)?.toDouble() ?: (cfg[key] as? Number)?.toDouble()
        val temperature = (req.temperature ?: num("temperature") ?: 0.8).coerceIn(0.0, 2.0)
        val topP = (req.topP ?: num("topP") ?: 0.95).coerceIn(0.0, 1.0)
        val topK = req.topK ?: num("topK")?.toInt() ?: 40
        val minP = num("minP") ?: 0.05
        val repeat = num("repeatPenalty") ?: 1.0

        val sink = LlamaNative.ByteSink { bytes ->
            emit(rewriter.feed(String(bytes, Charsets.UTF_8)))
            !matcher.stopped && !run.aborted
        }
        val result = try {
            JSONObject(
                LlamaNative.generate(
                    h, prompt.toByteArray(Charsets.UTF_8), req.maxTokens?.takeIf { it > 0 } ?: 0,
                    temperature.toFloat(), topP.toFloat(), topK, minP.toFloat(), repeat.toFloat(), Random.nextInt(1, Int.MAX_VALUE), sink,
                ),
            )
        } catch (e: RuntimeException) {
            if (run.aborted) return TextResult(matcher.text, "abort", backendOf(gpu), null)
            val msg = e.message ?: "llama.cpp failed"
            if (msg.contains("memory", true) || msg.contains("alloc", true)) throw Errors.outOfMemory(backendOf(gpu))
            throw DeviceException(msg, "ERROR", e)
        }
        emit(rewriter.flush())
        val tail = matcher.flush()
        if (tail.isNotEmpty()) onDelta(tail)

        val stopReason = when {
            run.aborted || result.optString("stop") == "abort" -> "abort"
            result.optString("stop") == "length" -> "length"
            else -> "stop"
        }
        val genTokens = result.optInt("genTokens")
        val genMs = result.optLong("genMs")
        val tps = if (genTokens > 1 && genMs > 0) genTokens * 1000.0 / genMs else null
        Log.i(
            TAG,
            "reply on ${backendOf(gpu)}: prompt ${result.optInt("promptTokens")} tok (${result.optInt("reusedTokens")} cached) in " +
                "${result.optLong("promptMs")} ms, $genTokens tok in $genMs ms (${tps?.let { "%.1f".format(it) } ?: "-"} tok/s), $stopReason",
        )
        return TextResult(matcher.text, stopReason, backendOf(gpu), tps)
    }

    companion object {
        private const val TAG = "StitchGguf"
        private const val THINK_OPEN = "<think>"
        private const val THINK_CLOSE = "</think>"
        const val DEFAULT_CTX = 4096
        const val MAX_CTX = 32768

        fun backendOf(gpu: Boolean) = if (gpu) "gpu" else "cpu"

        /**
         * System + turns as the JSON messages the chat template gets. Same shaping as the LiteRT-LM path: system parts
         * merged, consecutive same-role turns merged, a user turn first and last (templates like Gemma's insist).
         */
        fun messagesJson(system: String?, messages: List<ChatTurn>): JSONArray {
            val (sys, history, prompt) = TextEngine.shape(system, messages)
            val arr = JSONArray()
            if (sys != null) arr.put(JSONObject().put("role", "system").put("content", sys))
            for (t in history) arr.put(JSONObject().put("role", t.role).put("content", t.content))
            arr.put(JSONObject().put("role", "user").put("content", prompt))
            return arr
        }
    }
}
