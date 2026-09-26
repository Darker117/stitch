package com.stitch.mobile.device.text

import android.content.Context
import android.os.SystemClock
import android.util.Log
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.ExperimentalFlags
import com.google.ai.edge.litertlm.LogSeverity
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.MessageCallback
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.ThinkingConfig
import com.stitch.mobile.device.DeviceException
import com.stitch.mobile.device.Errors
import com.stitch.mobile.device.NativeRuntime
import java.io.File
import java.util.concurrent.CancellationException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.random.Random

data class ChatTurn(val role: String, val content: String)

data class TextRequest(
    val requestId: String,
    val modelPath: String,
    /** 'npu' | 'gpu' | 'cpu' */
    val backend: String,
    val system: String?,
    val messages: List<ChatTurn>,
    val maxTokens: Int?,
    val temperature: Double?,
    val topP: Double?,
    val topK: Int?,
    val stop: List<String>,
    val contextLength: Int?,
    /** Catalog facts: enableThinking (default false), speculativeDecoding, sampler: null (NPU builds). */
    val config: Map<String, Any?> = emptyMap(),
)

data class TextResult(val text: String, val stopReason: String, val backend: String, val tokensPerSecond: Double?)

/**
 * LiteRT-LM chat. One engine stays loaded (reloaded when the model/backend/context changes); each request builds a
 * fresh Conversation from system + history so the model's own chat template is applied, streams the reply and closes
 * the conversation. Requests are serialized by the caller (single-thread executor).
 */
class TextEngine(private val context: Context) {
    private data class Key(val path: String, val backend: String, val maxTokens: Int?, val speculative: Boolean)

    private var engine: Engine? = null
    private var key: Key? = null
    private val running = ConcurrentHashMap<String, Running>()
    /** Aborts that arrived while the request was still queued behind another one. */
    private val earlyAborts = ConcurrentHashMap.newKeySet<String>()

    private class Running {
        val conversation = AtomicReference<Conversation?>()
        @Volatile var aborted = false
    }

    init {
        try { Engine.setNativeMinLogSeverity(LogSeverity.WARNING) } catch (_: Throwable) {}
    }

    @Synchronized
    fun loadedModelPath(): String? = key?.path

    /** Blocking; call from a worker thread. */
    fun generate(req: TextRequest, onDelta: (String) -> Unit): TextResult {
        val file = File(req.modelPath)
        if (!file.isFile) throw DeviceException("Model file not found: ${req.modelPath}. Download the model first.", Errors.MODEL_MISSING)
        if (earlyAborts.remove(req.requestId)) return TextResult("", "abort", req.backend, null)
        val run = Running()
        running[req.requestId] = run
        try {
            val engine = ensureEngine(req)
            if (run.aborted) return TextResult("", "abort", req.backend, null)
            return chat(engine, req, run, onDelta)
        } finally {
            running.remove(req.requestId)
        }
    }

    fun abort(requestId: String) {
        val run = running[requestId] ?: run { earlyAborts += requestId; return }
        run.aborted = true
        try { run.conversation.get()?.cancelProcess() } catch (e: Exception) { Log.w(TAG, "cancelProcess failed", e) }
    }

    @Synchronized
    fun unload() {
        try { engine?.close() } catch (e: Exception) { Log.w(TAG, "engine close failed", e) }
        engine = null
        key = null
    }

    // ---------------------------------------------------------------------------------------------------------------

