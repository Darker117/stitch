package com.stitch.mobile.device.image

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.sqrt

/** Sigma / timestep math against diffusers' formulas (reference values computed independently in Python). */
class SchedulersTest {
    private val sd = NoiseSchedule() // SD 1.x/2.x: scaled_linear 0.00085 → 0.012, 1000 steps, leading, offset 1

    @Test
    fun alphasCumprodMatchesStableDiffusion() {
        val ac = sd.alphasCumprod
        assertEquals(0.99915, ac[0], 1e-12)
        assertEquals(0.004660098513077236, ac[999], 1e-12)
        val sigmaMax = sqrt((1 - ac[999]) / ac[999])
        val sigmaMin = sqrt((1 - ac[0]) / ac[0])
        assertEquals(14.614641229333643, sigmaMax, 1e-9) // k-diffusion's SD sigma_max
        assertEquals(0.029167158151720367, sigmaMin, 1e-9)
    }

    @Test
    fun eulerLeadingTimestepsAndSigmas() {
        val s = EulerScheduler(sd, 20, ancestral = false)
        assertEquals(20, s.timesteps.size)
        assertArrayEquals(doubleArrayOf(951.0, 901.0, 851.0), s.timesteps.copyOfRange(0, 3), 0.0)
        assertArrayEquals(doubleArrayOf(51.0, 1.0), s.timesteps.copyOfRange(18, 20), 0.0)
        assertEquals(21, s.sigmas.size)
        assertEquals(11.028331164775222, s.sigmas[0], 1e-9)
        assertEquals(0.0, s.sigmas[20], 0.0)
        // leading spacing → init_noise_sigma = sqrt(sigma_max² + 1)
        assertEquals(11.073576128782987, s.initNoiseSigma, 1e-9)
    }

    @Test
    fun trailingTimestepsForTurbo() {
        val one = Scheduler.create("turbo", 1, sd) as EulerScheduler
        assertArrayEquals(doubleArrayOf(999.0), one.timesteps, 0.0)
        assertEquals(14.614641229333643, one.sigmas[0], 1e-9)
        assertEquals(14.614641229333643, one.initNoiseSigma, 1e-9) // trailing → sigma_max
        val four = Scheduler.create("turbo", 4, sd) as EulerScheduler
        assertArrayEquals(doubleArrayOf(999.0, 749.0, 499.0, 249.0), four.timesteps, 0.0)
        assertEquals(4.081729363724309, four.sigmas[1], 1e-9)
        assertEquals(1.612886194303876, four.sigmas[2], 1e-9)
        assertEquals(0.6932048996386885, four.sigmas[3], 1e-9)
    }

    @Test
    fun linspaceInterpolatesSigmas() {
        val s = EulerScheduler(sd.copy(timestepSpacing = "linspace"), 10, ancestral = false)
        assertArrayEquals(doubleArrayOf(999.0, 888.0, 777.0), s.timesteps.copyOfRange(0, 3), 1e-9)
        assertEquals(7.8398828728198104, s.sigmas[1], 1e-9)
        assertEquals(0.029167158151720367, s.sigmas[9], 1e-9)
    }

    @Test
    fun lcmTimesteps() {
        assertArrayEquals(doubleArrayOf(999.0), LcmScheduler.timestepsFor(1000, 1), 0.0)
        assertArrayEquals(doubleArrayOf(999.0, 499.0), LcmScheduler.timestepsFor(1000, 2), 0.0)
        assertArrayEquals(doubleArrayOf(999.0, 759.0, 499.0, 259.0), LcmScheduler.timestepsFor(1000, 4), 0.0)
        val eight = LcmScheduler.timestepsFor(1000, 8)
        assertEquals(8, eight.size)
        assertEquals(999.0, eight[0], 0.0)
        assertTrue(eight.toList().zipWithNext().all { (a, b) -> a > b })
    }

    @Test
    fun lcmBoundaryScalings() {
        val lcm = LcmScheduler(sd, 4)
        val (skip, out) = lcm.boundaryScalings(999)
        assertEquals(0.25 / (9990.0 * 9990.0 + 0.25), skip, 1e-15)
        assertEquals(9990.0 / sqrt(9990.0 * 9990.0 + 0.25), out, 1e-12)
        val (skip0, out0) = lcm.boundaryScalings(0)
        assertEquals(1.0, skip0, 0.0)
        assertEquals(0.0, out0, 0.0)
    }

    @Test
    fun eulerOneStepRecoversCleanSampleWithPerfectNoisePrediction() {
        val s = Scheduler.create("turbo", 1, sd) as EulerScheduler
        val x0 = floatArrayOf(0.5f, -0.25f, 1.0f, 0f)
        val eps = floatArrayOf(0.1f, -1.2f, 0.7f, 2f)
        val sigma = s.sigmas[0]
        val sample = FloatArray(4) { (x0[it] + sigma * eps[it]).toFloat() }
        val r = s.step(eps, 0, sample, GaussianNoise(1))
        for (i in 0 until 4) {
            assertEquals(x0[i], r.prevSample[i], 1e-4f)
            assertEquals(x0[i], r.predictedOriginal[i], 1e-4f)
        }
    }

    @Test
    fun eulerAncestralFinalStepIsDeterministic() {
        val s = Scheduler.create("euler-a", 2, sd) as EulerScheduler
        val sample = floatArrayOf(1f, 2f, 3f)
        val eps = floatArrayOf(0.1f, 0.2f, 0.3f)
        val a = s.step(eps, 1, sample, GaussianNoise(1)).prevSample
        val b = s.step(eps, 1, sample, GaussianNoise(99)).prevSample
        assertArrayEquals(a, b, 0f) // sigma_next = 0 → no noise injected
    }

    @Test
    fun scaleModelInputDividesBySqrtSigmaSquaredPlusOne() {
        val s = EulerScheduler(sd, 20, ancestral = false)
        val x = s.scaleModelInput(floatArrayOf(2f), 0)
        assertEquals(2.0 / sqrt(s.sigmas[0] * s.sigmas[0] + 1), x[0].toDouble(), 1e-6)
    }

    @Test
    fun vPredictionOriginal() {
        val sigma = 2.0
        val x0 = predictOriginal(floatArrayOf(1f), floatArrayOf(3f), sigma, "v_prediction")
        assertEquals(1 * (-sigma / sqrt(sigma * sigma + 1)) + 3 / (sigma * sigma + 1), x0[0], 1e-9)
    }

    @Test
    fun guidanceEmbedding() {
        val e = LcmScheduler.guidanceEmbedding(0.0, 256)
        assertEquals(256, e.size)
        for (i in 0 until 128) {
            assertEquals(0f, e[i], 0f)
            assertEquals(1f, e[128 + i], 0f)
        }
        val w = LcmScheduler.guidanceEmbedding(7.0, 256)
        assertEquals(kotlin.math.sin(7000.0).toFloat(), w[0], 1e-5f)
        assertTrue(abs(w[127]) <= 1f)
    }

    @Test
    fun seededNoiseIsDeterministic() {
        assertArrayEquals(GaussianNoise(42).fill(16), GaussianNoise(42).fill(16), 0f)
    }
}
