package com.stitch.mobile.device

import com.stitch.mobile.device.image.Fp16
import com.stitch.mobile.device.image.OnnxInspector
import com.stitch.mobile.device.image.StaticDims
import com.stitch.mobile.device.text.ChatTurn
import com.stitch.mobile.device.text.StopMatcher
import com.stitch.mobile.device.text.TextEngine
import com.stitch.mobile.device.voice.SystemTts
import com.stitch.mobile.device.voice.Wav
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File

class StopMatcherTest {
    private fun stream(stops: List<String>, vararg deltas: String): Pair<String, StopMatcher> {
        val m = StopMatcher(stops)
        val sb = StringBuilder()
        for (d in deltas) sb.append(m.feed(d))
        sb.append(m.flush())
        return sb.toString() to m
    }

    @Test
    fun passesThroughWithoutStops() {
        val (out, m) = stream(emptyList(), "Hel", "lo", " world")
        assertEquals("Hello world", out)
        assertFalse(m.stopped)
    }

    @Test
    fun trimsAtStopSplitAcrossDeltas() {
        val (out, m) = stream(listOf("\nUser:"), "The end.", "\nUs", "er: next", " ignored")
        assertEquals("The end.", out)
        assertTrue(m.stopped)
        assertEquals("\nUser:", m.matched)
        assertEquals("The end.", m.text)
    }

    @Test
    fun releasesFalseStartsOfStops() {
        val (out, m) = stream(listOf("###"), "a #", "# b", " c")
        assertEquals("a ## b c", out)
        assertFalse(m.stopped)
    }

    @Test
    fun earliestOfSeveralStops() {
        val (out, _) = stream(listOf("END", "<|im_end|>"), "x <|im_", "end|> y END")
        assertEquals("x ", out)
    }

    @Test
    fun neverEmitsHeldPrefix() {
        val m = StopMatcher(listOf("</s>"))
        assertEquals("abc", m.feed("abc</"))
        assertEquals("", m.feed("s>tail"))
        assertTrue(m.stopped)
    }
}

class Fp16Test {
    @Test
    fun knownValues() {
        assertEquals(0x3C00, Fp16.toHalf(1f).toInt() and 0xffff)
        assertEquals(0xC000, Fp16.toHalf(-2f).toInt() and 0xffff)
        assertEquals(0x7BFF, Fp16.toHalf(65504f).toInt() and 0xffff)
        assertEquals(0x7C00, Fp16.toHalf(1e6f).toInt() and 0xffff)
        assertEquals(0x2E66, Fp16.toHalf(0.1f).toInt() and 0xffff)
        assertEquals(0x0001, Fp16.toHalf(5.9604645e-8f).toInt() and 0xffff) // 2^-24, smallest subnormal
        assertEquals(0x0400, Fp16.toHalf(6.1035156e-5f).toInt() and 0xffff) // 2^-14, smallest normal
        assertEquals(0x0000, Fp16.toHalf(1e-9f).toInt() and 0xffff)
        assertEquals(1f, Fp16.toFloat(0x3C00.toShort()), 0f)
        assertEquals(5.9604645e-8f, Fp16.toFloat(0x0001.toShort()), 0f)
        assertEquals(65504f, Fp16.toFloat(0x7BFF.toShort()), 0f)
        assertTrue(Fp16.toFloat(0x7E00.toShort()).isNaN())
    }

    @Test
    fun roundTripIsWithinHalfPrecision() {
        val r = java.util.Random(7)
        repeat(10_000) {
            val f = (r.nextGaussian() * 10).toFloat()
            val back = Fp16.toFloat(Fp16.toHalf(f))
            assertTrue("$f → $back", kotlin.math.abs(back - f) <= kotlin.math.abs(f) * 1e-3f + 1e-7f)
        }
    }
}

class WavTest {
    @Test
    fun writeReadRoundTrip() {
        val f = File.createTempFile("stitch", ".wav")
        try {
            val pcm = Wav.floatToPcm16(floatArrayOf(0f, 0.5f, -0.5f, 1f, -1f, 2f))
            assertArrayEquals(shortArrayOf(0, 16384, -16383, 32767, -32767, 32767), pcm)
            Wav.write(f, pcm, 24000)
            assertEquals(44L + pcm.size * 2, f.length())
            val back = Wav.read(f)
            assertEquals(24000, back.sampleRate)
            assertEquals(1, back.channels)
            assertArrayEquals(pcm, back.samples)
            assertEquals(6.0 / 24000, back.durationSeconds, 1e-12)
        } finally {
            f.delete()
        }
    }

    @Test
    fun chunksLongTextAtSentences() {
        val text = (1..50).joinToString(" ") { "Sentence number $it is here." }
        val chunks = SystemTts.chunk(text, 200)
        assertTrue(chunks.all { it.length <= 201 })
        assertEquals(text.replace(" ", ""), chunks.joinToString("").replace(" ", ""))
    }
}

class OnnxInspectorTest {
    // Minimal protobuf writer for a ModelProto with graph inputs/outputs.
    private fun varint(out: ByteArrayOutputStream, v: Long) {
        var x = v
        while (true) {
            if (x and 0x7fL.inv() == 0L) { out.write(x.toInt()); return }
            out.write(((x and 0x7f) or 0x80).toInt()); x = x ushr 7
        }
    }
    private fun tag(out: ByteArrayOutputStream, field: Int, wire: Int) = varint(out, ((field shl 3) or wire).toLong())
    private fun bytes(out: ByteArrayOutputStream, field: Int, b: ByteArray) { tag(out, field, 2); varint(out, b.size.toLong()); out.write(b) }
    private fun msg(block: ByteArrayOutputStream.() -> Unit) = ByteArrayOutputStream().apply(block).toByteArray()

