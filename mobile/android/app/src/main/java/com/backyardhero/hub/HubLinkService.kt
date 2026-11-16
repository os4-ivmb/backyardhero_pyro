package com.backyardhero.hub

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the phone working as the host while the screen is off.
 *
 * [com.backyardhero.hub.session.HubSession] runs on the view model's scope,
 * so it outlives the activity, but with the screen off Android lets the CPU
 * sleep and puts Wi-Fi into power save. The dongle's gpio_status frames then
 * stop being read, and a press on a bound header input (5–8) never reaches
 * the sequencer. A timeline show's cue timing stalls the same way.
 *
 * While this service runs it holds a partial wake lock and a Wi-Fi lock, and
 * being a foreground service keeps the process out of Doze's network and
 * wake-lock restrictions. [AppViewModel] starts it while a hub is linked or
 * a show is loaded, and stops it otherwise.
 */
class HubLinkService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: lastText ?: DEFAULT_TEXT
        lastText = text
        // Must be called promptly after startForegroundService(), every time.
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(this, text),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
        )
        acquireLocks()
        running = true
        // If the system kills the process, the session (and the loaded show)
        // is gone with it, so there is nothing to keep alive on restart.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        releaseLocks()
        super.onDestroy()
    }

    @SuppressLint("WakelockTimeout")
    private fun acquireLocks() {
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "byh:hub-link").apply {
                setReferenceCounted(false)
                // Released in onDestroy. A show night won't outlast this.
                acquire(WAKE_LOCK_MAX_MS)
            }
        }
        if (wifiLock == null) {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            // HIGH_PERF keeps Wi-Fi out of power save with the screen off;
            // LOW_LATENCY only applies while the screen is on.
            @Suppress("DEPRECATION")
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "byh:hub-link").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
    }

    private fun releaseLocks() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        wifiLock?.let { if (it.isHeld) it.release() }
        wifiLock = null
    }

    companion object {
        private const val TAG = "HubLinkService"
        private const val CHANNEL_ID = "hub_link"
        private const val NOTIFICATION_ID = 1
        private const val EXTRA_TEXT = "text"
        private const val DEFAULT_TEXT = "Keeping the hub link alive"
        private const val WAKE_LOCK_MAX_MS = 12L * 60 * 60 * 1000

        @Volatile private var running = false
        @Volatile private var lastText: String? = null

        /**
         * Start, update or stop the service. [text] null stops it; otherwise
         * it's the notification line. Safe to call repeatedly.
         */
        fun sync(context: Context, text: String?) {
            val app = context.applicationContext
            if (text == null) {
                lastText = null
                if (running) app.stopService(Intent(app, HubLinkService::class.java))
                return
            }
            if (running) {
                if (text == lastText) return
                lastText = text
                // A plain notify works from the background, where a second
                // startForegroundService() might not be allowed.
                ensureChannel(app)
                app.getSystemService(NotificationManager::class.java)
                    .notify(NOTIFICATION_ID, buildNotification(app, text))
                return
            }
            lastText = text
            try {
                ContextCompat.startForegroundService(
                    app,
                    Intent(app, HubLinkService::class.java).putExtra(EXTRA_TEXT, text),
                )
            } catch (e: IllegalStateException) {
                // ForegroundServiceStartNotAllowedException (API 31+) when the
                // app is already in the background. The next sync from the
                // foreground starts it.
                Log.w(TAG, "Couldn't start the hub link service", e)
            }
        }

        private fun ensureChannel(context: Context) {
            val nm = context.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL_ID) != null) return
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Hub link", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while the phone keeps the hub link running with the screen off"
                    setShowBadge(false)
                }
            )
        }

        private fun buildNotification(context: Context, text: String): Notification {
            val open = context.packageManager.getLaunchIntentForPackage(context.packageName)
            val pending = open?.let {
                PendingIntent.getActivity(
                    context, 0, it,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
            }
            return NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_hub)
                .setContentTitle("BYH Hub is running")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setContentIntent(pending)
                .build()
        }
    }
}
