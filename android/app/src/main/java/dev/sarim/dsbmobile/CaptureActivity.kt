package dev.sarim.dsbmobile

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Fingerprint
import androidx.compose.material.icons.outlined.Keyboard
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Logout
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.lifecycleScope
import dev.sarim.dsbmobile.data.BridgeClient
import dev.sarim.dsbmobile.data.CookieDto
import dev.sarim.dsbmobile.data.ServerConfig
import dev.sarim.dsbmobile.ui.Body
import dev.sarim.dsbmobile.ui.DsbField
import dev.sarim.dsbmobile.ui.LimeAction
import dev.sarim.dsbmobile.ui.Mono
import dev.sarim.dsbmobile.ui.StatusDot
import dev.sarim.dsbmobile.ui.Tag
import dev.sarim.dsbmobile.ui.theme.Dsb
import dev.sarim.dsbmobile.ui.theme.DsbTheme
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.json.JSONTokener

/**
 * The official chat.deepseek.com sign-in page, in a WebView.
 *
 * DeepSeek's first login carries a captcha / verification code, so the app does
 * not re-implement the form: it lets the real site run, watches localStorage
 * for the userToken, reads the HttpOnly session cookie from CookieManager, and
 * posts both to the bridge only when the user taps REGISTER.
 */
class CaptureActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private val handler = Handler(Looper.getMainLooper())
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val client = BridgeClient()

    private var capturedToken by mutableStateOf<String?>(null)
    private var errorMessage by mutableStateOf<String?>(null)
    private var registering by mutableStateOf(false)
    private var pageHost by mutableStateOf("chat.deepseek.com")
    private var assistOpen by mutableStateOf(false)
    private var assistEmail by mutableStateOf("")
    private var assistPassword by mutableStateOf("")
    // Sign-up needs these too: chat.deepseek.com's register form is email +
    // password + repeat-password + verification code. Filling only the first
    // password left the form half-complete and the submit button disabled,
    // which looked like the assist "not working" on that page.
    private var assistRepeat by mutableStateOf("")
    private var assistCode by mutableStateOf("")

    // Set once the WebView has a real size and the first load has been issued.
    private var webViewLoaded = false

    private var baseUrl = ""
    private var apiKey = ""
    private var replaceId: String? = null
    private var label = ""
    private var fresh = true

    private val tokenWatcher = object : Runnable {
        override fun run() {
            if (!::webView.isInitialized) return
            webView.evaluateJavascript(JS_READ) { raw ->
                val token = parseJsString(raw)
                if (token != null && token != capturedToken) {
                    capturedToken = token
                    errorMessage = null
                }
            }
            handler.postDelayed(this, 1400)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )

        baseUrl = intent.getStringExtra("base_url").orEmpty()
        apiKey = intent.getStringExtra("api_key").orEmpty()
        replaceId = intent.getStringExtra("replace_id")
        label = intent.getStringExtra("label").orEmpty()
        fresh = intent.getBooleanExtra("fresh", true)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.setSupportMultipleWindows(false)
            settings.loadsImagesAutomatically = true
            // Autofill inserts character-by-character into this React form and
            // trips the same caret bug the JS guard fixes; keep it out.
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            settings.userAgentString =
                "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    pageHost = runCatching { Uri.parse(url).host ?: "chat.deepseek.com" }.getOrDefault("chat.deepseek.com")
                    // Fix the zero-height viewport-unit collapse first, then the
                    // modal sizing; both must run on every page load.
                    view?.evaluateJavascript(JS_VH_SHIM, null)
                    view?.evaluateJavascript(JS_MODAL_FIX, null)
                    handler.removeCallbacks(tokenWatcher)
                    handler.post(tokenWatcher)
                }

                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val target = request?.url ?: return false
                    if (target.scheme == "http" || target.scheme == "https") return false
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, target)) }
                    return true
                }
            }
            if (fresh) clearSession(view = this)
            // NOT loaded here on purpose — see onSizeChanged in setContent.
        }

        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else finish()
            }
        })

        setContent {
            DsbTheme {
                Box(
                    Modifier.fillMaxSize().background(Dsb.Bg),
                    contentAlignment = Alignment.TopCenter,
                ) {
                    Column(
                        Modifier
                            .widthIn(max = 520.dp)
                            .fillMaxHeight()
                            .background(Dsb.Bg)
                            .statusBarsPadding(),
                    ) {
                        ChromeBar(
                            host = pageHost,
                            onClose = { finish() },
                            onReload = { webView.reload() },
                            onNewSession = {
                                clearSession(view = webView)
                                webView.loadUrl(SIGN_IN_URL)
                            },
                        )
                        Box(Modifier.weight(1f)) {
                            AndroidView(
                                factory = { webView },
                                modifier = Modifier
                                    .fillMaxSize()
                                    // Load only once the view has a real size.
                                    //
                                    // Chromium latches its layout viewport at the
                                    // first layout. Created in onCreate, this
                                    // WebView laid out at 0x0, so the page's
                                    // initial containing block stayed zero and
                                    // every viewport unit resolved to 0px — 1vh,
                                    // 100vh, 100dvh and 100svh all measured 0
                                    // while window.innerHeight correctly said
                                    // 678. chat.deepseek.com sizes its shell with
                                    // those units, so html/body/#root collapsed
                                    // to 0px and the page painted nothing: the DOM
                                    // mounted, cookies were set and the site's JS
                                    // ran, but the screen stayed blank. Deferring
                                    // the first load until the view is measured
                                    // gives the page a real layout viewport.
                                    .onSizeChanged { size ->
                                        if (!webViewLoaded && size.width > 0 && size.height > 0) {
                                            webViewLoaded = true
                                            webView.loadUrl(SIGN_IN_URL)
                                        }
                                    },
                            )
                            RegisterFloat(
                                captured = capturedToken != null,
                                registering = registering,
                                modifier = Modifier.align(Alignment.BottomEnd).padding(18.dp),
                                onClick = { register() },
                            )
                        }
                        CredentialAssist(
                            open = assistOpen,
                            email = assistEmail,
                            password = assistPassword,
                            repeat = assistRepeat,
                            code = assistCode,
                            onToggle = { assistOpen = !assistOpen },
                            onEmail = { assistEmail = it },
                            onPassword = { assistPassword = it },
                            onRepeat = { assistRepeat = it },
                            onCode = { assistCode = it },
                            onFill = { fillOfficialPage() },
                        )
                        CaptureSheet(
                            token = capturedToken,
                            error = errorMessage,
                            registering = registering,
                            replace = replaceId != null,
                            host = ServerConfig(baseUrl = baseUrl).hostLabel,
                            onRegister = { register() },
                        )
                    }
                }
            }
        }
    }

    private fun clearSession(view: WebView) {
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
        WebStorage.getInstance().deleteAllData()
        view.clearCache(true)
        view.clearHistory()
        capturedToken = null
        errorMessage = null
    }

    private fun register() {
        val token = capturedToken ?: return
        if (registering) return
        val server = ServerConfig(baseUrl = baseUrl.trim().trimEnd('/'), apiKey = apiKey.trim())
        registering = true
        errorMessage = null
        lifecycleScope.launch {
            try {
                val ua = webView.settings.userAgentString
                val cookies = readCookies()
                val response = client.addAccount(server, token, cookies, ua, label)
                val accountId = response.account?.id
                val replaced = replaceId
                if (replaced != null && accountId != null && accountId != replaced) {
                    runCatching { client.deleteAccount(server, replaced) }
                }
                val result = Intent().apply {
                    putExtra("token", token)
                    putExtra("account_id", accountId)
                    putExtra("label", response.account?.label ?: label)
                    putExtra("user_agent", ua)
                    putExtra("cookies_json", json.encodeToString(ListSerializer(CookieDto.serializer()), cookies))
                }
                setResult(RESULT_OK, result)
                finish()
            } catch (e: Exception) {
                errorMessage = e.message ?: "Registration failed"
            } finally {
                registering = false
            }
        }
    }

    /**
     * Fill the official page's inputs without touching the buggy WebView IME path.
     *
     * Handles both shapes of the site:
     *  - sign-in: email + password
     *  - sign-up: email + password + repeat password + verification code
     *
     * The previous version took the first text/email input and the first password
     * input only, so on the register page the repeat-password and the code box
     * stayed empty and the submit button stayed disabled. Inputs are now matched
     * by role, not by position: email by type/autocomplete/name, passwords by
     * type (first = password, second = repeat), and the code box by its
     * name/placeholder or a short maxlength. The code box only exists on the
     * step after the email is accepted, so re-running FILL once that step
     * appears is expected and harmless.
     */
    private fun fillOfficialPage() {
        val email = org.json.JSONObject.quote(assistEmail.trim())
        val password = org.json.JSONObject.quote(assistPassword)
        // Empty repeat means "same as password", which is what a sign-up form
        // wants; an explicitly typed repeat always wins.
        val repeat = org.json.JSONObject.quote(assistRepeat.ifBlank { assistPassword })
        val code = org.json.JSONObject.quote(assistCode.trim())
        val js = "(function(e,p,r,c){" +
            "function set(el,v){try{var d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value');" +
            "if(d&&d.set){d.set.call(el,v)}else{el.value=v}" +
            "el.dispatchEvent(new Event('input',{bubbles:true}));" +
            "el.dispatchEvent(new Event('change',{bubbles:true}));}catch(x){}}" +
            "var ins=[].slice.call(document.querySelectorAll('input')).filter(function(i){" +
            "return i.type!=='hidden'&&!i.disabled&&!i.readOnly;});" +
            "function pick(fn){for(var i=0;i<ins.length;i++){if(fn(ins[i]))return ins[i]}return null}" +
            "function hint(i){return ((i.name||'')+(i.id||'')+(i.placeholder||'')+(i.autocomplete||'')+(i.getAttribute('aria-label')||'')).toLowerCase()}" +
            "var em=pick(function(i){return i.type==='email'||i.autocomplete==='username'||/mail|phone|user|account/.test(hint(i))});" +
            "var pws=ins.filter(function(i){return i.type==='password'});" +
            "var cd=pick(function(i){if(i===em||pws.indexOf(i)>=0)return false;" +
            "var h=hint(i);if(/code|verify|verification|otp|captcha|token/.test(h))return true;" +
            "return i.maxLength>0&&i.maxLength<=8&&i.type!=='email'&&i.type!=='password';});" +
            "var n=0;" +
            "if(em&&e){set(em,e);n++}" +
            "if(pws[0]&&p){set(pws[0],p);n++}" +
            "if(pws[1]&&r){set(pws[1],r);n++}" +
            "if(cd&&c){set(cd,c);n++}" +
            "return String(n);" +
            "})($email,$password,$repeat,$code)"
        webView.evaluateJavascript(js) { raw ->
            val filled = raw?.trim()?.trim('"')?.toIntOrNull() ?: 0
            if (filled > 0) {
                assistOpen = false
                errorMessage = null
            } else {
                errorMessage =
                    "No login or sign-up fields found — tap the email box on the page once, then retry."
            }
        }
    }

    /** CookieManager sees HttpOnly cookies, unlike page JavaScript. */
    private fun readCookies(): List<CookieDto> {        val header = CookieManager.getInstance().getCookie("https://chat.deepseek.com") ?: return emptyList()
        return header.split(";").mapNotNull { part ->
            val index = part.indexOf('=')
            if (index <= 0) return@mapNotNull null
            val name = part.substring(0, index).trim()
            val value = part.substring(index + 1).trim()
            if (name.isBlank() || value.isBlank()) null else CookieDto(name = name, value = value)
        }
    }

    private fun parseJsString(raw: String?): String? {
        if (raw == null || raw == "null") return null
        val value = runCatching {
            when (val parsed = JSONTokener(raw).nextValue()) {
                is String -> parsed
                else -> null
            }
        }.getOrNull()
        return value?.trim()?.takeIf {
            it.length >= 20 && !it.contains('{') && !it.contains('"') && !it.contains(' ')
        }
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        if (::webView.isInitialized) {
            webView.stopLoading()
            webView.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val SIGN_IN_URL = "https://chat.deepseek.com/sign_in"
        private const val JS_READ =
            "(function(){try{var v=localStorage.getItem('userToken');if(!v)return null;var t=String(v).trim();if(t.charAt(0)==='{'){try{var p=JSON.parse(t);t=p&&typeof p.value==='string'?p.value:''}catch(e){return null}}if(!t||t.length<20||/[\\s{}\"]/.test(t))return null;return t}catch(e){return null}})()"

        /**
         * DeepSeek's verification modal relies on an entry animation that leaves
         * .ds-modal-content at max-height: 0 in Android WebView 118 (WSA): the
         * page dims and blurs, but the code dialog never appears, so the emailed
         * code expires before it can be entered.
         *
         * A plain stylesheet (even with !important) loses to the page's own
         * cascade here, and React rewrites inline styles on every render, which
         * is why patching element.style flickered once and vanished. Inline
         * declarations with !important outrank React's normal inline styles, so
         * the dialog stays open. The observer + timer re-apply the declarations
         * if React remounts the dialog; once it has height the pass is a no-op.
         */
        /**
         * Repairs viewport units in this WebView.
         *
         * Chromium here reports a correct layout viewport (411x678) yet resolves
         * every viewport unit to zero: 100vh, 100dvh, 100svh and even 1vh all
         * measure 0px, while percentages and px resolve fine. chat.deepseek.com
         * sizes its shell with those units, so html/body/#root collapsed to zero
         * height. The DOM mounted, cookies were set and the site's JS ran — but
         * the page painted nothing, which looked like "the page never loaded".
         *
         * Percentages DO resolve, so the height chain is pinned in px computed
         * from window.innerHeight, which is reported correctly. The stylesheet is
         * rewritten only when that height actually changes, and it re-applies on
         * rotation and on React re-renders (which replace the containers).
         */
        private const val JS_VH_SHIM =
            "(function(){" +
                "function apply(){var h=window.innerHeight||0;if(h<50)return;" +
                "if(window.__dsbVhH===h)return;window.__dsbVhH=h;" +
                "var s=document.getElementById('dsb-vh');" +
                "if(!s){s=document.createElement('style');s.id='dsb-vh';" +
                "(document.head||document.documentElement).appendChild(s);}" +
                // Two levels must be pinned, and exactly two.
                //
                // #root itself, and #root>div which is the page's scroll
                // container (c994dda2). That container carries overflow:auto
                // and computes to height:0 because its own height comes from a
                // viewport unit — so it clipped the entire login form to
                // nothing. The form was laid out at correct coordinates with
                // opacity 1 and visibility visible, yet painted zero pixels;
                // the only way to see it was to pin this box.
                //
                // Going deeper is what broke this earlier: forcing
                // #root>div>div matched an EMPTY spacer div and stretched it to
                // a full 678px, pushing the real form below the fold. So the
                // empty spacers are explicitly collapsed here instead.
                "s.textContent='#root{height:'+h+'px!important;min-height:'+h+'px!important}'+" +
                "'#root>div{height:'+h+'px!important;min-height:'+h+'px!important}'+" +
                "'#root>div>div:empty{display:none!important;height:0!important;min-height:0!important}';}" +
                "apply();" +
                "window.addEventListener('resize',apply);" +
                "setInterval(apply,700);" +
                "})()"

        private const val JS_MODAL_FIX =
            "(function(){" +
                "if(window.__dsbModalFix)return;window.__dsbModalFix=1;" +
                "function fix(){var ms=document.querySelectorAll('.ds-modal-content');" +
                "for(var i=0;i<ms.length;i++){var el=ms[i];" +
                "if(el.getBoundingClientRect().height>0)continue;" +
                "el.style.setProperty('max-height','none','important');" +
                "el.style.setProperty('height','auto','important');" +
                "el.style.setProperty('overflow','visible','important');}}" +
                "fix();" +
                "try{new MutationObserver(fix).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style']})}catch(e){}" +
                "setInterval(fix,600);" +
                "})()"
    }
}

