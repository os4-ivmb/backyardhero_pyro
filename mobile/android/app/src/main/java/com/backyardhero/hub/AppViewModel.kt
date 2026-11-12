package com.backyardhero.hub

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import android.content.Context
import com.backyardhero.hub.net.ActiveLink
import com.backyardhero.hub.net.HubClient
import com.backyardhero.hub.net.HubWifi
import com.backyardhero.hub.net.LinkMode
import com.backyardhero.hub.net.LinkState
import com.backyardhero.hub.net.UsbLink
import com.backyardhero.hub.session.HubSession
import com.backyardhero.hub.show.Show
import com.backyardhero.hub.show.ShowParseException
import com.backyardhero.hub.show.ShowParser
import com.backyardhero.hub.show.ShowStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class AppViewModel(app: Application) : AndroidViewModel(app) {
    val wifi = HubWifi(app)
    private val wifiClient = HubClient(viewModelScope)
    private val usbLink = UsbLink(app, viewModelScope)
    val client = ActiveLink(viewModelScope, wifiClient, usbLink)
    val session = HubSession(app, viewModelScope, client)
    private val linkPrefs = app.getSharedPreferences(LINK_PREFS, Context.MODE_PRIVATE)
    private val showStore = ShowStore(app)

    private val _shows = MutableStateFlow<List<Show>>(emptyList())
    val shows: StateFlow<List<Show>> = _shows.asStateFlow()

    /** Ticks twice a second so freshness / countdowns redraw. */
    private val _now = MutableStateFlow(System.currentTimeMillis())
    val now: StateFlow<Long> = _now.asStateFlow()

    /** True once a hub connection has succeeded this session. */
    private val _hasConnected = MutableStateFlow(false)
    val hasConnected: StateFlow<Boolean> = _hasConnected.asStateFlow()

    init {
        wifi.start()
        session.start()
        client.setMode(LinkMode.fromStored(linkPrefs.getString(KEY_LINK_MODE, null)))
        viewModelScope.launch {
            combine(wifi.requestedNetwork, wifi.wifiNetworks) { requested, all ->
                listOfNotNull(requested) + all.filter { it != requested }
            }.collect { wifiClient.setCandidates(it) }
        }
        viewModelScope.launch {
            client.state.collect { if (it is LinkState.Connected) _hasConnected.value = true }
        }
        viewModelScope.launch {
            while (true) {
                _now.value = System.currentTimeMillis()
                delay(500)
            }
        }
        viewModelScope.launch {
            _shows.value = withContext(Dispatchers.IO) { showStore.list() }
        }
    }

    fun setLinkMode(mode: LinkMode) {
        if (mode == client.mode.value) return
        linkPrefs.edit().putString(KEY_LINK_MODE, LinkMode.stored(mode)).apply()
        _hasConnected.value = false
        if (mode == LinkMode.USB) wifi.releaseJoin()
        client.setMode(mode)
    }

    fun forgetHub() {
        _hasConnected.value = false
        when (client.mode.value) {
            LinkMode.WIRELESS -> {
                wifi.releaseJoin()
                client.reconnectWifi()
            }
            LinkMode.USB -> client.holdUsb()
        }
    }

    /** Returns an error message, or null on success. */
    suspend fun importShow(uri: Uri): String? = withContext(Dispatchers.IO) {
        val ctx = getApplication<Application>()
        val name = ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
            ?.substringBeforeLast('.')
            ?: "Imported show"
        val text = runCatching {
            ctx.contentResolver.openInputStream(uri)?.use { it.readBytes().decodeToString() }
        }.getOrNull() ?: return@withContext "Couldn't read the file"
        try {
            val show = ShowParser.parse(text, name)
            showStore.save(show)
            _shows.value = showStore.list()
            null
        } catch (e: ShowParseException) {
            e.message
        }
    }

    /** Remap every cue on the loaded show from [from] to [to], and save it. */
    fun swapLoadedReceiver(from: String, to: String) {
        val updated = session.swapLoadedReceiver(from, to) ?: return
        viewModelScope.launch(Dispatchers.IO) {
            showStore.save(updated)
            _shows.value = showStore.list()
        }
    }

    fun deleteShow(show: Show) {
        viewModelScope.launch(Dispatchers.IO) {
            showStore.delete(show)
            _shows.value = showStore.list()
        }
    }

    override fun onCleared() {
        client.close()
        wifi.stop()
        super.onCleared()
    }

    companion object {
        private const val LINK_PREFS = "hub_link"
        private const val KEY_LINK_MODE = "mode"
    }
}
