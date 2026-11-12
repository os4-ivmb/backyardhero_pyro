package com.backyardhero.hub.ui.connect

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.backyardhero.hub.net.LinkMode
import com.backyardhero.hub.ui.theme.ByhColors

@Composable
fun LinkModeSelect(
    mode: LinkMode,
    onSelect: (LinkMode) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(ByhColors.SurfaceHigh)
            .padding(4.dp),
    ) {
        ModeChip("Wireless", mode == LinkMode.WIRELESS, Modifier.weight(1f)) {
            onSelect(LinkMode.WIRELESS)
        }
        ModeChip("USB", mode == LinkMode.USB, Modifier.weight(1f)) {
            onSelect(LinkMode.USB)
        }
    }
}

@Composable
private fun ModeChip(label: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Box(
        modifier
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) ByhColors.Surface else ByhColors.SurfaceHigh)
            .border(
                width = 1.dp,
                color = if (selected) ByhColors.Accent else ByhColors.SurfaceHigh,
                shape = RoundedCornerShape(8.dp),
            )
            .clickable(onClick = onClick)
            .semantics {
                role = Role.RadioButton
                this.selected = selected
            }
            .padding(vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            color = if (selected) ByhColors.Text else ByhColors.TextDim,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            fontSize = 15.sp,
        )
    }
}
