package com.backyardhero.hub.ui.manual

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.backyardhero.hub.AppViewModel
import com.backyardhero.hub.proto.BscFire
import com.backyardhero.hub.session.ReceiverState
import com.backyardhero.hub.ui.common.CueGrid
import com.backyardhero.hub.ui.receivers.identOrder
import com.backyardhero.hub.ui.theme.ByhColors

@Composable
fun ManualFireTab(vm: AppViewModel) {
    val receivers by vm.session.receivers.collectAsStateWithLifecycle()
    val registered by vm.session.registered.collectAsStateWithLifecycle()
    val zones by vm.session.bilusocn.collectAsStateWithLifecycle()
    // Re-evaluate the gate whenever any input to it changes.
    val switches by vm.session.switches.collectAsStateWithLifecycle()
    val show by vm.session.show.collectAsStateWithLifecycle()
    val link by vm.client.state.collectAsStateWithLifecycle()
    val now by vm.now.collectAsStateWithLifecycle()
    val haptics = LocalHapticFeedback.current

    val blocked = remember(switches, show, link) { vm.session.manualFireBlockedReason() }
    val idents = (registered + receivers.keys).sortedWith(identOrder)
    val zoneList = zones.sorted()
    val keys = idents + zoneList.map { zoneKey(it) }
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    val current = selected?.takeIf { it in keys } ?: keys.firstOrNull()
    var lastFired by remember { mutableStateOf<String?>(null) }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        GateBanner(blocked)
        Spacer(Modifier.height(12.dp))

        if (keys.isEmpty()) {
            Text("No receivers. Add an nRF ident or a Bilusocn zone on the Receivers tab.", color = ByhColors.TextDim)
            return@Column
        }

        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            for (ident in idents) {
                val online = receivers[ident]?.online(now) == true
                FilterChip(
                    selected = ident == current,
                    onClick = { selected = ident },
                    label = { Text(ident) },
                    leadingIcon = {
                        Text("●", color = if (online) ByhColors.Ok else ByhColors.Danger, fontSize = 10.sp)
                    },
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = ByhColors.SurfaceHigh,
                        selectedLabelColor = ByhColors.Text,
                    ),
                )
            }
            for (zone in zoneList) {
                val key = zoneKey(zone)
                FilterChip(
                    selected = key == current,
                    onClick = { selected = key },
                    label = { Text("Zone $zone") },
                    leadingIcon = { Text("●", color = ByhColors.Accent, fontSize = 10.sp) },
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = ByhColors.SurfaceHigh,
                        selectedLabelColor = ByhColors.Text,
                    ),
                )
            }
        }
        Spacer(Modifier.height(12.dp))

        val key = current!!
        val zone = zoneOf(key)
        if (zone != null) {
            Text(
                "Zone $zone · 433 MHz · ${BscFire.CUES} cues",
                color = ByhColors.Text,
                fontWeight = FontWeight.Medium,
            )
            lastFired?.let { Text(it, color = ByhColors.Accent, fontSize = 13.sp) }
            Spacer(Modifier.height(8.dp))
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                CueGrid(
                    receiver = ReceiverState(ident = key, cuesAvailable = BscFire.CUES),
                    enabled = blocked == null,
                    big = true,
                    onCue = { target ->
                        if (vm.session.fireBilusocn(zone, target)) {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            lastFired = "Fired zone $zone cue $target"
                        }
                    },
                )
            }
        } else {
            val r = receivers[key] ?: ReceiverState(ident = key)
            val online = r.online(now)
            Text(
                buildString {
                    append(r.ident)
                    append(if (online) " · online" else " · offline")
                    r.batteryPct?.let { append(" · battery $it%") }
                    if (r.continuity != null) append(" · ${r.continuityCount()}/${r.cueCount} connected")
                },
                color = if (online) ByhColors.Text else ByhColors.Danger,
                fontWeight = FontWeight.Medium,
            )
            lastFired?.let { Text(it, color = ByhColors.Accent, fontSize = 13.sp) }
            Spacer(Modifier.height(8.dp))

            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                CueGrid(
                    receiver = r,
                    enabled = blocked == null,
                    big = true,
                    onCue = { target ->
                        if (vm.session.fire(r.ident, target)) {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            lastFired = "Fired ${r.ident} cue $target"
                        }
                    },
                )
            }
        }
    }
}

private fun zoneKey(zone: Int) = "zone:$zone"

private fun zoneOf(key: String): Int? =
    key.removePrefix("zone:").toIntOrNull()?.takeIf { key.startsWith("zone:") && it in BscFire.ZONE_MIN..BscFire.ZONE_MAX }

@Composable
private fun GateBanner(blocked: String?) {
    val live = blocked == null
    Column(
        Modifier
            .fillMaxWidth()
            .background(if (live) ByhColors.Danger.copy(alpha = 0.18f) else ByhColors.Surface, RoundedCornerShape(10.dp))
            .border(1.dp, if (live) ByhColors.Danger else ByhColors.Outline, RoundedCornerShape(10.dp))
            .padding(12.dp)
    ) {
        Text(
            if (live) "LIVE — tapping a cue fires it" else "Manual fire locked",
            color = if (live) ByhColors.Danger else ByhColors.Text,
            fontWeight = FontWeight.Bold,
        )
        Text(
            blocked ?: "Arm, start, and manual fire switches are on.",
            color = ByhColors.TextDim, fontSize = 13.sp,
        )
    }
}
