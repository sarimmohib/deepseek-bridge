package dev.sarim.dsbmobile

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import dev.sarim.dsbmobile.data.CookieDto
import dev.sarim.dsbmobile.ui.screens.ConnectScreen
import dev.sarim.dsbmobile.ui.screens.ConsoleScreen
import dev.sarim.dsbmobile.ui.screens.PoolScreen
import dev.sarim.dsbmobile.ui.screens.SettingsScreen
import dev.sarim.dsbmobile.ui.screens.VaultScreen
import dev.sarim.dsbmobile.ui.theme.Dsb
import dev.sarim.dsbmobile.ui.theme.DsbTheme
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

class MainActivity : ComponentActivity() {
    private val vm: DsbViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )

        // Test hook: only debug builds accept a pre-seeded server so adb can
        // drive the app without typing a URL/key on a TV-sized keyboard.
        if (BuildConfig.DEBUG) {
            intent?.getStringExtra("dsb_server")?.takeIf { it.isNotBlank() }?.let { server ->
                vm.seedForTesting(server, intent.getStringExtra("dsb_key").orEmpty())
            }
        }

        setContent {
            DsbTheme {
                Box(
                    Modifier.fillMaxSize().background(Dsb.Bg),
                    contentAlignment = Alignment.TopCenter,
                ) {
                    Box(Modifier.widthIn(max = 520.dp).fillMaxHeight()) {
                        AppRoot(vm)
                    }
                }
            }
        }
    }
}

@Composable
private fun AppRoot(vm: DsbViewModel) {
    val nav = rememberNavController()
    val context = LocalContext.current
    val json = Json { ignoreUnknownKeys = true }

    val capture = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data ?: return@rememberLauncherForActivityResult
            val token = data.getStringExtra("token") ?: return@rememberLauncherForActivityResult
            val cookies = data.getStringExtra("cookies_json")?.let {
                runCatching { json.decodeFromString(ListSerializer(CookieDto.serializer()), it) }
                    .getOrDefault(emptyList())
            } ?: emptyList()
            vm.saveCaptured(
                token = token,
                cookies = cookies,
                userAgent = data.getStringExtra("user_agent").orEmpty(),
                accountId = data.getStringExtra("account_id"),
                label = data.getStringExtra("label").orEmpty(),
            )
            vm.refresh()
        }
    }

    fun launchCapture(fresh: Boolean, replaceId: String?) {
        val server = vm.active ?: return
        val intent = Intent(context, CaptureActivity::class.java).apply {
            putExtra("base_url", server.baseUrl)
            putExtra("api_key", server.apiKey)
            putExtra("fresh", fresh)
            putExtra("replace_id", replaceId)
        }
        capture.launch(intent)
    }

    val goTab: (String) -> Unit = { route ->
        nav.navigate(route) {
            launchSingleTop = true
            popUpTo("console") { saveState = true }
            restoreState = true
        }
    }

    LaunchedEffect(Unit) {
        val active = vm.active
        if (active != null && vm.health?.ok != true) {
            vm.connect(active.baseUrl, active.apiKey)
        }
        if (vm.health?.ok == true) {
            nav.navigate("console") {
                popUpTo("connect") { inclusive = true }
            }
        }
    }

    NavHost(navController = nav, startDestination = "connect") {
        composable("connect") {
            ConnectScreen(vm) {
                nav.navigate("console") {
                    popUpTo("connect") { inclusive = true }
                }
            }
        }
        composable("console") {
            ConsoleScreen(
                vm = vm,
                onAddAccount = { launchCapture(fresh = true, replaceId = null) },
                onTab = goTab,
            )
        }
        composable("pool") {
            PoolScreen(
                vm = vm,
                onAddAccount = { launchCapture(fresh = true, replaceId = null) },
                onRelogin = { accountId -> launchCapture(fresh = false, replaceId = accountId) },
                onTab = goTab,
            )
        }
        composable("vault") {
            VaultScreen(vm = vm, onTab = goTab)
        }
        composable("setup") {
            SettingsScreen(
                vm = vm,
                onEditServer = { nav.navigate("connect") { launchSingleTop = true } },
                onTab = goTab,
            )
        }
    }
}
