package dev.sarim.dsbmobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.sarim.dsbmobile.data.Account
import dev.sarim.dsbmobile.ui.theme.Barlow
import dev.sarim.dsbmobile.ui.theme.Dsb
import dev.sarim.dsbmobile.ui.theme.PlexMono
import java.text.SimpleDateFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Date
import java.util.Locale

@Composable
fun Mono(
    text: String,
    modifier: Modifier = Modifier,
    size: Int = 10,
    color: Color = Dsb.Muted,
    weight: FontWeight = FontWeight.Normal,
    letterSpacing: Float = 1.2f,
    align: TextAlign = TextAlign.Start,
    maxLines: Int = 1,
) {
    Text(
        text = text,
        modifier = modifier,
        color = color,
        fontFamily = PlexMono,
        fontSize = size.sp,
        fontWeight = weight,
        letterSpacing = letterSpacing.sp,
        textAlign = align,
        maxLines = maxLines,
    )
}

@Composable
fun Body(
    text: String,
    modifier: Modifier = Modifier,
    size: Int = 14,
    color: Color = Dsb.Text,
    weight: FontWeight = FontWeight.Normal,
    align: TextAlign = TextAlign.Start,
    maxLines: Int = Int.MAX_VALUE,
) {
    Text(
        text = text,
        modifier = modifier,
        color = color,
        fontFamily = Barlow,
        fontSize = size.sp,
        fontWeight = weight,
        textAlign = align,
        maxLines = maxLines,
    )
}

@Composable
fun Display(
    text: String,
    modifier: Modifier = Modifier,
    size: Int = 38,
    color: Color = Dsb.Text,
) {
    Text(
        text = text,
        modifier = modifier,
        color = color,
        fontFamily = dev.sarim.dsbmobile.ui.theme.Anton,
        fontSize = size.sp,
        lineHeight = (size * 1.02f).sp,
        letterSpacing = 0.8.sp,
    )
}

@Composable
fun Hairline(color: Color = Dsb.Line) {
    Spacer(Modifier.fillMaxWidth().height(1.dp).background(color))
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Mono(text, modifier, size = 9, letterSpacing = 1.8f)
}

@Composable
fun Tag(text: String, fg: Color, bg: Color, modifier: Modifier = Modifier) {
    Box(
        modifier
            .background(bg, RoundedCornerShape(3.dp))
            .padding(horizontal = 7.dp, vertical = 4.dp),
    ) {
        Mono(text, size = 8, color = fg, letterSpacing = 1.2f)
    }
}

@Composable
fun StatusDot(color: Color, size: Int = 6) {
    Box(Modifier.size(size.dp).background(color, RoundedCornerShape(size.dp)))
}

