package com.backyardhero.hub.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

object ByhColors {
    val Background = Color(0xFF0B0F14)
    val Surface = Color(0xFF141A22)
    val SurfaceHigh = Color(0xFF1C2430)
    val Outline = Color(0xFF2A3442)
    val Text = Color(0xFFE6EDF3)
    val TextDim = Color(0xFF8B98A8)
    val Accent = Color(0xFFFFB020)
    val Ok = Color(0xFF2FBF71)
    val Warn = Color(0xFFF2C94C)
    val Danger = Color(0xFFEB5757)
    val Info = Color(0xFF4EA8FF)
    val Purple = Color(0xFFB57BFF)
    val Cyan = Color(0xFF3CD3E0)
}

private val scheme = darkColorScheme(
    primary = ByhColors.Accent,
    onPrimary = Color.Black,
    secondary = ByhColors.Info,
    background = ByhColors.Background,
    onBackground = ByhColors.Text,
    surface = ByhColors.Surface,
    onSurface = ByhColors.Text,
    surfaceVariant = ByhColors.SurfaceHigh,
    onSurfaceVariant = ByhColors.TextDim,
    outline = ByhColors.Outline,
    error = ByhColors.Danger,
)

@Composable
fun ByhTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, content = content)
}
