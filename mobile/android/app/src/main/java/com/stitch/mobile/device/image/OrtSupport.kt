package com.stitch.mobile.device.image

import ai.onnxruntime.OnnxJavaType
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtLoggingLevel
import ai.onnxruntime.OrtProvider
import ai.onnxruntime.OrtSession
import ai.onnxruntime.providers.NNAPIFlags
import android.util.Log
import com.stitch.mobile.device.DeviceException
import com.stitch.mobile.device.Errors
import com.stitch.mobile.device.NativeRuntime
import java.io.File
import java.nio.FloatBuffer
import java.nio.IntBuffer
import java.nio.LongBuffer
import java.nio.ShortBuffer
import java.util.EnumSet

/** ONNX Runtime environment + per-backend session creation (CPU / QNN HTP / QNN GPU / NNAPI). */
object OrtSupport {
    private const val TAG = "StitchOrt"

    val env: OrtEnvironment by lazy {
        OrtEnvironment.getEnvironment(OrtLoggingLevel.ORT_LOGGING_LEVEL_WARNING, "stitch").also {
            try { it.setTelemetry(false) } catch (_: Throwable) {}
        }
    }

    fun availableProviders(): Set<OrtProvider> = try {
        OrtEnvironment.getAvailableProviders()
    } catch (t: Throwable) {
        Log.w(TAG, "ORT providers unavailable", t)
        emptySet()
    }

    fun cpuThreads(): Int = Runtime.getRuntime().availableProcessors().let { if (it >= 8) 4 else maxOf(1, it / 2) }

