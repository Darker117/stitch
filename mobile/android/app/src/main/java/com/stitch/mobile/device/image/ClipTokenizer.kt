package com.stitch.mobile.device.image

import org.json.JSONObject
import java.io.File

/**
 * CLIP byte-level BPE tokenizer (the one Stable Diffusion's text encoders use), reading the Hugging Face
 * `tokenizer/vocab.json` + `tokenizer/merges.txt`. Matches `transformers.CLIPTokenizer` without ftfy: HTML
 * unescape, whitespace collapse, lower-case, the CLIP regex, byte→unicode mapping and BPE with `</w>` word ends.
 * Output is always [maxLength] ids: BOS, up to maxLength-2 tokens, EOS, then padding. Pure JVM (unit tested).
 */
class ClipTokenizer(
    private val encoder: Map<String, Int>,
    merges: List<Pair<String, String>>,
    padToken: String? = null,
    val maxLength: Int = 77,
    padTokenId: Int? = null,
) {
    private val bpeRanks: Map<Pair<String, String>, Int> = merges.withIndex().associate { it.value to it.index }
    private val byteEncoder: Array<String> = bytesToUnicode()
    private val cache = HashMap<String, List<String>>()

    val bosId: Int = encoder[BOS] ?: 49406
    val eosId: Int = encoder[EOS] ?: 49407
    /** SD 1.x pads with <|endoftext|>; SD 2.x (OpenCLIP) uses "!" (id 0). */
    val padId: Int = padTokenId ?: padToken?.let { encoder[it] } ?: eosId

    /** Token ids of [text] without BOS/EOS/padding. */
    fun tokenize(text: String): List<Int> {
        val cleaned = clean(text)
        val ids = ArrayList<Int>()
        for (m in PATTERN.findAll(cleaned)) {
            val piece = m.value
            val special = encoder[piece]
            if ((piece == BOS || piece == EOS) && special != null) {
                ids += special; continue
            }
            val bytes = piece.toByteArray(Charsets.UTF_8)
            val mapped = buildString { for (b in bytes) append(byteEncoder[b.toInt() and 0xff]) }
            for (tok in bpe(mapped)) {
                ids += encoder[tok] ?: continue
            }
        }
        return ids
    }

    /** [maxLength] ids: BOS + tokens (truncated) + EOS + padding. */
    fun encode(text: String): IntArray {
        val body = tokenize(text).take(maxLength - 2)
        val out = IntArray(maxLength) { padId }
        out[0] = bosId
        body.forEachIndexed { i, id -> out[i + 1] = id }
        out[body.size + 1] = eosId
        return out
    }

    private fun bpe(token: String): List<String> {
        cache[token]?.let { return it }
        if (token.isEmpty()) return emptyList()
        // Split into unicode code points; the last one carries the end-of-word marker.
        val chars = ArrayList<String>()
        var i = 0
        while (i < token.length) {
            val cp = token.codePointAt(i)
            chars += String(Character.toChars(cp))
            i += Character.charCount(cp)
        }
        chars[chars.size - 1] = chars.last() + "</w>"
        var word: MutableList<String> = chars
        if (word.size == 1) {
            cache[token] = word
            return word
        }
        while (true) {
            var best: Pair<String, String>? = null
            var bestRank = Int.MAX_VALUE
            for (j in 0 until word.size - 1) {
                val pair = word[j] to word[j + 1]
                val rank = bpeRanks[pair] ?: continue
                if (rank < bestRank) {
                    bestRank = rank; best = pair
                }
            }
            if (best == null) break
            val merged = ArrayList<String>(word.size)
            var j = 0
            while (j < word.size) {
                if (j < word.size - 1 && word[j] == best.first && word[j + 1] == best.second) {
                    merged += best.first + best.second
                    j += 2
                } else {
                    merged += word[j]
                    j += 1
                }
            }
            word = merged
            if (word.size == 1) break
        }
        cache[token] = word
        return word
    }

    companion object {
        const val BOS = "<|startoftext|>"
        const val EOS = "<|endoftext|>"

        private val PATTERN = Regex(
            "<\\|startoftext\\|>|<\\|endoftext\\|>|'s|'t|'re|'ve|'m|'ll|'d|[\\p{L}]+|[\\p{N}]|[^\\s\\p{L}\\p{N}]+",
            RegexOption.IGNORE_CASE,
        )
        private val WHITESPACE = Regex("\\s+")

        fun load(vocabFile: File, mergesFile: File, padToken: String? = null, maxLength: Int = 77, padTokenId: Int? = null): ClipTokenizer {
            val json = JSONObject(vocabFile.readText(Charsets.UTF_8))
            val encoder = HashMap<String, Int>(json.length() * 2)
            val keys = json.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                encoder[k] = json.getInt(k)
            }
            return ClipTokenizer(encoder, parseMerges(mergesFile.readLines(Charsets.UTF_8)), padToken, maxLength, padTokenId)
        }

        /** merges.txt: optional "#version" header, then "a b" per line. CLIP uses the first 48894 merges. */
        fun parseMerges(lines: List<String>): List<Pair<String, String>> {
            val out = ArrayList<Pair<String, String>>(lines.size)
            for (line in lines) {
                if (line.startsWith("#version") || line.isBlank()) continue
                val sp = line.indexOf(' ')
                if (sp <= 0) continue
                out += line.substring(0, sp) to line.substring(sp + 1).trimEnd()
            }
            return if (out.size > CLIP_MERGES) out.subList(0, CLIP_MERGES) else out
        }

        private const val CLIP_MERGES = 49152 - 256 - 2

        fun clean(text: String): String {
            var t = text
            repeat(2) { t = htmlUnescape(t) }
            return WHITESPACE.replace(t, " ").trim().lowercase()
        }

        private fun htmlUnescape(s: String): String {
            if (!s.contains('&')) return s
            return s.replace("&quot;", "\"").replace("&#39;", "'").replace("&#x27;", "'")
                .replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ").replace("&amp;", "&")
        }

        /** GPT-2/CLIP reversible byte → printable unicode mapping. */
        fun bytesToUnicode(): Array<String> {
            val bs = ArrayList<Int>()
            bs.addAll('!'.code..'~'.code)
            bs.addAll('¡'.code..'¬'.code)
            bs.addAll('®'.code..'ÿ'.code)
            val cs = ArrayList<Int>(bs)
            var n = 0
            for (b in 0 until 256) {
                if (b !in bs) {
                    bs += b
                    cs += 256 + n
                    n++
                }
            }
            val out = Array(256) { "" }
            for (i in bs.indices) out[bs[i]] = String(Character.toChars(cs[i]))
            return out
        }
    }
}
