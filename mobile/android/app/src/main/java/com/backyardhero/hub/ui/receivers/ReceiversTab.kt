package com.backyardhero.hub.ui.receivers

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.backyardhero.hub.AppViewModel
import com.backyardhero.hub.proto.BscFire
import com.backyardhero.hub.session.ReceiverState
import com.backyardhero.hub.ui.common.CueGrid
import com.backyardhero.hub.ui.theme.ByhColors

@Composable
fun ReceiversTab(vm: AppViewModel) {
    val receivers by vm.session.receivers.collectAsStateWithLifecycle()
    val registered by vm.session.registered.collectAsStateWithLifecycle()
    val zones by vm.session.bilusocn.collectAsStateWithLifecycle()
    val show by vm.session.show.collectAsStateWithLifecycle()
    val now by vm.now.collectAsStateWithLifecycle()
    var adding by remember { mutableStateOf(false) }

    val idents = (registered + receivers.keys).sortedWith(identOrder)
    val online = idents.count { receivers[it]?.online(now) == true }
    val zoneList = zones.sorted()

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("Receivers", color = ByhColors.Text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    buildString {
                        append("$online of ${idents.size} online")
                        if (zoneList.isNotEmpty()) append(" · ${zoneList.size} 433 MHz")
                    },
                    color = ByhColors.TextDim, fontSize = 13.sp,
                )
            }
            Button(onClick = { adding = true }) {
                Icon(Icons.Filled.Add, null)
                Spacer(Modifier.width(4.dp))
                Text("Add")
            }
        }
        if (idents.isEmpty() && zoneList.isEmpty()) {
            Text(
                "No receivers yet. Add an nRF ident (e.g. RX12) so the hub starts polling it, " +
                    "or a Bilusocn zone to fire over 433 MHz. Loading a show adds both automatically.",
                color = ByhColors.TextDim, fontSize = 14.sp, modifier = Modifier.padding(16.dp),
            )
        }
        LazyColumn(
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(idents, key = { it }) { ident ->
                val r = receivers[ident] ?: ReceiverState(ident = ident)
                val showCues = show.show?.takeIf { show.hasShowLoaded }?.cuesFor(ident)?.map { it.target }?.toSet().orEmpty()
                ReceiverCard(
                    r = r,
                    now = now,
                    registered = ident in registered,
                    showCues = showCues,
                    onRefresh = { vm.session.refreshReceiverConfig(ident) },
                    onRemove = { vm.session.removeReceiver(ident) },
                    onRegister = { vm.session.addReceivers(listOf(ident)) },
                )
            }
            items(zoneList, key = { "zone-$it" }) { zone ->
                val showCues = show.show?.takeIf { show.hasShowLoaded }
                    ?.bilusocnCuesFor(zone)?.map { it.target }?.toSet().orEmpty()
                BilusocnCard(zone = zone, showCues = showCues, onRemove = { vm.session.removeBilusocn(zone) })
            }
        }
    }

    if (adding) AddReceiversDialog(
        onDismiss = { adding = false },
        onAddNative = { vm.session.addReceivers(it); adding = false },
        onAddBilusocn = { vm.session.addBilusocn(listOf(it)); adding = false },
    )
}

/** RX2 before RX10. */
val identOrder = Comparator<String> { a, b ->
    val pa = a.takeWhile { !it.isDigit() }
    val pb = b.takeWhile { !it.isDigit() }
    if (pa != pb) return@Comparator pa.compareTo(pb)
    val na = a.drop(pa.length).toIntOrNull()
    val nb = b.drop(pb.length).toIntOrNull()
    if (na != null && nb != null) na.compareTo(nb) else a.compareTo(b)
}

@Composable
private fun ReceiverCard(
    r: ReceiverState,
    now: Long,
    registered: Boolean,
    showCues: Set<Int>,
    onRefresh: () -> Unit,
    onRemove: () -> Unit,
    onRegister: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val age = r.ageMs(now)
    // Host freshness tones: <=4s green, <=8s orange, older red.
    val freshness = when {
        age == null -> ByhColors.TextDim
        age <= 4_000 -> ByhColors.Ok
        age <= 8_000 -> ByhColors.Warn
        else -> ByhColors.Danger
    }
    Column(
        Modifier
            .fillMaxWidth()
            .background(ByhColors.Surface, RoundedCornerShape(12.dp))
            .border(1.dp, ByhColors.Outline, RoundedCornerShape(12.dp))
            .padding(12.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).background(freshness, CircleShape))
            Spacer(Modifier.width(8.dp))
            Text(r.ident, color = ByhColors.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.width(8.dp))
            Text(
                when {
                    age == null -> "never heard"
                    r.online(now) -> "online"
                    else -> "last seen ${age / 1000}s ago"
                },
                color = ByhColors.TextDim, fontSize = 12.sp, modifier = Modifier.weight(1f),
            )
            Box {
                IconButton(onClick = { menu = true }, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Filled.MoreVert, contentDescription = "Receiver actions", tint = ByhColors.TextDim)
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("Refresh config") }, onClick = { menu = false; onRefresh() })
                    if (registered) {
                        DropdownMenuItem(text = { Text("Remove") }, onClick = { menu = false; onRemove() })
                    } else {
                        DropdownMenuItem(text = { Text("Keep in list") }, onClick = { menu = false; onRegister() })
                    }
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Metric("Battery", r.batteryPct?.let { "$it%" } ?: "—", batteryColor(r.batteryPct))
            Metric("Latency", r.latencyMs?.let { "${it}ms" } ?: "—")
            Metric("Cont.", if (r.continuity != null) "${r.continuityCount()}/${r.cueCount}" else "—")
            Metric("FW", r.fw?.let { "v$it" } ?: "—")
            Metric("Boards", r.numBoards?.let { if (r.noBoardsDetected == true) "none" else "$it" } ?: "—")
        }
        r.successPct?.let { sp ->
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Link", color = ByhColors.TextDim, fontSize = 11.sp)
                Spacer(Modifier.width(8.dp))
                LinearProgressIndicator(
                    progress = { sp / 100f },
                    modifier = Modifier.weight(1f).height(6.dp),
                    color = when {
                        sp >= 90 -> ByhColors.Ok
                        sp >= 60 -> ByhColors.Warn
                        else -> ByhColors.Danger
                    },
                    trackColor = ByhColors.SurfaceHigh,
                )
                Spacer(Modifier.width(8.dp))
                Text("$sp%", color = ByhColors.Text, fontSize = 11.sp)
            }
        }
        Spacer(Modifier.height(10.dp))
        CueGrid(receiver = r, showCues = showCues)
    }
}

