package com.cinebox.app.downloader

import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream

/**
 * Handles Stage 2 ("Transfer to Local Storage"):
 * - Copies completed verified Stage-1 private file -> Android public MediaStore
 *   (Movies/Cinebox/ or Downloads/Cinebox/).
 * - Zero re-download and zero video transcoding.
 * - Verifies destination byte count before marking exported.
 * - Keeps original Stage-1 private offline copy intact (and allows retrying on failure).
 * - Supports independent deletion of the exported MediaStore copy.
 */
object MediaStoreTransferManager {

    data class TransferOutcome(
        val exportedUri: String,
        val exportedPath: String,
        val sizeBytes: Long,
        val verified: Boolean
    )

    suspend fun exportToPublicStorage(
        context: Context,
        sourcePathOrUri: String,
        fileName: String,
        mimeType: String,
        destination: String = "movies", // "movies" | "downloads"
        onProgress: (copiedBytes: Long, totalBytes: Long, percent: Int) -> Unit
    ): TransferOutcome = withContext(Dispatchers.IO) {
        val sourceFile = resolveLocalFile(sourcePathOrUri)
            ?: throw IllegalArgumentException("Private offline file path is invalid: $sourcePathOrUri")

        if (!sourceFile.exists() || !sourceFile.isFile) {
            throw IllegalStateException("Private offline file does not exist on disk.")
        }

        val totalBytes = sourceFile.length()
        if (totalBytes <= 0L) {
            throw IllegalStateException("Private offline file is empty (0 bytes).")
        }

        val safeName = sanitizeExportFileName(fileName.ifBlank { sourceFile.name })
        val resolvedMime = mimeType.ifBlank { inferMimeType(safeName) }
        val isDownloadDest = destination.equals("downloads", ignoreCase = true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val resolver = context.contentResolver
            val subFolder = if (isDownloadDest) {
                "${Environment.DIRECTORY_DOWNLOADS}/Cinebox"
            } else {
                "${Environment.DIRECTORY_MOVIES}/Cinebox"
            }

            val collection: Uri = if (isDownloadDest) {
                MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            } else {
                MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            }

            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, safeName)
                put(MediaStore.MediaColumns.MIME_TYPE, resolvedMime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, subFolder)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }

            val itemUri = resolver.insert(collection, values)
                ?: throw IllegalStateException("Android MediaStore refused to create destination entry.")

