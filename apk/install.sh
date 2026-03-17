#!/bin/bash
# Quick script to build and install APK to wireless device
# Auto-detects wireless device and installs
# Usage: ./install.sh [--release]

IS_RELEASE=0
if [ "$1" == "--release" ]; then
    IS_RELEASE=1
    echo "🚀 Building STANDALONE RELEASE APK for Bikel..."
else
    echo "🔨 Building DEBUG APK for Bikel..."
fi

cd "$(dirname "$0")"

# Ensure android native dir exists
if [ ! -d "android" ]; then
    echo "⚙️ Generating native Android project..."
    npx expo prebuild -p android --clean
fi

# Auto-configure local.properties if it doesn't exist
if [ ! -f "android/local.properties" ]; then
    echo "⚙️ Creating local.properties..."
    SDK_PATH="$HOME/android-sdk"
    if [ ! -d "$SDK_PATH" ]; then
        SDK_PATH="$HOME/Android/Sdk"
    fi
    echo "sdk.dir=$SDK_PATH" > android/local.properties
fi

if [ $IS_RELEASE -eq 1 ]; then
    echo "📦 Bundling JavaScript assets (Offline bundle)..."
    npx expo export --platform android
    
    echo "🔨 Compiling standalone APK via Gradle..."
    cd android
    ./gradlew assembleRelease
    BUILD_STAT=$?
    cd ..
    APK_PATH=$(ls -t android/app/build/outputs/apk/release/*.apk | head -n 1)
else
    echo "🔨 Compiling debug APK via Gradle..."
    cd android
    ./gradlew assembleDebug
    BUILD_STAT=$?
    cd ..
    APK_PATH="android/app/build/outputs/apk/debug/app-debug.apk"
fi

if [ $BUILD_STAT -ne 0 ]; then
    echo "❌ Build failed!"
    exit 1
fi

echo ""
echo "📱 Installing to device..."

# Try to find wireless device first (usually has IP address)
WIRELESS_DEVICE=$(adb devices | grep -E ":[0-9]+.*device$" | awk '{print $1}' | head -1)

if [ -z "$WIRELESS_DEVICE" ]; then
    # Fall back to any device
    DEVICE=$(adb devices | tail -n +2 | grep "device$" | awk '{print $1}' | head -1)
    if [ -z "$DEVICE" ]; then
        echo "❌ No devices found!"
        echo ""
        echo "To connect wirelessly:"
        echo "1. On phone: Settings > Developer options > Wireless debugging"
        echo "2. Note the 'IP address & port' (e.g., 192.168.0.31:45191)"
        echo "3. Run: adb connect 192.168.0.31:45191"
        exit 1
    fi
    WIRELESS_DEVICE=$DEVICE
fi

echo "Installing to: $WIRELESS_DEVICE"

if [ $IS_RELEASE -eq 0 ]; then
    # Forward Metro bundler port so the app can load the JS bundle from the PC
    echo "🔌 Forwarding Metro Bundler port (8081)..."
    adb -s "$WIRELESS_DEVICE" reverse tcp:8081 tcp:8081
fi

adb -s "$WIRELESS_DEVICE" install -r "$APK_PATH"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Install successful!"
    echo "📱 App should now be on your device"
    
    # Launch the app automatically
    echo "🚀 Launching Bikel..."
    adb -s "$WIRELESS_DEVICE" shell monkey -p com.bikel.app -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
else
    echo ""
    echo "❌ Install failed!"
    exit 1
fi
