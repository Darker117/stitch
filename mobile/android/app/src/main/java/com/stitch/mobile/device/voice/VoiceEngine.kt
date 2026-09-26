package com.stitch.mobile.device.voice

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Log
import com.k2fsa.sherpa.onnx.GenerationConfig
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKittenModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsMatchaModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import com.stitch.mobile.device.DeviceException
import com.stitch.mobile.device.Errors
import java.io.File
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

data class SpeakRequest(
    val modelId: String,
    val backend: String,
    val dir: String,
    /** 'tts-onnx' | 'tts-system' */
    val format: String,
    val text: String,
    val voice: String?,
    val speed: Double,
    val config: Map<String, Any?>,
)

data class SpeakResult(val path: String, val sampleRate: Int, val duration: Double, val backend: String, val seconds: Double)

data class SystemVoiceInfo(val id: String, val name: String, val language: String, val quality: Int, val network: Boolean)

/**
 * Text to speech → 16-bit PCM WAV. Neural voices run through sherpa-onnx (Kokoro / Kitten / Piper-VITS / Matcha with
 * its bundled espeak-ng) on the CPU; the zero-download system voice uses Android's TextToSpeech.synthesizeToFile.
 */
class VoiceEngine(private val context: Context) {
    private var sherpa: OfflineTts? = null
    private var sherpaKey: String? = null
    private val system = SystemTts(context)

    fun outDir(): File = File(context.cacheDir, "stitch-out").apply { mkdirs() }

    @Synchronized
    fun speak(req: SpeakRequest): SpeakResult {
        if (req.text.isBlank()) throw DeviceException("Nothing to say", Errors.BAD_REQUEST)
        val started = SystemClock.elapsedRealtime()
        val out = File(outDir(), "voice-${System.currentTimeMillis()}-${UUID.randomUUID().toString().take(8)}.wav")
        return if (req.format == "tts-system") {
            val pcm = system.synthesize(req.text, req.voice, req.speed, out)
            SpeakResult(out.absolutePath, pcm.sampleRate, pcm.durationSeconds, "cpu", (SystemClock.elapsedRealtime() - started) / 1000.0)
        } else {
            if (req.backend != "cpu") {
                throw DeviceException(
                    "Neural voices run on the CPU (sherpa-onnx has no NPU/GPU path for TTS on Android). Use the CPU backend.",
                    Errors.BACKEND_UNAVAILABLE,
                )
            }
            val tts = ensureSherpa(req)
            val sid = req.voice?.trim()?.toIntOrNull() ?: 0
            val speed = req.speed.toFloat().coerceIn(0.5f, 2.0f)
            val lang = (req.config["langBySid"] as? Map<*, *>)?.get(sid.toString()) as? String
            val audio = try {
                if (lang != null) tts.generateWithConfig(req.text, GenerationConfig(speed = speed, sid = sid, extra = mapOf("lang" to lang)))
                else tts.generate(req.text, sid, speed)
            } catch (e: OutOfMemoryError) {
                throw Errors.outOfMemory("cpu")
            }
            if (audio.samples.isEmpty()) throw DeviceException("The voice model produced no audio for this text.", "ERROR")
            val pcm = Wav.floatToPcm16(audio.samples)
            Wav.write(out, pcm, audio.sampleRate)
            SpeakResult(out.absolutePath, audio.sampleRate, pcm.size.toDouble() / audio.sampleRate, "cpu", (SystemClock.elapsedRealtime() - started) / 1000.0)
        }
    }

    fun systemVoices(): List<SystemVoiceInfo> = system.voices()

    /** Folder of the loaded neural voice, if any. */
    fun loadedDir(): String? = sherpaKey?.substringBefore('|')

    @Synchronized
    fun unload() {
        try { sherpa?.release() } catch (e: Throwable) { Log.w(TAG, "sherpa release failed", e) }
        sherpa = null
        sherpaKey = null
    }

    fun shutdown() {
        unload()
        system.shutdown()
    }

