package com.stitch.mobile.device.image

/** IEEE-754 half ⇄ float conversion (round-to-nearest-even), pure JVM. */
object Fp16 {
    fun toHalf(f: Float): Short {
        val bits = java.lang.Float.floatToRawIntBits(f)
        val sign = (bits ushr 16) and 0x8000
        var value = bits and 0x7fffffff
        if (value >= 0x7f800000) { // Inf / NaN
            return (sign or 0x7c00 or (if (value > 0x7f800000) 0x200 or ((value ushr 13) and 0x3ff) else 0)).toShort()
        }
        if (value >= 0x477ff000) return (sign or 0x7c00).toShort() // overflow → Inf
        if (value < 0x38800000) { // subnormal half or zero
            if (value < 0x33000000) return sign.toShort()
            val shift = 126 - (value ushr 23)
            value = (value and 0x7fffff) or 0x800000
            val mant = value ushr shift
            val rem = value and ((1 shl shift) - 1)
            val halfway = 1 shl (shift - 1)
            val rounded = if (rem > halfway || (rem == halfway && (mant and 1) == 1)) mant + 1 else mant
            return (sign or rounded).toShort()
        }
        val exp = ((value ushr 23) - 112) shl 10
        val mant = (value ushr 13) and 0x3ff
        val rem = value and 0x1fff
        var half = exp or mant
        if (rem > 0x1000 || (rem == 0x1000 && (half and 1) == 1)) half++
        return (sign or half).toShort()
    }

    fun toFloat(h: Short): Float {
        val bits = h.toInt() and 0xffff
        val sign = (bits and 0x8000) shl 16
        val exp = (bits ushr 10) and 0x1f
        val mant = bits and 0x3ff
        val out = when (exp) {
            0 -> {
                if (mant == 0) sign
                else {
                    // subnormal: normalise
                    var m = mant
                    var e = -1
                    while (m and 0x400 == 0) { m = m shl 1; e++ }
                    m = m and 0x3ff
                    sign or ((127 - 15 - e) shl 23) or (m shl 13)
                }
            }
            0x1f -> sign or 0x7f800000 or (mant shl 13)
            else -> sign or ((exp + 112) shl 23) or (mant shl 13)
        }
        return java.lang.Float.intBitsToFloat(out)
    }

    fun toHalf(src: FloatArray): ShortArray = ShortArray(src.size) { toHalf(src[it]) }
    fun toFloat(src: ShortArray): FloatArray = FloatArray(src.size) { toFloat(src[it]) }
}
