package com.stitch.mobile.device

import android.net.Uri
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.stitch.mobile.device.image.ImageEngine
import com.stitch.mobile.device.image.ImageRequest
import com.stitch.mobile.device.image.SdCppEngine
import com.stitch.mobile.device.text.ChatTurn
import com.stitch.mobile.device.text.GgufEngine
import com.stitch.mobile.device.text.TextEngine
import com.stitch.mobile.device.text.TextRequest
import com.stitch.mobile.device.voice.SpeakRequest
import com.stitch.mobile.device.voice.VoiceEngine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * On-device checks of the native runtimes and the model store, run with `am instrument` (never
 * connectedAndroidTest, which uninstalls the app). Models are pushed into the app's model folders beforehand:
 *   files/models/test-gguf/<any>.gguf                      llama.cpp chat
 *   files/models/test-sdcpp/{model.gguf,taesd.safetensors,lcm.safetensors}   stable-diffusion.cpp
 * and the download test expects scripts/native/test-server.mjs behind `adb reverse tcp:8765 tcp:8765`. The regression
 * tests reuse catalog models already downloaded by the app (read-only). Tests whose inputs are missing are skipped.
 */
@RunWith(AndroidJUnit4::class)
class DeviceRuntimeTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val models = File(context.filesDir, "models")

    @Before
    fun setUp() {
        NativeRuntime.init(context)
    }

    private fun log(msg: String) = Log.i("StitchTest", msg)

    @Test
    fun ggufChatStreamsAndReusesTheCache() {
        val dir = File(models, "test-gguf")
        val gguf = dir.listFiles()?.firstOrNull { it.name.endsWith(".gguf") }
        assumeTrue("no test GGUF pushed", gguf != null)
        val engine = GgufEngine { false }
        fun ask(id: String, turns: List<ChatTurn>, max: Int = 64): Pair<String, com.stitch.mobile.device.text.TextResult> {
            val deltas = StringBuilder()
            val r = engine.generate(
                TextRequest(id, gguf!!.absolutePath, "cpu", "You are a helpful assistant.", turns, max, 0.7, 0.9, 40, emptyList(), 4096, mapOf("enableThinking" to false)),
            ) { deltas.append(it) }
            log("$id: ${r.stopReason} ${r.tokensPerSecond} tok/s :: ${deltas.toString().replace('\n', ' ').take(300)}")
            return deltas.toString() to r
        }
        val (first, r1) = ask("t1", listOf(ChatTurn("user", "Name three colours of the rainbow. 🌈")))
        assertTrue(first.isNotBlank())
        assertEquals(first, r1.text)
        assertTrue((r1.tokensPerSecond ?: 0.0) > 1.0)
        // A follow-up re-sends the history; only the new part is evaluated (see logcat StitchGguf "cached").
        val (second, _) = ask("t2", listOf(ChatTurn("user", "Name three colours of the rainbow. 🌈"), ChatTurn("assistant", first), ChatTurn("user", "And one more?")))
        assertTrue(second.isNotBlank())
        // Stop sequences end the reply without leaking the stop string.
        val deltas = StringBuilder()
        val stopped = engine.generate(
            TextRequest("t3", gguf!!.absolutePath, "cpu", null, listOf(ChatTurn("user", "Count from 1 to 20, separated by commas.")), 80, 0.0, 1.0, 1, listOf("7"), 4096, emptyMap()),
        ) { deltas.append(it) }
        log("t3: ${stopped.stopReason} :: ${stopped.text}")
        assertTrue(!stopped.text.contains("7"))
        // Abort from another thread.
        val latch = CountDownLatch(1)
        Thread { latch.await(); Thread.sleep(300); engine.abort("t4") }.start()
        val aborted = engine.generate(
            TextRequest("t4", gguf.absolutePath, "cpu", null, listOf(ChatTurn("user", "Write a very long story about the sea.")), 2000, 0.8, 0.95, 40, emptyList(), 4096, emptyMap()),
        ) { latch.countDown() }
        log("t4: ${aborted.stopReason} after ${aborted.text.length} chars")
        assertEquals("abort", aborted.stopReason)
        engine.unload()
        assertNull(engine.loadedModelPath())
    }

    /** Steady-state speed: a ~600-token prompt, then 200 generated tokens, twice (the second run is reported). */
    @Test
    fun ggufBenchmark() {
        val dir = File(models, "test-gguf")
        val ggufs = dir.listFiles()?.filter { it.name.endsWith(".gguf") }.orEmpty()
        assumeTrue("no test GGUF pushed", ggufs.isNotEmpty())
        val prompt = (1..60).joinToString(" ") { "Sentence $it of a long passage about rivers, mountains and the sea." } + " Now write a long story."
        for (gguf in ggufs) {
            val engine = GgufEngine { false }
            repeat(2) { i ->
                val started = System.nanoTime()
                val r = engine.generate(
                    TextRequest("b$i", gguf.absolutePath, "cpu", null, listOf(ChatTurn("user", "$prompt ($i)")), 200, 0.8, 0.95, 40, emptyList(), 4096, emptyMap()),
                ) {}
                log("bench ${gguf.name} run $i: ${r.tokensPerSecond} tok/s generation, ${(System.nanoTime() - started) / 1e9} s total")
            }
            engine.unload()
        }
    }

    @Test
    fun sdcppGeneratesAnImage() {
        val dir = File(models, "test-sdcpp")
        val model = dir.listFiles()?.firstOrNull { it.name.endsWith(".gguf") || it.name.endsWith(".safetensors") && it.name !in setOf("taesd.safetensors", "lcm.safetensors", "vae.safetensors") }
        assumeTrue("no test checkpoint pushed", model != null)
        val engine = SdCppEngine(context.cacheDir) { false }
        val cfg = HashMap<String, Any?>()
        if (File(dir, "taesd.safetensors").isFile) cfg["taesd"] = "taesd.safetensors"
        val lcm = File(dir, "lcm.safetensors").isFile
        if (lcm) cfg["loras"] = listOf(mapOf("path" to "lcm.safetensors", "scale" to 1.0))
        var previews = 0
        var lastStep = 0
        val res = engine.generate(
            ImageRequest("img1", "test-sdcpp", "cpu", dir.absolutePath, "a red fox in the snow, detailed photo", "blurry", if (lcm) 4 else 8, if (lcm) 1.5 else 7.0, 42, 384, 384, if (lcm) "lcm" else "euler-a", cfg),
            model!!.name,
        ) { p ->
            if (p.preview != null) previews++
            lastStep = p.step
        }
        log("sd-cpp: ${res.width}x${res.height} in ${res.seconds} s on ${res.backend}, previews $previews, last step $lastStep -> ${res.path}")
        assertTrue(File(res.path).length() > 10_000)
        assertEquals(384, res.width)
        // A custom model imported with its own VAE (sources.ts importFromPhone: config.vae, no TAESD), 2 steps at 256 px.
        if (File(dir, "vae.safetensors").isFile) {
            val vaeCfg = HashMap<String, Any?>(mapOf("vae" to "vae.safetensors", "previews" to false))
            if (lcm) vaeCfg["loras"] = cfg["loras"]
            val r2 = engine.generate(
                ImageRequest("img2", "test-sdcpp", "cpu", dir.absolutePath, "a lighthouse", "", 2, if (lcm) 1.5 else 7.0, 7, 256, 256, if (lcm) "lcm" else "euler-a", vaeCfg),
                model.name,
            ) {}
            log("sd-cpp with imported VAE: ${r2.width}x${r2.height} in ${r2.seconds} s")
            assertTrue(File(r2.path).length() > 5_000)
        }
        engine.unload()
    }

    /** LiteRT-LM (catalog qwen3-0.6b-int4) still answers after the conversation-shaping refactor. */
    @Test
    fun litertlmStillWorks() {
        val file = File(models, "qwen3-0.6b-int4/Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm")
        assumeTrue("qwen3-0.6b-int4 not downloaded", file.isFile)
        val engine = TextEngine(context)
        val r = engine.generate(
            TextRequest("l1", file.absolutePath, "cpu", "Be brief.", listOf(ChatTurn("user", "Say hello in French.")), 32, 0.7, 0.9, 40, emptyList(), 4096, mapOf("enableThinking" to false)),
        ) {}
        log("litert-lm: ${r.stopReason} ${r.tokensPerSecond} tok/s :: ${r.text}")
        assertTrue(r.text.isNotBlank())
        engine.unload()
    }

    /** The ONNX pipeline (catalog sdxs-512-dreamshaper) still renders. */
    @Test
    fun onnxStillWorks() {
        val dir = File(models, "sdxs-512-dreamshaper")
        assumeTrue("sdxs-512-dreamshaper not downloaded", File(dir, "unet/model.onnx").isFile)
        val cfg = mapOf<String, Any?>(
            "prediction" to "epsilon", "betaStart" to 0.00085, "betaEnd" to 0.012, "betaSchedule" to "scaled_linear", "trainSteps" to 1000,
            "latentChannels" to 4, "timestepSpacing" to "trailing", "stepsOffset" to 1, "fixedResolution" to 512, "padTokenId" to 49407,
            "dtype" to "float32", "weightDtype" to "float16", "vaeScale" to 1.0, "vaeOutputRange" to listOf(-1, 1), "textDim" to 768,
        )
        val engine = ImageEngine(context)
        val soc = DeviceProbe(context).soc()
        val r = engine.generate(ImageRequest("o1", "sdxs-512-dreamshaper", "cpu", dir.absolutePath, "a lighthouse at dusk", null, 1, 0.0, 7, 512, 512, "euler", cfg), soc) {}
        log("onnx: ${r.width}x${r.height} in ${r.seconds} s")
        assertTrue(File(r.path).length() > 10_000)
        engine.unload()
    }

    /** sherpa-onnx voices (catalog kitten-nano-en-v0_8-int8) still speak. */
    @Test
    fun voiceStillWorks() {
        val dir = File(models, "kitten-nano-en-v0_8-int8")
        assumeTrue("kitten not downloaded", File(dir, "model.int8.onnx").isFile)
        val engine = VoiceEngine(context)
        val cfg = mapOf<String, Any?>("engine" to "kitten", "model" to "model.int8.onnx", "voices" to "voices.bin", "tokens" to "tokens.txt", "dataDir" to "espeak-ng-data", "sampleRate" to 24000, "lengthScale" to 1.0)
        val r = engine.speak(SpeakRequest("kitten-nano-en-v0_8-int8", "cpu", dir.absolutePath, "tts-onnx", "Hello from the phone.", "1", 1.0, cfg))
        log("voice: ${r.duration} s of audio in ${r.seconds} s")
        assertTrue(r.duration > 0.5)
        engine.shutdown()
    }

    /**
     * Real Hugging Face downloads (redirected to HF's storage) of a GGUF from the catalog, then a reply from it.
     * Instrumentation args: -e hfRepo <repo> -e hfRev <commit> -e hfFile <file> -e hfSize <bytes> [-e think true] [-e keep true].
     */
    @Test
    fun downloadsAndRunsAHuggingFaceGguf() {
        val args = InstrumentationRegistry.getArguments()
        val repo = args.getString("hfRepo")
        assumeTrue("no -e hfRepo", repo != null)
        val file = args.getString("hfFile")!!
        val size = args.getString("hfSize")!!.toLong()
        val url = "https://huggingface.co/$repo/resolve/${args.getString("hfRev")}/$file"
        val think = args.getString("think") == "true"
        val id = "test-hf-${file.lowercase().replace(Regex("[^a-z0-9.]+"), "-").take(60)}"
        val store = ModelStore(context)
        val done = CountDownLatch(1)
        var error: Throwable? = null
        val started = System.nanoTime()
        store.download(id, listOf(ModelFile(url, file, size)), emptyMap(), onEvent = {}) { err -> error = err; done.countDown() }
        assertTrue(done.await(30, TimeUnit.MINUTES))
        val secs = (System.nanoTime() - started) / 1e9
        log("hf download $repo/$file: ${error?.message ?: "ok"} in $secs s (${"%.1f".format(size / 1e6 / secs)} MB/s)")
        assertNull(error)
        val engine = GgufEngine { false }
        val r = engine.generate(
            TextRequest("h1", File(store.dirFor(id), file).absolutePath, "cpu", null, listOf(ChatTurn("user", "In one sentence, what is a lighthouse?")), if (think) 400 else 64, 0.7, 0.9, 40, emptyList(), 4096, mapOf("enableThinking" to think)),
        ) {}
        // Reasoning must arrive as a complete <think>…</think> block before the answer.
        if (think) assertTrue(r.text.trimStart().startsWith("<think>") && (r.text.contains("</think>") || r.stopReason == "length"))
        log("hf gguf reply: ${r.stopReason} ${r.tokensPerSecond} tok/s :: ${r.text.replace('\n', ' ')}")
        assertTrue(r.text.isNotBlank())
        engine.unload()
        if (args.getString("keep") != "true") store.delete(id)
    }

    @Test
    fun importCopiesAPickedFile() {
        val store = ModelStore(context)
        val src = File(context.cacheDir, "import-src.gguf").apply { writeBytes(ByteArray(3 * 1024 * 1024 + 17) { (it % 251).toByte() }) }
        val done = CountDownLatch(1)
        var files: List<ImportedFile>? = null
        var error: Throwable? = null
        val events = ArrayList<String>()
        store.importFiles("test-import", listOf(Uri.fromFile(src)), context.contentResolver, onEvent = { e -> events += "${e.state}:${e.receivedBytes}" }) { f, err ->
            files = f; error = err; done.countDown()
        }
        assertTrue(done.await(60, TimeUnit.SECONDS))
        log("import: $files $error ${events.takeLast(3)}")
        assertNull(error)
        val copied = File(models, "test-import/${files!!.single().path}")
        assertTrue(copied.readBytes().contentEquals(src.readBytes()))
        val st = store.status("test-import", listOf(ModelFile("", files!!.single().path, src.length())))
        assertTrue(st.ready)
        assertTrue(store.status("test-import", null).ready)
        store.delete("test-import")
        src.delete()
    }

    @Test
    fun downloadsFollowRedirectsWithoutLeakingHeaders() {
        val base = "http://127.0.0.1:8765"
        val reachable = try {
            (java.net.URL("$base/ping").openConnection() as java.net.HttpURLConnection).run { connectTimeout = 2000; responseCode == 200 }
        } catch (_: Exception) {
            false
        }
        assumeTrue("test server not reachable", reachable)
        val store = ModelStore(context)
        val files = listOf(
            // Same host: sized, with Range support.
            ModelFile("$base/file/plain.bin", "plain.bin", 1_000_000),
            // No Content-Length (chunked), size unknown to the catalog.
            ModelFile("$base/file/chunked.bin?chunked=1", "chunked.bin", null),
            // Redirect to another host (localhost ≠ 127.0.0.1); the server rejects any Authorization it receives there.
            ModelFile("$base/redirect?to=http://localhost:8765/file/redirected.bin%3Fnoauth%3D1", "redirected.bin", 1_000_000),
            // A server that ignores Range: the file restarts from zero.
            ModelFile("$base/file/norange.bin?norange=1", "norange.bin", 1_000_000),
        )
        File(models, "test-dl").mkdirs()
        File(models, "test-dl/norange.bin.part").writeBytes(ByteArray(1234))
        val done = CountDownLatch(1)
        var error: Throwable? = null
        store.download("test-dl", files, mapOf("Authorization" to "Bearer secret-token"), onEvent = {}) { err -> error = err; done.countDown() }
        assertTrue(done.await(120, TimeUnit.SECONDS))
        log("download: ${error?.message}")
        assertNull(error)
        assertTrue(store.status("test-dl", files).ready)
        assertEquals(1_000_000L, File(models, "test-dl/norange.bin").length())
        store.delete("test-dl")
    }
}
