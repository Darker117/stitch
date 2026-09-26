package com.stitch.mobile.device.text

import com.stitch.mobile.device.ModelStore
import org.junit.Assert.assertEquals
import org.junit.Test

class TagRewriterTest {
    private fun stream(map: Map<String, String>, vararg chunks: String): String {
        val r = TagRewriter(map)
        val sb = StringBuilder()
        for (c in chunks) sb.append(r.feed(c))
        sb.append(r.flush())
        return sb.toString()
    }

    @Test
    fun passesThroughWithoutTags() {
        assertEquals("plain text", stream(emptyMap(), "plain", " text"))
    }

    @Test
    fun rewritesTagsSplitAcrossChunks() {
        val map = mapOf("<|channel>thought" to "<think>", "<channel|>" to "</think>")
        assertEquals("<think>hmm</think>Answer", stream(map, "<|chan", "nel>thou", "ght", "hmm<chan", "nel|>Answer"))
    }

    @Test
    fun releasesPartialPrefixThatNeverCompletes() {
        assertEquals("a [TH b", stream(mapOf("[THINK]" to "<think>"), "a [TH", " b"))
        assertEquals("tail [TH", stream(mapOf("[THINK]" to "<think>"), "tail [TH"))
    }

    @Test
    fun prefersLongestTag() {
        val map = mapOf("[THINK]" to "<think>", "[/THINK]" to "</think>")
        assertEquals("<think>x</think>y", stream(map, "[THINK]x[/THI", "NK]y"))
    }
}

class SafeNameTest {
    @Test
    fun keepsOrdinaryNames() {
        assertEquals("Qwen3-0.6B-Q4_0.gguf", ModelStore.safeName("Qwen3-0.6B-Q4_0.gguf"))
    }

    @Test
    fun stripsDirectoriesAndOddCharacters() {
        assertEquals("evil.gguf", ModelStore.safeName("../../evil.gguf"))
        assertEquals("a_b.safetensors", ModelStore.safeName("dir\\a:b.safetensors"))
        assertEquals("model.bin", ModelStore.safeName("..."))
    }
}
