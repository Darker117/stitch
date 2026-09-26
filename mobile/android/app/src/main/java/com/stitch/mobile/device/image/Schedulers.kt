package com.stitch.mobile.device.image

import java.util.Random
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.roundToLong
import kotlin.math.sqrt

/** Noise schedule facts from the model's scheduler_config.json (diffusers names). */
data class NoiseSchedule(
    val trainSteps: Int = 1000,
    val betaStart: Double = 0.00085,
    val betaEnd: Double = 0.012,
    /** "scaled_linear" (SD) or "linear". */
    val betaSchedule: String = "scaled_linear",
    /** "epsilon" or "v_prediction". */
    val prediction: String = "epsilon",
    /** "leading" | "trailing" | "linspace" */
    val timestepSpacing: String = "leading",
    val stepsOffset: Int = 1,
) {
    val alphasCumprod: DoubleArray by lazy {
        val n = trainSteps
        val betas = DoubleArray(n) { i ->
            val t = if (n == 1) 0.0 else i.toDouble() / (n - 1)
            if (betaSchedule == "linear") betaStart + t * (betaEnd - betaStart)
            else {
                val s = sqrt(betaStart) + t * (sqrt(betaEnd) - sqrt(betaStart))
                s * s
            }
        }
        val out = DoubleArray(n)
        var acc = 1.0
        for (i in 0 until n) {
            acc *= 1.0 - betas[i]
            out[i] = acc
        }
        out
    }
}

/** Seeded standard-normal noise (deterministic per seed). */
class GaussianNoise(seed: Long) {
    private val rng = Random(seed)
    fun next(): Float = rng.nextGaussian().toFloat()
    fun fill(n: Int): FloatArray = FloatArray(n) { next() }
}

class StepResult(val prevSample: FloatArray, val predictedOriginal: FloatArray)

/** A diffusers-style sampler over flat latent arrays. */
interface Scheduler {
    /** Timesteps fed to the UNet, one per step. */
    val timesteps: DoubleArray
    val initNoiseSigma: Double
    fun scaleModelInput(sample: FloatArray, stepIndex: Int): FloatArray
    fun step(modelOutput: FloatArray, stepIndex: Int, sample: FloatArray, noise: GaussianNoise): StepResult

    companion object {
        /**
         * @param kind 'euler' | 'euler-a' | 'lcm' | 'turbo'. 'turbo' is Euler with trailing timesteps (SD-Turbo /
         * SDXL-Turbo), which makes 1–4 steps land on the right noise levels.
         */
        fun create(kind: String, steps: Int, schedule: NoiseSchedule, originalInferenceSteps: Int = 50): Scheduler = when (kind) {
            "lcm" -> LcmScheduler(schedule, steps, originalInferenceSteps)
            "euler-a", "euler_a", "euler-ancestral" -> EulerScheduler(schedule, steps, ancestral = true)
            "turbo" -> EulerScheduler(schedule.copy(timestepSpacing = "trailing"), steps, ancestral = false)
            else -> EulerScheduler(schedule, steps, ancestral = false)
        }
    }
}

/** diffusers EulerDiscreteScheduler / EulerAncestralDiscreteScheduler (linear sigma interpolation, no churn). */
class EulerScheduler(private val schedule: NoiseSchedule, steps: Int, private val ancestral: Boolean) : Scheduler {
    override val timesteps: DoubleArray = timestepsFor(schedule, steps)
    val sigmas: DoubleArray
    override val initNoiseSigma: Double

    init {
        val ac = schedule.alphasCumprod
        val full = DoubleArray(ac.size) { sqrt((1 - ac[it]) / ac[it]) }
        sigmas = DoubleArray(timesteps.size + 1)
        for (i in timesteps.indices) sigmas[i] = interp(timesteps[i], full)
        sigmas[timesteps.size] = 0.0
        val maxSigma = sigmas.maxOrNull() ?: 1.0
        initNoiseSigma = if (schedule.timestepSpacing == "linspace" || schedule.timestepSpacing == "trailing") maxSigma
        else sqrt(maxSigma * maxSigma + 1)
    }

    override fun scaleModelInput(sample: FloatArray, stepIndex: Int): FloatArray {
        val sigma = sigmas[stepIndex]
        val k = (1.0 / sqrt(sigma * sigma + 1)).toFloat()
        return FloatArray(sample.size) { sample[it] * k }
    }

    override fun step(modelOutput: FloatArray, stepIndex: Int, sample: FloatArray, noise: GaussianNoise): StepResult {
        val sigma = sigmas[stepIndex]
        val sigmaNext = sigmas[stepIndex + 1]
        val x0 = predictOriginal(modelOutput, sample, sigma, schedule.prediction)
        val prev = FloatArray(sample.size)
        if (!ancestral) {
            val dt = sigmaNext - sigma
            for (i in sample.indices) {
                val d = (sample[i] - x0[i]) / sigma
                prev[i] = (sample[i] + d * dt).toFloat()
            }
        } else {
            val sigmaUp = if (sigma > 0) sqrt(max(0.0, sigmaNext * sigmaNext * (sigma * sigma - sigmaNext * sigmaNext) / (sigma * sigma)))
            else 0.0
            val sigmaDown = sqrt(max(0.0, sigmaNext * sigmaNext - sigmaUp * sigmaUp))
            val dt = sigmaDown - sigma
            for (i in sample.indices) {
                val d = (sample[i] - x0[i]) / sigma
                prev[i] = (sample[i] + d * dt + noise.next() * sigmaUp).toFloat()
            }
        }
        return StepResult(prev, FloatArray(x0.size) { x0[it].toFloat() })
    }

