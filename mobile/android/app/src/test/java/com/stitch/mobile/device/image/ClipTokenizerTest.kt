package com.stitch.mobile.device.image

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.BeforeClass
import org.junit.Test
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Checks the CLIP BPE tokenizer against ids produced by Hugging Face `tokenizers` (tokenizer.json of
 * openai/clip-vit-large-patch14, the SD 1.x text encoder's tokenizer) using the real vocab.json / merges.txt,
 * downloaded once into the build directory (skipped when offline).
 */
class ClipTokenizerTest {
    companion object {
        private lateinit var tokenizer: ClipTokenizer
        private lateinit var vocab: File
        private lateinit var merges: File

        @BeforeClass
        @JvmStatic
        fun setUp() {
            val dir = File(System.getProperty("java.io.tmpdir"), "stitch-test-clip").apply { mkdirs() }
            vocab = File(dir, "vocab.json")
            merges = File(dir, "merges.txt")
            val base = "https://huggingface.co/openai/clip-vit-large-patch14/resolve/main"
            val ok = fetch("$base/vocab.json", vocab) && fetch("$base/merges.txt", merges)
            assumeTrue("CLIP tokenizer files unavailable (offline?)", ok)
            tokenizer = ClipTokenizer.load(vocab, merges)
        }

        private fun fetch(url: String, dest: File): Boolean {
            if (dest.isFile && dest.length() > 100_000) return true
            return try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.instanceFollowRedirects = true
                conn.connectTimeout = 20_000
                conn.readTimeout = 60_000
                if (conn.responseCode != 200) return false
                val tmp = File(dest.path + ".tmp")
                conn.inputStream.use { input -> tmp.outputStream().use { input.copyTo(it) } }
                tmp.renameTo(dest)
            } catch (e: Exception) {
                false
            }
        }
    }

    private fun ids(text: String) = listOf(49406) + tokenizer.tokenize(text) + listOf(49407)

    @Test
    fun simplePrompt() {
        assertEquals(listOf(49406, 320, 1125, 539, 320, 2368, 49407), ids("a photo of a cat"))
    }

    @Test
    fun punctuationAndCase() {
        assertEquals(
            listOf(49406, 320, 36896, 2012, 536, 930, 267, 13919, 3073, 256, 49407),
            ids("A cyberpunk street at night, neon lights!"),
        )
        assertEquals(
            listOf(49406, 5352, 539, 550, 896, 14295, 282, 5302, 268, 12609, 267, 279, 330, 267, 6087, 525, 1486, 2631, 49407),
            ids("Portrait of an old wizard; highly-detailed, 8k, trending on ArtStation"),
        )
    }

    @Test
    fun contractionsDigitsAndWhitespace() {
        assertEquals(listOf(49406, 847, 713, 1691, 614, 692, 272, 273, 274, 275, 49407), ids("don't STOP me now 1234"))
        assertEquals(listOf(49406, 6470, 9006, 537, 1218, 3418, 49407), ids("  multiple   spaces\tand\nnewlines  "))
    }

    @Test
    fun unicodeBytes() {
        assertEquals(
            listOf(49406, 15304, 1075, 12138, 614, 711, 127, 119, 75, 13489, 30051, 261, 283, 18231, 285, 49407),
            ids("café crème brûlée 🍰 & <html>"),
        )
    }

    @Test
    fun encodePadsAndTruncates() {
        val e = tokenizer.encode("a photo of a cat")
        assertEquals(77, e.size)
        assertArrayEquals(intArrayOf(49406, 320, 1125, 539, 320, 2368, 49407), e.copyOfRange(0, 7))
        for (i in 7 until 77) assertEquals(49407, e[i]) // SD 1.x pads with <|endoftext|>

        val sd2 = ClipTokenizer.load(vocab, merges, padToken = "!")
        val e2 = sd2.encode("a photo of a cat")
        assertEquals(49407, e2[6])
        for (i in 7 until 77) assertEquals(0, e2[i]) // SD 2.x (OpenCLIP) pads with "!" = 0

        val long = tokenizer.encode((1..200).joinToString(" ") { "cat" })
        assertEquals(77, long.size)
        assertEquals(49406, long[0])
        assertEquals(2368, long[75])
        assertEquals(49407, long[76])
    }
}
