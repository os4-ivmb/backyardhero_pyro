package com.backyardhero.hub.net

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object HubDefaults {
    const val HOST = "192.17.76.1"
    const val PORT = 80
    const val WS_PATH = "/ws"
    const val SSID_PREFIX = "BYH-Hub-"
    const val DEFAULT_PASSWORD = "backyardhero"
}

data class WifiNetworkInfo(
    val ssid: String,
    val levelDbm: Int,
    val frequencyMhz: Int,
    val secured: Boolean,
) {
    val looksLikeHub: Boolean get() = ssid.startsWith(HubDefaults.SSID_PREFIX)
    val signalBars: Int get() = WifiManager.calculateSignalLevel(levelDbm, 5)
}

sealed interface JoinState {
    data object Idle : JoinState
    data class Joining(val ssid: String) : JoinState
    data class Joined(val ssid: String) : JoinState
    data class Failed(val ssid: String, val reason: String) : JoinState
}

/**
 * WiFi side of finding a hub:
 *  - scanning for nearby networks (hub SSIDs sort first),
 *  - asking Android to join one from inside the app (WifiNetworkSpecifier),
 *  - tracking every WiFi network the phone is on so the hub client can probe
 *    each one for the hub's HTTP server, whichever way it was joined.
 */
class HubWifi(context: Context) {
    private val appContext = context.applicationContext
    private val wifiManager = appContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private val connectivity = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private val _scanResults = MutableStateFlow<List<WifiNetworkInfo>>(emptyList())
    val scanResults: StateFlow<List<WifiNetworkInfo>> = _scanResults.asStateFlow()

    private val _scanning = MutableStateFlow(false)
    val scanning: StateFlow<Boolean> = _scanning.asStateFlow()

    private val _joinState = MutableStateFlow<JoinState>(JoinState.Idle)
    val joinState: StateFlow<JoinState> = _joinState.asStateFlow()

    /** WiFi networks currently connected (system-joined or app-requested). */
    private val _wifiNetworks = MutableStateFlow<Set<Network>>(emptySet())
    val wifiNetworks: StateFlow<Set<Network>> = _wifiNetworks.asStateFlow()

    /** The network obtained through an in-app join, if any. Preferred for probing. */
    private val _requestedNetwork = MutableStateFlow<Network?>(null)
    val requestedNetwork: StateFlow<Network?> = _requestedNetwork.asStateFlow()

    private var joinCallback: ConnectivityManager.NetworkCallback? = null
    private var scanReceiverRegistered = false

    private val scanReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            _scanning.value = false
            publishScanResults()
        }
    }

    private val wifiCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            _wifiNetworks.value = _wifiNetworks.value + network
        }

        override fun onLost(network: Network) {
            _wifiNetworks.value = _wifiNetworks.value - network
        }
    }

    fun start() {
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            // The hub has no internet; don't let the default filter hide it.
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        connectivity.registerNetworkCallback(request, wifiCallback)
        if (!scanReceiverRegistered) {
            val filter = IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION)
            if (Build.VERSION.SDK_INT >= 33) {
                appContext.registerReceiver(scanReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                appContext.registerReceiver(scanReceiver, filter)
            }
            scanReceiverRegistered = true
        }
    }

    fun stop() {
        runCatching { connectivity.unregisterNetworkCallback(wifiCallback) }
        if (scanReceiverRegistered) {
            runCatching { appContext.unregisterReceiver(scanReceiver) }
            scanReceiverRegistered = false
        }
        releaseJoin()
    }

    val wifiEnabled: Boolean get() = wifiManager.isWifiEnabled

    /** Requires the scan permission (see [com.backyardhero.hub.ui.connect.wifiScanPermissions]). */
    @SuppressLint("MissingPermission")
    fun scan() {
        _scanning.value = true
        // startScan is throttled by Android (4 scans / 2 min in the foreground);
        // when refused, the cached results are still useful.
        @Suppress("DEPRECATION")
        val started = runCatching { wifiManager.startScan() }.getOrDefault(false)
        publishScanResults()
        if (!started) _scanning.value = false
    }

    @SuppressLint("MissingPermission")
    private fun publishScanResults() {
        val results = runCatching { wifiManager.scanResults }.getOrNull() ?: return
        val byName = LinkedHashMap<String, WifiNetworkInfo>()
        for (r in results) {
            val ssid = ssidOf(r)
            if (ssid.isBlank()) continue
            val info = WifiNetworkInfo(
                ssid = ssid,
                levelDbm = r.level,
                frequencyMhz = r.frequency,
                secured = r.capabilities.contains("WPA") || r.capabilities.contains("SAE"),
            )
            val existing = byName[ssid]
            if (existing == null || existing.levelDbm < info.levelDbm) byName[ssid] = info
        }
        _scanResults.value = byName.values.sortedWith(
            compareByDescending<WifiNetworkInfo> { it.looksLikeHub }.thenByDescending { it.levelDbm }
        )
    }

    @Suppress("DEPRECATION")
    private fun ssidOf(r: android.net.wifi.ScanResult): String =
        if (Build.VERSION.SDK_INT >= 33) {
            r.wifiSsid?.toString()?.removeSurrounding("\"") ?: ""
        } else {
            r.SSID ?: ""
        }

    /**
     * Ask Android to join [ssid] for this app. The system shows its own
     * confirmation dialog. The connection lasts while the app holds it.
     */
    fun join(ssid: String, password: String?) {
        releaseJoin()
        _joinState.value = JoinState.Joining(ssid)
        val spec = WifiNetworkSpecifier.Builder().setSsid(ssid).apply {
            if (!password.isNullOrEmpty()) setWpa2Passphrase(password)
        }.build()
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .setNetworkSpecifier(spec)
            .build()
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                _requestedNetwork.value = network
                _joinState.value = JoinState.Joined(ssid)
            }

            override fun onUnavailable() {
                _requestedNetwork.value = null
                _joinState.value = JoinState.Failed(ssid, "Couldn't join $ssid (cancelled, out of range, or wrong password)")
            }

            override fun onLost(network: Network) {
                if (_requestedNetwork.value == network) _requestedNetwork.value = null
                _joinState.value = JoinState.Failed(ssid, "Lost connection to $ssid")
            }
        }
        joinCallback = cb
        connectivity.requestNetwork(request, cb)
    }

    fun releaseJoin() {
        joinCallback?.let { runCatching { connectivity.unregisterNetworkCallback(it) } }
        joinCallback = null
        _requestedNetwork.value = null
        if (_joinState.value !is JoinState.Failed) _joinState.value = JoinState.Idle
    }

    fun clearJoinError() {
        if (_joinState.value is JoinState.Failed) _joinState.value = JoinState.Idle
    }
}