@Composable
fun LimeAction(
    text: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val bg = if (enabled) Dsb.Lime else Dsb.Surface2
    val fg = if (enabled) Dsb.Bg else Dsb.Muted
    Row(
        modifier
            .fillMaxWidth()
            .height(52.dp)
            .background(bg, RoundedCornerShape(8.dp))
            .clickable(enabled = enabled, onClick = onClick),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Display(text, size = 16, color = fg)
        if (icon != null) {
            Spacer(Modifier.width(10.dp))
            Icon(icon, contentDescription = null, tint = fg, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
fun OutlineAction(
    text: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    tint: Color = Dsb.Text,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Row(
        modifier
            .fillMaxWidth()
            .height(46.dp)
            .border(1.dp, Dsb.Line, RoundedCornerShape(8.dp))
            .clickable(enabled = enabled, onClick = onClick),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(8.dp))
        }
        Mono(text, size = 10, color = tint, letterSpacing = 1.4f)
    }
}

@Composable
fun DsbIconButton(
    icon: ImageVector,
    contentDescription: String? = null,
    tint: Color = Dsb.Muted,
    onClick: () -> Unit,
) {
    Box(
        Modifier
            .size(38.dp)
            .border(1.dp, Dsb.Line, RoundedCornerShape(6.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = contentDescription, tint = tint, modifier = Modifier.size(16.dp))
    }
}

@Composable
fun SignalSpine(accounts: List<Account>, modifier: Modifier = Modifier, height: Int = 46) {
    val colors = if (accounts.isEmpty()) {
        List(5) { Dsb.Line }
    } else {
        accounts.take(8).map { Color(it.stateColor) }
    }
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        colors.forEach { color ->
            Box(
                Modifier
                    .weight(1f)
                    .height(height.dp)
                    .background(color, RoundedCornerShape(2.dp)),
            )
        }
    }
}

@Composable
fun MetricCell(label: String, value: String, modifier: Modifier = Modifier, accent: Color = Dsb.Text) {
    Column(modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
        Mono(label, size = 8, letterSpacing = 1.4f)
        Spacer(Modifier.height(3.dp))
        Text(value, color = accent, fontFamily = PlexMono, fontSize = 19.sp)
    }
}

@Composable
fun DsbField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    mono: Boolean = false,
    password: Boolean = false,
    keyboardType: androidx.compose.ui.text.input.KeyboardType = androidx.compose.ui.text.input.KeyboardType.Text,
    trailing: @Composable (() -> Unit)? = null,
) {
    androidx.compose.material3.OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth(),
        singleLine = true,
        shape = RoundedCornerShape(8.dp),
        textStyle = androidx.compose.ui.text.TextStyle(
            fontFamily = if (mono) PlexMono else Barlow,
            fontSize = if (mono) 11.sp else 14.sp,
            color = Dsb.Text,
        ),
        placeholder = {
            Text(placeholder, color = Dsb.Muted, fontFamily = if (mono) PlexMono else Barlow, fontSize = if (mono) 11.sp else 14.sp)
        },
        trailingIcon = trailing,
        visualTransformation = if (password) androidx.compose.ui.text.input.PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = keyboardType),
        colors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(
            focusedBorderColor = Dsb.Lime,
            unfocusedBorderColor = Dsb.Line,
            focusedContainerColor = Dsb.Surface,
            unfocusedContainerColor = Dsb.Surface,
            cursorColor = Dsb.Lime,
            focusedTextColor = Dsb.Text,
            unfocusedTextColor = Dsb.Text,
        ),
    )
}

@Composable
fun DsbBottomBar(current: String, onSelect: (String) -> Unit) {
    Column(Modifier.fillMaxWidth().background(Dsb.Bg).navigationBarsPadding()) {
        Hairline()
        Row(Modifier.fillMaxWidth().height(62.dp)) {
            TabItem("console", "CONSOLE", Icons.Outlined.Terminal, current, onSelect)
            TabItem("pool", "POOL", Icons.Outlined.Groups, current, onSelect)
            TabItem("vault", "VAULT", Icons.Outlined.Shield, current, onSelect)
            TabItem("setup", "SETUP", Icons.Outlined.Tune, current, onSelect)
        }
    }
}

@Composable
private fun RowScope.TabItem(
    route: String,
    label: String,
    icon: ImageVector,
    current: String,
    onSelect: (String) -> Unit,
) {
    val active = current == route
    val tint = if (active) Dsb.Lime else Dsb.Muted
    Column(
        Modifier
            .weight(1f)
            .fillMaxWidth()
            .clickable { onSelect(route) },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(19.dp))
        Spacer(Modifier.height(3.dp))
        Mono(label, size = 9, color = tint, letterSpacing = 0.8f)
    }
}

fun shortTime(ms: Long?): String {
    if (ms == null || ms <= 0) return "—"
    val fmt = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())
    return fmt.format(Instant.ofEpochMilli(ms))
}

fun relativeTime(ms: Long?): String {
    if (ms == null || ms <= 0) return "never"
    val delta = System.currentTimeMillis() - ms
    return when {
        delta < 60_000 -> "just now"
        delta < 3_600_000 -> "${delta / 60_000}m ago"
        delta < 86_400_000 -> "${delta / 3_600_000}h ago"
        else -> "${delta / 86_400_000}d ago"
    }
}

fun compactNumber(value: Long?): String {
    if (value == null || value <= 0) return "—"
    return when {
        value >= 1_000_000 -> String.format(Locale.US, "%.1fM", value / 1_000_000.0)
        value >= 1_000 -> "${value / 1000}K"
        else -> value.toString()
    }
}

@Suppress("unused")
fun dateStamp(ms: Long = System.currentTimeMillis()): String =
    SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(Date(ms))

private typealias RowScope = androidx.compose.foundation.layout.RowScope
