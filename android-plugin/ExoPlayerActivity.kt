package com.cinebox.app.player

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.ui.PlayerView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Native Android Media3 ExoPlayer Activity for:
 * 1. Offline Stage-1 private playback (MP4, MKV, offline HLS index.m3u8) with zero network required.
 * 2. Online adaptive streaming (HLS master/variant playlists, MP4, MKV, MPEG-TS) with custom headers,
 *    audio & subtitle track switching, seeking, and resume position return.
 */
@OptIn(UnstableApi::class)
class ExoPlayerActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_URL_OR_PATH = "url_or_path"
        const val EXTRA_TITLE = "title"
        const val EXTRA_SUBTITLE = "subtitle"
        const val EXTRA_MIME_TYPE = "mime_type"
        const val EXTRA_RESUME_MS = "resume_ms"
        const val EXTRA_HEADERS_JSON = "headers_json"
        const val EXTRA_SUBTITLES_JSON = "subtitles_json"
        const val EXTRA_IS_OFFLINE = "is_offline"

        const val RESULT_POSITION_MS = "last_position_ms"
        const val RESULT_DURATION_MS = "duration_ms"
        const val RESULT_COMPLETED = "completed"
    }

    private var player: ExoPlayer? = null
    private lateinit var playerView: PlayerView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemBars()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF000000.toInt())
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(28, 24, 28, 12)
            setBackgroundColor(0x99000000.toInt())
        }

        val backBtn = ImageButton(this).apply {
            setImageResource(android.R.drawable.ic_media_previous)
            setBackgroundColor(0x00000000)
            setColorFilter(0xFFFFFFFF.toInt())
            contentDescription = "Back"
            setOnClickListener { finishWithResult() }
        }

        val titleView = TextView(this).apply {
            text = intent.getStringExtra(EXTRA_TITLE) ?: "CineBox Player"
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 16f
            setPadding(24, 8, 16, 8)
        }

        header.addView(backBtn)
        header.addView(titleView)

        playerView = PlayerView(this).apply {
            useController = true
            setShowSubtitleButton(true)
            setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
        }

        root.addView(header)
        root.addView(
            playerView,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )
        setContentView(root)

        initializePlayer()
    }

    private fun initializePlayer() {
        val rawSource = intent.getStringExtra(EXTRA_URL_OR_PATH)?.trim().orEmpty()
        if (rawSource.isEmpty()) {
            finish()
            return
        }

        val mimeType = intent.getStringExtra(EXTRA_MIME_TYPE)?.trim().orEmpty()
        val resumeMs = intent.getLongExtra(EXTRA_RESUME_MS, 0L).coerceAtLeast(0L)
        val headers = parseHeaders(intent.getStringExtra(EXTRA_HEADERS_JSON))
        val isOffline = intent.getBooleanExtra(EXTRA_IS_OFFLINE, false)

        val httpFactory = DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(20_000)
            .setReadTimeoutMs(30_000)
        if (headers.isNotEmpty()) {
            httpFactory.setDefaultRequestProperties(headers)
        }

        val dataSourceFactory = DefaultDataSource.Factory(this, httpFactory)
        val trackSelector = DefaultTrackSelector(this).apply {
            setParameters(
                buildUponParameters()
                    .setPreferredTextLanguage("en")
                    .setSelectUndeterminedTextLanguage(true)
            )
        }

        val exo = ExoPlayer.Builder(this)
            .setTrackSelector(trackSelector)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSourceFactory))
            .build()

        val uri = if (isOffline && !rawSource.contains("://")) {
            Uri.fromFile(File(rawSource))
        } else {
            Uri.parse(rawSource)
        }

        val resolvedMime = when {
            rawSource.contains(".m3u8", ignoreCase = true) ||
                mimeType.contains("mpegurl", ignoreCase = true) -> MimeTypes.APPLICATION_M3U8
            mimeType.isNotBlank() -> mimeType
            rawSource.endsWith(".mkv", ignoreCase = true) -> MimeTypes.VIDEO_MATROSKA
            else -> MimeTypes.VIDEO_MP4
        }

        val subtitleConfigs = parseOfflineSubtitles(intent.getStringExtra(EXTRA_SUBTITLES_JSON))
        val mediaItem = MediaItem.Builder()
            .setUri(uri)
            .setMimeType(resolvedMime)
            .setSubtitleConfigurations(subtitleConfigs)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(intent.getStringExtra(EXTRA_TITLE) ?: "CineBox")
                    .setSubtitle(intent.getStringExtra(EXTRA_SUBTITLE) ?: "")
                    .build()
            )
            .build()

        exo.setMediaItem(mediaItem)
        exo.prepare()
        if (resumeMs > 0L) {
            exo.seekTo(resumeMs)
        }
        exo.playWhenReady = true
        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED) {
                    finishWithResult(completed = true)
                }
            }
        })

        player = exo
        playerView.player = exo
    }

    private fun parseHeaders(rawJson: String?): Map<String, String> {
        if (rawJson.isNullOrBlank()) return emptyMap()
        return try {
            val obj = JSONObject(rawJson)
            val map = LinkedHashMap<String, String>()
            val keys = obj.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                val v = obj.optString(k, "")
                if (v.isNotEmpty()) map[k] = v
            }
            map
        } catch (_: Throwable) {
            emptyMap()
        }
    }

    private fun parseOfflineSubtitles(rawJson: String?): List<MediaItem.SubtitleConfiguration> {
        if (rawJson.isNullOrBlank()) return emptyList()
        return try {
            val arr = JSONArray(rawJson)
            val out = mutableListOf<MediaItem.SubtitleConfiguration>()
            val subDir = File(cacheDir, "exo_subtitles").apply { mkdirs() }
            for (i in 0 until arr.length()) {
                val item = arr.optJSONObject(i) ?: continue
                val vttText = item.optString("vttText", "")
                val lang = item.optString("language", "en")
                val label = item.optString("label", lang)
                if (vttText.isBlank()) continue
                val file = File(subDir, "sub_$i.vtt").apply { writeText(vttText) }
                out.add(
                    MediaItem.SubtitleConfiguration.Builder(Uri.fromFile(file))
                        .setMimeType(MimeTypes.TEXT_VTT)
                        .setLanguage(lang)
                        .setLabel(label)
                        .setSelectionFlags(if (i == 0) C.SELECTION_FLAG_DEFAULT else 0)
                        .build()
                )
            }
            out
        } catch (_: Throwable) {
            emptyList()
        }
    }

    private fun finishWithResult(completed: Boolean = false) {
        val pos = player?.currentPosition ?: 0L
        val dur = player?.duration?.coerceAtLeast(0L) ?: 0L
        setResult(
            Activity.RESULT_OK,
            Intent().apply {
                putExtra(RESULT_POSITION_MS, pos)
                putExtra(RESULT_DURATION_MS, dur)
                putExtra(RESULT_COMPLETED, completed)
            }
        )
        finish()
    }

    override fun onBackPressed() {
        finishWithResult()
    }

    override fun onStop() {
        super.onStop()
        player?.pause()
    }

    override fun onDestroy() {
        playerView.player = null
        player?.release()
        player = null
        super.onDestroy()
    }

    @Suppress("DEPRECATION")
    private fun hideSystemBars() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            )
    }
}
