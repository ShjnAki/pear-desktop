package cc.shinaki.pear

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.preference.PreferenceFragmentCompat

class SettingsActivity : AppCompatActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    supportActionBar?.setDisplayHomeAsUpEnabled(true)
    if (savedInstanceState == null) {
      supportFragmentManager.beginTransaction()
        .replace(android.R.id.content, SettingsFragment())
        .commit()
    }
  }

  override fun onSupportNavigateUp(): Boolean {
    finish()
    return true
  }

  class SettingsFragment : PreferenceFragmentCompat() {
    override fun onCreatePreferences(savedInstanceState: Bundle?, rootKey: String?) {
      setPreferencesFromResource(R.xml.preferences, rootKey)
      findPreference<androidx.preference.Preference>("reload")?.setOnPreferenceClickListener {
        startActivity(
          Intent(requireContext(), MainActivity::class.java)
            .setAction(MainActivity.ACTION_RELOAD)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP),
        )
        requireActivity().finish()
        true
      }
    }
  }
}
