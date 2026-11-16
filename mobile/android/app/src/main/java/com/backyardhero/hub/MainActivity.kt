package com.backyardhero.hub

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.backyardhero.hub.net.LinkState
import com.backyardhero.hub.ui.MainScreen
import com.backyardhero.hub.ui.connect.ConnectScreen
import com.backyardhero.hub.ui.theme.ByhTheme

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            ByhTheme {
                val link by vm.client.state.collectAsStateWithLifecycle()
                val hasConnected by vm.hasConnected.collectAsStateWithLifecycle()
                // Stay on the main screen through brief drops once connected;
                // go back to finding a hub only when no hub answers at all.
                val showMain = link is LinkState.Connected || (hasConnected && link !is LinkState.NoHub)
                if (showMain) MainScreen(vm) else ConnectScreen(vm)
            }
        }
    }
}