@Composable
private fun ChromeBar(host: String, onClose: () -> Unit, onReload: () -> Unit, onNewSession: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .height(46.dp)
            .background(Dsb.Surface)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            Icons.Outlined.Close,
            "Close",
            tint = Dsb.Muted,
            modifier = Modifier.size(18.dp).clickable(onClick = onClose),
        )
        Row(
            Modifier
                .weight(1f)
                .height(28.dp)
                .background(Dsb.Bg, RoundedCornerShape(6.dp))
                .padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Outlined.Lock, null, tint = Dsb.Lime, modifier = Modifier.size(11.dp))
            Mono(host, size = 9, color = Dsb.Muted, letterSpacing = 0.4f)
        }
        Icon(
            Icons.Outlined.Refresh,
            "Reload",
            tint = Dsb.Muted,
            modifier = Modifier.size(16.dp).clickable(onClick = onReload),
        )
        Icon(
            Icons.Outlined.Logout,
            "New session",
            tint = Dsb.Muted,
            modifier = Modifier.size(16.dp).clickable(onClick = onNewSession),
        )
    }
}

@Composable
private fun RegisterFloat(
    captured: Boolean,
    registering: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val active = captured && !registering
    val tint = if (active) Dsb.Lime else Dsb.Amber
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier
                .height(30.dp)
                .background(Dsb.Bg, RoundedCornerShape(4.dp))
                .border(1.dp, if (active) Dsb.Lime else Dsb.Line, RoundedCornerShape(4.dp))
                .padding(horizontal = 9.dp),
            contentAlignment = Alignment.Center,
        ) {
            Mono(if (registering) "SENDING" else if (active) "REGISTER" else "WAITING", size = 8, color = tint, letterSpacing = 1f)
        }
        Spacer(Modifier.size(8.dp))
        Box(
            Modifier
                .size(58.dp)
                .background(if (active) Dsb.Lime else Dsb.Surface, RoundedCornerShape(29.dp))
                .border(1.dp, tint, RoundedCornerShape(29.dp))
                .clickable(enabled = active, onClick = onClick),
            contentAlignment = Alignment.Center,
        ) {
            if (registering) {
                CircularProgressIndicator(color = Dsb.Bg, strokeWidth = 2.dp, modifier = Modifier.size(22.dp))
            } else {
                Icon(
                    if (active) Icons.Outlined.PersonAdd else Icons.Outlined.Fingerprint,
                    contentDescription = "Register",
                    tint = if (active) Dsb.Bg else Dsb.Amber,
                    modifier = Modifier.size(24.dp),
                )
            }
        }
    }
}

