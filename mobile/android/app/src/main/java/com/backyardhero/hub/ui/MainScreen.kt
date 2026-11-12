package com.backyardhero.hub.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Sensors
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.backyardhero.hub.AppViewModel
import com.backyardhero.hub.net.LinkMode
import com.backyardhero.hub.net.LinkState
import com.backyardhero.hub.session.ShowPhase
import com.backyardhero.hub.ui.manual.ManualFireTab
import com.backyardhero.hub.ui.receivers.ReceiversTab
import com.backyardhero.hub.ui.settings.HubSettingsSheet
import com.backyardhero.hub.ui.show.ShowTab
import com.backyardhero.hub.ui.theme.ByhColors

private enum class Tab(val label: String) { SHOW("Show"), RECEIVERS("Receivers"), MANUAL("Manual fire") }

@Composable
fun MainScreen(vm: AppViewModel) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var settingsOpen by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(Unit) {
        vm.session.events.collect { snackbar.showSnackbar(it) }
    }

    Scaffold(
        containerColor = ByhColors.Background,
        topBar = { StatusBar(vm, onSettings = { settingsOpen = true }) },
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            NavigationBar(containerColor = ByhColors.Surface) {
                Tab.entries.forEachIndexed { i, t ->
                    NavigationBarItem(
                        selected = tab == i,
                        onClick = { tab = i },
                        icon = {
                            Icon(
                                when (t) {
                                    Tab.SHOW -> Icons.Filled.Movie
                                    Tab.RECEIVERS -> Icons.Filled.Sensors
                                    Tab.MANUAL -> Icons.Filled.Bolt
                                },
                                contentDescription = t.label,
                            )
                        },
                        label = { Text(t.label) },
                        colors = NavigationBarItemDefaults.colors(indicatorColor = ByhColors.SurfaceHigh),
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (Tab.entries[tab]) {
                Tab.SHOW -> ShowTab(vm)
                Tab.RECEIVERS -> ReceiversTab(vm)
                Tab.MANUAL -> ManualFireTab(vm)
            }
        }
    }

    if (settingsOpen) HubSettingsSheet(vm, onDismiss = { settingsOpen = false })
}

enum class Tone(val color: Color) {
    OK(ByhColors.Ok), WARN(ByhColors.Warn), DANGER(ByhColors.Danger), NEUTRAL(ByhColors.TextDim), LIVE(ByhColors.Accent)
}

@Composable
private fun StatusBar(vm: AppViewModel, onSettings: () -> Unit) {
    val link by vm.client.state.collectAsStateWithLifecycle()
    val mode by vm.client.mode.collectAsStateWithLifecycle()
    val dongle by vm.session.dongle.collectAsStateWithLifecycle()
    val switches by vm.session.switches.collectAsStateWithLifecycle()
    val receivers by vm.session.receivers.collectAsStateWithLifecycle()
    val registered by vm.session.registered.collectAsStateWithLifecycle()
    val show by vm.session.show.collectAsStateWithLifecycle()
    val now by vm.now.collectAsStateWithLifecycle()

    val known = (registered + receivers.keys)
    val online = known.count { receivers[it]?.online(now) == true }

    Column(
        Modifier
            .fillMaxWidth()
            .background(ByhColors.Surface)
            .statusBarsPadding()
            .padding(horizontal = 12.dp, vertical = 8.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val (linkText, linkTone) = when (val l = link) {
                is LinkState.Connected -> (if (mode == LinkMode.USB) "Connected" else l.label) to Tone.OK
                is LinkState.Connecting -> "Connecting…" to Tone.WARN
                is LinkState.Reconnecting -> "Reconnecting…" to Tone.DANGER
                LinkState.NoHub -> "No hub" to Tone.DANGER
            }
            Stat(if (mode == LinkMode.USB) "USB" else "Hub", linkText, linkTone)
            Spacer(Modifier.width(14.dp))
            val dongleSilent = link is LinkState.Connected && dongle.silent(now)
            Stat(
                "Dongle",
                when {
                    link !is LinkState.Connected -> "—"
                    dongleSilent -> "Silent"
                    else -> "q ${dongle.queue}/${dongle.queueMax} · ch ${dongle.rfChannel ?: "?"}"
                },
                when {
                    link !is LinkState.Connected -> Tone.NEUTRAL
                    dongleSilent -> Tone.DANGER
                    dongle.queueMax > 0 && dongle.queue * 4 > dongle.queueMax * 3 -> Tone.WARN
                    else -> Tone.OK
                },
            )
            Spacer(Modifier.weight(1f))
            IconButton(onClick = onSettings, modifier = Modifier.size(32.dp)) {
                Icon(Icons.Filled.Settings, contentDescription = "Hub settings", tint = ByhColors.TextDim)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            ArmChip(switches.known, switches.armed)
            Stat(
                "Receivers",
                "$online/${known.size}",
                when {
                    known.isEmpty() -> Tone.NEUTRAL
                    online == known.size -> Tone.OK
                    online == 0 -> Tone.DANGER
                    else -> Tone.WARN
                },
            )
            val (showText, showTone) = showSummary(show.phase, show.startAtMs, show.pausedAtMs, now)
            Stat("Show", showText, showTone)
            if (switches.manualEngaged) Stat("Mode", "Manual fire", Tone.LIVE)
        }
    }
}

private fun showSummary(phase: ShowPhase, startAt: Long?, pausedAt: Long?, now: Long): Pair<String, Tone> = when (phase) {
    ShowPhase.IDLE -> "—" to Tone.NEUTRAL
    ShowPhase.LOADING -> "Loading" to Tone.WARN
    ShowPhase.LOADED -> "Loaded" to Tone.OK
    ShowPhase.LOAD_ERROR -> "Load error" to Tone.DANGER
    ShowPhase.STARTING -> "Starting T-${secs(startAt, now)}" to Tone.LIVE
    ShowPhase.COUNTDOWN -> "T-${secs(startAt, now)}" to Tone.LIVE
    ShowPhase.RUNNING -> "Running ${clock(startAt?.let { now - it } ?: 0)}" to Tone.LIVE
    ShowPhase.PAUSED -> "Paused ${clock(if (startAt != null && pausedAt != null) pausedAt - startAt else 0)}" to Tone.WARN
    ShowPhase.COMPLETE -> "Complete" to Tone.OK
}

private fun secs(startAt: Long?, now: Long): Long = ((startAt ?: now) - now).coerceAtLeast(0) / 1000

fun clock(ms: Long): String {
    val s = (ms.coerceAtLeast(0) / 1000)
    return "%d:%02d".format(s / 60, s % 60)
}

@Composable
fun Stat(label: String, value: String, tone: Tone) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).background(tone.color, CircleShape))
        Spacer(Modifier.width(5.dp))
        Text(label, color = ByhColors.TextDim, fontSize = 11.sp)
        Spacer(Modifier.width(4.dp))
        Text(value, color = ByhColors.Text, fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1)
    }
}

@Composable
private fun ArmChip(known: Boolean, armed: Boolean) {
    val (text, bg) = when {
        !known -> "ARM ?" to ByhColors.SurfaceHigh
        armed -> "ARMED" to ByhColors.Danger
        else -> "SAFE" to ByhColors.SurfaceHigh
    }
    Text(
        text,
        color = if (armed && known) Color.White else ByhColors.TextDim,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(bg, RoundedCornerShape(4.dp))
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}