    companion object {
        fun timestepsFor(schedule: NoiseSchedule, steps: Int): DoubleArray {
            require(steps >= 1) { "steps must be >= 1" }
            val n = schedule.trainSteps
            return when (schedule.timestepSpacing) {
                "linspace" -> DoubleArray(steps) { i ->
                    val v = if (steps == 1) 0.0 else i * (n - 1).toDouble() / (steps - 1)
                    v
                }.reversedArray()
                "trailing" -> {
                    val ratio = n.toDouble() / steps
                    // np.arange(n, 0, -ratio).round() - 1
                    val out = ArrayList<Double>()
                    var v = n.toDouble()
                    while (v > 0 && out.size < steps) {
                        out += roundHalfEven(v) - 1
                        v -= ratio
                    }
                    out.toDoubleArray()
                }
                else -> { // leading
                    val ratio = n / steps
                    DoubleArray(steps) { i -> (i * ratio).toDouble() }.reversedArray()
                        .map { it + schedule.stepsOffset }.toDoubleArray()
                }
            }
        }

        /** np.interp(t, arange(len), values). */
        fun interp(t: Double, values: DoubleArray): Double {
            if (t <= 0) return values[0]
            if (t >= values.size - 1) return values[values.size - 1]
            val lo = floor(t).toInt()
            val f = t - lo
            return values[lo] * (1 - f) + values[lo + 1] * f
        }

        private fun roundHalfEven(v: Double): Double = Math.rint(v)
    }
}

/** diffusers LCMScheduler (consistency sampling, boundary-condition scalings, final_alpha_cumprod = 1). */
class LcmScheduler(private val schedule: NoiseSchedule, steps: Int, originalInferenceSteps: Int = 50) : Scheduler {
    override val timesteps: DoubleArray = timestepsFor(schedule.trainSteps, steps, originalInferenceSteps)
    override val initNoiseSigma: Double = 1.0
    private val timestepScaling = 10.0
    private val sigmaData = 0.5

    override fun scaleModelInput(sample: FloatArray, stepIndex: Int): FloatArray = sample

    override fun step(modelOutput: FloatArray, stepIndex: Int, sample: FloatArray, noise: GaussianNoise): StepResult {
        val ac = schedule.alphasCumprod
        val t = timesteps[stepIndex].toInt()
        val prevT = if (stepIndex + 1 < timesteps.size) timesteps[stepIndex + 1].toInt() else t
        val alphaT = ac[t]
        val alphaPrev = if (prevT >= 0) ac[prevT] else 1.0
        val betaT = 1 - alphaT
        val betaPrev = 1 - alphaPrev
        val (cSkip, cOut) = boundaryScalings(t)
        val sqrtAlphaT = sqrt(alphaT)
        val sqrtBetaT = sqrt(betaT)
        val x0 = FloatArray(sample.size)
        val denoised = FloatArray(sample.size)
        for (i in sample.indices) {
            val p = if (schedule.prediction == "v_prediction") sqrtAlphaT * sample[i] - sqrtBetaT * modelOutput[i]
            else (sample[i] - sqrtBetaT * modelOutput[i]) / sqrtAlphaT
            x0[i] = p.toFloat()
            denoised[i] = (cOut * p + cSkip * sample[i]).toFloat()
        }
        if (stepIndex == timesteps.size - 1) return StepResult(denoised, denoised)
        val a = sqrt(alphaPrev)
        val b = sqrt(betaPrev)
        val prev = FloatArray(sample.size) { (a * denoised[it] + b * noise.next()).toFloat() }
        return StepResult(prev, denoised)
    }

    fun boundaryScalings(t: Int): Pair<Double, Double> {
        val scaled = t * timestepScaling
        val cSkip = sigmaData * sigmaData / (scaled * scaled + sigmaData * sigmaData)
        val cOut = scaled / sqrt(scaled * scaled + sigmaData * sigmaData)
        return cSkip to cOut
    }

    companion object {
        fun timestepsFor(trainSteps: Int, steps: Int, originalSteps: Int = 50): DoubleArray {
            require(steps >= 1) { "steps must be >= 1" }
            val k = trainSteps / originalSteps
            // lcm_origin_timesteps = arange(1, original+1) * k - 1, reversed
            val origin = IntArray(originalSteps) { (originalSteps - it) * k - 1 }
            val count = minOf(steps, originalSteps)
            return DoubleArray(count) { i ->
                val idx = floor(i * originalSteps.toDouble() / count).toInt()
                origin[idx].toDouble()
            }
        }

        /**
         * LCM's guidance-scale embedding w → [dim] (sin | cos), as in
         * LatentConsistencyModelPipeline.get_guidance_scale_embedding(w = guidance - 1).
         */
        fun guidanceEmbedding(w: Double, dim: Int = 256): FloatArray {
            val half = dim / 2
            val scale = ln(10000.0) / (half - 1)
            val out = FloatArray(dim)
            val ww = w * 1000.0
            for (i in 0 until half) {
                val v = ww * exp(-scale * i)
                out[i] = kotlin.math.sin(v).toFloat()
                out[half + i] = kotlin.math.cos(v).toFloat()
            }
            return out
        }
    }
}

fun predictOriginal(modelOutput: FloatArray, sample: FloatArray, sigma: Double, prediction: String): DoubleArray {
    val x0 = DoubleArray(sample.size)
    if (prediction == "v_prediction") {
        val c = -sigma / sqrt(sigma * sigma + 1)
        val d = 1.0 / (sigma * sigma + 1)
        for (i in sample.indices) x0[i] = modelOutput[i] * c + sample[i] * d
    } else {
        for (i in sample.indices) x0[i] = sample[i] - sigma * modelOutput[i]
    }
    return x0
}

/** Stable Diffusion UNet timestep value for an int64 input (diffusers passes the float timestep; exports round it). */
fun timestepAsLong(t: Double): Long = t.roundToLong()
