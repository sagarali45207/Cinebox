package com.cinebox.app.plugins

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.StatFs
import androidx.activity.result.ActivityResult
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.cinebox.app.downloader.CineBoxDownloadDatabase
import com.cinebox.app.downloader.DownloadEntity
import com.cinebox.app.downloader.MediaStoreTransferManager
import com.cinebox.app.downloader.NativeChunkDownloadWorker
import com.cinebox.app.player.ExoPlayerActivity
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * MovieBox-Style Two-Stage Capacitor Plugin (`NativeDownloader`):
 * - Stage 1: Saves downloads strictly inside Android/data/com.cinebox.app/files/Cinebox/Downloads/
 *   (Movies & Series organized cleanly into subfolders) using WorkManager + Room + adaptive parallel
 *   HTTP Range chunking & offline HLS segment packaging. Survives restarts & cache clears.
 * - Stage 2: "Transfer to Local Storage" copies verified Stage-1 files into MediaStore
 *   (Movies/Cinebox/ or Downloads/Cinebox/) without re-downloading or transcoding.
 * - Playback: Media3 ExoPlayer native launch + verified FileProvider ACTION_VIEW external player chooser.
 */
@CapacitorPlugin(name = "NativeDownloader")
class NativeDownloaderPlugin : Plugin() {

    private val pluginScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    companion object {
        private const val PREFS_NAME = "cinebox_downloader_prefs"
        private const val KEY_PROFILE = "download_profile"
    }

    private fun db() = CineBoxDownloadDatabase.getInstance(context)

    override fun load() {
        super.load()
        NativeChunkDownloadWorker.listener = { entity ->
            emitEntityEvent(entity)
        }
    }

    override fun handleOnDestroy() {
        NativeChunkDownloadWorker.listener = null
        pluginScope.cancel()
        super.handleOnDestroy()
    }

    @PluginMethod
    fun downloadFile(call: PluginCall) {
        val rawUrl = call.getString("url")?.trim().orEmpty()
        val rawFileName = call.getString("fileName")?.trim().orEmpty()
        val category = call.getString("category")?.trim().orEmpty().ifEmpty { "movies" }

        if (rawUrl.isEmpty() || rawFileName.isEmpty()) {
            call.reject("url and fileName are required")
            return
        }

        val taskId = call.getString("taskId")?.trim().orEmpty()
            .ifEmpty { "dl_${UUID.randomUUID().toString().replace("-", "").take(12)}" }
        val mediaId = call.getString("mediaId")?.trim().orEmpty()
        val title = call.getString("title")?.trim().orEmpty().ifEmpty { rawFileName }
        val subtitle = call.getString("subtitle")?.trim().orEmpty()
        val seriesTitle = call.getString("seriesTitle")?.trim().orEmpty()
        val seasonNum = call.getInt("seasonNum") ?: 0
        val episodeNum = call.getInt("episodeNum") ?: 0
        val quality = call.getString("quality")?.trim().orEmpty().ifEmpty { "720p" }
        val mimeType = call.getString("mimeType")?.trim().orEmpty().ifEmpty { "video/mp4" }
        val profile = call.getString("profile")?.trim().orEmpty()
            .ifEmpty { loadSavedProfile() }
        val baseFolder = call.getString("baseFolder")?.trim().orEmpty()
            .ifEmpty {
                if (category.equals("downloads", ignoreCase = true)) "Downloads"
                else "Cinebox/Downloads"
            }

        val headersJson = call.getObject("headers")?.toString() ?: "{}"
        val safeFileName = sanitizeFileName(rawFileName)

        val destDir = resolveStage1CategoryDir(
            baseFolder = baseFolder,
            category = category,
            seriesTitle = seriesTitle,
            seasonNum = seasonNum
        )
        val tempDir = resolveStage1TempDir()
        val finalFile = File(destDir, safeFileName)
        val tempFile = File(tempDir, "${taskId}_$safeFileName.part")

        val engine = if (rawUrl.contains(".m3u8", ignoreCase = true) ||
            mimeType.contains("mpegurl", ignoreCase = true)
        ) {
            "hls"
        } else {
            "chunked"
        }

        val entity = DownloadEntity(
            taskId = taskId,
            mediaId = mediaId,
            kind = category.lowercase(),
            title = title,
            subtitle = subtitle,
            seriesTitle = seriesTitle,
            seasonNum = seasonNum,
            episodeNum = episodeNum,
            selectedQuality = quality,
            sourceUrl = rawUrl,
            headersJson = headersJson,
            fileName = safeFileName,
            filePath = Uri.fromFile(finalFile).toString(),
            tempPath = tempFile.absolutePath,
            mimeType = mimeType,
            status = "queued",
            downloadProfile = profile
        )

        pluginScope.launch {
            try {
                db().downloadDao().upsert(entity)
                enqueueWorker(taskId)
                emitEntityEvent(entity)

                call.resolve(JSObject().apply {
                    put("id", taskId)
                    put("taskId", taskId)
                    put("filePath", entity.filePath)
                    put("privateDir", destDir.absolutePath)
                    put("engine", engine)
                })
            } catch (err: Throwable) {
                call.reject(err.message ?: "Unable to schedule download")
            }
        }
    }

