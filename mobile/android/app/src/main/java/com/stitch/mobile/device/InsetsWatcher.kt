package com.stitch.mobile.device

import android.graphics.Color
import android.os.Build
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.appcompat.app.AppCompatActivity
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

data class SafeInsets(val top: Double, val bottom: Double, val left: Double, val right: Double, val ime: Double)

/**
 * Edge-to-edge window with transparent bars and light icons (the UI is dark), reporting system-bar + display-cutout
 * insets and the keyboard height in CSS px. It replaces the decor-view insets listener of Capacitor's built-in
 * SystemBars plugin (which would pad the WebView inside the bars):
 *  - the WebView is drawn under the status/navigation bars and cutout; the page pads itself with top/left/right/bottom;
 *  - while the keyboard is open the WebView is resized above it (Keyboard.resize = 'native'), `bottom` is then 0
 *    (the keyboard covers the navigation bar) and `ime` is the keyboard height.
 */
class InsetsWatcher(private val activity: AppCompatActivity, private val onChange: (SafeInsets) -> Unit) {
    @Volatile var current = SafeInsets(0.0, 0.0, 0.0, 0.0, 0.0)
        private set
    @Volatile private var measured = false

    /** Call on the main thread. */
    fun attach() {
        applyStyle()
        val decor = activity.window.decorView
        ViewCompat.setOnApplyWindowInsetsListener(decor) { v, insets -> handle(v, insets) }
        ViewCompat.requestApplyInsets(decor)
    }

    /** Re-assert transparent bars + light icons (other plugins restyle the bars on theme changes). */
    fun applyStyle() {
        try {
            activity.enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
        } catch (_: Throwable) {
            WindowCompat.setDecorFitsSystemWindows(activity.window, false)
        }
        val window = activity.window
        if (Build.VERSION.SDK_INT >= 29) {
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = false
        }
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = false
        controller.isAppearanceLightNavigationBars = false
    }

    /** Current insets; measured from the root insets when no dispatch happened yet. Main thread. */
    fun snapshot(): SafeInsets {
        if (!measured) {
            ViewCompat.getRootWindowInsets(activity.window.decorView)?.let { compute(it) }?.let { current = it }
        }
        return current
    }

    private fun handle(v: View, insets: WindowInsetsCompat): WindowInsetsCompat {
        val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
        // Resize the content above the keyboard; everything else stays edge-to-edge.
        v.setPadding(0, 0, 0, if (imeVisible) ime else 0)
        val values = compute(insets)
        measured = true
        if (values != current) {
            current = values
            onChange(values)
        }
        // Hand the WebView zero bar insets so it doesn't apply its own safe areas on top of ours (same as
        // Capacitor's SystemBars; returning CONSUMED would break later recalculation).
        return WindowInsetsCompat.Builder(insets)
            .setInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(), Insets.NONE)
            .build()
    }

    private fun compute(insets: WindowInsetsCompat): SafeInsets {
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
        val ime = if (imeVisible) insets.getInsets(WindowInsetsCompat.Type.ime()).bottom else 0
        val d = activity.resources.displayMetrics.density.toDouble().takeIf { it > 0 } ?: 1.0
        fun css(px: Int) = Math.round(px / d * 10.0) / 10.0
        return SafeInsets(
            top = css(bars.top),
            bottom = if (imeVisible) 0.0 else css(bars.bottom),
            left = css(bars.left),
            right = css(bars.right),
            ime = css(ime),
        )
    }
}
