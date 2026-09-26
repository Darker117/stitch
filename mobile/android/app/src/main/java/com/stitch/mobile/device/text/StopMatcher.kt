package com.stitch.mobile.device.text

/**
 * Streams text while watching for stop sequences. Text that could still turn into a stop sequence is held back
 * until it can't, so a stop string never leaks into the emitted deltas. Pure JVM (unit tested).
 */
class StopMatcher(stops: List<String>) {
    private val stops = stops.filter { it.isNotEmpty() }
    private val buffer = StringBuilder()
    private var emitted = 0

    /** True once a stop sequence has been seen; later input is ignored. */
    var stopped = false
        private set

    /** The stop sequence that ended the text, if any. */
    var matched: String? = null
        private set

    /** The text so far, trimmed at the stop sequence. */
    val text: String get() = buffer.toString()

    /** Feed a new delta; returns the part that is safe to show now (possibly empty). */
    fun feed(delta: String): String {
        if (stopped || delta.isEmpty()) return ""
        buffer.append(delta)
        if (stops.isEmpty()) return drain(buffer.length)

        val maxLen = stops.maxOf { it.length }
        val searchFrom = maxOf(0, emitted - maxLen)
        var cut = -1
        var which: String? = null
        for (s in stops) {
            val i = buffer.indexOf(s, searchFrom)
            if (i >= 0 && (cut < 0 || i < cut)) {
                cut = i; which = s
            }
        }
        if (cut >= 0) {
            stopped = true
            matched = which
            val end = maxOf(cut, emitted)
            val out = if (end > emitted) buffer.substring(emitted, end) else ""
            buffer.setLength(maxOf(cut, 0))
            emitted = buffer.length
            return out
        }

        // Hold back the longest tail that is a proper prefix of some stop sequence.
        var hold = 0
        for (s in stops) {
            val limit = minOf(s.length - 1, buffer.length - emitted)
            for (k in limit downTo 1) {
                if (k <= hold) break
                if (buffer.matchesAt(buffer.length - k, s, 0, k)) {
                    hold = k; break
                }
            }
        }
        return drain(buffer.length - hold)
    }

    /** Generation ended without a stop sequence: release anything held back. */
    fun flush(): String = if (stopped) "" else drain(buffer.length)

    private fun drain(end: Int): String {
        if (end <= emitted) return ""
        val out = buffer.substring(emitted, end)
        emitted = end
        return out
    }

    private fun StringBuilder.matchesAt(start: Int, other: String, otherStart: Int, len: Int): Boolean {
        if (start < 0 || start + len > length) return false
        for (i in 0 until len) if (this[start + i] != other[otherStart + i]) return false
        return true
    }
}
