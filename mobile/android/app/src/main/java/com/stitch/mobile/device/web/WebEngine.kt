package com.stitch.mobile.device.web

import android.content.Context
import android.os.SystemClock
import android.util.Log
import com.chaquo.python.PyObject
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import com.stitch.mobile.BuildConfig
import com.stitch.mobile.device.DeviceException
import com.stitch.mobile.device.Errors
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** What the web side sees (`WebStatus` in src/device/plugin.ts). */
data class WebState(
    /** 'stopped' | 'starting' | 'running' | 'error' */
    val state: String,
    val version: String,
    val error: String? = null,
    /** Enabled engines once loaded. */
    val engines: Int? = null,
    /** How long the last start took (Python + SearXNG). */
    val loadMs: Long? = null,
)

/**
 * Web search on the phone: SearXNG in-process on CPython 3.13 (Chaquopy), driven through
 * src/main/python/stitch_phone.py → stitch_searx (shared with the desktop app).
 *
 * Nothing starts with the app: Python and SearXNG load on the first start/search, on [executor] (one thread, so
 * calls run one at a time). Python can't be unloaded, so [stop] only marks the engine idle; the next search
 * picks it up again without reloading.
 */
class WebEngine(private val context: Context, private val onState: (WebState) -> Unit) {
    val executor: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "stitch-web").apply { isDaemon = true } }

    @Volatile private var current = WebState("stopped", BuildConfig.SEARXNG_VERSION)

    // Touched on [executor] only.
    private var module: PyObject? = null

    fun state(): WebState = current

    /** Load SearXNG if needed. Call on [executor]. */
    fun start(safeSearch: Int): WebState {
        ensure(safeSearch)
        return current
    }

    fun stop(): WebState {
        if (current.state != "stopped") set(current.copy(state = "stopped", error = null))
        return current
    }

    /** `reqJson` = WebSearchRequest. Returns WebSearchResult's fields (without `where`). Call on [executor]. */
    fun search(reqJson: String, safeSearch: Int): JSONObject = unwrap(ensure(safeSearch).callAttr("search", reqJson).toString())

    /** Returns `{url, title, text, truncated}`. Call on [executor]. */
    fun page(url: String, maxChars: Int, safeSearch: Int): JSONObject = unwrap(ensure(safeSearch).callAttr("page", url, maxChars).toString())

    private fun ensure(safeSearch: Int): PyObject {
        module?.let { m ->
            if (current.state != "running") set(current.copy(state = "running", error = null))
            return m
        }
        set(WebState("starting", current.version))
        val t0 = SystemClock.elapsedRealtime()
        try {
            if (!Python.isStarted()) Python.start(AndroidPlatform(context))
            val m = Python.getInstance().getModule("stitch_phone")
            val dataDir = File(context.filesDir, "searxng").apply { mkdirs() }
            val info = JSONObject(m.callAttr("start", dataDir.absolutePath, safeSearch.coerceIn(0, 2)).toString())
            val ms = SystemClock.elapsedRealtime() - t0
            module = m
            val version = info.optString("version").ifEmpty { BuildConfig.SEARXNG_VERSION }
            Log.i(TAG, "SearXNG $version ready in $ms ms (${info.optInt("engines")} engines, SearXNG itself ${info.optLong("ms")} ms)")
            set(WebState("running", version, engines = info.optInt("engines"), loadMs = ms))
            return m
        } catch (t: Throwable) {
            val msg = pythonMessage(t)
            Log.w(TAG, "SearXNG failed to start: $msg", t)
            set(WebState("error", current.version, error = msg))
            if (t is OutOfMemoryError) throw DeviceException("Not enough memory to start web search on this phone.", Errors.OOM, t)
            throw DeviceException("Couldn't start web search on this phone: $msg", Errors.BACKEND_INIT, t)
        }
    }

    private fun unwrap(json: String): JSONObject {
        val out = JSONObject(json)
        out.optJSONObject("ok")?.let { return it }
        val status = out.optInt("status", 500)
        throw DeviceException(out.optString("error").ifEmpty { "Web search failed" }, if (status in 400..499) Errors.BAD_REQUEST else Errors.NETWORK)
    }

    private fun set(s: WebState) {
        current = s
        try {
            onState(s)
        } catch (t: Throwable) {
            Log.w(TAG, "webStatus listener failed", t)
        }
    }

    companion object {
        private const val TAG = "StitchWeb"

        /** A Python exception's last line ("ModuleNotFoundError: No module named 'x'") instead of the whole traceback. */
        fun pythonMessage(t: Throwable): String {
            val raw = t.message ?: t.javaClass.simpleName
            return raw.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }.firstOrNull()?.take(400) ?: raw.take(400)
        }
    }
}
