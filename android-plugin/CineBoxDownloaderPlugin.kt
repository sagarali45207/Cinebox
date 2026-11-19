package com.cinebox.app.plugins

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap

@CapacitorPlugin(name = "CineBoxDownloader")
class CineBoxDownloaderPlugin : Plugin() {

    private data class ActiveTask(
        val taskId: String,
        val downloadId: Long,
        val fileName: String,
        val filePath: String,
        var lastBytes: Long = 0L,
        var lastTimestampMs: Long = System.currentTimeMillis()
    )

    companion object {
        private const val PREFS_NAME = "cinebox_native_downloads"
        private const val PREFS_TASKS_KEY = "persisted_tasks"
    }

    private val tasksById = ConcurrentHashMap<String, ActiveTask>()
    private val taskIdsByDownloadId = ConcurrentHashMap<Long, String>()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var receiverRegistered = false
    private var pollingActive = false

    private val completionReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
            val dmId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
            if (dmId <= 0L) return
            val taskId = taskIdsByDownloadId[dmId] ?: return
            queryAndEmitTaskState(taskId, emitTerminalOnly = true)
        }
    }

    private val progressRunnable = object : Runnable {
        override fun run() {
            if (tasksById.isEmpty()) {
                pollingActive = false
                return
            }
            for (taskId in tasksById.keys.toList()) {
                queryAndEmitTaskState(taskId, emitTerminalOnly = false)
            }
            if (tasksById.isNotEmpty()) {
                mainHandler.postDelayed(this, 850L)
            } else {
                pollingActive = false
            }
        }
    }

    override fun load() {
        super.load()
        rehydratePersistedTasks()
        if (!receiverRegistered) {
            val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ContextCompat.registerReceiver(
                    context,
                    completionReceiver,
                    filter,
                    ContextCompat.RECEIVER_EXPORTED
                )
            } else {
                context.registerReceiver(completionReceiver, filter)
            }
            receiverRegistered = true
        }
        if (tasksById.isNotEmpty() && !pollingActive) {
            pollingActive = true
            mainHandler.postDelayed(progressRunnable, 500L)
        }
    }

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        pollingActive = false
        mainHandler.removeCallbacks(progressRunnable)
        if (receiverRegistered) {
            try {
                context.unregisterReceiver(completionReceiver)
            } catch (_: Exception) {
            }
            receiverRegistered = false
        }
    }

    @PluginMethod
    fun startDownload(call: PluginCall) {
        val taskId = call.getString("taskId")?.trim().orEmpty()
        val rawUrl = call.getString("url")?.trim().orEmpty()
        val fileName = sanitizeFileName(call.getString("fileName") ?: "cinebox_video.mp4")
        val title = call.getString("title") ?: fileName
        val subtitle = call.getString("subtitle") ?: "Downloading offline video"
        val mimeType = call.getString("mimeType") ?: "video/mp4"
        val saveToPublic = call.getBoolean("saveToPublicDownloads", true) ?: true

        if (taskId.isEmpty() || rawUrl.isEmpty()) {
            call.reject("taskId and url are required")
            return
        }

        val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val saveToPublic = call.getBoolean("saveToPublicDownloads", false) ?: false

        val appSubFolder = if (saveToPublic) "Downloads" else "Cinebox/Downloads/Movies"
        val base = context.getExternalFilesDir(null) ?: context.filesDir
        val outFile = File(File(base, appSubFolder).apply { mkdirs() }, fileName)
        if (outFile.exists()) {
            outFile.delete()
        }

        val request = DownloadManager.Request(Uri.parse(rawUrl)).apply {
            setTitle(title)
            setDescription(subtitle)
            setMimeType(mimeType)
            setAllowedNetworkTypes(
                DownloadManager.Request.NETWORK_WIFI or DownloadManager.Request.NETWORK_MOBILE
            )
            setAllowedOverMetered(true)
            setAllowedOverRoaming(true)
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            setDestinationUri(Uri.fromFile(outFile))

            val headersObj = call.getObject("headers")
            if (headersObj != null) {
                val keys = headersObj.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    val value = headersObj.optString(key, "")
                    if (value.isNotEmpty()) {
                        addRequestHeader(key, value)
                    }
                }
            }
        }

        val downloadId = dm.enqueue(request)
        val fileUri = Uri.fromFile(outFile).toString()
        val task = ActiveTask(
            taskId = taskId,
            downloadId = downloadId,
            fileName = fileName,
            filePath = fileUri
        )
        tasksById[taskId] = task
        taskIdsByDownloadId[downloadId] = taskId
        persistTasksRegistry()

        if (!pollingActive) {
            pollingActive = true
            mainHandler.postDelayed(progressRunnable, 600L)
        }

        val result = JSObject().apply {
            put("taskId", taskId)
            put("downloadId", downloadId)
            put("filePath", fileUri)
        }
        call.resolve(result)
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) {
        val taskId = call.getString("taskId")?.trim().orEmpty()
        val task = tasksById.remove(taskId)
        if (task != null) {
            taskIdsByDownloadId.remove(task.downloadId)
            persistTasksRegistry()
            val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            dm.remove(task.downloadId)
            notifyListeners("downloadStateChange", JSObject().apply {
                put("taskId", taskId)
                put("status", "cancelled")
            })
        }
        call.resolve()
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        val taskId = call.getString("taskId")?.trim().orEmpty()
        val statusObj = queryTaskStatus(taskId)
        if (statusObj == null) {
            call.reject("Download task not found")
            return
        }
        call.resolve(statusObj)
    }

    @PluginMethod
    fun listActiveTasks(call: PluginCall) {
        val arr = JSArray()
        for (taskId in tasksById.keys.toList()) {
            val statusObj = queryTaskStatus(taskId)
            if (statusObj != null) {
                arr.put(statusObj)
            }
        }
        call.resolve(JSObject().apply { put("tasks", arr) })
    }

    @PluginMethod
    fun listDownloads(call: PluginCall) {
        val arr = JSArray()
        val dirs = listOfNotNull(
            context.getExternalFilesDir(Environment.DIRECTORY_MOVIES)?.let { File(it, "CineBox") },
            File(context.filesDir, "CineBox")
        )
        for (dir in dirs) {
            if (!dir.exists() || !dir.isDirectory) continue
            dir.listFiles()?.forEach { file ->
                if (file.isFile) {
                    arr.put(JSObject().apply {
                        put("taskId", file.nameWithoutExtension)
                        put("fileName", file.name)
                        put("filePath", Uri.fromFile(file).toString())
                        put("sizeBytes", file.length())
                    })
                }
            }
        }
        call.resolve(JSObject().apply { put("downloads", arr) })
    }

    @PluginMethod
    fun deleteFile(call: PluginCall) {
        val rawPath = call.getString("filePath")?.trim().orEmpty()
        if (rawPath.isNotEmpty()) {
            val file = if (rawPath.startsWith("file://")) {
                File(Uri.parse(rawPath).path ?: "")
            } else {
                File(rawPath)
            }
            if (file.exists()) {
                file.delete()
            }
        }
        call.resolve()
    }

    @PluginMethod
    fun getPlayableUrl(call: PluginCall) {
        val rawPath = call.getString("filePath")?.trim().orEmpty()
        call.resolve(JSObject().apply { put("url", rawPath) })
    }

    private fun rehydratePersistedTasks() {
        try {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val raw = prefs.getString(PREFS_TASKS_KEY, null) ?: return
            val root = JSONObject(raw)
            val keys = root.keys()
            while (keys.hasNext()) {
                val taskId = keys.next()
                val obj = root.optJSONObject(taskId) ?: continue
                val downloadId = obj.optLong("downloadId", -1L)
                val fileName = obj.optString("fileName", "cinebox_video.mp4")
                val filePath = obj.optString("filePath", "")
                if (downloadId <= 0L || filePath.isEmpty()) continue
                val task = ActiveTask(
                    taskId = taskId,
                    downloadId = downloadId,
                    fileName = fileName,
                    filePath = filePath
                )
                tasksById[taskId] = task
                taskIdsByDownloadId[downloadId] = taskId
            }
        } catch (_: Exception) {
        }
    }

    private fun persistTasksRegistry() {
        try {
            val root = JSONObject()
            for ((taskId, task) in tasksById.entries) {
                root.put(taskId, JSONObject().apply {
                    put("downloadId", task.downloadId)
                    put("fileName", task.fileName)
                    put("filePath", task.filePath)
                })
            }
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(PREFS_TASKS_KEY, root.toString())
                .apply()
        } catch (_: Exception) {
        }
    }

    private fun removePersistedTask(taskId: String) {
        val task = tasksById.remove(taskId)
        if (task != null) {
            taskIdsByDownloadId.remove(task.downloadId)
            persistTasksRegistry()
        }
    }

    private fun queryTaskStatus(taskId: String): JSObject? {
        val task = tasksById[taskId] ?: return null
        val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val query = DownloadManager.Query().setFilterById(task.downloadId)
        var cursor: Cursor? = null
        try {
            cursor = dm.query(query)
            if (cursor == null || !cursor.moveToFirst()) return null

            val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
            val bytesLoaded = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
            val bytesTotal = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
            val reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))

            val waitingForNetwork = status == DownloadManager.STATUS_PAUSED && (
                reason == DownloadManager.PAUSED_WAITING_FOR_NETWORK ||
                    reason == DownloadManager.PAUSED_QUEUED_FOR_WIFI ||
                    reason == DownloadManager.PAUSED_WAITING_TO_RETRY
                )

            val mappedStatus = when (status) {
                DownloadManager.STATUS_PENDING -> "queued"
                DownloadManager.STATUS_RUNNING, DownloadManager.STATUS_PAUSED -> "downloading"
                DownloadManager.STATUS_SUCCESSFUL -> "completed"
                DownloadManager.STATUS_FAILED -> "failed"
                else -> "downloading"
            }

            return JSObject().apply {
                put("taskId", taskId)
                put("status", mappedStatus)
                put("receivedBytes", bytesLoaded.coerceAtLeast(0L))
                put("totalBytes", bytesTotal.coerceAtLeast(0L))
                put("filePath", task.filePath)
                put("waitingForNetwork", waitingForNetwork)
                if (mappedStatus == "failed") {
                    put("error", "Native DownloadManager error (code $reason)")
                }
            }
        } finally {
            cursor?.close()
        }
    }

    private fun queryAndEmitTaskState(taskId: String, emitTerminalOnly: Boolean) {
        val task = tasksById[taskId] ?: return
        val statusObj = queryTaskStatus(taskId) ?: return
        val status = statusObj.getString("status") ?: "downloading"
        val received = statusObj.optLong("receivedBytes", 0L)
        val total = statusObj.optLong("totalBytes", 0L)
        val waitingForNetwork = statusObj.optBoolean("waitingForNetwork", false)

        if (!emitTerminalOnly && (status == "downloading" || status == "queued")) {
            val nowMs = System.currentTimeMillis()
            val dtSec = ((nowMs - task.lastTimestampMs).coerceAtLeast(1L)) / 1000.0
            val speed = if (waitingForNetwork) 0L else ((received - task.lastBytes).coerceAtLeast(0L) / dtSec).toLong()
            task.lastBytes = received
            task.lastTimestampMs = nowMs

            val percent = if (total > 0L) ((received * 100L) / total).toInt().coerceIn(0, 99) else 0
            notifyListeners("downloadProgress", JSObject().apply {
                put("taskId", taskId)
                put("receivedBytes", received)
                put("totalBytes", total)
                put("percent", percent)
                put("speedBytesPerSec", speed)
                put("waitingForNetwork", waitingForNetwork)
            })
        }

        if (status == "completed" || status == "failed") {
            removePersistedTask(taskId)
            notifyListeners("downloadStateChange", statusObj)
        }
    }

    private fun sanitizeFileName(name: String): String {
        return name.replace(Regex("[^a-zA-Z0-9._-]"), "_").take(100).ifEmpty { "cinebox_video.mp4" }
    }
}
