package com.stitch.mobile.device

/** An error with a message that is safe to show in the UI. `code` lets the web side react (e.g. offer another backend). */
class DeviceException(message: String, val code: String = "ERROR", cause: Throwable? = null) : Exception(message, cause)

object Errors {
    const val CANCELED = "CANCELED"
    const val OOM = "OOM"
    const val BACKEND_INIT = "BACKEND_INIT"
    const val BACKEND_UNAVAILABLE = "BACKEND_UNAVAILABLE"
    const val MODEL_MISSING = "MODEL_MISSING"
    const val BAD_REQUEST = "BAD_REQUEST"
    const val GATED = "GATED"
    const val NETWORK = "NETWORK"
    const val STORAGE = "STORAGE"

    fun backendLabel(backend: String): String = when (backend) {
        "npu" -> "NPU"
        "gpu" -> "GPU"
        else -> "CPU"
    }

    /** Suggest the other backends after a failure on [backend]. */
    fun otherBackends(backend: String): String = when (backend) {
        "npu" -> "Try the GPU or CPU backend."
        "gpu" -> "Try the CPU backend."
        else -> "Try a smaller model."
    }

    fun canceled(what: String = "Canceled") = DeviceException(what, CANCELED)

    fun outOfMemory(backend: String) = DeviceException(
        "Out of memory while running on the ${backendLabel(backend)}. Close other apps or pick a smaller model.",
        OOM,
    )

    fun backendInit(backend: String, detail: String?, cause: Throwable? = null) = DeviceException(
        "Couldn't start the ${backendLabel(backend)} backend" + (detail?.let { ": ${it.trim().take(400)}" } ?: "") +
            ". " + otherBackends(backend),
        BACKEND_INIT,
        cause,
    )

    /** Map anything thrown by an engine to a [DeviceException] with a readable message. */
    fun friendly(t: Throwable, backend: String? = null): DeviceException {
        if (t is DeviceException) return t
        if (t is OutOfMemoryError) return outOfMemory(backend ?: "cpu")
        if (t is InterruptedException) return canceled()
        val raw = t.message ?: t.javaClass.simpleName
        if (raw.contains("bad_alloc", true) || raw.contains("out of memory", true) || raw.contains("Failed to allocate", true)) {
            return outOfMemory(backend ?: "cpu")
        }
        return DeviceException(raw.take(600), "ERROR", t)
    }
}
