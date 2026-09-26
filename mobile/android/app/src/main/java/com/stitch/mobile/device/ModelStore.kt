package com.stitch.mobile.device

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.os.StatFs
import android.provider.OpenableColumns
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/** A model file: downloaded from [url], or (url empty) imported by the user and only checked by path and size. */
data class ModelFile(val url: String, val path: String, val size: Long?)

/** A file copied into a model folder by [ModelStore.importFiles]. */
data class ImportedFile(val path: String, val name: String, val size: Long)

data class DownloadProgress(
    val id: String,
    val state: String,
    val receivedBytes: Long,
    val totalBytes: Long,
    val file: String? = null,
    val error: String? = null,
)

data class ModelStatus(val id: String, val ready: Boolean, val sizeBytes: Long, val dir: String, val downloading: Boolean)

/**
 * Model folders under filesDir/models/<id>/ and their resumable downloads (and imports of files the user picks).
 * Each file is fetched into "<path>.part" with HTTP Range resumes, renamed when complete, and a ".complete" marker is
 * written once every file is present. Redirects are followed by hand so the caller's headers (a Hugging Face token)
 * only ever reach the file's own host, never the storage a download link redirects to (Civitai, HF's CDN ...); servers
 * without Content-Length or Range support are handled by restarting the file.
 */
class ModelStore(context: Context) {
    val root = File(context.filesDir, "models").apply { mkdirs() }
    private val jobs = ConcurrentHashMap<String, Job>()

    private class Job(val id: String) {
        @Volatile var canceled = false
        /** Set when one file failed for good: the other workers stop. */
        @Volatile var failed = false
        val connections: MutableSet<HttpURLConnection> = ConcurrentHashMap.newKeySet()
        var thread: Thread? = null
        val stopped get() = canceled || failed
    }

    fun dirFor(id: String): File {
        if (!ID_REGEX.matches(id)) throw DeviceException("Invalid model id \"$id\"", Errors.BAD_REQUEST)
        return File(root, id)
    }

    fun isDownloading(id: String) = jobs.containsKey(id)

    /**
     * Start (or resume) a download on a background thread. [onEvent] gets throttled progress; [onFinish] is called
     * once with null on success or the error (a [DeviceException] with code CANCELED when canceled).
     */
    fun download(
        id: String,
        files: List<ModelFile>,
        headers: Map<String, String>,
        onEvent: (DownloadProgress) -> Unit,
        onFinish: (Throwable?) -> Unit,
    ) {
        val dir = dirFor(id)
        if (files.isEmpty()) throw DeviceException("No files to download for $id", Errors.BAD_REQUEST)
        files.forEach { resolveInside(dir, it.path) }
        for (f in files) {
            if (f.url.isBlank() && !resolveInside(dir, f.path).let { it.isFile && (f.size == null || it.length() == f.size) }) {
                throw DeviceException("${f.path} has no download link; import it from the phone instead.", Errors.BAD_REQUEST)
            }
        }
        val job = Job(id)
        if (jobs.putIfAbsent(id, job) != null) throw DeviceException("$id is already downloading", Errors.BAD_REQUEST)
        val t = Thread({
            var error: Throwable? = null
            try {
                run(job, dir, files, headers, onEvent)
            } catch (t: Throwable) {
                error = if (job.canceled) Errors.canceled("Download canceled") else t
            } finally {
                jobs.remove(id)
            }
            val last = progressOf(dir, files)
            when {
                error == null -> onEvent(DownloadProgress(id, "done", last.first, last.second))
                (error as? DeviceException)?.code == Errors.CANCELED ->
                    onEvent(DownloadProgress(id, "canceled", last.first, last.second))
                else -> onEvent(DownloadProgress(id, "error", last.first, last.second, error = error.message ?: error.toString()))
            }
            onFinish(error)
        }, "stitch-download-$id")
        job.thread = t
        t.start()
    }

    fun cancel(id: String) {
        val job = jobs[id] ?: return
        job.canceled = true
        for (c in job.connections) try { c.disconnect() } catch (_: Exception) {}
        job.thread?.interrupt()
    }

