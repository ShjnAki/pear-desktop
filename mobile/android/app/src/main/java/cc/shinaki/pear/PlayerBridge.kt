package cc.shinaki.pear

import org.json.JSONObject

data class PlayerState(
  val title: String,
  val artist: String,
  val album: String,
  val artwork: String,
  val playing: Boolean,
  val position: Long,
  val duration: Long,
) {
  companion object {
    fun parse(json: String): PlayerState {
      val o = JSONObject(json)
      return PlayerState(
        title = o.optString("title"),
        artist = o.optString("artist"),
        album = o.optString("album"),
        artwork = o.optString("artwork"),
        playing = o.optBoolean("playing"),
        position = o.optLong("position"),
        duration = o.optLong("duration"),
      )
    }
  }
}

/** Links the WebView (owned by MainActivity) and the notification (owned by PlaybackService). */
object PlayerBridge {
  /** Set by MainActivity: runs `__pear.control(action, arg)` in the page. */
  var controller: ((action: String, arg: Long) -> Unit)? = null

  fun control(action: String, arg: Long = 0) {
    controller?.invoke(action, arg)
  }
}
