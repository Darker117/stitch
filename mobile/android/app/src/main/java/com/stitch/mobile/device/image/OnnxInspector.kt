package com.stitch.mobile.device.image

import java.io.Closeable
import java.io.EOFException
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

/** One graph input/output: name, ONNX element type and dims (a fixed value or a symbolic name). */
data class OnnxValueInfo(val name: String, val elemType: Int, val dims: List<OnnxDim>) {
    val rank get() = dims.size
}

data class OnnxDim(val value: Long?, val param: String?)

data class OnnxGraphInfo(val inputs: List<OnnxValueInfo>, val outputs: List<OnnxValueInfo>, val initializerNames: Set<String>)

/**
 * Reads the graph inputs/outputs of an .onnx file without loading its weights (initializers and nodes are skipped
 * by seeking), so the free dimensions can be pinned before a session is created — QNN needs static shapes.
 */
object OnnxInspector {
    const val FLOAT = 1
    const val UINT8 = 2
    const val INT8 = 3
    const val INT32 = 6
    const val INT64 = 7
    const val FLOAT16 = 10
    const val DOUBLE = 11
    const val BFLOAT16 = 16

    fun inspect(file: File): OnnxGraphInfo = Reader(RandomAccessFile(file, "r")).use { r -> readModel(r) }

    fun inspect(bytes: ByteArray): OnnxGraphInfo {
        val tmp = File.createTempFile("onnx", ".onnx")
        try {
            tmp.writeBytes(bytes)
            return inspect(tmp)
        } finally {
            tmp.delete()
        }
    }

    private fun readModel(r: Reader): OnnxGraphInfo {
        val end = r.length
        while (r.position < end) {
            val tag = r.varint()
            val field = (tag ushr 3).toInt()
            val wire = (tag and 7).toInt()
            if (field == 7 && wire == 2) {
                val len = r.varint()
                return readGraph(r, r.position + len)
            }
            r.skip(wire)
        }
        throw IOException("No graph in ONNX model")
    }

    private fun readGraph(r: Reader, end: Long): OnnxGraphInfo {
        val inputs = ArrayList<OnnxValueInfo>()
        val outputs = ArrayList<OnnxValueInfo>()
        val initializers = HashSet<String>()
        while (r.position < end) {
            val tag = r.varint()
            val field = (tag ushr 3).toInt()
            val wire = (tag and 7).toInt()
            when {
                (field == 11 || field == 12) && wire == 2 -> {
                    val len = r.varint()
                    val info = readValueInfo(r, r.position + len)
                    if (field == 11) inputs += info else outputs += info
                }
                field == 5 && wire == 2 -> {
                    // TensorProto: name is field 8; skip the rest.
                    val len = r.varint()
                    val tEnd = r.position + len
                    while (r.position < tEnd) {
                        val t = r.varint()
                        val f = (t ushr 3).toInt()
                        val w = (t and 7).toInt()
                        if (f == 8 && w == 2) initializers += r.string() else r.skip(w)
                    }
                    r.seek(tEnd)
                }
                else -> r.skip(wire)
            }
        }
        r.seek(end)
        // Graph inputs that have initializers are weights, not real inputs (older exporters list them).
        return OnnxGraphInfo(inputs.filter { it.name !in initializers }, outputs, initializers)
    }

    private fun readValueInfo(r: Reader, end: Long): OnnxValueInfo {
        var name = ""
        var elem = 0
        var dims: List<OnnxDim> = emptyList()
        while (r.position < end) {
            val tag = r.varint()
            val field = (tag ushr 3).toInt()
            val wire = (tag and 7).toInt()
            when {
                field == 1 && wire == 2 -> name = r.string()
                field == 2 && wire == 2 -> {
                    val len = r.varint()
                    val tEnd = r.position + len
                    while (r.position < tEnd) {
                        val t = r.varint()
                        val f = (t ushr 3).toInt()
                        val w = (t and 7).toInt()
                        if (f == 1 && w == 2) { // tensor_type
                            val l = r.varint()
                            val ttEnd = r.position + l
                            while (r.position < ttEnd) {
                                val t2 = r.varint()
                                val f2 = (t2 ushr 3).toInt()
                                val w2 = (t2 and 7).toInt()
                                when {
                                    f2 == 1 && w2 == 0 -> elem = r.varint().toInt()
                                    f2 == 2 && w2 == 2 -> {
                                        val sl = r.varint()
                                        dims = readShape(r, r.position + sl)
                                    }
                                    else -> r.skip(w2)
                                }
                            }
                        } else r.skip(w)
                    }
                    r.seek(tEnd)
                }
                else -> r.skip(wire)
            }
        }
        r.seek(end)
        return OnnxValueInfo(name, elem, dims)
    }

    private fun readShape(r: Reader, end: Long): List<OnnxDim> {
        val dims = ArrayList<OnnxDim>()
        while (r.position < end) {
            val tag = r.varint()
            val field = (tag ushr 3).toInt()
            val wire = (tag and 7).toInt()
            if (field == 1 && wire == 2) {
                val len = r.varint()
                val dEnd = r.position + len
                var value: Long? = null
                var param: String? = null
                while (r.position < dEnd) {
                    val t = r.varint()
                    val f = (t ushr 3).toInt()
                    val w = (t and 7).toInt()
                    when {
                        f == 1 && w == 0 -> value = r.varint()
                        f == 2 && w == 2 -> param = r.string()
                        else -> r.skip(w)
                    }
                }
                r.seek(dEnd)
                dims += OnnxDim(value, param)
            } else r.skip(wire)
        }
        r.seek(end)
        return dims
    }

    /** Buffered, seekable protobuf reader over a RandomAccessFile. */
    private class Reader(private val raf: RandomAccessFile) : Closeable {
        val length: Long = raf.length()
        private val buf = ByteArray(64 * 1024)
        private var bufStart = 0L
        private var bufLen = 0
        var position = 0L
            private set

        fun seek(pos: Long) {
            position = pos
        }

        private fun byte(): Int {
            if (position >= length) throw EOFException()
            if (position < bufStart || position >= bufStart + bufLen) {
                raf.seek(position)
                bufStart = position
                bufLen = maxOf(0, raf.read(buf, 0, buf.size))
                if (bufLen == 0) throw EOFException()
            }
            val b = buf[(position - bufStart).toInt()].toInt() and 0xff
            position++
            return b
        }

        fun varint(): Long {
            var result = 0L
            var shift = 0
            while (shift < 64) {
                val b = byte()
                result = result or ((b and 0x7f).toLong() shl shift)
                if (b and 0x80 == 0) return result
                shift += 7
            }
            throw IOException("Malformed varint")
        }

        fun string(): String {
            val len = varint().toInt()
            val bytes = ByteArray(len)
            for (i in 0 until len) bytes[i] = byte().toByte()
            return String(bytes, Charsets.UTF_8)
        }

        fun skip(wire: Int) {
            when (wire) {
                0 -> varint()
                1 -> position += 8
                2 -> { val len = varint(); position += len }
                5 -> position += 4
                else -> throw IOException("Unsupported protobuf wire type $wire")
            }
        }

        override fun close() = raf.close()
    }
}