    private fun valueInfo(name: String, elem: Int, dims: List<Any>) = msg {
        bytes(this, 1, name.toByteArray())
        bytes(this, 2, msg { // TypeProto
            bytes(this, 1, msg { // Tensor
                tag(this, 1, 0); varint(this, elem.toLong())
                bytes(this, 2, msg { // Shape
                    for (d in dims) bytes(this, 1, msg {
                        if (d is Long) { tag(this, 1, 0); varint(this, d) } else bytes(this, 2, (d as String).toByteArray())
                    })
                })
            })
        })
    }

    @Test
    fun readsInputsSkippingNodesAndWeights() {
        val graph = msg {
            bytes(this, 1, ByteArray(300) { 1 }) // a node blob (skipped)
            bytes(this, 5, msg { bytes(this, 8, "w".toByteArray()); bytes(this, 9, ByteArray(5000)) }) // initializer
            bytes(this, 11, valueInfo("sample", OnnxInspector.FLOAT16, listOf("unet_batch", 4L, "unet_h", "unet_w")))
            bytes(this, 11, valueInfo("timestep", OnnxInspector.INT64, listOf("unet_batch")))
            bytes(this, 11, valueInfo("encoder_hidden_states", OnnxInspector.FLOAT16, listOf("unet_batch", "seq", 768L)))
            bytes(this, 11, valueInfo("w", OnnxInspector.FLOAT, listOf(3L))) // weight listed as input (old exporters)
            bytes(this, 12, valueInfo("out_sample", OnnxInspector.FLOAT16, listOf("unet_batch", 4L, "unet_h", "unet_w")))
        }
        val model = msg {
            tag(this, 1, 0); varint(this, 8) // ir_version
            bytes(this, 2, "test".toByteArray())
            bytes(this, 7, graph)
        }
        val info = OnnxInspector.inspect(model)
        assertEquals(listOf("sample", "timestep", "encoder_hidden_states"), info.inputs.map { it.name })
        assertEquals(OnnxInspector.FLOAT16, info.inputs[0].elemType)
        assertEquals("unet_h", info.inputs[0].dims[2].param)
        assertEquals(4L, info.inputs[0].dims[1].value)
        assertEquals(1, info.outputs.size)

        val dims = StaticDims.unet(info, 4, 64, 48, 77, 768)
        assertEquals(mapOf("unet_batch" to 1L, "unet_h" to 64L, "unet_w" to 48L, "seq" to 77L), dims)
    }
}

class SocTableTest {
    @Test
    fun snapdragonFromSocModel() {
        val s = SocTable.resolve("SM8650", "QTI", "pineapple", "qcom", null)
        assertTrue(s.qualcomm)
        assertEquals("SM8650", s.model)
        assertEquals("Snapdragon 8 Gen 3", s.name)
        assertEquals("v75", s.htpArch)
        assertEquals(75, s.htpVersion)
    }

    @Test
    fun snapdragonFromBoardCodenameOnOldAndroid() {
        val s = SocTable.resolve(null, null, "kalama", "qcom", null)
        assertEquals("SM8550", s.model)
        assertEquals("v73", s.htpArch)
    }

    @Test
    fun snapdragonFromCpuinfo() {
        val s = SocTable.resolve(null, null, "msm", "qcom", "Qualcomm Technologies, Inc SM8750")
        assertEquals("Snapdragon 8 Elite", s.name)
        assertEquals("v79", s.htpArch)
    }

    @Test
    fun googleTensor() {
        val s = SocTable.resolve("Tensor G3", "Google", "akita", "akita", null)
        assertFalse(s.qualcomm)
        assertTrue(s.googleTensor)
        assertEquals("Google Tensor G3", s.name)
        assertNull(s.htpArch)
    }

    @Test
    fun gpuName() {
        assertEquals("Adreno 750", SocTable.friendlyGpu("Adreno (TM) 750"))
        assertEquals("Mali-G715", SocTable.friendlyGpu("Mali-G715"))
    }
}

class ConversationTest {
    @Test
    fun splitsSystemHistoryAndPrompt() {
        val (system, history, prompt) = TextEngine.buildConversation(
            "Be brief.",
            listOf(
                ChatTurn("system", "Stay in character."),
                ChatTurn("user", "Hi"),
                ChatTurn("assistant", "Hello!"),
                ChatTurn("user", "Tell me"),
                ChatTurn("user", "a story"),
            ),
        )
        assertEquals("Be brief.\n\nStay in character.", system)
        assertEquals(2, history.size)
        assertEquals("Hi", history[0].toString())
        assertEquals("Hello!", history[1].toString())
        assertEquals("Tell me\n\na story", prompt.toString())
    }

    @Test
    fun continuesWhenLastTurnIsAssistant() {
        val (system, history, prompt) = TextEngine.buildConversation(null, listOf(ChatTurn("assistant", "Once upon a time")))
        assertNull(system)
        assertEquals(listOf("Begin.", "Once upon a time"), history.map { it.toString() })
        assertEquals("Continue.", prompt.toString())
    }
}
