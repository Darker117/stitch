import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.stitch.mobile',
  appName: 'Stitch',
  webDir: 'dist',
  // The page is served from http://localhost so it can reach the PC over plain
  // LAN HTTP/WebSocket without mixed-content blocking (localhost stays a secure context).
  server: {
    androidScheme: 'http',
    cleartext: true,
    // Dev live reload: `CAP_LIVE_URL=http://<pc-ip>:5174 npx cap sync android` loads the UI from Vite.
    ...(process.env.CAP_LIVE_URL ? { url: process.env.CAP_LIVE_URL } : {})
  },
  android: {
    backgroundColor: '#07060b',
    allowMixedContent: true
  },
  plugins: {
    SplashScreen: { launchShowDuration: 0, backgroundColor: '#07060b', showSpinner: false },
    Keyboard: { resize: 'native', resizeOnFullScreen: true },
    StatusBar: { overlaysWebView: true, style: 'DARK', backgroundColor: '#00000000' }
  }
}

export default config
