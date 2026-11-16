package com.backyardhero.hub.ui.show

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.FileOpen
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.backyardhero.hub.AppViewModel
import com.backyardhero.hub.session.ShowPhase
import com.backyardhero.hub.session.ShowState
import com.backyardhero.hub.show.Show
import com.backyardhero.hub.show.ShowCue
import com.backyardhero.hub.show.StepFireMode
import com.backyardhero.hub.ui.clock
import com.backyardhero.hub.ui.theme.ByhColors
import kotlinx.coroutines.launch

@Composable
fun ShowTab(vm: AppViewModel) {
    val shows by vm.shows.collectAsStateWithLifecycle()
    val state by vm.session.show.collectAsStateWithLifecycle()
    val receivers by vm.session.receivers.collectAsStateWithLifecycle()
    val switches by vm.session.switches.collectAsStateWithLifecycle()
    val stepInput by vm.session.stepInput.collectAsStateWithLifecycle()
    val stepListen by vm.session.stepListen.collectAsStateWithLifecycle()
    val now by vm.now.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    var importError by remember { mutableStateOf<String?>(null) }
    var confirmStart by remember { mutableStateOf<List<String>?>(null) }
    var confirmDelete by remember { mutableStateOf<Show?>(null) }
    var swapFrom by remember { mutableStateOf<String?>(null) }
    var swapTo by remember { mutableStateOf("") }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) scope.launch { importError = vm.importShow(uri) }
    }

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            ActiveShowCard(
                state = state,
                now = now,
                pending = state.show?.let { vm.session.pendingLoad(it) }.orEmpty(),
                readyCount = state.show?.receivers?.count { receivers[it]?.startReady == true } ?: 0,
                armed = switches.armed,
                startBlocked = vm.session.startBlockedReason(),
                onStart = { confirmStart = vm.session.precheck() },
                onPause = { vm.session.pauseShow() },
                onResume = { vm.session.resumeShow() },
                onStop = { vm.session.stopShow() },
                onUnload = { vm.session.unloadShow() },
                onReload = { state.show?.let { vm.session.loadShow(it) } },
                sequenceBlocked = vm.session.sequenceBlockedReason(),
                onFireStep = { vm.session.fireSequenceStep() },
                onCancelStep = { vm.session.cancelSequenceFire() },
                onJog = { vm.session.jogSequence(it) },
                onSwap = { swapFrom = it; swapTo = "" },
                stepInput = stepInput,
                stepListening = stepListen,
                onBindStep = { vm.session.beginStepButtonBind() },
                onCancelBind = { vm.session.cancelStepButtonBind() },
                onClearStep = { vm.session.clearStepButton() },
            )
        }
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Shows on this phone", color = ByhColors.Text, fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f),
                )
                Button(onClick = { picker.launch(arrayOf("application/json", "text/plain", "*/*")) }) {
                    Icon(Icons.Filled.FileOpen, null)
                    Spacer(Modifier.width(6.dp))
                    Text("Import")
                }
            }
            importError?.let {
                Text("Import failed: $it", color = ByhColors.Danger, fontSize = 13.sp)
            }
        }
        if (shows.isEmpty()) {
            item {
                Text(
                    "Import a show from Backyard Hero. On the host's show status page, use Export to app.",
                    color = ByhColors.TextDim, fontSize = 14.sp,
                )
            }
        }
        items(shows, key = { it.id }) { show ->
            ShowRow(
                show = show,
                isActive = state.show?.id == show.id && state.phase != ShowPhase.IDLE,
                canLoad = !state.isLive,
                onLoad = { vm.session.loadShow(show) },
                onDelete = { confirmDelete = show },
            )
        }
    }

    confirmStart?.let { issues ->
        AlertDialog(
            onDismissRequest = { confirmStart = null },
            title = { Text("Start show?") },
            text = {
                Column {
                    Text(
                        "Receivers start in 25 seconds. The physical arm switch must stay on; " +
                            "turning it off stops the show.",
                        fontSize = 14.sp,
                    )
                    if (issues.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
                        Text("Pre-start check:", color = ByhColors.Warn, fontWeight = FontWeight.SemiBold)
                        issues.forEach { Text("• $it", color = ByhColors.Warn, fontSize = 13.sp) }
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = { confirmStart = null; vm.session.startShow() },
                    colors = ButtonDefaults.buttonColors(containerColor = ByhColors.Danger, contentColor = Color.White),
                ) { Text(if (issues.isEmpty()) "Start" else "Start anyway") }
            },
            dismissButton = { TextButton(onClick = { confirmStart = null }) { Text("Cancel") } },
        )
    }

    swapFrom?.let { from ->
        val sequence = state.show?.isSequence == true
        val label = if (from.toIntOrNull() != null) "zone $from" else from
        AlertDialog(
            onDismissRequest = { swapFrom = null },
            title = { Text("Replace $label") },
            text = {
                Column {
                    Text(
                        if (sequence) {
                            "Cues aimed at $label move to the new receiver. A sequence isn't loaded onto receivers."
                        } else {
                            "The show reloads onto the new receiver. $label is reset and drops this show."
                        },
                        fontSize = 14.sp,
                    )
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(
                        value = swapTo,
                        onValueChange = { swapTo = it },
                        label = { Text("New receiver") },
                        placeholder = { Text("RX12 or a zone number") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        vm.swapLoadedReceiver(from, swapTo)
                        swapFrom = null
                    },
                    enabled = swapTo.isNotBlank(),
                ) { Text("Swap") }
            },
            dismissButton = { TextButton(onClick = { swapFrom = null }) { Text("Cancel") } },
        )
    }

    confirmDelete?.let { show ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("Delete ${show.name}?") },
            text = { Text("Removes it from this phone. Receivers aren't affected.") },
            confirmButton = { TextButton(onClick = { vm.deleteShow(show); confirmDelete = null }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun ActiveShowCard(
    state: ShowState,
    now: Long,
    pending: List<String>,
    readyCount: Int,
    armed: Boolean,
    startBlocked: String?,
    onStart: () -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onStop: () -> Unit,
    onUnload: () -> Unit,
    onReload: () -> Unit,
    sequenceBlocked: String?,
    onFireStep: () -> Unit,
    onCancelStep: () -> Unit,
    onJog: (Int) -> Unit,
    onSwap: (String) -> Unit,
    stepInput: Int,
    stepListening: Boolean,
    onBindStep: () -> Unit,
    onCancelBind: () -> Unit,
    onClearStep: () -> Unit,
) {
    val show = state.show
    Column(
        Modifier
            .fillMaxWidth()
            .background(ByhColors.Surface, RoundedCornerShape(12.dp))
            .border(1.dp, if (state.isLive) ByhColors.Accent else ByhColors.Outline, RoundedCornerShape(12.dp))
            .padding(16.dp)
    ) {
        if (show == null) {
            Text("No show loaded", color = ByhColors.Text, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
            Text("Pick a show below to load it into the receivers.", color = ByhColors.TextDim, fontSize = 13.sp)
            return@Column
        }
        Text(show.name, color = ByhColors.Text, fontWeight = FontWeight.SemiBold, fontSize = 18.sp)
        Text(showSummary(show), color = ByhColors.TextDim, fontSize = 13.sp)
        Spacer(Modifier.height(10.dp))

        if (show.isSequence) {
            SequenceBody(
                show = show,
                state = state,
                blocked = sequenceBlocked,
                canSwap = !state.sequenceFiring,
                onFireStep = onFireStep,
                onCancelStep = onCancelStep,
                onJog = onJog,
                onUnload = onUnload,
                onSwap = onSwap,
                armed = armed,
                stepInput = stepInput,
                stepListening = stepListening,
                onBindStep = onBindStep,
                onCancelBind = onCancelBind,
                onClearStep = onClearStep,
            )
            return@Column
        }

        val (phaseText, phaseColor) = when (state.phase) {
            ShowPhase.IDLE -> "Idle" to ByhColors.TextDim
            ShowPhase.LOADING -> "Loading… ${show.receivers.size - pending.size}/${show.receivers.size} receivers" to ByhColors.Warn
            ShowPhase.LOADED -> (if (armed) "Loaded · armed" else "Loaded · arm to start") to ByhColors.Ok
            ShowPhase.LOAD_ERROR -> "Load failed" to ByhColors.Danger
            ShowPhase.STARTING -> "Starting · $readyCount/${show.receivers.size} ready · T-${remaining(state.startAtMs, now)}" to ByhColors.Accent
            ShowPhase.COUNTDOWN -> "Countdown T-${remaining(state.startAtMs, now)}" to ByhColors.Accent
            ShowPhase.RUNNING -> {
                val elapsed = now - (state.startAtMs ?: now)
                "Running ${clock(elapsed)} / ${clock(show.lastCueMs)}" to ByhColors.Accent
            }
            ShowPhase.PAUSED -> "Paused" to ByhColors.Warn
            ShowPhase.COMPLETE -> "Complete" to ByhColors.Ok
        }
        Text(phaseText, color = phaseColor, fontWeight = FontWeight.Bold, fontSize = 20.sp)
        state.message?.let { Text(it, color = ByhColors.TextDim, fontSize = 13.sp) }

        Spacer(Modifier.height(10.dp))
        ReceiverChips(
            show = show,
            pending = pending,
            canSwap = !state.isLive && state.phase != ShowPhase.LOADING && state.phase != ShowPhase.STARTING,
            onSwap = onSwap,
        )

        Spacer(Modifier.height(12.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            when (state.phase) {
                ShowPhase.LOADED -> {
                    Button(
                        onClick = onStart,
                        enabled = startBlocked == null,
                        colors = ButtonDefaults.buttonColors(containerColor = ByhColors.Danger, contentColor = Color.White),
                    ) { Text("Start show") }
                    OutlinedButton(onClick = onUnload) { Text("Unload") }
                }
                ShowPhase.STARTING, ShowPhase.COUNTDOWN -> {
                    Button(onClick = onStop) { Text("Abort") }
                }
                ShowPhase.RUNNING -> {
                    Button(onClick = onStop) { Text("Stop") }
                    OutlinedButton(onClick = onPause) { Text("Pause") }
                }
                ShowPhase.PAUSED -> {
                    Button(onClick = onResume, enabled = armed) { Text("Resume") }
                    OutlinedButton(onClick = onStop) { Text("Stop") }
                }
                ShowPhase.LOADING -> OutlinedButton(onClick = onUnload) { Text("Cancel") }
                ShowPhase.LOAD_ERROR, ShowPhase.COMPLETE -> {
                    Button(onClick = onReload) { Text("Load again") }
                    OutlinedButton(onClick = onUnload) { Text("Unload") }
                }
                ShowPhase.IDLE -> {}
            }
        }
        if (state.phase == ShowPhase.LOADED && startBlocked != null) {
            Text(startBlocked, color = ByhColors.TextDim, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
        }
    }
}

private fun remaining(startAt: Long?, now: Long): Long = ((startAt ?: now) - now).coerceAtLeast(0) / 1000

private fun showSummary(show: Show): String = buildString {
    if (show.isSequence) {
        append("Manual sequence · ${show.steps.size} steps · ${show.cues.size} cues")
    } else {
        append("${show.nativeCues.size} cues · ${show.receivers.size} receivers")
        if (show.bilusocnCues.isNotEmpty()) append(" · ${show.bilusocnCues.size} 433 MHz")
        append(" · ${clock((show.durationSec * 1000).toLong())}")
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun SequenceBody(
    show: Show,
    state: ShowState,
    blocked: String?,
    canSwap: Boolean,
    onFireStep: () -> Unit,
    onCancelStep: () -> Unit,
    onJog: (Int) -> Unit,
    onUnload: () -> Unit,
    onSwap: (String) -> Unit,
    armed: Boolean,
    stepInput: Int,
    stepListening: Boolean,
    onBindStep: () -> Unit,
    onCancelBind: () -> Unit,
    onClearStep: () -> Unit,
) {
    val groups = show.groupedSteps()
    val index = state.sequenceIndex.coerceIn(0, groups.size)
    val done = index >= groups.size
    val current = groups.getOrNull(index)
    Text(
        if (done) "All steps fired" else "Step ${index + 1} of ${groups.size}",
        color = if (done) ByhColors.Ok else ByhColors.Accent,
        fontWeight = FontWeight.Bold,
        fontSize = 20.sp,
    )
    if (current != null) {
        val (step, cues) = current
        Text(
            if (step.fireMode == StepFireMode.STAGGERED) "Interval · ${step.intervalMs} ms apart"
            else "Fire all · together",
            color = ByhColors.TextDim, fontSize = 13.sp,
        )
        Spacer(Modifier.height(8.dp))
        if (cues.isEmpty()) {
            Text("This step has no cues.", color = ByhColors.TextDim, fontSize = 13.sp)
        } else {
            cues.forEach { cue ->
                Text(cueLabel(cue), color = ByhColors.Text, fontSize = 14.sp)
            }
        }
    }
    state.message?.let {
        Text(it, color = ByhColors.TextDim, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp))
    }
    Spacer(Modifier.height(10.dp))
    ReceiverChips(show = show, pending = emptyList(), canSwap = canSwap, onSwap = onSwap, showLoadState = false)
    Spacer(Modifier.height(12.dp))
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (state.sequenceFiring) {
            Button(onClick = onCancelStep) { Text("Cancel remaining") }
        } else if (!done) {
            Button(
                onClick = onFireStep,
                enabled = blocked == null,
                colors = ButtonDefaults.buttonColors(containerColor = ByhColors.Danger, contentColor = Color.White),
            ) { Text("Fire step") }
        }
        OutlinedButton(onClick = { onJog(-1) }, enabled = index > 0 && !state.sequenceFiring) { Text("Previous") }
        OutlinedButton(onClick = { onJog(1) }, enabled = !done && !state.sequenceFiring) { Text("Next") }
        OutlinedButton(onClick = onUnload) { Text("Unload") }
    }
    Spacer(Modifier.height(8.dp))
    when {
        stepListening -> {
            Text("Press a button on inputs 5–8", color = ByhColors.Accent, fontSize = 14.sp)
            TextButton(onClick = onCancelBind) { Text("Cancel") }
        }
        stepInput in 5..8 -> {
            Text("Input $stepInput fires this step", color = ByhColors.Text, fontSize = 14.sp)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = onBindStep, enabled = !armed) { Text("Rebind") }
                TextButton(onClick = onClearStep) { Text("Clear") }
            }
        }
        else -> {
            OutlinedButton(onClick = onBindStep, enabled = !armed) { Text("Bind hardware button") }
        }
    }
    if (armed && !stepListening) {
        Text(
            "Turn the arm switch off to bind a button",
            color = ByhColors.TextDim, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp),
        )
    }
    if (!state.sequenceFiring && !done && blocked != null) {
        Text(blocked, color = ByhColors.TextDim, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
    }
}

private fun cueLabel(cue: ShowCue): String {
    val who = if (cue.native) cue.zone else "Zone ${cue.zone}"
    val name = if (cue.name.isBlank()) "" else " · ${cue.name}"
    return "$who · cue ${cue.target}$name"
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun ReceiverChips(
    show: Show,
    pending: List<String>,
    canSwap: Boolean,
    onSwap: (String) -> Unit,
    showLoadState: Boolean = true,
) {
    val chips = buildList {
        for (ident in show.receivers) add(Triple(ident, ident, show.cuesFor(ident).size))
        for (zone in show.bilusocnZones) add(Triple(zone.toString(), "Zone $zone", show.bilusocnCuesFor(zone).size))
    }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for ((id, label, count) in chips) {
            val loaded = id !in pending
            Row(
                Modifier
                    .background(ByhColors.SurfaceHigh, RoundedCornerShape(6.dp))
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (showLoadState && id.toIntOrNull() == null) {
                    Box(Modifier.size(8.dp).background(if (loaded) ByhColors.Ok else ByhColors.Warn, CircleShape))
                    Spacer(Modifier.width(6.dp))
                }
                Text("$label · $count", color = ByhColors.Text, fontSize = 12.sp)
                if (canSwap) {
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "Swap",
                        color = ByhColors.Accent,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.clickable { onSwap(id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun ShowRow(show: Show, isActive: Boolean, canLoad: Boolean, onLoad: () -> Unit, onDelete: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(ByhColors.Surface, RoundedCornerShape(10.dp))
            .border(1.dp, if (isActive) ByhColors.Accent else ByhColors.Outline, RoundedCornerShape(10.dp))
            .clickable(enabled = canLoad && !isActive, onClick = onLoad)
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(show.name, color = ByhColors.Text, fontWeight = FontWeight.Medium)
            Text(
                if (show.isSequence) showSummary(show) else buildString {
                    append("${show.nativeCues.size} cues")
                    if (show.receivers.isNotEmpty()) append(" · ${show.receivers.joinToString()}")
                    if (show.bilusocnCues.isNotEmpty()) {
                        append(" · ${show.bilusocnZones.joinToString { "Z$it" }}")
                    }
                },
                color = ByhColors.TextDim, fontSize = 12.sp, maxLines = 2,
            )
        }
        if (!isActive) {
            TextButton(onClick = onLoad, enabled = canLoad) { Text("Load") }
        }
        IconButton(onClick = onDelete, enabled = !isActive) {
            Icon(Icons.Filled.Delete, contentDescription = "Delete", tint = ByhColors.TextDim)
        }
    }
}
