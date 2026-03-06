# Bikel 🚲⚡

A Nostr-native cycling coordination app. Sovereignty, community, and real-world coordination.

## Project Structure

This repository contains two main applications built for the Bikel MVP:

1. **`web/`** - The read-only Web Dashboard (Built with Vite + React + Leaflet).
2. **`apk/`** - The mobile tracking application (Built with React Native + Expo).

---

## 🏃 Running the Web Dashboard

The web dashboard provides a global heatmap and recent public rides feed.

```bash
cd web
npm install
npm run dev
```
Open `http://localhost:5173` in your browser.

---

## 📱 Running the Mobile App (APK)

The mobile app gets local GPS coordinates, records rides, and publishes them to Nostr relays.

```bash
cd apk
npm install
npm run start
```
Use the **Expo Go** app on your iOS or Android device to scan the QR code and view the mobile app.

---

## Architecture

- **Styling**: Both apps use custom, highly polished dark-mode aesthetics using pure Vanilla CSS / StyleSheet logic. No Tailwind.
- **Maps**: `react-leaflet` on the Web, `react-native-maps` on Mobile.
- **Nostr**: Ready to be integrated using `@nostr-dev-kit/ndk` in upcoming phases.

---

---

## 📦 Building & Installing the APK (Local Fast Install)

We've included a custom script (`apk/install.sh`) to automatically compile the React Native app into an APK and push it over WiFi to your Android device via `adb`.


### Prerequisites for the Install Script
1. Connect your Android phone to the same WiFi network as your PC.
2. Enable Developer Options -> **Wireless Debugging**.
3. Run `adb connect <YOUR_PHONE_IP>:<PORT>`
4. Ensure `adb devices` shows your device.

### Running the install script:
```bash
cd apk
./install.sh
```
This script will:
- Auto-generate the native Android project via Expo Prebuild.
- Compile a debug APK using Gradle.
- Search for your wireless ADB device and install it automatically.
- Launch the `com.bikel.app` package immediately on success.

## 📥 Distributing the APK on the Website
To make Bikel truly sovereign, users can download the APK right from the site.
1. Copy the generated `app-debug.apk` from `apk/android/app/build/outputs/apk/debug/app-debug.apk` to `web/public/bikel-app.apk`.
2. The web dashboard will now successfully serve the file when users click **Download APK**.




adb kill-server
adb start-server
adb connect 192.168.0.31:33387



Just plug in the phone and run
./install.sh --release