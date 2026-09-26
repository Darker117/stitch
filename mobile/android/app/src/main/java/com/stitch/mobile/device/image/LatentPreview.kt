package com.stitch.mobile.device.image

/**
 * Cheap latent → RGB approximation for step previews: a per-pixel linear map of the 4 SD latent channels
 * (SD 1.x / 2.x VAE factors, as used by ComfyUI's previewer). Returns ARGB pixels of the latent's size.
 */
object LatentPreview {
    // rows = latent channel, cols = R, G, B
    private val FACTORS = arrayOf(
        floatArrayOf(0.3512f, 0.2297f, 0.3227f),
        floatArrayOf(0.3250f, 0.4974f, 0.2350f),
        floatArrayOf(-0.2829f, 0.1762f, 0.2721f),
        floatArrayOf(-0.2120f, -0.2616f, -0.7177f),
    )

    /** [latents] is NCHW with N = 1, C = 4 (scaled latent space, i.e. what the UNet sees). */
    fun argb(latents: FloatArray, channels: Int, height: Int, width: Int): IntArray {
        val plane = height * width
        val out = IntArray(plane)
        val c = minOf(channels, 4)
        for (p in 0 until plane) {
            var r = 0f
            var g = 0f
            var b = 0f
            for (ch in 0 until c) {
                val v = latents[ch * plane + p]
                r += v * FACTORS[ch][0]
                g += v * FACTORS[ch][1]
                b += v * FACTORS[ch][2]
            }
            out[p] = (0xff shl 24) or (to8(r) shl 16) or (to8(g) shl 8) or to8(b)
        }
        return out
    }

    private fun to8(v: Float): Int = (((v + 1f) * 0.5f) * 255f).toInt().coerceIn(0, 255)
}