@Composable
private fun CredentialAssist(
    open: Boolean,
    email: String,
    password: String,
    repeat: String,
    code: String,
    onToggle: () -> Unit,
    onEmail: (String) -> Unit,
    onPassword: (String) -> Unit,
    onRepeat: (String) -> Unit,
    onCode: (String) -> Unit,
    onFill: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(Dsb.Bg)
            .border(1.dp, Dsb.Line)
            .padding(horizontal = 14.dp, vertical = 8.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onToggle),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                Icon(Icons.Outlined.Keyboard, null, tint = Dsb.Lime, modifier = Modifier.size(14.dp))
                Mono("PAGE TYPING REVERSED? TYPE HERE", size = 8, color = Dsb.Lime, letterSpacing = 0.8f)
            }
            Icon(
                if (open) Icons.Outlined.KeyboardArrowUp else Icons.Outlined.KeyboardArrowDown,
                contentDescription = if (open) "Collapse" else "Expand",
                tint = Dsb.Muted,
                modifier = Modifier.size(16.dp),
            )
        }
        if (open) {
            Spacer(Modifier.height(8.dp))
            DsbField(email, onEmail, "Email / phone number")
            Spacer(Modifier.height(6.dp))
            DsbField(password, onPassword, "Password", password = true)
            Spacer(Modifier.height(6.dp))
            DsbField(repeat, onRepeat, "Repeat password (sign-up)", password = true)
            Spacer(Modifier.height(6.dp))
            DsbField(code, onCode, "Verification code (sign-up)", mono = true)
            Spacer(Modifier.height(8.dp))
            LimeAction(
                "FILL THE OFFICIAL PAGE",
                enabled = email.isNotBlank() || password.isNotBlank() || code.isNotBlank(),
                onClick = onFill,
            )
            Spacer(Modifier.height(5.dp))
            Body(
                "Fills sign-in and sign-up fields. Repeat password defaults to the password; the code box is filled when it appears. The page still handles Log in, captcha and sending the code.",
                size = 9,
                color = Dsb.Muted,
            )
        }
    }
}

