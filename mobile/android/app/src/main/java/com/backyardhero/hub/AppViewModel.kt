package com.backyardhero.hub

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import android.content.Context
import com.backyardhero.hub.cloud.CloudClient
import com.backyardhero.hub.cloud.CloudException
import com.backyardhero.hub.cloud.CloudShowInfo
import com.backyardhero.hub.net.ActiveLink
import com.backyardhero.hub.net.HubClient
import com.backyardhero.hub.net.HubWifi
import com.backyardhero.hub.net.LinkMode
import com.backyardhero.hub.net.LinkState
import com.backyardhero.hub.net.UsbLink
import com.backyardhero.hub.session.HubSession
import com.backyardhero.hub.session.ShowPhase
import com.backyardhero.hub.session.ShowState
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
import kotlinx.coroutines.flow.distinctUntilChanged
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

    /** The cloud builder account. Shows are downloaded from it into [shows]. */
    val cloud = CloudClient(app)

    /** The account's show list; null until it has been fetched. */
    private val _cloudShows = MutableStateFlow<List<CloudShowInfo>?>(null)
    val cloudShows: StateFlow<List<CloudShowInfo>?> = _cloudShows.asStateFlow()
    private val _cloudLoading = MutableStateFlow(false)
    val cloudLoading: StateFlow<Boolean> = _cloudLoading.asStateFlow()
    private val _cloudError = MutableStateFlow<String?>(null)
    val cloudError: StateFlow<String?> = _cloudError.asStateFlow()
    /** Cloud id of the show being downloaded. */
    private val _cloudDownloading = MutableStateFlow<String?>(null)
    val cloudDownloading: StateFlow<String?> = _cloudDownloading.asStateFlow()

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
        // Keep the session running with the screen off (see HubLinkService):
        // while a hub is linked, or a show is loaded and the link may come back.
        viewModelScope.launch {
            combine(client.state, session.show, session.stepInput) { link, show, stepInput ->
                keepAliveText(link, show, stepInput)
            }.distinctUntilChanged().collect { HubLinkService.sync(app, it) }
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
        if (cloud.account.value != null) refreshCloudShows()
    }

    /** Returns an error message, or null on success. */
    suspend fun cloudSignIn(email: String, password: String): String? = try {
        cloud.signIn(email.trim(), password)
        refreshCloudShows()
        null
    } catch (e: CloudException) {
        e.message
    }

    fun cloudSignOut() {
        _cloudShows.value = null
        _cloudError.value = null
        viewModelScope.launch { cloud.signOut() }
    }

    fun refreshCloudShows() {
        if (_cloudLoading.value) return
        _cloudLoading.value = true
        viewModelScope.launch {
            try {
                _cloudShows.value = cloud.listShows()
                _cloudError.value = null
            } catch (e: CloudException) {
                _cloudError.value = e.message
                if (cloud.account.value == null) _cloudShows.value = null
            } finally {
                _cloudLoading.value = false
            }
        }
    }

    /** Download a cloud show onto this phone, replacing an earlier download of it. */
    fun downloadCloudShow(info: CloudShowInfo) {
        if (_cloudDownloading.value != null) return
        val current = session.show.value
        if (current.show?.cloudId == info.id && current.phase != ShowPhase.IDLE) {
            _cloudError.value = "Unload ${info.name} before updating it"
            return
        }
        _cloudDownloading.value = info.id
        viewModelScope.launch {
            try {
                val row = cloud.fetchShow(info.id)
                withContext(Dispatchers.IO) {
                    val parsed = ShowParser.parse(row.json, row.info.name)
                    showStore.saveCloud(parsed, row.info.id, row.info.updatedAt)
                    _shows.value = showStore.list()
                }
                // The row may be newer than the list it was picked from.
                _cloudShows.value = _cloudShows.value?.map { if (it.id == row.info.id) row.info else it }
                _cloudError.value = null
            } catch (e: CloudException) {
                _cloudError.value = e.message
            } catch (e: ShowParseException) {
                _cloudError.value = "${info.name}: ${e.message}"
            } finally {
                _cloudDownloading.value = null
            }
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

    /** Notification line for [HubLinkService], or null when nothing needs keeping alive. */
    private fun keepAliveText(link: LinkState, show: ShowState, stepInput: Int): String? {
        val linked = link is LinkState.Connected || link is LinkState.Reconnecting
        if (!linked && !show.hasShowLoaded) return null
        val loaded = show.show?.takeIf { show.hasShowLoaded }
        return when {
            link !is LinkState.Connected -> "Reconnecting to the hub"
            loaded?.isSequence == true && stepInput in 5..8 ->
                "Input $stepInput fires steps with the screen off"
            loaded?.isSequence == true -> "Sequence loaded"
            loaded != null -> "Show loaded"
            else -> "Linked to ${link.label}"
        }
    }

    override fun onCleared() {
        HubLinkService.sync(getApplication(), null)
        client.close()
        wifi.stop()
        super.onCleared()
    }

    companion object {
        private const val LINK_PREFS = "hub_link"
        private const val KEY_LINK_MODE = "mode"
    }
}