            var copiedBytes = 0L
            try {
                resolver.openOutputStream(itemUri, "w")?.use { output ->
                    FileInputStream(sourceFile).use { input ->
                        val buffer = ByteArray(256 * 1024)
                        var read: Int
                        var lastEmitMs = 0L
                        while (input.read(buffer).also { read = it } != -1) {
                            output.write(buffer, 0, read)
                            copiedBytes += read
                            val now = System.currentTimeMillis()
                            if (now - lastEmitMs >= 160L || copiedBytes == totalBytes) {
                                lastEmitMs = now
                                val pct = ((copiedBytes * 100L) / totalBytes).toInt().coerceIn(0, 99)
                                onProgress(copiedBytes, totalBytes, pct)
                            }
                        }
                        output.flush()
                    }
                } ?: throw IllegalStateException("Unable to open MediaStore output stream.")

                // Verify exact byte size match before clearing IS_PENDING
                if (copiedBytes != totalBytes) {
                    throw IllegalStateException(
                        "Exported size mismatch ($copiedBytes of $totalBytes bytes copied)."
                    )
                }

                val finalizeValues = ContentValues().apply {
                    put(MediaStore.MediaColumns.IS_PENDING, 0)
                }
                resolver.update(itemUri, finalizeValues, null, null)

                val verifiedSize = queryUriSize(resolver, itemUri)
                if (verifiedSize > 0L && verifiedSize != totalBytes) {
                    throw IllegalStateException(
                        "Verified MediaStore size ($verifiedSize) does not match source ($totalBytes)."
                    )
                }

                onProgress(totalBytes, totalBytes, 100)
                return@withContext TransferOutcome(
                    exportedUri = itemUri.toString(),
                    exportedPath = "$subFolder/$safeName",
                    sizeBytes = totalBytes,
                    verified = true
                )
            } catch (err: Throwable) {
                try {
                    resolver.delete(itemUri, null, null)
                } catch (_: Throwable) {
                }
                throw err
            }
        } else {
            // Android 9 (API <= 28) fallback
            @Suppress("DEPRECATION")
            val basePublicDir = if (isDownloadDest) {
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            } else {
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES)
            }
            val cineboxDir = File(basePublicDir, "Cinebox").apply { mkdirs() }
            val destFile = File(cineboxDir, safeName)
            var copiedBytes = 0L
            try {
                FileInputStream(sourceFile).use { input ->
                    destFile.outputStream().use { output ->
                        val buffer = ByteArray(256 * 1024)
                        var read: Int
                        var lastEmitMs = 0L
                        while (input.read(buffer).also { read = it } != -1) {
                            output.write(buffer, 0, read)
                            copiedBytes += read
                            val now = System.currentTimeMillis()
                            if (now - lastEmitMs >= 160L || copiedBytes == totalBytes) {
                                lastEmitMs = now
                                val pct = ((copiedBytes * 100L) / totalBytes).toInt().coerceIn(0, 99)
                                onProgress(copiedBytes, totalBytes, pct)
                            }
                        }
                        output.flush()
                    }
                }
                if (!destFile.exists() || destFile.length() != totalBytes) {
                    destFile.delete()
                    throw IllegalStateException("Verified destination file size mismatch.")
                }
                onProgress(totalBytes, totalBytes, 100)
                return@withContext TransferOutcome(
                    exportedUri = Uri.fromFile(destFile).toString(),
                    exportedPath = destFile.absolutePath,
                    sizeBytes = totalBytes,
                    verified = true
                )
            } catch (err: Throwable) {
                destFile.delete()
                throw err
            }
        }
    }

    suspend fun deleteExportedCopy(context: Context, exportedUriOrPath: String): Boolean =
        withContext(Dispatchers.IO) {
            if (exportedUriOrPath.isBlank()) return@withContext true
            return@withContext try {
                val uri = Uri.parse(exportedUriOrPath)
                if (uri.scheme == ContentResolver.SCHEME_CONTENT) {
                    context.contentResolver.delete(uri, null, null) > 0
                } else {
                    val file = resolveLocalFile(exportedUriOrPath)
                    file?.delete() ?: false
                }
            } catch (_: Throwable) {
                false
            }
        }

    fun getExternalPlayableUri(context: Context, pathOrUri: String): Uri {
        val parsed = Uri.parse(pathOrUri)
        if (parsed.scheme == ContentResolver.SCHEME_CONTENT ||
            parsed.scheme == "http" ||
            parsed.scheme == "https"
        ) {
            return parsed
        }
        val file = resolveLocalFile(pathOrUri)
            ?: throw IllegalArgumentException("Cannot resolve local file for external player: $pathOrUri")
        val authority = "${context.packageName}.fileprovider"
        return FileProvider.getUriForFile(context, authority, file)
    }

    fun resolveLocalFile(rawPathOrUri: String): File? {
        if (rawPathOrUri.isBlank()) return null
        return if (rawPathOrUri.startsWith("file://")) {
            Uri.parse(rawPathOrUri).path?.let { File(it) }
        } else {
            File(rawPathOrUri)
        }
    }

    private fun queryUriSize(resolver: ContentResolver, uri: Uri): Long {
        return try {
            resolver.query(uri, arrayOf(MediaStore.MediaColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getLong(0) else -1L
            } ?: -1L
        } catch (_: Throwable) {
            -1L
        }
    }

    private fun sanitizeExportFileName(name: String): String {
        return name.replace(Regex("[^a-zA-Z0-9._ ()-]"), "_")
            .replace(Regex("\\s+"), " ")
            .trim()
            .take(120)
            .ifEmpty { "cinebox_video.mp4" }
    }

    private fun inferMimeType(name: String): String {
        return when (name.substringAfterLast('.', "").lowercase()) {
            "mkv" -> "video/x-matroska"
            "webm" -> "video/webm"
            "ts" -> "video/mp2t"
            "m3u8" -> "application/vnd.apple.mpegurl"
            "mov" -> "video/quicktime"
            "avi" -> "video/x-msvideo"
            else -> "video/mp4"
        }
    }
}