    @OptIn(com.google.ai.edge.litertlm.ExperimentalApi::class)
    @Synchronized
    private fun ensureEngine(req: TextRequest): Engine {
        // NPU models are compiled for a fixed KV-cache length: keep the model's own value there.
        val maxTokens = if (req.backend == "npu") null else req.contextLength?.takeIf { it > 0 }
        val speculative = req.config["speculativeDecoding"] == true
        val want = Key(req.modelPath, req.backend, maxTokens, speculative)
        // Reuse the loaded engine; a request without a context length keeps whatever the engine was built with.
        engine?.let { e ->
            val k = key
            if (k != null && e.isInitialized() && k.path == want.path && k.backend == want.backend &&
                k.speculative == want.speculative && (maxTokens == null || k.maxTokens == maxTokens)
            ) return e
        }
        unload()

        val backend = when (req.backend) {
            "npu" -> Backend.NPU(nativeLibraryDir = NativeRuntime.nativeLibDir)
            "gpu" -> Backend.GPU()
            else -> Backend.CPU(threadCount = cpuThreads())
        }
        // Compiled GPU programs / weight caches live next to the model so deleting the model removes them too.
        val cacheDir = File(File(req.modelPath).parentFile, ".cache/${req.backend}").apply { mkdirs() }
        val config = EngineConfig(
            modelPath = req.modelPath,
            backend = backend,
            maxNumTokens = maxTokens,
            cacheDir = cacheDir.absolutePath,
        )
        val started = SystemClock.elapsedRealtime()
        ExperimentalFlags.enableSpeculativeDecoding = if (speculative) true else null
        val e = Engine(config)
        try {
            e.initialize()
        } catch (t: Throwable) {
            try { e.close() } catch (_: Throwable) {}
            if (t is OutOfMemoryError) throw Errors.outOfMemory(req.backend)
            throw Errors.backendInit(req.backend, t.message ?: t.javaClass.simpleName, t)
        }
        Log.i(TAG, "LiteRT-LM engine ready on ${req.backend} in ${SystemClock.elapsedRealtime() - started} ms: ${req.modelPath}")
        // Keep only this backend's cache (XNNPACK / GPU weight caches are about 1-2x the model size each).
        cacheDir.parentFile?.listFiles()?.forEach { if (it.isDirectory && it.name != req.backend) it.deleteRecursively() }
        engine = e
        key = want
        return e
    }

    private fun chat(engine: Engine, req: TextRequest, run: Running, onDelta: (String) -> Unit): TextResult {
        val (system, history, prompt) = buildConversation(req.system, req.messages)
        val temperature = (req.temperature ?: 0.8).coerceIn(0.0, 2.0)
        val sampler = SamplerConfig(
            topK = if (temperature <= 0.0) 1 else (req.topK ?: 40).coerceAtLeast(1),
            topP = (req.topP ?: 0.95).coerceIn(0.0, 1.0),
            temperature = temperature,
            seed = Random.nextInt(1, Int.MAX_VALUE),
        )
        // NPU builds sample inside the compiled graph: leave the sampler to the model (as Google's Gallery does).
        val useSampler = req.backend != "npu" && !(req.config.containsKey("sampler") && req.config["sampler"] == null)
        val conversation = try {
            engine.createConversation(
                ConversationConfig(
                    systemInstruction = system?.let { Contents.of(it) },
                    initialMessages = history,
                    samplerConfig = if (useSampler) sampler else null,
                ),
            )
        } catch (t: Throwable) {
            throw Errors.friendly(t, req.backend)
        }
        run.conversation.set(conversation)

        val matcher = StopMatcher(req.stop)
        val maxTokens = req.maxTokens?.takeIf { it > 0 }
        val done = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        var chunks = 0
        var firstChunkAt = 0L
        var lastChunkAt = 0L
        var stopReason = "stop"

        val callback = object : MessageCallback {
            override fun onMessage(message: Message) {
                val delta = textOf(message)
                if (delta.isEmpty() || matcher.stopped) return
                val now = SystemClock.elapsedRealtime()
                if (chunks == 0) firstChunkAt = now
                lastChunkAt = now
                chunks++
                val out = matcher.feed(delta)
                if (out.isNotEmpty()) onDelta(out)
                if (matcher.stopped) {
                    stopReason = "stop"
                    try { conversation.cancelProcess() } catch (_: Exception) {}
                } else if (maxTokens != null && chunks >= maxTokens) {
                    stopReason = "length"
                    try { conversation.cancelProcess() } catch (_: Exception) {}
                }
            }

            override fun onDone() {
                done.countDown()
            }

            override fun onError(throwable: Throwable) {
                if (throwable !is CancellationException) failure.set(throwable)
                done.countDown()
            }
        }

        try {
            // Reasoning models (Qwen3, LFM) think on a separate channel; it's off unless the catalog enables it, and
            // thought text never reaches the reply (only Content.Text is streamed).
            val thinking = ThinkingConfig(enableThinking = req.config["enableThinking"] == true)
            conversation.sendMessageAsync(prompt, callback, maxOutputToken = maxTokens, thinkingConfig = thinking)
            while (!done.await(250, TimeUnit.MILLISECONDS)) {
                if (Thread.currentThread().isInterrupted) {
                    run.aborted = true
                    try { conversation.cancelProcess() } catch (_: Exception) {}
                }
            }
        } catch (t: Throwable) {
            failure.compareAndSet(null, t)
        } finally {
            run.conversation.set(null)
            try { conversation.close() } catch (_: Exception) {}
        }

        failure.get()?.let { t ->
            if (!run.aborted) throw Errors.friendly(t, req.backend)
        }
        val tail = matcher.flush()
        if (tail.isNotEmpty()) onDelta(tail)
        if (run.aborted) stopReason = "abort"
        else if (!matcher.stopped && stopReason != "length" && maxTokens != null && chunks >= maxTokens) stopReason = "length"

        val seconds = (lastChunkAt - firstChunkAt) / 1000.0
        val tps = if (chunks > 1 && seconds > 0) (chunks - 1) / seconds else null
        return TextResult(matcher.text, stopReason, req.backend, tps)
    }