private fun batteryColor(pct: Int?) = when {
    pct == null -> ByhColors.Text
    pct < 20 -> ByhColors.Danger
    pct < 50 -> ByhColors.Warn
    else -> ByhColors.Ok
}

@Composable
private fun Metric(label: String, value: String, color: androidx.compose.ui.graphics.Color = ByhColors.Text) {
    Column {
        Text(label, color = ByhColors.TextDim, fontSize = 11.sp)
        Text(value, color = color, fontSize = 14.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun BilusocnCard(zone: Int, showCues: Set<Int>, onRemove: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    val r = ReceiverState(ident = "Z$zone", cuesAvailable = BscFire.CUES)
    Column(
        Modifier
            .fillMaxWidth()
            .background(ByhColors.Surface, RoundedCornerShape(12.dp))
            .border(1.dp, ByhColors.Accent, RoundedCornerShape(12.dp))
            .padding(12.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Zone $zone", color = ByhColors.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.width(8.dp))
            Text(
                "433 MHz · 12 cues · transmit only",
                color = ByhColors.TextDim, fontSize = 12.sp, modifier = Modifier.weight(1f),
            )
            Box {
                IconButton(onClick = { menu = true }, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Filled.MoreVert, contentDescription = "Zone actions", tint = ByhColors.TextDim)
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("Remove") }, onClick = { menu = false; onRemove() })
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        CueGrid(receiver = r, showCues = showCues)
    }
}

/** Accepts "RX12", "RX1, RX2", or a range like "RX1-RX8" / "RX1-8". */
fun parseIdentList(text: String): List<String> {
    val out = mutableListOf<String>()
    for (raw in text.split(',', ' ', '\n').map { it.trim() }.filter { it.isNotEmpty() }) {
        val m = Regex("^([A-Za-z]+)(\\d+)-(?:[A-Za-z]+)?(\\d+)$").find(raw)
        if (m != null) {
            val prefix = m.groupValues[1].uppercase()
            val a = m.groupValues[2].toInt()
            val b = m.groupValues[3].toInt()
            if (b >= a && b - a < 64) for (n in a..b) out += "$prefix$n"
        } else {
            out += raw.uppercase()
        }
    }
    return out.distinct()
}

@Composable
private fun AddReceiversDialog(
    onDismiss: () -> Unit,
    onAddNative: (List<String>) -> Unit,
    onAddBilusocn: (Int) -> Unit,
) {
    var bilusocn by remember { mutableStateOf(false) }
    var text by remember { mutableStateOf("RX") }
    var zoneText by remember { mutableStateOf("1") }
    val parsed = parseIdentList(text).filter { Regex("^[A-Z]+\\d+$").matches(it) }
    val zone = zoneText.toIntOrNull()?.takeIf { it in BscFire.ZONE_MIN..BscFire.ZONE_MAX }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (bilusocn) "Add Bilusocn zone" else "Add receivers") },
        text = {
            Column {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { bilusocn = false }) {
                        Text("nRF", color = if (!bilusocn) ByhColors.Accent else ByhColors.TextDim)
                    }
                    TextButton(onClick = { bilusocn = true }) {
                        Text("Bilusocn", color = if (bilusocn) ByhColors.Accent else ByhColors.TextDim)
                    }
                }
                if (!bilusocn) {
                    OutlinedTextField(
                        value = text,
                        onValueChange = { text = it },
                        label = { Text("Idents") },
                        supportingText = { Text("e.g. RX12, or RX1-RX8") },
                        singleLine = true,
                    )
                    if (parsed.isNotEmpty()) {
                        Text(parsed.joinToString(), color = ByhColors.TextDim, fontSize = 12.sp)
                    }
                } else {
                    OutlinedTextField(
                        value = zoneText,
                        onValueChange = { zoneText = it.filter { ch -> ch.isDigit() }.take(3) },
                        label = { Text("Zone") },
                        supportingText = { Text("1–${BscFire.ZONE_MAX}. Twelve cues, fired over 433 MHz.") },
                        singleLine = true,
                    )
                }
            }
        },
        confirmButton = {
            if (!bilusocn) {
                Button(onClick = { onAddNative(parsed) }, enabled = parsed.isNotEmpty()) { Text("Add ${parsed.size}") }
            } else {
                Button(onClick = { zone?.let(onAddBilusocn) }, enabled = zone != null) { Text("Add zone") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
