package com.cinebox.app.downloader

import android.content.Context
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

/**
 * Room Entity persisting every Stage-1 private download and Stage-2 MediaStore export state.
 * Survives app restarts, device reboots, cache clears, and offline restarts.
 */
@Entity(tableName = "download_items")
data class DownloadEntity(
    @PrimaryKey
    @ColumnInfo(name = "task_id")
    val taskId: String,

    @ColumnInfo(name = "download_id")
    val downloadId: Long = -1L,

    @ColumnInfo(name = "media_id")
    val mediaId: String = "",

    @ColumnInfo(name = "kind")
    val kind: String = "movie", // "movie" | "series" | "downloads"

    @ColumnInfo(name = "title")
    val title: String,

    @ColumnInfo(name = "subtitle")
    val subtitle: String = "",

    @ColumnInfo(name = "series_title")
    val seriesTitle: String = "",

    @ColumnInfo(name = "season_num")
    val seasonNum: Int = 0,

    @ColumnInfo(name = "episode_num")
    val episodeNum: Int = 0,

    @ColumnInfo(name = "selected_quality")
    val selectedQuality: String = "720p",

    @ColumnInfo(name = "source_url")
    val sourceUrl: String,

    @ColumnInfo(name = "headers_json")
    val headersJson: String = "{}",

    @ColumnInfo(name = "file_name")
    val fileName: String,

    @ColumnInfo(name = "file_path")
    val filePath: String,

    @ColumnInfo(name = "temp_path")
    val tempPath: String = "",

    @ColumnInfo(name = "hls_manifest_path")
    val hlsManifestPath: String = "",

    @ColumnInfo(name = "mime_type")
    val mimeType: String = "video/mp4",

    @ColumnInfo(name = "received_bytes")
    val receivedBytes: Long = 0L,

    @ColumnInfo(name = "total_bytes")
    val totalBytes: Long = 0L,

    @ColumnInfo(name = "speed_bytes_per_sec")
    val speedBytesPerSec: Long = 0L,

    @ColumnInfo(name = "eta_seconds")
    val etaSeconds: Long = 0L,

    @ColumnInfo(name = "status")
    val status: String = "queued", // queued | downloading | paused | completed | failed | cancelled

    @ColumnInfo(name = "retry_count")
    val retryCount: Int = 0,

    @ColumnInfo(name = "last_checkpoint")
    val lastCheckpoint: String = "",

    @ColumnInfo(name = "transfer_status")
    val transferStatus: String = "not_exported", // not_exported | transferring | exported | transfer_failed

    @ColumnInfo(name = "transfer_progress")
    val transferProgress: Int = 0,

    @ColumnInfo(name = "exported_uri")
    val exportedUri: String = "",

    @ColumnInfo(name = "exported_path")
    val exportedPath: String = "",

    @ColumnInfo(name = "transfer_error")
    val transferError: String = "",

    @ColumnInfo(name = "download_profile")
    val downloadProfile: String = "free", // free | premium

    @ColumnInfo(name = "is_verified_playable")
    val isVerifiedPlayable: Boolean = false,

    @ColumnInfo(name = "error_message")
    val errorMessage: String = "",

    @ColumnInfo(name = "created_at")
    val createdAt: Long = System.currentTimeMillis(),

    @ColumnInfo(name = "updated_at")
    val updatedAt: Long = System.currentTimeMillis()
)

@Dao
interface DownloadDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: DownloadEntity)

    @Query("SELECT * FROM download_items WHERE task_id = :taskId LIMIT 1")
    suspend fun getById(taskId: String): DownloadEntity?

    @Query("SELECT * FROM download_items ORDER BY updated_at DESC")
    suspend fun getAll(): List<DownloadEntity>

    @Query("SELECT * FROM download_items WHERE status IN ('queued', 'downloading', 'paused') ORDER BY updated_at DESC")
    suspend fun getActiveTasks(): List<DownloadEntity>

    @Query("SELECT * FROM download_items WHERE status = 'completed' ORDER BY updated_at DESC")
    suspend fun getCompletedDownloads(): List<DownloadEntity>

    @Query("SELECT * FROM download_items ORDER BY updated_at DESC")
    fun observeAll(): Flow<List<DownloadEntity>>

    @Query(
        """
        UPDATE download_items
        SET received_bytes = :receivedBytes,
            total_bytes = :totalBytes,
            speed_bytes_per_sec = :speedBytesPerSec,
            eta_seconds = :etaSeconds,
            status = :status,
            last_checkpoint = :checkpoint,
            updated_at = :updatedAt
        WHERE task_id = :taskId
        """
    )
    suspend fun updateProgress(
        taskId: String,
        receivedBytes: Long,
        totalBytes: Long,
        speedBytesPerSec: Long,
        etaSeconds: Long,
        status: String,
        checkpoint: String,
        updatedAt: Long = System.currentTimeMillis()
    )

    @Query(
        """
        UPDATE download_items
        SET status = :status,
            error_message = :errorMessage,
            retry_count = :retryCount,
            updated_at = :updatedAt
        WHERE task_id = :taskId
        """
    )
    suspend fun updateStatus(
        taskId: String,
        status: String,
        errorMessage: String = "",
        retryCount: Int = 0,
        updatedAt: Long = System.currentTimeMillis()
    )

    @Query(
        """
        UPDATE download_items
        SET status = 'completed',
            file_path = :filePath,
            hls_manifest_path = :hlsManifestPath,
            received_bytes = :finalBytes,
            total_bytes = :finalBytes,
            speed_bytes_per_sec = 0,
            eta_seconds = 0,
            is_verified_playable = :verified,
            error_message = '',
            updated_at = :updatedAt
        WHERE task_id = :taskId
        """
    )
    suspend fun markCompleted(
        taskId: String,
        filePath: String,
        hlsManifestPath: String,
        finalBytes: Long,
        verified: Boolean,
        updatedAt: Long = System.currentTimeMillis()
    )

    @Query(
        """
        UPDATE download_items
        SET transfer_status = :transferStatus,
            transfer_progress = :transferProgress,
            exported_uri = :exportedUri,
            exported_path = :exportedPath,
            transfer_error = :transferError,
            updated_at = :updatedAt
        WHERE task_id = :taskId
        """
    )
    suspend fun updateTransferState(
        taskId: String,
        transferStatus: String,
        transferProgress: Int,
        exportedUri: String,
        exportedPath: String,
        transferError: String = "",
        updatedAt: Long = System.currentTimeMillis()
    )

    @Query("DELETE FROM download_items WHERE task_id = :taskId")
    suspend fun deleteById(taskId: String)
}

@Database(
    entities = [DownloadEntity::class],
    version = 1,
    exportSchema = false
)
abstract class CineBoxDownloadDatabase : RoomDatabase() {
    abstract fun downloadDao(): DownloadDao

    companion object {
        @Volatile
        private var INSTANCE: CineBoxDownloadDatabase? = null

        fun getInstance(context: Context): CineBoxDownloadDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    CineBoxDownloadDatabase::class.java,
                    "cinebox_downloads_room.db"
                )
                    .fallbackToDestructiveMigration()
                    .build()
                    .also { INSTANCE = it }
            }
        }
    }
}
