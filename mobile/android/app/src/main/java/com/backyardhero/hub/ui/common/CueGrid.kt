package com.backyardhero.hub.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.backyardhero.hub.session.ReceiverState
import com.backyardhero.hub.ui.theme.ByhColors

/** Same layout as the host's receiver cards: 5 cues per row. */
const val CUE_COLUMNS = 5

/**
 * Cue grid colored by continuity (green = connected, red = open, grey = no
 * data yet). [showCues] get a purple border, like the host's show mapping.
 * When [onCue] is set the cells are buttons.
 */
@Composable
fun CueGrid(
    receiver: ReceiverState,
    showCues: Set<Int> = emptySet(),
    enabled: Boolean = true,
    big: Boolean = false,
    onCue: ((Int) -> Unit)? = null,
) {
    val count = receiver.cueCount
    Column(verticalArrangement = Arrangement.spacedBy(if (big) 8.dp else 4.dp)) {
        for (rowStart in 1..count step CUE_COLUMNS) {
            Row(horizontalArrangement = Arrangement.spacedBy(if (big) 8.dp else 4.dp)) {
                for (target in rowStart until rowStart + CUE_COLUMNS) {
                    Box(Modifier.weight(1f)) {
                        if (target <= count) {
                            CueCell(
                                target = target,
                                continuity = receiver.hasContinuity(target),
                                inShow = target in showCues,
                                enabled = enabled,
                                big = big,
                                onClick = onCue?.let { { it(target) } },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CueCell(
    target: Int,
    continuity: Boolean?,
    inShow: Boolean,
    enabled: Boolean,
    big: Boolean,
    onClick: (() -> Unit)?,
) {
    val dot = when (continuity) {
        true -> ByhColors.Ok
        false -> ByhColors.Danger
        null -> ByhColors.TextDim
    }
    val shape = RoundedCornerShape(if (big) 10.dp else 6.dp)
    var m = Modifier
        .fillMaxWidth()
        .aspectRatio(if (big) 1.1f else 1.6f)
        .background(if (onClick != null && enabled) ByhColors.SurfaceHigh else ByhColors.Surface, shape)
        .border(if (inShow) 2.dp else 1.dp, if (inShow) ByhColors.Purple else ByhColors.Outline, shape)
    if (onClick != null && enabled) m = m.clickable(onClick = onClick)
    Box(m, contentAlignment = Alignment.Center) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(if (big) 10.dp else 7.dp).background(dot, CircleShape))
            Spacer(Modifier.size(if (big) 6.dp else 4.dp))
            Text(
                "$target",
                color = if (enabled) ByhColors.Text else ByhColors.TextDim,
                fontSize = if (big) 18.sp else 12.sp,
                fontWeight = if (big) FontWeight.Bold else FontWeight.Medium,
            )
        }
    }
}
