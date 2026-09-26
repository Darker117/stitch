// Stitch for Android. The bridge is installed first so every desktop module sees `window.stitch`.
import './bridge/install'
import './mobile.css'

void import('./boot').then((m) => m.boot())