    private fun ensureSherpa(req: SpeakRequest): OfflineTts {
        val dir = File(req.dir)
        if (!dir.isDirectory) throw DeviceException("Voice model folder not found: ${req.dir}. Download it first.", Errors.MODEL_MISSING)
        val cfg = req.config
        val engine = (cfg["engine"] as? String) ?: "vits"
        val key = "${dir.absolutePath}|$engine|${cfg["lang"]}"
        sherpa?.let { if (sherpaKey == key) return it }
        unload()

        fun path(key: String, def: String? = null): String {
            val rel = (cfg[key] as? String) ?: def ?: return ""
            if (rel.isEmpty()) return ""
            // Comma-separated lists (lexicons, rule FSTs) resolve each entry.
            return rel.split(',').filter { it.isNotBlank() }.joinToString(",") { part ->
                val f = File(dir, part.trim())
                if (!f.exists()) throw DeviceException("Voice model file missing: ${part.trim()}", Errors.MODEL_MISSING)
                f.absolutePath
            }
        }
        fun num(key: String, def: Float): Float = (cfg[key] as? Number)?.toFloat() ?: def

        val threads = (cfg["numThreads"] as? Number)?.toInt() ?: Runtime.getRuntime().availableProcessors().let { if (it >= 8) 4 else 2 }
        val modelConfig = when (engine) {
            "kokoro" -> OfflineTtsModelConfig(
                kokoro = OfflineTtsKokoroModelConfig(
                    model = path("model", "model.onnx"),
                    voices = path("voices", "voices.bin"),
                    tokens = path("tokens", "tokens.txt"),
                    dataDir = path("dataDir", "espeak-ng-data"),
                    lexicon = path("lexicon"),
                    lang = (cfg["lang"] as? String) ?: "",
                    lengthScale = num("lengthScale", 1.0f),
                ),
                numThreads = threads,
                provider = "cpu",
            )
            "kitten" -> OfflineTtsModelConfig(
                kitten = OfflineTtsKittenModelConfig(
                    model = path("model", "model.onnx"),
                    voices = path("voices", "voices.bin"),
                    tokens = path("tokens", "tokens.txt"),
                    dataDir = path("dataDir", "espeak-ng-data"),
                    lengthScale = num("lengthScale", 1.0f),
                ),
                numThreads = threads,
                provider = "cpu",
            )
            "matcha" -> OfflineTtsModelConfig(
                matcha = OfflineTtsMatchaModelConfig(
                    acousticModel = path("model", "model.onnx"),
                    vocoder = path("vocoder"),
                    lexicon = path("lexicon"),
                    tokens = path("tokens", "tokens.txt"),
                    dataDir = path("dataDir"),
                    noiseScale = num("noiseScale", 1.0f),
                    lengthScale = num("lengthScale", 1.0f),
                ),
                numThreads = threads,
                provider = "cpu",
            )
            else -> OfflineTtsModelConfig(
                vits = OfflineTtsVitsModelConfig(
                    model = path("model", "model.onnx"),
                    lexicon = path("lexicon"),
                    tokens = path("tokens", "tokens.txt"),
                    dataDir = path("dataDir"),
                    noiseScale = num("noiseScale", 0.667f),
                    noiseScaleW = num("noiseScaleW", 0.8f),
                    lengthScale = num("lengthScale", 1.0f),
                ),
                numThreads = threads,
                provider = "cpu",
            )
        }
        val config = OfflineTtsConfig(
            model = modelConfig,
            ruleFsts = path("ruleFsts"),
            maxNumSentences = 1,
            silenceScale = num("silenceScale", 0.2f),
        )
        val started = SystemClock.elapsedRealtime()
        val tts = try {
            OfflineTts(assetManager = null, config = config)
        } catch (e: OutOfMemoryError) {
            throw Errors.outOfMemory("cpu")
        } catch (e: Throwable) {
            throw Errors.backendInit("cpu", "voice model failed to load: ${e.message}", e)
        }
        Log.i(TAG, "sherpa-onnx $engine loaded in ${SystemClock.elapsedRealtime() - started} ms (${tts.numSpeakers()} speakers, ${tts.sampleRate()} Hz)")
        sherpa = tts
        sherpaKey = key
        return tts
    }

    companion object {
        private const val TAG = "StitchVoice"
    }
}

/** Android's built-in TextToSpeech, synthesized to WAV files (long text is split into chunks). */
class SystemTts(private val context: Context) {
    private var tts: TextToSpeech? = null
    private var ready = false
    private val pending = ConcurrentHashMap<String, Pair<CountDownLatch, Array<String?>>>()
    private val main = Handler(Looper.getMainLooper())

