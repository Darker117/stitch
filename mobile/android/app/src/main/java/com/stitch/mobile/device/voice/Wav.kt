package com.stitch.mobile.device.voice

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt

/** 16-bit PCM mono/stereo WAV read/write. Pure JVM (unit tested). */
object Wav {
    data class Pcm(val samples: ShortArray, val sampleRate: Int, val channels: Int) {
        val durationSeconds: Double get() = samples.size.toDouble() / channels / sampleRate
    }

    fun floatToPcm16(samples: FloatArray): ShortArray = ShortArray(samples.size) {
        (samples[it].coerceIn(-1f, 1f) * 32767f).roundToInt().toShort()
    }

    fun write(file: File, samples: ShortArray, sampleRate: Int, channels: Int = 1) {
        val dataBytes = samples.size * 2
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray(Charsets.US_ASCII)); putInt(36 + dataBytes)
            put("WAVE".toByteArray(Charsets.US_ASCII))
            put("fmt ".toByteArray(Charsets.US_ASCII)); putInt(16)
            putShort(1) // PCM
            putShort(channels.toShort())
            putInt(sampleRate)
            putInt(sampleRate * channels * 2)
            putShort((channels * 2).toShort())
            putShort(16)
            put("data".toByteArray(Charsets.US_ASCII)); putInt(dataBytes)
        }
        FileOutputStream(file).use { out ->
            out.write(header.array())
            val body = ByteBuffer.allocate(dataBytes).order(ByteOrder.LITTLE_ENDIAN)
            body.asShortBuffer().put(samples)
            out.write(body.array())
        }
    }

    /**
     * Read a WAV and return 16-bit PCM, converting 8-bit / 24-bit / 32-bit int and 32-bit float PCM (some TTS
     * engines write those). Tolerates bogus RIFF/data sizes (streamed files) by reading to EOF.
     */
    fun read(file: File): Pcm {
        val bytes = file.readBytes()
        val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        if (bytes.size < 12 || String(bytes, 0, 4, Charsets.US_ASCII) != "RIFF" || String(bytes, 8, 4, Charsets.US_ASCII) != "WAVE") {
            throw IOException("Not a WAV file")
        }
        var pos = 12
        var format = 1
        var channels = 1
        var rate = 0
        var bits = 16
        var dataStart = -1
        var dataLen = 0
        while (pos + 8 <= bytes.size) {
            val id = String(bytes, pos, 4, Charsets.US_ASCII)
            val len = bb.getInt(pos + 4)
            val body = pos + 8
            if (id == "fmt ") {
                format = bb.getShort(body).toInt() and 0xffff
                channels = bb.getShort(body + 2).toInt()
                rate = bb.getInt(body + 4)
                bits = bb.getShort(body + 14).toInt()
                if (format == 0xFFFE && len >= 26) format = bb.getShort(body + 24).toInt() and 0xffff // extensible
            } else if (id == "data") {
                dataStart = body
                dataLen = if (len <= 0 || body + len > bytes.size) bytes.size - body else len
                break
            }
            if (len < 0) break
            pos = body + len + (len and 1)
        }
        if (dataStart < 0 || rate <= 0) throw IOException("WAV has no audio data")
        val bytesPer = bits / 8
        val n = dataLen / bytesPer
        val out = ShortArray(n)
        for (i in 0 until n) {
            val o = dataStart + i * bytesPer
            out[i] = when {
                format == 3 && bits == 32 -> (bb.getFloat(o).coerceIn(-1f, 1f) * 32767f).roundToInt().toShort()
                bits == 16 -> bb.getShort(o)
                bits == 8 -> (((bytes[o].toInt() and 0xff) - 128) shl 8).toShort()
                bits == 24 -> ((bytes[o + 1].toInt() and 0xff) or (bytes[o + 2].toInt() shl 8)).toShort()
                bits == 32 -> (bb.getInt(o) shr 16).toShort()
                else -> throw IOException("Unsupported WAV sample format ($bits-bit, format $format)")
            }
        }
        return Pcm(out, rate, channels)
    }

    /** Duration of a 16-bit PCM WAV from its header, or null. */
    fun duration(file: File): Double? = try {
        val p = read(file)
        p.durationSeconds
    } catch (_: Exception) {
        null
    }
}
