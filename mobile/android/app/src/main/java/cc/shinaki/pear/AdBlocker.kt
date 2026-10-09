package cc.shinaki.pear

import android.net.Uri
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream

/** Network-level counterpart of the injected pruner: drops requests to ad/tracking endpoints. */
object AdBlocker {
  private val blockedHosts = listOf(
    "doubleclick.net",
    "googleadservices.com",
    "googlesyndication.com",
    "googletagservices.com",
    "google-analytics.com",
    "adservice.google.com",
    "imasdk.googleapis.com",
  )

  private val blockedPaths = listOf(
    "/api/stats/ads",
    "/pagead/",
    "/ptracking",
    "/get_midroll_",
    "/youtubei/v1/log_event",
  )

  fun shouldBlock(uri: Uri): Boolean {
    val host = uri.host ?: return false
    if (blockedHosts.any { host == it || host.endsWith(".$it") }) return true
    val path = uri.path ?: return false
    return (host.endsWith("youtube.com") || host.endsWith("google.com")) &&
      blockedPaths.any { path.startsWith(it) }
  }

  fun emptyResponse() = WebResourceResponse("text/plain", "utf-8", 204, "No Content", emptyMap(), ByteArrayInputStream(ByteArray(0)))
}