@Composable
private fun CaptureSheet(
    token: String?,
    error: String?,
    registering: Boolean,
    replace: Boolean,
    host: String,
    onRegister: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(Dsb.Surface)
            .border(1.dp, if (token != null) Dsb.Lime else Dsb.Line)
            .padding(14.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                StatusDot(if (token != null) Dsb.Lime else Dsb.Amber, 7)
                Mono(
                    if (token != null) "TOKEN CAPTURED" else if (registering) "REGISTERING" else "WAITING FOR LOGIN",
                    size = 9,
                    color = if (token != null) Dsb.Lime else Dsb.Amber,
                    letterSpacing = 1.4f,
                )
            }
            Tag(if (replace) "REPLACE" else "OFFICIAL SITE", Dsb.Bg, if (token != null) Dsb.Lime else Dsb.Amber)
        }
        Spacer(Modifier.height(8.dp))
        if (token == null) {
            Body(
                "Sign in here — captchas and verification codes are handled by chat.deepseek.com. The button arms when the session token appears.",
                size = 11,
                color = Dsb.Muted,
            )
        } else {
            Mono("${token.take(8)}…${token.takeLast(4)}", size = 12, color = Dsb.Text, letterSpacing = 0.6f)
            Spacer(Modifier.height(6.dp))
            Body(
                if (replace) "Replaces the old login on $host." else "Adds a new login to $host.",
                size = 10,
                color = Dsb.Muted,
            )
            Spacer(Modifier.height(10.dp))
            LimeAction(
                text = if (registering) "REGISTERING…" else "REGISTER TO DSB",
                enabled = !registering,
                onClick = onRegister,
            )
        }
        if (error != null) {
            Spacer(Modifier.height(8.dp))
            Body(error, size = 11, color = Dsb.Red, maxLines = 3)
        }
    }
}