    @Synchronized
    private fun ensure(): TextToSpeech {
        tts?.let { if (ready) return it }
        val latch = CountDownLatch(1)
        var status = TextToSpeech.ERROR
        main.post {
            tts = TextToSpeech(context.applicationContext) { s ->
                status = s
                latch.countDown()
            }
        }
        if (!latch.await(15, TimeUnit.SECONDS) || status != TextToSpeech.SUCCESS) {
            try { tts?.shutdown() } catch (_: Exception) {}
            tts = null
            throw DeviceException("The system text-to-speech engine isn't available on this phone.", Errors.BACKEND_UNAVAILABLE)
        }
        val engine = tts!!
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String) {}
            override fun onDone(utteranceId: String) {
                pending.remove(utteranceId)?.first?.countDown()
            }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String) {
                pending.remove(utteranceId)?.let { it.second[0] = "synthesis error"; it.first.countDown() }
            }
            override fun onError(utteranceId: String, errorCode: Int) {
                pending.remove(utteranceId)?.let { it.second[0] = "synthesis error $errorCode"; it.first.countDown() }
            }
        })
        ready = true
        return engine
    }

    @Synchronized
    fun voices(): List<SystemVoiceInfo> {
        val engine = ensure()
        val list: Set<Voice> = try { engine.voices ?: emptySet() } catch (_: Exception) { emptySet() }
        return list.filter { v -> v.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) != true }
            .sortedWith(compareBy({ it.locale.toLanguageTag() }, { it.name }))
            .map { v ->
                SystemVoiceInfo(
                    id = v.name,
                    name = "${v.locale.getDisplayName(Locale.getDefault())} · ${v.name}",
                    language = v.locale.toLanguageTag(),
                    quality = v.quality,
                    network = v.isNetworkConnectionRequired,
                )
            }
    }

    @Synchronized
    fun synthesize(text: String, voice: String?, speed: Double, out: File): Wav.Pcm {
        val engine = ensure()
        if (!voice.isNullOrBlank()) {
            val v = try { engine.voices?.firstOrNull { it.name == voice } } catch (_: Exception) { null }
            if (v != null) engine.voice = v
            else {
                val locale = Locale.forLanguageTag(voice)
                if (locale.language.isNotEmpty()) engine.language = locale
            }
        }
        engine.setSpeechRate(speed.toFloat().coerceIn(0.25f, 4f))
        val chunks = chunk(text, (TextToSpeech.getMaxSpeechInputLength() - 16).coerceAtLeast(200))
        val parts = ArrayList<Wav.Pcm>()
        val tmpDir = File(context.cacheDir, "tts-tmp").apply { mkdirs() }
        try {
            for ((i, c) in chunks.withIndex()) {
                val id = UUID.randomUUID().toString()
                val file = File(tmpDir, "$id.wav")
                val latch = CountDownLatch(1)
                val err = arrayOfNulls<String>(1)
                pending[id] = latch to err
                val params = Bundle().apply { putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, id) }
                val rc = engine.synthesizeToFile(c, params, file, id)
                if (rc != TextToSpeech.SUCCESS) {
                    pending.remove(id)
                    throw DeviceException("System TTS refused chunk ${i + 1}", "ERROR")
                }
                if (!latch.await(120, TimeUnit.SECONDS)) {
                    pending.remove(id)
                    throw DeviceException("System TTS timed out", "ERROR")
                }
                err[0]?.let { throw DeviceException("System TTS failed: $it", "ERROR") }
                parts += Wav.read(file)
                file.delete()
            }
        } finally {
            tmpDir.listFiles()?.forEach { it.delete() }
        }
        if (parts.isEmpty()) throw DeviceException("System TTS produced no audio", "ERROR")
        val rate = parts[0].sampleRate
        val channels = parts[0].channels
        val total = parts.sumOf { it.samples.size }
        val all = ShortArray(total)
        var o = 0
        for (p in parts) {
            System.arraycopy(p.samples, 0, all, o, p.samples.size); o += p.samples.size
        }
        Wav.write(out, all, rate, channels)
        return Wav.Pcm(all, rate, channels)
    }

    fun shutdown() {
        try { tts?.shutdown() } catch (_: Exception) {}
        tts = null
        ready = false
    }

    companion object {
        /** Split at sentence/paragraph boundaries into pieces of at most [max] chars. */
        fun chunk(text: String, max: Int): List<String> {
            val out = ArrayList<String>()
            var rest = text.trim()
            while (rest.length > max) {
                var cut = rest.lastIndexOfAny(charArrayOf('.', '!', '?', '\n'), max)
                if (cut < max / 3) cut = rest.lastIndexOf(' ', max)
                if (cut <= 0) cut = max
                out += rest.substring(0, cut + 1).trim()
                rest = rest.substring(cut + 1).trim()
            }
            if (rest.isNotEmpty()) out += rest
            return out
        }
    }
}
