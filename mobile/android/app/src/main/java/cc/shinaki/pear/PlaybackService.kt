package cc.shinaki.pear

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.media.app.NotificationCompat.MediaStyle
import androidx.media.session.MediaButtonReceiver
import java.net.URL
import java.util.concurrent.Executors

/**
 * Foreground service that keeps the process alive while music plays in the WebView,
 * and exposes it to Android (notification, lock screen, Bluetooth/headset buttons).
 */
class PlaybackService : Service() {
  companion object {
    private const val CHANNEL_ID = "playback"
    private const val NOTIFICATION_ID = 1

    private var instance: PlaybackService? = null
    private var latest: PlayerState? = null

    fun update(context: Context, state: PlayerState, background: Boolean) {
      if (!background) {
        stop(context)
        return
      }
      latest = state
      instance?.let {
        it.render(state)
        return
      }
      if (!state.playing) return // only start the service for actual playback
      try {
        ContextCompat.startForegroundService(context, Intent(context, PlaybackService::class.java))
      } catch (_: IllegalStateException) {
        // Background start not allowed (Android 12+); the next update while visible will start it.
      }
    }

    fun stop(context: Context) {
      latest = null
      context.stopService(Intent(context, PlaybackService::class.java))
    }
  }

  private lateinit var session: MediaSessionCompat
  private val main = Handler(Looper.getMainLooper())
  private val artLoader = Executors.newSingleThreadExecutor()
  private var artUrl: String? = null
  private var artBitmap: Bitmap? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onCreate() {
    super.onCreate()
    instance = this

    val nm = getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW).apply {
        setShowBadge(false)
      },
    )

    session = MediaSessionCompat(this, "Pear").apply {
      setCallback(object : MediaSessionCompat.Callback() {
        override fun onPlay() = PlayerBridge.control("play")
        override fun onPause() = PlayerBridge.control("pause")
        override fun onSkipToNext() = PlayerBridge.control("next")
        override fun onSkipToPrevious() = PlayerBridge.control("previous")
        override fun onSeekTo(pos: Long) = PlayerBridge.control("seek", pos)
        override fun onStop() = PlayerBridge.control("stop")
      })
      setSessionActivity(openAppIntent())
      isActive = true
    }

    wakeLock = getSystemService(PowerManager::class.java)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Pear:playback")
      .apply { setReferenceCounted(false) }
    @Suppress("DEPRECATION")
    wifiLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
      .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Pear:playback")
      .apply { setReferenceCounted(false) }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // startForeground must be called promptly after startForegroundService.
    render(latest ?: PlayerState("", "", "", "", false, 0, 0))
    if (PlayerBridge.controller == null) {
      // Started by a media button while the app (and its WebView) is gone: nothing to control.
      stopSelf()
      return START_NOT_STICKY
    }
    MediaButtonReceiver.handleIntent(session, intent)
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onTaskRemoved(rootIntent: Intent?) {
    // App swiped away from recents: the WebView is gone, so is the music.
    stopSelf()
  }

  override fun onDestroy() {
    instance = null
    releaseLocks()
    session.isActive = false
    session.release()
    artLoader.shutdownNow()
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  fun render(state: PlayerState) {
    if (state.playing) acquireLocks() else releaseLocks()

    val art = if (state.artwork == artUrl) artBitmap else null
    if (state.artwork.isNotEmpty() && state.artwork != artUrl) loadArtwork(state.artwork)

    session.setMetadata(
      MediaMetadataCompat.Builder()
        .putString(MediaMetadataCompat.METADATA_KEY_TITLE, state.title)
        .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, state.artist)
        .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, state.album)
        .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, state.duration)
        .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art)
        .build(),
    )
    session.setPlaybackState(
      PlaybackStateCompat.Builder()
        .setActions(
          PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
            PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
            PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or PlaybackStateCompat.ACTION_SEEK_TO or
            PlaybackStateCompat.ACTION_STOP,
        )
        .setState(
          if (state.playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
          state.position,
          if (state.playing) 1f else 0f,
        )
        .build(),
    )

    val playPause = if (state.playing) {
      NotificationCompat.Action(R.drawable.ic_pause, getString(R.string.action_pause), mediaAction(PlaybackStateCompat.ACTION_PAUSE))
    } else {
      NotificationCompat.Action(R.drawable.ic_play, getString(R.string.action_play), mediaAction(PlaybackStateCompat.ACTION_PLAY))
    }

    val notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_note)
      .setContentTitle(state.title.ifEmpty { getString(R.string.nothing_playing) })
      .setContentText(state.artist)
      .setSubText(state.album.ifEmpty { null })
      .setLargeIcon(art)
      .setContentIntent(openAppIntent())
      .setDeleteIntent(mediaAction(PlaybackStateCompat.ACTION_STOP))
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOnlyAlertOnce(true)
      .setOngoing(state.playing)
      .addAction(R.drawable.ic_previous, getString(R.string.action_previous), mediaAction(PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS))
      .addAction(playPause)
      .addAction(R.drawable.ic_next, getString(R.string.action_next), mediaAction(PlaybackStateCompat.ACTION_SKIP_TO_NEXT))
      .setStyle(MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
      .build()

    ServiceCompat.startForeground(
      this,
      NOTIFICATION_ID,
      notification,
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0,
    )
  }

  private fun loadArtwork(url: String) {
    artUrl = url
    artBitmap = null
    artLoader.execute {
      val bitmap = runCatching { URL(url).openStream().use { BitmapFactory.decodeStream(it) } }.getOrNull()
      main.post {
        if (artUrl == url && bitmap != null) {
          artBitmap = bitmap
          latest?.let { render(it) }
        }
      }
    }
  }

  private fun acquireLocks() {
    if (wakeLock?.isHeld == false) wakeLock?.acquire()
    if (wifiLock?.isHeld == false) wifiLock?.acquire()
  }

  private fun releaseLocks() {
    if (wakeLock?.isHeld == true) wakeLock?.release()
    if (wifiLock?.isHeld == true) wifiLock?.release()
  }

  private fun mediaAction(action: Long): PendingIntent =
    MediaButtonReceiver.buildMediaButtonPendingIntent(this, action)

  private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
    this,
    0,
    Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
  )
}