    fun status(id: String, files: List<ModelFile>?): ModelStatus {
        val dir = dirFor(id)
        // Most catalog models aren't on the phone: answer those without touching each listed file.
        if (!dir.exists()) return ModelStatus(id, files?.isEmpty() == true, 0L, dir.absolutePath, isDownloading(id))
        val ready = when {
            files == null -> File(dir, MARKER).isFile
            files.isEmpty() -> true
            else -> files.all { f ->
                val target = resolveInside(dir, f.path)
                target.isFile && (f.size == null || target.length() == f.size)
            }
        }
        return ModelStatus(id, ready && !isDownloading(id), dirSize(dir), dir.absolutePath, isDownloading(id))
    }

    fun delete(id: String) {
        cancel(id)
        jobs[id]?.thread?.join(5000)
        val dir = dirFor(id)
        if (dir.exists() && !dir.deleteRecursively()) throw DeviceException("Couldn't delete ${dir.absolutePath}", Errors.STORAGE)
    }

    /**
     * Copies files the user picked (Storage Access Framework URIs) into model [id]'s folder on a background thread,
     * streaming (multi-GB files never sit in memory), with `download` progress events for [id]; [cancel] stops it.
     * [onFinish] gets the copied files (paths relative to the folder) or the error.
     */
    fun importFiles(
        id: String,
        uris: List<Uri>,
        resolver: ContentResolver,
        onEvent: (DownloadProgress) -> Unit,
        onFinish: (List<ImportedFile>?, Throwable?) -> Unit,
    ) {
        val dir = dirFor(id)
        if (uris.isEmpty()) throw Errors.canceled("No files picked")
        val job = Job(id)
        if (jobs.putIfAbsent(id, job) != null) throw DeviceException("$id is already downloading", Errors.BAD_REQUEST)
        val t = Thread({
            var error: Throwable? = null
            var done: List<ImportedFile>? = null
            var received = 0L
            var total = 0L
            try {
                val items = uris.map { uri -> describe(resolver, uri) }
                total = items.sumOf { it.second.coerceAtLeast(0) }
                dir.mkdirs()
                val free = StatFs(dir.absolutePath).availableBytes
                if (total > 0 && free < total + SAFETY_MARGIN) {
                    throw DeviceException("Not enough storage: these files need ${gb(total)} but only ${gb(free)} is free.", Errors.STORAGE)
                }
                val names = HashSet<String>()
                val out = ArrayList<ImportedFile>()
                var lastEmit = 0L
                for ((i, item) in items.withIndex()) {
                    val display = item.first
                    var name = safeName(display)
                    if (!names.add(name.lowercase(Locale.ROOT))) name = "${i + 1}-$name".also { names += it.lowercase(Locale.ROOT) }
                    val target = resolveInside(dir, name)
                    val part = File(target.path + PART)
                    part.delete()
                    var written = 0L
                    val input = resolver.openInputStream(uris[i]) ?: throw DeviceException("Couldn't open $display", Errors.STORAGE)
                    input.use { ins ->
                        FileOutputStream(part).use { os ->
                            val buf = ByteArray(1 shl 20)
                            while (true) {
                                if (job.stopped) throw Errors.canceled("Import canceled")
                                val n = ins.read(buf)
                                if (n < 0) break
                                os.write(buf, 0, n)
                                written += n
                                val now = System.currentTimeMillis()
                                if (now - lastEmit >= EMIT_INTERVAL_MS) {
                                    lastEmit = now
                                    onEvent(DownloadProgress(id, "downloading", received + written, maxOf(total, received + written), name))
                                }
                            }
                            os.fd.sync()
                        }
                    }
                    if (target.exists()) target.delete()
                    if (!part.renameTo(target)) throw DeviceException("Couldn't write ${target.absolutePath}", Errors.STORAGE)
                    received += written
                    out += ImportedFile(name, display, written)
                }
                writeMarker(dir)
                done = out
            } catch (t: Throwable) {
                error = if (job.canceled) Errors.canceled("Import canceled") else t
                dir.listFiles()?.forEach { if (it.name.endsWith(PART)) it.delete() }
            } finally {
                jobs.remove(id)
            }
            when {
                error == null -> onEvent(DownloadProgress(id, "done", received, maxOf(total, received)))
                (error as? DeviceException)?.code == Errors.CANCELED -> onEvent(DownloadProgress(id, "canceled", received, total))
                else -> onEvent(DownloadProgress(id, "error", received, total, error = error.message ?: error.toString()))
            }
            onFinish(done, error)
        }, "stitch-import-$id")
        job.thread = t
        t.start()
    }

