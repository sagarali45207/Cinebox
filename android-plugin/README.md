# CineBox MovieBox-Style Android Native Downloader & ExoPlayer Setup

This directory contains the native Android Kotlin implementation powering CineBox's two-stage offline download engine, Room metadata database, MediaStore public exporter, Media3 ExoPlayer native player, and `ACTION_VIEW` External Player chooser.

## Architecture Overview

1. **Stage 1 — Private Persistent Offline Storage (`Cinebox/Downloads/`)**:
   - Stored inside `context.getExternalFilesDir(null)/Cinebox/Downloads/` (`Android/data/com.cinebox.app/files/Cinebox/Downloads/`), separated into `Movies/` and `Series/<Series Name>/Season <NN>/`, with temporary chunks in `Temp/`.
   - Files survive app restarts, cache clears, device reboots, and offline operation.
   - **Never stored in IndexedDB, WebView Cache Storage, or in-memory Blob URLs.**
2. **Stage 2 — "Transfer to Local Storage" (`MediaStoreTransferManager.kt`)**:
   - Copies verified Stage 1 private files into Android public storage (`Movies/Cinebox/` or `Downloads/Cinebox/`) via `MediaStore` with `IS_PENDING = 1`.
   - Zero re-download, zero transcoding, live byte progress, destination size verification, and independent deletion of exported vs. private copies.
3. **High-Performance WorkManager + Room Engine (`NativeChunkDownloadWorker.kt`, `DownloadDatabase.kt`)**:
   - Foreground service (`FOREGROUND_SERVICE_TYPE_DATA_SYNC`) for reliable background execution.
   - Parallel HTTP `Range` chunk downloading (`RandomAccessFile` direct-to-disk writes, `.ckpt` checkpoints) with automatic sequential fallback.
   - Full HLS offline package downloader (master variant matching, `#EXT-X-MAP` init segment, bounded concurrent segment fetches, local `index.m3u8`).
   - Adaptive `FREE` (conservative) and `PREMIUM` (higher bounded concurrency) profiles with HTTP 429 exponential backoff.
4. **Native Media3 ExoPlayer & External Player (`ExoPlayerActivity.kt`, `NativeDownloaderPlugin.kt`)**:
   - Verified offline playback from Stage 1 private files without online URL resolution.
   - Android-only `ACTION_VIEW` system chooser passing `FileProvider` `content://` URIs for offline exports/files or real stream URLs + MIME + headers (never `blob:` or `capacitor://`).

---

## Android Project Integration

### 1. Copy Kotlin Files into the Capacitor Android Project

Generate or sync the Capacitor Android platform if not yet created:

```bash
npm install
npm run build
npx cap add android   # first time only
npx cap sync android
```

Copy the Kotlin files from `android-plugin/` into `android/app/src/main/java/com/cinebox/app/`:

```text
android/app/src/main/java/com/cinebox/app/
├── plugins/
│   ├── NativeDownloaderPlugin.kt
│   └── CineBoxDownloaderPlugin.kt
├── downloader/
│   ├── DownloadDatabase.kt
│   ├── MediaStoreTransferManager.kt
│   └── NativeChunkDownloadWorker.kt
└── player/
    └── ExoPlayerActivity.kt
```

### 2. Add Dependencies to `android/app/build.gradle`

```groovy
dependencies {
    def room_version = "2.6.1"
    def work_version = "2.9.1"
    def media3_version = "1.4.1"

    implementation "androidx.room:room-runtime:$room_version"
    implementation "androidx.room:room-ktx:$room_version"
    kapt "androidx.room:room-compiler:$room_version" // or ksp(...)

    implementation "androidx.work:work-runtime-ktx:$work_version"
    implementation "org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1"

    implementation "androidx.media3:media3-exoplayer:$media3_version"
    implementation "androidx.media3:media3-exoplayer-hls:$media3_version"
    implementation "androidx.media3:media3-ui:$media3_version"
}
```

Ensure the `kotlin-kapt` (or `com.google.devtools.ksp`) plugin is enabled in `android/app/build.gradle`.

### 3. Update `android/app/src/main/res/xml/file_paths.xml`

Create or update `file_paths.xml` so `FileProvider` can safely share offline private files with external players (`VLC`, `MX Player`, `MPV`):

```xml
<?xml version="1.0" encoding="utf-8"?>
<paths>
    <external-files-path name="cinebox_private_downloads" path="Cinebox/Downloads/" />
    <external-files-path name="app_downloads" path="Downloads/" />
    <files-path name="internal_files" path="." />
    <cache-path name="cache" path="." />
</paths>
```

### 4. Update `android/app/src/main/AndroidManifest.xml`

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />

<!-- Inside <application> -->
<activity
    android:name="com.cinebox.app.player.ExoPlayerActivity"
    android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout|keyboardHidden"
    android:exported="false"
    android:theme="@style/Theme.AppCompat.NoActionBar" />

<service
    android:name="androidx.work.impl.foreground.SystemForegroundService"
    android:foregroundServiceType="dataSync"
    tools:node="merge" />
```

Make sure `<provider android:name="androidx.core.content.FileProvider" android:authorities="${applicationId}.fileprovider" ...>` points to `@xml/file_paths`.

### 5. Register Plugins in `MainActivity.kt`

```kotlin
package com.cinebox.app

import android.os.Bundle
import com.cinebox.app.plugins.CineBoxDownloaderPlugin
import com.cinebox.app.plugins.NativeDownloaderPlugin
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(NativeDownloaderPlugin::class.java)
        registerPlugin(CineBoxDownloaderPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
```

### 6. Build & Generate the APK

```bash
# 1. Build web bundle & sync Capacitor Android project
npm run build
npx cap sync android

# 2. Build Debug APK
cd android
./gradlew assembleDebug
# Output: android/app/build/outputs/apk/debug/app-debug.apk

# 3. Or build Release APK (configure signingConfig in build.gradle)
./gradlew assembleRelease
# Output: android/app/build/outputs/apk/release/app-release.apk
```