    companion object {
        private const val TAG = "StitchText"

        fun cpuThreads(): Int = Runtime.getRuntime().availableProcessors().let { if (it >= 8) 4 else maxOf(2, it / 2) }

        fun textOf(message: Message): String = buildString {
            for (c in message.contents.contents) if (c is Content.Text) append(c.text)
        }

        /**
         * Map system + chat turns onto LiteRT-LM's conversation: system instruction, earlier turns as initial
         * messages, and the final user turn as the prompt. Consecutive turns of the same role are merged (several
         * chat templates require alternation). If the chat doesn't end with a user turn, ask the model to continue.
         */
        fun buildConversation(system: String?, messages: List<ChatTurn>): Triple<String?, List<Message>, Message> {
            val (sys, turns, prompt) = shape(system, messages)
            val history = turns.map { if (it.role == "assistant") Message.model(it.content) else Message.user(it.content) }
            return Triple(sys, history, Message.user(prompt))
        }

        /** The shaping behind [buildConversation] (also used for GGUF chat templates): system, earlier turns, final prompt. */
        fun shape(system: String?, messages: List<ChatTurn>): Triple<String?, List<ChatTurn>, String> {
            val systemParts = mutableListOf<String>()
            system?.trim()?.takeIf { it.isNotEmpty() }?.let { systemParts += it }
            val turns = mutableListOf<ChatTurn>()
            for (m in messages) {
                val role = when (m.role) {
                    "system" -> { m.content.trim().takeIf { it.isNotEmpty() }?.let { systemParts += it }; continue }
                    "assistant", "model" -> "assistant"
                    else -> "user"
                }
                val last = turns.lastOrNull()
                if (last != null && last.role == role) turns[turns.size - 1] = ChatTurn(role, last.content + "\n\n" + m.content)
                else turns += ChatTurn(role, m.content)
            }
            // Templates such as Gemma's require the chat to open with a user turn.
            if (turns.firstOrNull()?.role == "assistant") turns.add(0, ChatTurn("user", "Begin."))
            val prompt = if (turns.lastOrNull()?.role == "user") turns.removeAt(turns.size - 1).content else "Continue."
            return Triple(systemParts.joinToString("\n\n").ifEmpty { null }, turns, prompt)
        }
    }
}