    /** Display name and size (-1 when unknown) of a picked document. */
    private fun describe(resolver: ContentResolver, uri: Uri): Pair<String, Long> {
        var name: String? = null
        var size = -1L
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val si = c.getColumnIndex(OpenableColumns.SIZE)
                    if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
                    if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Couldn't query $uri", e)
        }
        return (name ?: uri.lastPathSegment?.substringAfterLast('/') ?: "model.bin") to size
    }

    /** Marks the folder complete with a manifest of every file in it (imports have no catalog file list). */
    private fun writeMarker(dir: File) {
        val manifest = JSONArray()
        dir.walkTopDown().filter { it.isFile && !it.name.startsWith(".") && !it.name.endsWith(PART) }.forEach { f ->
            manifest.put(JSONObject().put("path", f.relativeTo(dir).path.replace(File.separatorChar, '/')).put("size", f.length()))
        }
        File(dir, MARKER).writeText(JSONObject().put("files", manifest).put("completedAt", System.currentTimeMillis()).toString())
    }

    // ---------------------------------------------------------------------------------------------------------------

    private fun run(job: Job, dir: File, files: List<ModelFile>, headers: Map<String, String>, onEvent: (DownloadProgress) -> Unit) {
        dir.mkdirs()
        File(dir, MARKER).delete()
        val known = files.sumOf { it.size ?: 0L }
        // Storage check against what's still missing.
        val have = files.sumOf { f ->
            val target = resolveInside(dir, f.path)
            when {
                target.isFile -> target.length()
                else -> File(target.path + PART).takeIf { it.isFile }?.length() ?: 0L
            }
        }
        val free = StatFs(dir.absolutePath).availableBytes
        val need = known - have
        if (need > 0 && free < need + SAFETY_MARGIN) {
            throw DeviceException(
                "Not enough storage: this model needs ${gb(need)} more but only ${gb(free)} is free.",
                Errors.STORAGE,
            )
        }

        // Files download in parallel (up to PARALLEL at a time): big weights stream at full speed either way, and
        // models made of hundreds of small files (espeak-ng-data) finish several times faster.
        val total = AtomicLong(known)
        val done = AtomicLong(0)
        val inflight = ConcurrentHashMap<String, Long>()
        val lastEmit = AtomicLong(0)
        fun emit(file: String?, force: Boolean = false) {
            val now = System.currentTimeMillis()
            val prev = lastEmit.get()
            if (!force && (now - prev < EMIT_INTERVAL_MS || !lastEmit.compareAndSet(prev, now))) return
            if (force) lastEmit.set(now)
            val received = done.get() + inflight.values.sum()
            onEvent(DownloadProgress(job.id, "downloading", received, maxOf(total.get(), received), file))
        }

        val todo = ArrayList<ModelFile>()
        for (f in files) {
            val target = resolveInside(dir, f.path)
            target.parentFile?.mkdirs()
            if (target.isFile && (f.size == null || target.length() == f.size)) {
                done.addAndGet(target.length())
                if (f.size == null) total.addAndGet(target.length())
            } else {
                if (target.exists()) target.delete()
                File(target.path + PART).takeIf { it.isFile }?.let { inflight[f.path] = it.length() }
                todo += f
            }
        }
        emit(null, force = true)

        fun downloadOne(f: ModelFile) {
            val target = resolveInside(dir, f.path)
            val part = File(target.path + PART)
            var attempt = 0
            var discovered = false
            while (true) {
                if (job.stopped) throw Errors.canceled()
                try {
                    fetch(job, f, part, headers, onSize = { size ->
                        if (f.size == null && !discovered) {
                            discovered = true
                            total.addAndGet(size)
                        }
                    }) { current ->
                        inflight[f.path] = current
                        emit(f.path)
                    }
                    break
                } catch (e: DeviceException) {
                    throw e
                } catch (e: IOException) {
                    if (job.stopped) throw Errors.canceled()
                    attempt++
                    Log.w(TAG, "Download of ${f.path} failed (attempt $attempt)", e)
                    if (attempt >= MAX_ATTEMPTS) {
                        throw DeviceException("Download failed for ${f.path}: ${e.message ?: e.javaClass.simpleName}", Errors.NETWORK, e)
                    }
                    try { Thread.sleep(1500L * attempt) } catch (_: InterruptedException) { throw Errors.canceled() }
                }
            }
            if (!part.renameTo(target)) throw DeviceException("Couldn't write ${target.absolutePath}", Errors.STORAGE)
            inflight.remove(f.path)
            done.addAndGet(target.length())
            emit(f.path, force = f.size == null || f.size > 8L * 1024 * 1024)
        }

        if (todo.isNotEmpty()) {
            val pool = Executors.newFixedThreadPool(minOf(PARALLEL, todo.size)) { r -> Thread(r, "stitch-dl-${job.id}").apply { isDaemon = true } }
            val firstError = AtomicReference<Throwable?>()
            try {
                val futures = todo.map { f ->
                    pool.submit {
                        if (job.stopped) return@submit
                        try {
                            downloadOne(f)
                        } catch (t: Throwable) {
                            if (firstError.compareAndSet(null, t)) {
                                job.failed = true
                                for (c in job.connections) try { c.disconnect() } catch (_: Exception) {}
                            }
                        }
                    }
                }
                for (fu in futures) {
                    try {
                        fu.get()
                    } catch (e: InterruptedException) {
                        job.canceled = true
                        for (c in job.connections) try { c.disconnect() } catch (_: Exception) {}
                        throw Errors.canceled()
                    }
                }
            } finally {
                pool.shutdownNow()
            }
            if (job.canceled) throw Errors.canceled()
            firstError.get()?.let { throw it }
        }

        // Every file present with the expected size → mark complete.
        val manifest = JSONArray()
        for (f in files) {
            val target = resolveInside(dir, f.path)
            if (!target.isFile || (f.size != null && target.length() != f.size)) {
                throw DeviceException("${f.path} is incomplete after download", Errors.NETWORK)
            }
            manifest.put(JSONObject().put("path", f.path).put("size", target.length()))
        }
        File(dir, MARKER).writeText(JSONObject().put("files", manifest).put("completedAt", System.currentTimeMillis()).toString())
    }

    private fun fetch(
        job: Job,
        f: ModelFile,
        part: File,
        headers: Map<String, String>,
        onSize: (Long) -> Unit,
        onProgress: (Long) -> Unit,
    ) {
        var offset = if (part.isFile) part.length() else 0L
        if (f.size != null && offset > f.size) {
            part.delete(); offset = 0
        }
        if (f.size != null && offset == f.size) return

        val conn = open(job, f, offset, headers)
        try {
            val code = conn.responseCode
            when (code) {
                HttpURLConnection.HTTP_PARTIAL -> {}
                HttpURLConnection.HTTP_OK -> offset = 0
                416 -> {
                    // Range not satisfiable: the part file already holds everything (or is corrupt).
                    val remote = conn.getHeaderField("Content-Range")?.substringAfter('/')?.toLongOrNull()
                    if (remote != null && remote == part.length()) {
                        onSize(remote); return
                    }
                    part.delete()
                    throw IOException("Server rejected resume of ${f.path}; restarting")
                }
                401, 403 -> throw DeviceException(accessDenied(code, f), Errors.GATED)
                404, 410 -> throw DeviceException("File not found (HTTP $code): ${f.url}", Errors.NETWORK)
                else -> throw IOException("HTTP $code for ${f.path}")
            }
            val length = conn.contentLengthLong
            if (length >= 0) onSize(offset + length)
            val expected = f.size ?: if (length >= 0) offset + length else null

            conn.inputStream.use { input ->
                FileOutputStream(part, offset > 0).use { out ->
                    val buf = ByteArray(256 * 1024)
                    var written = offset
                    while (true) {
                        if (job.stopped) throw Errors.canceled()
                        val n = try {
                            input.read(buf)
                        } catch (e: InterruptedIOException) {
                            if (job.stopped) throw Errors.canceled() else throw e
                        }
                        if (n < 0) break
                        out.write(buf, 0, n)
                        written += n
                        onProgress(written)
                    }
                    out.fd.sync()
                    if (expected != null && written != expected) {
                        throw IOException("Connection closed early for ${f.path} ($written of $expected bytes)")
                    }
                }
            }
        } catch (e: IOException) {
            if (job.stopped) throw Errors.canceled()
            throw e
        } finally {
            job.connections -= conn
            conn.disconnect()
        }
    }

    /**
     * Opens [f], following up to 10 redirects by hand. The caller's [headers] go only to the host of the file's own
     * URL: once a redirect leaves that host (signed storage URLs from Hugging Face or Civitai), nothing is forwarded.
     */
    private fun open(job: Job, f: ModelFile, offset: Long, headers: Map<String, String>): HttpURLConnection {
        var url = URL(f.url)
        val origin = url.host.lowercase(Locale.ROOT)
        var hops = 0
        while (true) {
            if (url.protocol != "https" && url.protocol != "http") throw DeviceException("Unsupported link for ${f.path}: $url", Errors.BAD_REQUEST)
            val conn = (url.openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = 20_000
                readTimeout = 60_000
                setRequestProperty("User-Agent", "StitchMobile/1.0 (Android)")
                setRequestProperty("Accept-Encoding", "identity")
                if (url.host.lowercase(Locale.ROOT) == origin) for ((k, v) in headers) setRequestProperty(k, v)
                if (offset > 0) setRequestProperty("Range", "bytes=$offset-")
            }
            job.connections += conn
            val code = try {
                conn.responseCode
            } catch (e: IOException) {
                job.connections -= conn
                conn.disconnect()
                throw e
            }
            if (code !in REDIRECTS) return conn
            val location = conn.getHeaderField("Location")
            job.connections -= conn
            conn.disconnect()
            if (location.isNullOrBlank()) throw IOException("HTTP $code without a Location for ${f.path}")
            if (++hops > MAX_REDIRECTS) throw DeviceException("Too many redirects for ${f.path}", Errors.NETWORK)
            val next = URL(url, location)
            // Never downgrade an https download to plain http.
            if (url.protocol == "https" && next.protocol == "http") throw DeviceException("Refusing an https to http redirect for ${f.path}", Errors.NETWORK)
            url = next
        }
    }

    private fun accessDenied(code: Int, f: ModelFile): String {
        val host = try { URL(f.url).host.lowercase(Locale.ROOT) } catch (_: Exception) { "" }
        return when {
            host.endsWith("huggingface.co") || host.endsWith("hf.co") ->
                "Access denied (HTTP $code) for ${f.path}. If this is a gated Hugging Face model, accept its license on huggingface.co and add your access token."
            host.endsWith("civitai.com") ->
                "Civitai refused the download (HTTP $code) for ${f.path}. Some Civitai models need you to be signed in: add your Civitai API key to the link (?token=...)."
            else -> "Access denied (HTTP $code) for ${f.path} at $host."
        }
    }

    private fun progressOf(dir: File, files: List<ModelFile>): Pair<Long, Long> {
        var received = 0L
        var total = 0L
        for (f in files) {
            val target = try { resolveInside(dir, f.path) } catch (_: Exception) { continue }
            val have = when {
                target.isFile -> target.length()
                else -> File(target.path + PART).takeIf { it.isFile }?.length() ?: 0L
            }
            received += have
            total += f.size ?: have
        }
        return received to total
    }

    companion object {
        private const val TAG = "StitchDevice"
        const val MARKER = ".complete"
        private const val PART = ".part"
        private const val EMIT_INTERVAL_MS = 250L
        private const val MAX_ATTEMPTS = 5
        private const val PARALLEL = 4
        private const val SAFETY_MARGIN = 200L * 1024 * 1024
        private const val MAX_REDIRECTS = 10
        private val REDIRECTS = setOf(301, 302, 303, 307, 308)
        private val ID_REGEX = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

        fun gb(bytes: Long) = String.format(java.util.Locale.US, "%.1f GB", bytes / 1e9)

        /** Resolve a catalog-relative path inside [dir], refusing anything that escapes it. */
        fun resolveInside(dir: File, path: String): File {
            if (path.isBlank() || path.startsWith("/") || path.startsWith("\\") || path.split('/', '\\').any { it == ".." }) {
                throw DeviceException("Invalid file path \"$path\"", Errors.BAD_REQUEST)
            }
            val file = File(dir, path)
            val base = dir.canonicalPath + File.separator
            if (!file.canonicalPath.startsWith(base)) throw DeviceException("Invalid file path \"$path\"", Errors.BAD_REQUEST)
            return file
        }

        /** A picked file's name made safe for the model folder (no directories, no odd characters). */
        fun safeName(name: String): String {
            val base = name.substringAfterLast('/').substringAfterLast('\\').trim()
            val clean = base.replace(Regex("[^A-Za-z0-9._ +()-]"), "_").trimStart('.').take(120)
            return clean.ifBlank { "model.bin" }
        }

        fun dirSize(dir: File): Long = if (!dir.exists()) 0L else dir.walkBottomUp().filter { it.isFile }.sumOf { it.length() }
    }
}
