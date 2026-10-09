package cc.shinaki.pear

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class MainActivity : AppCompatActivity() {
  companion object {
    const val ACTION_RELOAD = "cc.shinaki.pear.RELOAD"
    private const val HOME = "https://music.youtube.com/"
    private val ORIGINS = setOf("https://music.youtube.com")

    // Desktop UA used when the "Version bureau" setting is on.
    private const val DESKTOP_UA =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
  }

  private lateinit var webView: WebView
  private lateinit var prefs: Prefs
  private var scriptHandler: ScriptHandler? = null
  private val injectSource by lazy { assets.open("inject.js").bufferedReader().use { it.readText() } }

  // Fullscreen video (desktop layout) support.
  private var customView: View? = null
  private var customViewCallback: WebChromeClient.CustomViewCallback? = null

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    prefs = Prefs.load(this)

    val root = FrameLayout(this)
    webView = WebView(this)
    root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    setContentView(root)

    // targetSdk 35 forces edge-to-edge: keep the page clear of the system bars.
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }

    CookieManager.getInstance().apply {
      setAcceptCookie(true)
      setAcceptThirdPartyCookies(webView, true)
    }

    webView.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      databaseEnabled = true
      mediaPlaybackRequiresUserGesture = false
      cacheMode = WebSettings.LOAD_DEFAULT
      useWideViewPort = true
      loadWithOverviewMode = true
      applyUserAgent(this)
    }

    webView.webViewClient = PearWebViewClient()
    webView.webChromeClient = object : WebChromeClient() {
      override fun onShowCustomView(view: View, callback: CustomViewCallback) {
        customView = view
        customViewCallback = callback
        root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      }

      override fun onHideCustomView() {
        customView?.let { root.removeView(it) }
        customView = null
        customViewCallback?.onCustomViewHidden()
        customViewCallback = null
      }
    }

    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      // Only music.youtube.com can talk to the app (unlike addJavascriptInterface, which exposes every origin).
      WebViewCompat.addWebMessageListener(webView, "PearAndroid", ORIGINS) { _, message, _, _, _ ->
        message.data?.let { onPlayerState(PlayerState.parse(it)) }
      }
    }
    installScript()

    PlayerBridge.controller = { action, arg ->
      webView.post { webView.evaluateJavascript("window.__pear && window.__pear.control('$action', $arg)", null) }
    }

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        when {
          customView != null -> webView.webChromeClient?.onHideCustomView()
          webView.canGoBack() -> webView.goBack()
          else -> moveTaskToBack(true) // keep the music playing instead of destroying the WebView
        }
      }
    })

    requestNotificationPermission()

    if (savedInstanceState != null) webView.restoreState(savedInstanceState)
    else webView.loadUrl(intent.musicUrl() ?: HOME)
  }

  private fun applyUserAgent(settings: WebSettings) {
    settings.userAgentString = if (prefs.desktop) {
      DESKTOP_UA
    } else {
      // Google refuses sign-in from embedded WebViews: drop the "; wv" / "Version/x" markers.
      WebSettings.getDefaultUserAgent(this)
        .replace("; wv", "")
        .replace(Regex("Version/\\S+ "), "")
    }
  }

  /** (Re)registers inject.js so it runs before any page script, with the current settings. */
  private fun installScript() {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
    scriptHandler?.remove()
    val source = "window.__PEAR_CFG__ = ${prefs.toJs()};\n$injectSource"
    scriptHandler = WebViewCompat.addDocumentStartJavaScript(webView, source, ORIGINS)
  }

  private fun onPlayerState(state: PlayerState) {
    if (state.title.isEmpty() && !state.playing) return
    PlaybackService.update(this, state, prefs.background)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    if (intent.action == ACTION_RELOAD) {
      webView.reload()
      return
    }
    intent.musicUrl()?.let { webView.loadUrl(it) }
  }

  override fun onResume() {
    super.onResume()
    webView.onResume()
    val fresh = Prefs.load(this)
    if (fresh != prefs) {
      val uaChanged = fresh.desktop != prefs.desktop
      prefs = fresh
      installScript()
      if (uaChanged) applyUserAgent(webView.settings)
      webView.reload()
    }
  }

  override fun onStop() {
    super.onStop()
    // With background playback, the WebView must keep running when the app is hidden.
    if (!prefs.background) webView.onPause()
  }

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    webView.saveState(outState)
  }

  override fun onDestroy() {
    PlayerBridge.controller = null
    PlaybackService.stop(this)
    webView.destroy()
    super.onDestroy()
  }

  private fun requestNotificationPermission() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }
  }

  private fun Intent.musicUrl(): String? =
    // https only: a "javascript://music.youtube.com/..." intent would otherwise run code in the logged-in page.
    data?.takeIf { action == Intent.ACTION_VIEW && it.scheme == "https" && it.host == "music.youtube.com" }?.toString()

  private inner class PearWebViewClient : WebViewClient() {
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
      if (prefs.adblock && AdBlocker.shouldBlock(request.url)) AdBlocker.emptyResponse() else null

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
      val host = request.url.host ?: return false
      if (isInternal(host)) return false
      try {
        startActivity(Intent(Intent.ACTION_VIEW, request.url))
      } catch (_: ActivityNotFoundException) {
      }
      return true
    }

    // YouTube Music + Google sign-in / consent pages stay inside the app; everything else opens in the browser.
    private fun isInternal(host: String) =
      host == "music.youtube.com" ||
        host.endsWith(".youtube.com") || host == "youtube.com" ||
        host.endsWith(".google.com") || host == "google.com" ||
        // Country Google domains only (google.fr, google.co.uk, google.com.br), not "google.evil.com".
        Regex("""(^|\.)google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$""").containsMatchIn(host) ||
        host.endsWith(".gstatic.com") || host.endsWith(".googleusercontent.com")
  }
}
