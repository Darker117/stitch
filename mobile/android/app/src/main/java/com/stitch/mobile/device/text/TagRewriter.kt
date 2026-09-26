package com.stitch.mobile.device.text

/**
 * Streaming find-and-replace for a few fixed tags (a model's own reasoning markers → `<think>` / `</think>`, which is
 * what the app's thinking splitter understands). Text that could still become a tag is held back until it can't.
 * Pure JVM (unit tested).
 */
class TagRewriter(replacements: Map<String, String>) {
    private val tags = replacements.filterKeys { it.isNotEmpty() }.entries.sortedByDescending { it.key.length }
    private val buffer = StringBuilder()

    /** Feed a chunk; returns the rewritten text that is safe to emit now. */
    fun feed(chunk: String): String {
        if (tags.isEmpty()) return chunk
        buffer.append(chunk)
        val out = StringBuilder()
        var i = 0
        while (i < buffer.length) {
            val hit = tags.firstOrNull { buffer.startsWith(it.key, i) }
            if (hit != null) {
                out.append(hit.value)
                i += hit.key.length
                continue
            }
            // Could a tag start here but not be complete yet? Keep the rest for the next chunk.
            val rest = buffer.length - i
            if (tags.any { it.key.length > rest && it.key.regionMatches(0, buffer, i, rest) }) break
            out.append(buffer[i])
            i++
        }
        buffer.delete(0, i)
        return out.toString()
    }

    /** End of stream: release anything held back. */
    fun flush(): String = buffer.toString().also { buffer.setLength(0) }

    private fun StringBuilder.startsWith(prefix: String, at: Int): Boolean =
        at + prefix.length <= length && prefix.regionMatches(0, this, at, prefix.length)

    private fun String.regionMatches(from: Int, other: CharSequence, otherFrom: Int, len: Int): Boolean {
        for (k in 0 until len) if (this[from + k] != other[otherFrom + k]) return false
        return true
    }
}