    @PluginMethod
    fun getDownloadStatus(call: PluginCall) {
        val id = call.getString("id")?.trim().orEmpty()
        if (id.isEmpty()) {
            call.reject("id is required")
            return
        }
        pluginScope.launch {
            val entity = db().downloadDao().getById(id)
            if (entity == null) {
                call.reject("Download not found: $id")
                return@launch
            }
            call.resolve(entityToJsObject(entity))
        }
    }

    @PluginMethod
    fun pauseDownload(call: PluginCall) {
        val id = call.getString("id")?.trim().orEmpty()
        if (id.isEmpty()) {
            call.reject("id is required")
            return
        }
        WorkManager.getInstance(context).cancelUniqueWork(workName(id))
        pluginScope.launch {
            val existing = db().downloadDao().getById(id)
            if (existing != null) {
                db().downloadDao().updateStatus(id, "paused", "", existing.retryCount)
                db().downloadDao().getById(id)?.let { emitEntityEvent(it) }
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun resumeDownload(call: PluginCall) {
        val id = call.getString("id")?.trim().orEmpty()
        if (id.isEmpty()) {
            call.reject("id is required")
            return
        }
        pluginScope.launch {
            val entity = db().downloadDao().getById(id)
            if (entity == null) {
                call.reject("Download task not found: $id")
                return@launch
            }
            db().downloadDao().updateStatus(id, "queued", "", entity.retryCount)
            enqueueWorker(id)
            db().downloadDao().getById(id)?.let { emitEntityEvent(it) }
            call.resolve(JSObject().apply {
                put("id", id)
                put("taskId", id)
                put("filePath", entity.filePath)
                put("privateDir", File(Uri.parse(entity.filePath).path ?: "").parent ?: "")
                put("engine", "chunked")
            })
        }
    }

    @PluginMethod
    fun retryDownload(call: PluginCall) {
        resumeDownload(call)
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) {
        val id = call.getString("id")?.trim().orEmpty()
        if (id.isEmpty()) {
            call.reject("id is required")
            return
        }
        WorkManager.getInstance(context).cancelUniqueWork(workName(id))
        pluginScope.launch {
            val entity = db().downloadDao().getById(id)
            if (entity != null) {
                db().downloadDao().updateStatus(id, "cancelled", "", entity.retryCount)
                deleteTempFiles(entity)
                db().downloadDao().getById(id)?.let { emitEntityEvent(it) }
                db().downloadDao().deleteById(id)
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun deletePrivateDownload(call: PluginCall) {
        val id = call.getString("id")?.trim().orEmpty()
        val filePath = call.getString("filePath")?.trim().orEmpty()
        if (id.isNotEmpty()) {
            WorkManager.getInstance(context).cancelUniqueWork(workName(id))
        }
        pluginScope.launch {
            val entity = if (id.isNotEmpty()) db().downloadDao().getById(id) else null
            val targetPath = entity?.filePath?.ifBlank { filePath } ?: filePath
            if (targetPath.isNotEmpty()) {
                val f = MediaStoreTransferManager.resolveLocalFile(targetPath)
                if (f != null) {
                    if (f.name == "index.m3u8" && f.parentFile?.name?.endsWith("_hls") == true) {
                        f.parentFile?.deleteRecursively()
                    } else if (f.exists()) {
                        f.delete()
                    }
                }
            }
            if (entity != null) {
                deleteTempFiles(entity)
                db().downloadDao().deleteById(entity.taskId)
            } else if (id.isNotEmpty()) {
                db().downloadDao().deleteById(id)
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun transferToLocalStorage(call: PluginCall) {
        val id = call.getString("id")?.trim().orEmpty()
        val rawFilePath = call.getString("filePath")?.trim().orEmpty()
        val fileName = call.getString("fileName")?.trim().orEmpty()
        val destination = call.getString("destination")?.trim().orEmpty().ifEmpty { "movies" }
        val mimeType = call.getString("mimeType")?.trim().orEmpty().ifEmpty { "video/mp4" }

        if (id.isEmpty()) {
            call.reject("id is required")
            return
        }

        pluginScope.launch {
            val dao = db().downloadDao()
            val entity = dao.getById(id)
            val sourcePath = entity?.filePath?.ifBlank { rawFilePath } ?: rawFilePath
            val exportName = fileName.ifBlank { entity?.fileName ?: "cinebox_video.mp4" }
            val resolvedMime = mimeType.ifBlank { entity?.mimeType ?: "video/mp4" }

            if (sourcePath.isEmpty()) {
                call.reject("Private offline file path is missing")
                return@launch
            }

            dao.updateTransferState(id, "transferring", 0, "", "", "")
            try {
                val outcome = MediaStoreTransferManager.exportToPublicStorage(
                    context = context,
                    sourcePathOrUri = sourcePath,
                    fileName = exportName,
                    mimeType = resolvedMime,
                    destination = destination
                ) { copied, total, pct ->
                    notifyListeners("transferProgress", JSObject().apply {
                        put("taskId", id)
                        put("copiedBytes", copied)
                        put("totalBytes", total)
                        put("percent", pct)
                        put("transferStatus", "transferring")
                    })
                }

                dao.updateTransferState(
                    taskId = id,
                    transferStatus = "exported",
                    transferProgress = 100,
                    exportedUri = outcome.exportedUri,
                    exportedPath = outcome.exportedPath,
                    transferError = ""
                )

                val res = JSObject().apply {
                    put("taskId", id)
                    put("transferStatus", "exported")
                    put("exportedUri", outcome.exportedUri)
                    put("exportedPath", outcome.exportedPath)
                    put("sizeBytes", outcome.sizeBytes)
                    put("verified", outcome.verified)
                }
                notifyListeners("transferStateChange", res)
                call.resolve(res)
            } catch (err: Throwable) {
                val msg = err.message ?: "Failed to transfer file to MediaStore"
                dao.updateTransferState(id, "transfer_failed", 0, "", "", msg)
                notifyListeners("transferStateChange", JSObject().apply {
                    put("taskId", id)
                    put("transferStatus", "transfer_failed")
                    put("exportedUri", "")
                    put("exportedPath", "")
                    put("sizeBytes", 0L)
                    put("verified", false)
                    put("error", msg)
                })
                call.reject(msg)
            }
        }
    }

    @PluginMethod
    fun deleteExportedCopy(call: PluginCall) {
        val id = call.getString("id")?.trim().orEmpty()
        val exportedUri = call.getString("exportedUri")?.trim().orEmpty()
        if (id.isEmpty()) {
            call.reject("id is required")
            return
        }
        pluginScope.launch {
            val dao = db().downloadDao()
            val entity = dao.getById(id)
            val uriToDelete = exportedUri.ifBlank { entity?.exportedUri ?: "" }
            if (uriToDelete.isNotEmpty()) {
                MediaStoreTransferManager.deleteExportedCopy(context, uriToDelete)
            }
            dao.updateTransferState(id, "not_exported", 0, "", "", "")
            call.resolve()
        }
    }

    @PluginMethod
    fun verifyPrivateFile(call: PluginCall) {
        val id = call.getString("id")?.trim().orEmpty()
        val rawPath = call.getString("filePath")?.trim().orEmpty()
        pluginScope.launch {
            val entity = if (id.isNotEmpty()) db().downloadDao().getById(id) else null
            val path = entity?.filePath?.ifBlank { rawPath } ?: rawPath
            val file = MediaStoreTransferManager.resolveLocalFile(path)
            val exists = file?.exists() == true
            val isHlsDir = file?.name == "index.m3u8"
            val sizeBytes = when {
                !exists -> 0L
                isHlsDir -> file?.parentFile?.walkTopDown()?.filter { it.isFile }?.sumOf { it.length() } ?: 0L
                else -> file?.length() ?: 0L
            }
            val playable = exists && sizeBytes > 0L
            val canonicalUri = if (file != null) Uri.fromFile(file).toString() else path

            call.resolve(JSObject().apply {
                put("exists", exists)
                put("playable", playable)
                put("sizeBytes", sizeBytes)
                put("filePath", canonicalUri)
                put("webviewUrl", canonicalUri)
                put("mimeType", entity?.mimeType ?: if (isHlsDir) "application/vnd.apple.mpegurl" else "video/mp4")
                put("isHlsDirectory", isHlsDir)
            })
        }
    }

    @PluginMethod
    fun getPlayableUri(call: PluginCall) {
        val rawPath = call.getString("filePath")?.trim().orEmpty()
        val file = MediaStoreTransferManager.resolveLocalFile(rawPath)
        val uriStr = if (file != null) Uri.fromFile(file).toString() else rawPath
        call.resolve(JSObject().apply {
            put("url", uriStr)
            put("filePath", uriStr)
        })
    }

    @PluginMethod
    fun playOfflineWithExoPlayer(call: PluginCall) {
        val filePath = call.getString("filePath")?.trim().orEmpty()
        val title = call.getString("title")?.trim().orEmpty().ifEmpty { "Offline Video" }
        val subtitle = call.getString("subtitle")?.trim().orEmpty()
        val mimeType = call.getString("mimeType")?.trim().orEmpty()
        val resumeMs = call.getLong("resumePositionMs") ?: 0L
        val subtitlesArr: JSArray? = call.getArray("subtitles")

        if (filePath.isEmpty()) {
            call.reject("filePath is required")
            return
        }

        val file = MediaStoreTransferManager.resolveLocalFile(filePath)
        if (file == null || !file.exists() || file.length() <= 0L) {
            call.reject("Offline media file does not exist or is empty")
            return
        }

        val intent = Intent(context, ExoPlayerActivity::class.java).apply {
            putExtra(ExoPlayerActivity.EXTRA_URL_OR_PATH, Uri.fromFile(file).toString())
            putExtra(ExoPlayerActivity.EXTRA_TITLE, title)
            putExtra(ExoPlayerActivity.EXTRA_SUBTITLE, subtitle)
            putExtra(ExoPlayerActivity.EXTRA_MIME_TYPE, mimeType)
            putExtra(ExoPlayerActivity.EXTRA_RESUME_MS, resumeMs)
            putExtra(ExoPlayerActivity.EXTRA_IS_OFFLINE, true)
            if (subtitlesArr != null) {
                putExtra(ExoPlayerActivity.EXTRA_SUBTITLES_JSON, subtitlesArr.toString())
            }
        }
        startActivityForResult(call, intent, "onExoPlayerClosed")
    }

    @PluginMethod
    fun playStreamWithExoPlayer(call: PluginCall) {
        val url = call.getString("url")?.trim().orEmpty()
        val title = call.getString("title")?.trim().orEmpty().ifEmpty { "CineBox Stream" }
        val subtitle = call.getString("subtitle")?.trim().orEmpty()
        val mimeType = call.getString("mimeType")?.trim().orEmpty()
        val resumeMs = call.getLong("resumePositionMs") ?: 0L
        val headersJson = call.getObject("headers")?.toString() ?: "{}"

        if (url.isEmpty() || url.startsWith("blob:") || url.startsWith("capacitor:")) {
            call.reject("Valid HTTP/HTTPS stream URL is required")
            return
        }

        val intent = Intent(context, ExoPlayerActivity::class.java).apply {
            putExtra(ExoPlayerActivity.EXTRA_URL_OR_PATH, url)
            putExtra(ExoPlayerActivity.EXTRA_TITLE, title)
            putExtra(ExoPlayerActivity.EXTRA_SUBTITLE, subtitle)
            putExtra(ExoPlayerActivity.EXTRA_MIME_TYPE, mimeType)
            putExtra(ExoPlayerActivity.EXTRA_RESUME_MS, resumeMs)
            putExtra(ExoPlayerActivity.EXTRA_HEADERS_JSON, headersJson)
            putExtra(ExoPlayerActivity.EXTRA_IS_OFFLINE, false)
        }
        startActivityForResult(call, intent, "onExoPlayerClosed")
    }

    @ActivityCallback
    private fun onExoPlayerClosed(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val data = result.data
        call.resolve(JSObject().apply {
            put("launched", true)
            put("lastPositionMs", data?.getLongExtra(ExoPlayerActivity.RESULT_POSITION_MS, 0L) ?: 0L)
            put("durationMs", data?.getLongExtra(ExoPlayerActivity.RESULT_DURATION_MS, 0L) ?: 0L)
            put("completed", data?.getBooleanExtra(ExoPlayerActivity.RESULT_COMPLETED, false) ?: false)
        })
    }

    @PluginMethod
    fun openInExternalPlayer(call: PluginCall) {
        val rawUrl = call.getString("url")?.trim().orEmpty()
        val rawFilePath = call.getString("filePath")?.trim().orEmpty()
        val title = call.getString("title")?.trim().orEmpty().ifEmpty { "Play Video" }
        val mimeType = call.getString("mimeType")?.trim().orEmpty().ifEmpty { "video/*" }
        val headersObj = call.getObject("headers")

        val source = rawFilePath.ifEmpty { rawUrl }
        if (source.isEmpty() ||
            source.startsWith("blob:", ignoreCase = true) ||
            source.startsWith("capacitor:", ignoreCase = true)
        ) {
            call.reject("External player requires a real stream URL or FileProvider URI (never Blob/WebView URL).")
            return
        }

        try {
            val playableUri = MediaStoreTransferManager.getExternalPlayableUri(context, source)
            val viewIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(playableUri, mimeType)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                putExtra("title", title)
                if (headersObj != null) {
                    val flatHeaders = ArrayList<String>()
                    val keys = headersObj.keys()
                    while (keys.hasNext()) {
                        val k = keys.next()
                        val v = headersObj.optString(k, "")
                        if (v.isNotEmpty()) {
                            flatHeaders.add(k)
                            flatHeaders.add(v)
                        }
                    }
                    if (flatHeaders.isNotEmpty()) {
                        putExtra("headers", flatHeaders.toTypedArray())
                    }
                }
            }

            val chooser = Intent.createChooser(viewIntent, "Open in External Player").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            val currentActivity: Activity? = activity
            if (currentActivity != null) {
                currentActivity.startActivity(chooser)
            } else {
                context.startActivity(chooser)
            }

            call.resolve(JSObject().apply {
                put("launched", true)
                put("chooserShown", true)
                put("uri", playableUri.toString())
                put("mimeType", mimeType)
            })
        } catch (err: Throwable) {
            call.reject(err.message ?: "No compatible external video player installed")
        }
    }

    @PluginMethod
    fun setDownloadProfile(call: PluginCall) {
        val raw = call.getString("profile")?.trim()?.lowercase().orEmpty()
        val normalized = if (raw == "premium") "premium" else "free"
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_PROFILE, normalized)
            .apply()
        call.resolve(JSObject().apply { put("profile", normalized) })
    }

    @PluginMethod
    fun getDownloadProfile(call: PluginCall) {
        call.resolve(JSObject().apply { put("profile", loadSavedProfile()) })
    }

    @PluginMethod
    fun listDownloads(call: PluginCall) {
        pluginScope.launch {
            val completed = db().downloadDao().getCompletedDownloads()
            val arr = JSArray()
            completed.forEach { arr.put(entityToJsObject(it)) }
            call.resolve(JSObject().apply { put("downloads", arr) })
        }
    }

    @PluginMethod
    fun listActiveTasks(call: PluginCall) {
        pluginScope.launch {
            val active = db().downloadDao().getActiveTasks()
            val arr = JSArray()
            active.forEach { arr.put(entityToJsObject(it)) }
            call.resolve(JSObject().apply { put("tasks", arr) })
        }
    }

    @PluginMethod
    fun getStorageSummary(call: PluginCall) {
        pluginScope.launch {
            val root = resolvePrivateRootDir("Cinebox/Downloads")
            val moviesDir = File(root, "Movies")
            val seriesDir = File(root, "Series")
            val usedBytes = root.walkTopDown().filter { it.isFile }.sumOf { it.length() }
            val stat = StatFs(root.absolutePath)
            val freeBytes = stat.availableBlocksLong * stat.blockSizeLong
            val all = db().downloadDao().getAll()
            val completedCount = all.count { it.status == "completed" }
            val activeCount = all.count { it.status in listOf("queued", "downloading", "paused") }

            call.resolve(JSObject().apply {
                put("privateRootPath", root.absolutePath)
                put("moviesDirPath", moviesDir.absolutePath)
                put("seriesDirPath", seriesDir.absolutePath)
                put("privateBytesUsed", usedBytes)
                put("freeBytesAvailable", freeBytes)
                put("completedCount", completedCount)
                put("activeCount", activeCount)
            })
        }
    }

    private fun resolvePrivateRootDir(baseFolder: String): File {
        val extBase = context.getExternalFilesDir(null) ?: context.filesDir
        return File(extBase, baseFolder).apply { mkdirs() }
    }

    private fun resolveStage1CategoryDir(
        baseFolder: String,
        category: String,
        seriesTitle: String,
        seasonNum: Int
    ): File {
        val root = resolvePrivateRootDir(baseFolder)
        return when {
            category.equals("series", ignoreCase = true) || category.equals("episode", ignoreCase = true) -> {
                val safeSeries = sanitizeFolderName(seriesTitle.ifBlank { "Series" })
                val seasonFolder = if (seasonNum > 0) "Season ${seasonNum.toString().padStart(2, '0')}" else "Episodes"
                File(File(File(root, "Series"), safeSeries), seasonFolder).apply { mkdirs() }
            }
            category.equals("downloads", ignoreCase = true) -> root
            else -> File(root, "Movies").apply { mkdirs() }
        }
    }

    private fun resolveStage1TempDir(): File {
        return File(resolvePrivateRootDir("Cinebox/Downloads"), "Temp").apply { mkdirs() }
    }

    private fun enqueueWorker(taskId: String) {
        val req = OneTimeWorkRequestBuilder<NativeChunkDownloadWorker>()
            .setInputData(Data.Builder().putString(NativeChunkDownloadWorker.KEY_TASK_ID, taskId).build())
            .addTag("cinebox_dl_$taskId")
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            workName(taskId),
            ExistingWorkPolicy.REPLACE,
            req
        )
    }

    private fun deleteTempFiles(entity: DownloadEntity) {
        if (entity.tempPath.isNotEmpty()) {
            File(entity.tempPath).delete()
            File("${entity.tempPath}.ckpt").delete()
        }
    }

    private fun workName(taskId: String) = "cinebox_download_$taskId"

    private fun loadSavedProfile(): String {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_PROFILE, "free") ?: "free"
    }

    private fun emitEntityEvent(entity: DownloadEntity) {
        val obj = entityToJsObject(entity)
        val eventName = if (entity.status in listOf("completed", "failed", "cancelled", "paused")) {
            "downloadStateChange"
        } else {
            "downloadProgress"
        }
        notifyListeners(eventName, obj)
    }

    private fun entityToJsObject(e: DownloadEntity): JSObject {
        val pct = when {
            e.status == "completed" -> 100
            e.totalBytes > 0L -> ((e.receivedBytes * 100L) / e.totalBytes).toInt().coerceIn(0, 99)
            else -> 0
        }
        return JSObject().apply {
            put("id", e.taskId)
            put("taskId", e.taskId)
            put("mediaId", e.mediaId)
            put("title", e.title)
            put("category", e.kind)
            put("quality", e.selectedQuality)
            put("status", e.status)
            put("receivedBytes", e.receivedBytes)
            put("totalBytes", e.totalBytes)
            put("percent", pct)
            put("speedBytesPerSec", e.speedBytesPerSec)
            put("etaSeconds", e.etaSeconds)
            put("retryCount", e.retryCount)
            put("lastCheckpoint", e.lastCheckpoint)
            put("filePath", e.filePath)
            put("hlsManifestPath", e.hlsManifestPath)
            put("mimeType", e.mimeType)
            put("transferStatus", e.transferStatus)
            put("transferProgress", e.transferProgress)
            put("exportedUri", e.exportedUri)
            put("exportedPath", e.exportedPath)
            put("isVerifiedPlayable", e.isVerifiedPlayable)
            put("profile", e.downloadProfile)
            if (e.errorMessage.isNotEmpty()) {
                put("error", e.errorMessage)
            }
        }
    }

    private fun sanitizeFileName(name: String): String {
        return name.replace(Regex("[^a-zA-Z0-9._ ()-]"), "_")
            .replace(Regex("\\s+"), "_")
            .trim()
            .take(100)
            .ifEmpty { "cinebox_video.mp4" }
    }

    private fun sanitizeFolderName(name: String): String {
        return name.replace(Regex("[^a-zA-Z0-9._ ()-]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
            .take(64)
            .ifEmpty { "Series" }
    }
}