    /**
     * How the image models run on each backend:
     *  - npu: QNN Execution Provider, HTP (Hexagon) backend, fp16 precision, burst performance mode. The compiled QNN
     *    graph is saved next to the model as an EP-context model ("<model>.<tag>_ctx.onnx" + its .bin) so the costly
     *    on-device compile happens once per model, chip and resolution.
     *  - gpu: QNN GPU backend (Adreno, OpenCL) on Snapdragon; NNAPI elsewhere when this ORT build has it.
     *  - cpu: default CPU EP (MLAS), plus XNNPACK for fp32 models when available.
     * Symbolic dims are pinned with free-dimension overrides ([dims]) — QNN only runs static shapes.
     */
    fun createSession(
        model: File,
        backend: String,
        dims: Map<String, Long>,
        cacheTag: String,
        qualcomm: Boolean,
        fp32Model: Boolean,
        basicOptimization: Boolean = false,
    ): OrtSession {
        if (!model.isFile) throw DeviceException("Missing model file ${model.absolutePath}. Download the model again.", Errors.MODEL_MISSING)
        return when (backend) {
            "npu" -> createQnnHtp(model, dims, cacheTag)
            "gpu" -> {
                if (qualcomm) {
                    open(model, backend) { o ->
                        base(o, dims)
                        o.addQnn(mapOf("backend_path" to qnnLib("libQnnGpu.so")))
                    }
                } else if (OrtProvider.NNAPI in availableProviders()) {
                    open(model, backend) { o ->
                        base(o, dims)
                        o.addNnapi(EnumSet.of(NNAPIFlags.USE_FP16, NNAPIFlags.CPU_DISABLED))
                    }
                } else {
                    throw DeviceException(
                        "ONNX Runtime has no GPU path on this chip (the GPU backend uses Qualcomm's QNN GPU on Adreno). Use the CPU backend.",
                        Errors.BACKEND_UNAVAILABLE,
                    )
                }
            }
            else -> {
                fun cpu(basic: Boolean) = open(model, backend) { o ->
                    base(o, dims)
                    if (basic) o.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.BASIC_OPT)
                    if (fp32Model && OrtProvider.XNNPACK in availableProviders()) {
                        o.setIntraOpNumThreads(1)
                        o.addConfigEntry("session.intra_op.allow_spinning", "0")
                        o.addXnnpack(mapOf("intra_op_num_threads" to cpuThreads().toString()))
                    }
                }
                if (basicOptimization) cpu(true)
                else try {
                    cpu(false)
                } catch (e: DeviceException) {
                    // Extended fusions can produce fp16 contrib ops (e.g. com.microsoft.Gelu) that have no CPU kernel;
                    // BASIC keeps the graph on standard ops.
                    val msg = e.message ?: ""
                    if (e.code == Errors.BACKEND_INIT && (msg.contains("NOT_IMPLEMENTED") || msg.contains("Failed to find kernel"))) {
                        Log.w(TAG, "Retrying ${model.name} with basic graph optimisation: $msg")
                        cpu(true)
                    } else throw e
                }
            }
        }
    }

    /** Whether [backend] can run image models on this chip at all (checked before anything is unloaded). */
    fun unavailableReason(backend: String, qualcomm: Boolean): String? = when {
        backend == "gpu" && !qualcomm && OrtProvider.NNAPI !in availableProviders() ->
            "ONNX Runtime has no GPU path on this chip (the GPU backend uses Qualcomm's QNN GPU on Adreno). Use the CPU backend."
        else -> null
    }

    private fun base(o: OrtSession.SessionOptions, dims: Map<String, Long>) {
        o.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
        o.setIntraOpNumThreads(cpuThreads())
        o.setMemoryPatternOptimization(true)
        for ((name, value) in dims) o.setSymbolicDimensionValue(name, value)
    }

    private fun qnnLib(name: String): String =
        if (NativeRuntime.hasBundledLib(name)) File(NativeRuntime.nativeLibDir, name).absolutePath else name

    private fun qnnHtpOptions(): Map<String, String> = mapOf(
        "backend_path" to qnnLib("libQnnHtp.so"),
        "htp_performance_mode" to "burst",
        "htp_graph_finalization_optimization_mode" to "3",
        "enable_htp_fp16_precision" to "1",
    )

    private fun createQnnHtp(model: File, dims: Map<String, Long>, cacheTag: String): OrtSession {
        val stem = model.name.removeSuffix(".onnx")
        val ctx = File(model.parentFile, "$stem.$cacheTag.qnn_ctx.onnx")
        if (ctx.isFile) {
            try {
                return open(ctx, "npu") { o ->
                    base(o, dims)
                    o.addQnn(qnnHtpOptions())
                }
            } catch (e: DeviceException) {
                Log.w(TAG, "Cached QNN context ${ctx.name} failed to load; recompiling", e)
                deleteContext(model.parentFile!!, "$stem.$cacheTag")
            }
        }
        // First run for this model + chip + resolution: compile for the HTP and write the EP-context cache.
        deleteContext(model.parentFile!!, "$stem.$cacheTag")
        val tmp = File(model.parentFile, "$stem.$cacheTag.gen_ctx.onnx")
        val session = open(model, "npu") { o ->
            base(o, dims)
            o.addQnn(qnnHtpOptions())
            o.addConfigEntry("ep.context_enable", "1")
            o.addConfigEntry("ep.context_file_path", tmp.absolutePath)
            o.addConfigEntry("ep.context_embed_mode", "0")
        }
        if (tmp.isFile && !tmp.renameTo(ctx)) Log.w(TAG, "Couldn't rename ${tmp.name}")
        return session
    }

    private fun deleteContext(dir: File, prefix: String) {
        dir.listFiles()?.forEach { f -> if (f.name.startsWith(prefix) && (f.name.endsWith("_ctx.onnx") || f.name.endsWith(".bin"))) f.delete() }
    }

    private inline fun open(model: File, backend: String, configure: (OrtSession.SessionOptions) -> Unit): OrtSession {
        val opts = OrtSession.SessionOptions()
        try {
            configure(opts)
            return env.createSession(model.absolutePath, opts)
        } catch (e: OutOfMemoryError) {
            throw Errors.outOfMemory(backend)
        } catch (e: DeviceException) {
            throw e
        } catch (e: Exception) {
            val msg = e.message ?: e.javaClass.simpleName
            if (msg.contains("bad_alloc", true) || msg.contains("Failed to allocate", true)) throw Errors.outOfMemory(backend)
            throw Errors.backendInit(backend, "${model.parentFile?.name}/${model.name}: $msg", e)
        } finally {
            opts.close()
        }
    }

    // --- tensors -----------------------------------------------------------------------------------------------------

    fun floatTensor(data: FloatArray, shape: LongArray, elemType: Int): OnnxTensor = when (elemType) {
        OnnxInspector.FLOAT16 -> OnnxTensor.createTensor(env, ShortBuffer.wrap(Fp16.toHalf(data)), shape, OnnxJavaType.FLOAT16)
        OnnxInspector.DOUBLE -> OnnxTensor.createTensor(env, java.nio.DoubleBuffer.wrap(DoubleArray(data.size) { data[it].toDouble() }), shape)
        else -> OnnxTensor.createTensor(env, FloatBuffer.wrap(data), shape)
    }

    fun intTensor(data: IntArray, shape: LongArray, elemType: Int): OnnxTensor = when (elemType) {
        OnnxInspector.INT64 -> OnnxTensor.createTensor(env, LongBuffer.wrap(LongArray(data.size) { data[it].toLong() }), shape)
        else -> OnnxTensor.createTensor(env, IntBuffer.wrap(data), shape)
    }

    /** Numeric tensor for a scalar-ish value (UNet timestep) in whatever type the model declares. */
    fun scalarTensor(value: Double, shape: LongArray, elemType: Int): OnnxTensor {
        val n = shape.fold(1L) { a, b -> a * b }.toInt().coerceAtLeast(1)
        return when (elemType) {
            OnnxInspector.INT64 -> OnnxTensor.createTensor(env, LongBuffer.wrap(LongArray(n) { timestepAsLong(value) }), shape)
            OnnxInspector.INT32 -> OnnxTensor.createTensor(env, IntBuffer.wrap(IntArray(n) { timestepAsLong(value).toInt() }), shape)
            else -> floatTensor(FloatArray(n) { value.toFloat() }, shape, elemType)
        }
    }

    fun readFloats(tensor: OnnxTensor): FloatArray {
        val info = tensor.info
        return when (info.type) {
            OnnxJavaType.FLOAT16 -> {
                val sb = tensor.shortBuffer
                val arr = ShortArray(sb.remaining())
                sb.get(arr)
                Fp16.toFloat(arr)
            }
            OnnxJavaType.DOUBLE -> {
                val db = tensor.doubleBuffer
                FloatArray(db.remaining()) { db.get().toFloat() }
            }
            else -> {
                val fb = tensor.floatBuffer
                val arr = FloatArray(fb.remaining())
                fb.get(arr)
                arr
            }
        }
    }
}
