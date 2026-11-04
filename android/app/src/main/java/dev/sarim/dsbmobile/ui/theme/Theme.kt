package dev.sarim.dsbmobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import dev.sarim.dsbmobile.R

object Dsb {
    val Bg = Color(0xFF0B0E0C)
    val Surface = Color(0xFF141A16)
    val Surface2 = Color(0xFF1C241E)
    val Line = Color(0xFF2B352D)
    val Text = Color(0xFFEDF2EC)
    val Muted = Color(0xFF93A196)
    val Lime = Color(0xFFB8F24B)
    val Amber = Color(0xFFF5B74A)
    val Red = Color(0xFFFF6F61)
    val Blue = Color(0xFF4D6BFE)
}

val Anton = FontFamily(Font(R.font.anton))
val Barlow = FontFamily(
    Font(R.font.barlow_regular, FontWeight.Normal),
    Font(R.font.barlow_medium, FontWeight.Medium),
    Font(R.font.barlow_semibold, FontWeight.SemiBold),
)
val PlexMono = FontFamily(
    Font(R.font.plex_mono_regular, FontWeight.Normal),
    Font(R.font.plex_mono_medium, FontWeight.Medium),
)

private val DsbTypography = Typography(
    displayLarge = androidx.compose.ui.text.TextStyle(
        fontFamily = Anton,
        fontSize = 56.sp,
        lineHeight = 58.sp,
        letterSpacing = 1.sp,
    ),
    headlineLarge = androidx.compose.ui.text.TextStyle(
        fontFamily = Anton,
        fontSize = 38.sp,
        lineHeight = 40.sp,
        letterSpacing = 0.8.sp,
    ),
    titleLarge = androidx.compose.ui.text.TextStyle(
        fontFamily = Barlow,
        fontWeight = FontWeight.SemiBold,
        fontSize = 20.sp,
        lineHeight = 26.sp,
    ),
    bodyLarge = androidx.compose.ui.text.TextStyle(
        fontFamily = Barlow,
        fontSize = 16.sp,
        lineHeight = 23.sp,
    ),
    bodyMedium = androidx.compose.ui.text.TextStyle(
        fontFamily = Barlow,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
    labelSmall = androidx.compose.ui.text.TextStyle(
        fontFamily = PlexMono,
        fontSize = 10.sp,
        letterSpacing = 1.2.sp,
    ),
)

@Composable
fun DsbTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Dsb.Lime,
            onPrimary = Dsb.Bg,
            secondary = Dsb.Amber,
            background = Dsb.Bg,
            onBackground = Dsb.Text,
            surface = Dsb.Surface,
            onSurface = Dsb.Text,
            surfaceVariant = Dsb.Surface2,
            onSurfaceVariant = Dsb.Muted,
            outline = Dsb.Line,
            error = Dsb.Red,
        ),
        typography = DsbTypography,
        content = content,
    )
}
