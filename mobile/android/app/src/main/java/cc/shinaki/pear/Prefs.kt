package cc.shinaki.pear

import android.content.Context
import androidx.preference.PreferenceManager
import org.json.JSONArray
import org.json.JSONObject

/** User settings, mirrored into `window.__PEAR_CFG__` for the injected script. */
data class Prefs(
  val background: Boolean,
  val adblock: Boolean,
  val sponsorblock: Boolean,
  val sbCategories: Set<String>,
  val desktop: Boolean,
) {
  fun toJs(): String = JSONObject()
    .put("background", background)
    .put("adblock", adblock)
    .put("sponsorblock", sponsorblock)
    .put("sbCategories", JSONArray(sbCategories.sorted()))
    .toString()

  companion object {
    private val DEFAULT_SB_CATEGORIES =
      setOf("sponsor", "intro", "outro", "interaction", "selfpromo", "music_offtopic")

    fun load(context: Context): Prefs {
      PreferenceManager.setDefaultValues(context, R.xml.preferences, false)
      val sp = PreferenceManager.getDefaultSharedPreferences(context)
      return Prefs(
        background = sp.getBoolean("background", true),
        adblock = sp.getBoolean("adblock", true),
        sponsorblock = sp.getBoolean("sponsorblock", true),
        sbCategories = sp.getStringSet("sb_categories", DEFAULT_SB_CATEGORIES) ?: DEFAULT_SB_CATEGORIES,
        desktop = sp.getBoolean("desktop", false),
      )
    }
  }
}
