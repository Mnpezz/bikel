import React, { useState, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Dimensions, Platform, ScrollView, TextInput, Alert, KeyboardAvoidingView, ActivityIndicator, Image, RefreshControl, BackHandler, AppState } from 'react-native';
import * as Location from 'expo-location';
import { LeafletView, MapLayerType, MapShapeType, WebViewLeafletEvents } from 'react-native-leaflet-view';
import { Bike, Square, Play, Zap, History, Settings, CalendarPlus, X, MessageSquare, Globe, LocateFixed, Map, Mail, Trash2, RotateCw, ChevronUp, Route, Clock, Gauge } from 'lucide-react-native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import * as Notifications from 'expo-notifications';
import { connectNDK, publishRide, fetchMyRides, fetchUserRides, getPrivateKeyNsec, getPublicKeyNpub, getPublicKeyHex, setPrivateKey, publishScheduledRide, publishContestEvent, fetchContests, fetchRecentRides, fetchScheduledRides, deleteRideEvent, publishRSVP, connectNWC, zapRideEvent, fetchComments, publishComment, fetchDMs, sendDM, publishProfile, fetchRideLeaderboard, uploadPhoto, ESCROW_PUBKEY, RideEvent, ScheduledRideEvent, ContestEvent, RideComment, DMessage } from './src/lib/nostr';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';

const LOCATION_TASK = 'BIKEL_LOCATION_TASK';
const PASSIVE_SCAN_TASK = 'BIKEL_PASSIVE_SCAN'; // legacy name kept for stop-cleanup only
const DRAFT_TASK = 'BIKEL_DRAFT_TASK';

const MAX_DRAFTS = 21;
const BIKE_SPEED_MIN_MPH = 5;   // m/s * 2.237 — covers slow cyclists & GPS jitter
const BIKE_SPEED_MAX_MPH = 25;
const CAR_SPEED_THRESHOLD_MPH = 30;
const CAR_SPIKE_LIMIT = 2;
const IDLE_STOP_SECONDS = 50;
// Warmup: must see N readings in bike range before committing route points
const WARMUP_NEEDED = 2;

export interface RideDraft {
  id: string;
  startTime: number; // unix seconds
  endTime: number;
  distance: number;
  durationSeconds: number;
  elevationGain: number; // in feet
  route: { lat: number; lng: number; alt?: number }[];
  confidence: number; // 0.0–1.0
  speedSpikes: number; // count of >30mph readings
}

// ── Module-level helper for persistent logging ──────────────────
let lastLogMsg = '';
let lastLogTime = 0;

async function logEvent(msg: string) {
  try {
    const now = Date.now();
    // Simple deduplication (ignore identical messages within 1000ms)
    if (msg === lastLogMsg && (now - lastLogTime) < 1000) return;
    lastLogMsg = msg;
    lastLogTime = now;

    const timestamp = new Date().toLocaleTimeString([], { hour12: false });
    const newLog = `[${timestamp}] ${msg}`;
    console.log(`[BikelLog] ${newLog}`);
    const existingRaw = await AsyncStorage.getItem('bikel_logs');
    let logs = existingRaw ? JSON.parse(existingRaw) : [];
    logs = [newLog, ...logs].slice(0, 100);
    await AsyncStorage.setItem('bikel_logs', JSON.stringify(logs));
  } catch (e) { console.error('Failed to save log:', e); }
}

// Manual high-accuracy tracking (existing)
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }: any) => {
  if (error) { console.error('[BackgroundLocation] Task error:', error.message); return; }
  if (data) {
    const { locations } = data as { locations: Location.LocationObject[] };
    if (!locations?.length) return;
    try {
      const existing = await AsyncStorage.getItem('bikel_route');
      const route: Location.LocationObject[] = existing ? JSON.parse(existing) : [];
      await AsyncStorage.setItem('bikel_route', JSON.stringify([...route, ...locations]));
    } catch (e) { console.error('[BackgroundLocation] Failed to save points:', e); }
  }
});

// Legacy passive scan stub — only registered so TaskManager doesn't crash if it finds
// a lingering registration from an older install. All logic moved into DRAFT_TASK.
TaskManager.defineTask(PASSIVE_SCAN_TASK, async () => { /* no-op */ });

// ── Single smart auto-detect task ────────────────────────────────────────────
// This single task replaces the broken two-stage passive→draft architecture.
// Root causes fixed:
//   1. Accuracy.Balanced returns null speed on Android → use High accuracy
//   2. Starting a new location service from inside a background task fails silently
//   3. 45-second intervals + 3-reading threshold = never triggers in practice
//
// State machine stored in AsyncStorage 'bikel_draft_state':
//   phase: 'warmup' | 'recording' | 'idle'
//   warmupCount: number of bike-speed readings seen so far
//   route: recorded points
//   spikes: car-speed spike count
//   startTime: ms when recording began
//   lastMovingTime: ms of last speed > 2mph reading
TaskManager.defineTask(DRAFT_TASK, async ({ data, error }: any) => {
  if (error) { console.error('[DraftTask] Error:', error.message); return; }
  if (!data) return;

  // await logEvent("📍 DraftTask entry"); // Low-level heartbeat if needed

  try {
    // logEvent("📍 DraftTask firing..."); // Too noisy for production, but good to know it works
    const autoDetect = await AsyncStorage.getItem('bikel_auto_detect');
    if (autoDetect !== 'true') return;
    const manualTracking = await AsyncStorage.getItem('bikel_manual_tracking');
    if (manualTracking === 'true') return;

    const { locations } = data as { locations: Location.LocationObject[] };
    if (!locations?.length) return;

    const stateRaw = await AsyncStorage.getItem('bikel_draft_state');
    let state = stateRaw ? JSON.parse(stateRaw) : {
      phase: 'warmup',
      warmupCount: 0,
      route: [],
      spikes: 0,
      startTime: Date.now(),
      lastMovingTime: Date.now(),
      lastSpeed: 0,
      lastPoint: null
    };

    if (state.phase === 'saving') return;

    let maxBatchSpeed = 0;
    let hasBikeSpeed = false;
    let hasCarSpeed = false;

    for (const loc of locations) {
      const now = loc.timestamp ?? Date.now();
      const rawSpeed = loc.coords.speed;

      let speedMph = 0;
      if (rawSpeed !== null && rawSpeed !== undefined && rawSpeed >= 0) {
        speedMph = rawSpeed * 2.237;
      } else if (state.lastPoint) {
        const dist = distanceMiles(state.lastPoint.lat, state.lastPoint.lng, loc.coords.latitude, loc.coords.longitude);
        const dt = (now - state.lastPoint.time) / 1000;
        if (dist > 0.002 && dt > 0 && dt < 20) speedMph = (dist / dt) * 3600;
      }

      if (speedMph > 60) speedMph = 60;
      if (speedMph > maxBatchSpeed) maxBatchSpeed = speedMph;
      if (speedMph >= BIKE_SPEED_MIN_MPH && speedMph <= BIKE_SPEED_MAX_MPH) hasBikeSpeed = true;
      if (speedMph > CAR_SPEED_THRESHOLD_MPH) hasCarSpeed = true;

      if (state.phase === 'recording') {
        state.route.push({
          lat: loc.coords.latitude,
          lng: loc.coords.longitude,
          alt: loc.coords.altitude ?? undefined,
          time: now,
          speed: speedMph,
        });
        if (speedMph > CAR_SPEED_THRESHOLD_MPH) state.spikes++;
      }

      state.lastSpeed = speedMph;
      state.lastPoint = { lat: loc.coords.latitude, lng: loc.coords.longitude, time: now };
    }

    if (state.phase === 'warmup') {
      if (hasCarSpeed) {
        state.warmupCount = 0;
        await logEvent(`🚗 Car detected (${maxBatchSpeed.toFixed(1)}mph) — warmup reset`);
      } else if (hasBikeSpeed) {
        state.warmupCount++;
        await logEvent(`🚲 Batch bike speed (${maxBatchSpeed.toFixed(1)}mph)! Warmup ${state.warmupCount}/${WARMUP_NEEDED}`);
        if (state.warmupCount >= WARMUP_NEEDED) {
          state.phase = 'recording';
          state.startTime = Date.now();
          state.lastMovingTime = Date.now();
          state.route = [];
          state.spikes = 0;
          await logEvent('✅ Bike confirmed — recording started');
          await Notifications.scheduleNotificationAsync({
            content: {
              title: '🚴 Bikel is recording your ride',
              body: 'Auto-detected ride in progress — draft will save when you stop',
              data: { type: 'recording' },
            },
            trigger: null,
          });
        }
      } else if (maxBatchSpeed < 1 && state.warmupCount > 0) {
        state.warmupCount--;
      }
    } else if (state.phase === 'recording') {
      if (maxBatchSpeed > 3) state.lastMovingTime = Date.now();

      // Detection reset (sustained car speed)
      const lastThree = state.route.slice(-3);
      const sustainedCar = lastThree.length === 3 && lastThree.every((p: any) => p.speed > BIKE_SPEED_MAX_MPH);
      if (state.spikes >= CAR_SPIKE_LIMIT || sustainedCar) {
        await logEvent(`🚗 Abandoning recording — ${state.spikes} spikes, sustainedCar=${sustainedCar}`);
        await Notifications.scheduleNotificationAsync({
          content: { title: '🚴 Bikel', body: 'Watching for bike rides in background…', data: { type: 'watching' } },
          trigger: null,
        });
        state = { phase: 'warmup', warmupCount: 0, route: [], spikes: 0, startTime: Date.now(), lastMovingTime: Date.now(), lastPoint: state.lastPoint, lastSpeed: state.lastSpeed };
        await AsyncStorage.setItem('bikel_draft_state', JSON.stringify(state));
        return;
      }

      const idleSeconds = (Date.now() - state.lastMovingTime) / 1000;
      if (idleSeconds >= IDLE_STOP_SECONDS && state.route.length > 5) {
        state.phase = 'saving';
        await AsyncStorage.setItem('bikel_draft_state', JSON.stringify(state));
        await logEvent(`🛑 Idle stop (${idleSeconds.toFixed(0)}s) — saving ${state.route.length} pts`);
        await finalizeDraft(state.startTime, state.route, state.spikes);
        await Notifications.scheduleNotificationAsync({
          content: { title: '🚴 Bikel', body: 'Watching for bike rides in background…', data: { type: 'watching' } },
          trigger: null,
        });
        state = { phase: 'warmup', warmupCount: 0, route: [], spikes: 0, startTime: Date.now(), lastMovingTime: Date.now(), lastPoint: state.lastPoint, lastSpeed: state.lastSpeed };
        await AsyncStorage.setItem('bikel_draft_state', JSON.stringify(state));
        return;
      }
    }

    await AsyncStorage.setItem('bikel_draft_state', JSON.stringify(state));
  } catch (e: any) {
    console.error('[DraftTask] Failed:', e);
    await logEvent(`⚠️ DraftTask Error: ${e.message || String(e)}`);
  }
});

// Helper: compute distance in miles between two lat/lng points
function distanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return distanceMiles(px, py, x1, y1);
  const t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
  if (t < 0) return distanceMiles(px, py, x1, y1);
  if (t > 1) return distanceMiles(px, py, x2, y2);
  return distanceMiles(px, py, x1 + t * dx, y1 + t * dy);
}

// Helper: finalize and save a draft to AsyncStorage + send notification
async function finalizeDraft(startTimeMs: number, rawRoute: any[], spikes: number) {
  try {
    // Calculate distance and elevation gain
    let totalDist = 0;
    let totalElevationGainM = 0;
    for (let i = 1; i < rawRoute.length; i++) {
      totalDist += distanceMiles(rawRoute[i - 1].lat, rawRoute[i - 1].lng, rawRoute[i].lat, rawRoute[i].lng);

      const alt1 = rawRoute[i - 1].alt;
      const alt2 = rawRoute[i].alt;
      if (alt1 !== undefined && alt2 !== undefined && alt2 > alt1) {
        totalElevationGainM += (alt2 - alt1);
      }
    }

    const elevationGainFt = Math.round(totalElevationGainM * 3.28084);

    if (totalDist < 0.1) {
      await logEvent(`📏 Draft too short (${totalDist.toFixed(2)}mi) — discarding`);
      return;
    }

    const endTimeMs = rawRoute[rawRoute.length - 1].time || Date.now();
    const durationSeconds = Math.floor((endTimeMs - startTimeMs) / 1000);

    // Confidence: start at 1.0, subtract 0.15 per spike
    const confidence = Math.max(0.1, 1.0 - spikes * 0.15);

    const draft: RideDraft = {
      id: `draft_${startTimeMs}`,
      startTime: Math.floor(startTimeMs / 1000),
      endTime: Math.floor(endTimeMs / 1000),
      distance: totalDist,
      durationSeconds,
      elevationGain: elevationGainFt,
      route: rawRoute.map((p: any) => ({ lat: p.lat, lng: p.lng, alt: p.alt })),
      confidence,
      speedSpikes: spikes,
    };

    // Load existing drafts, enforce max 10
    const existingRaw = await AsyncStorage.getItem('bikel_drafts');
    let drafts: RideDraft[] = existingRaw ? JSON.parse(existingRaw) : [];
    drafts = [draft, ...drafts].slice(0, MAX_DRAFTS);
    await AsyncStorage.setItem('bikel_drafts', JSON.stringify(drafts));

    // Send notification
    await Notifications.scheduleNotificationAsync({
      content: {
        title: '🚴 New ride draft saved',
        body: `${totalDist.toFixed(1)} mi · ${Math.floor(durationSeconds / 60)}m — tap to review`,
        data: { draftId: draft.id },
      },
      trigger: null,
    });

    await logEvent(`💾 Draft saved: ${totalDist.toFixed(2)}mi, confidence ${confidence.toFixed(2)}`);
  } catch (e) {
    console.error('[DraftTask] finalizeDraft failed:', e);
  }
}

async function stopRecordingManually() {
  try {
    const stateRaw = await AsyncStorage.getItem('bikel_draft_state');
    if (!stateRaw) return;
    const state = JSON.parse(stateRaw);
    if (state.phase !== 'recording' || state.route.length < 5) return;

    await logEvent("🛑 Manual stop triggered from UI");
    state.phase = 'saving';
    await AsyncStorage.setItem('bikel_draft_state', JSON.stringify(state));
    await finalizeDraft(state.startTime, state.route, state.spikes);

    // Reset state to warmup
    const now = Date.now();
    const newState = { phase: 'warmup', warmupCount: 0, route: [], spikes: 0, startTime: now, lastMovingTime: now, lastPoint: state.lastPoint, lastSpeed: state.lastSpeed };
    await AsyncStorage.setItem('bikel_draft_state', JSON.stringify(newState));

    await Notifications.scheduleNotificationAsync({
      content: { title: '🚴 Bikel', body: 'Watching for bike rides in background…', data: { type: 'watching' } },
      trigger: null,
    });
  } catch (e) {
    console.error('[App] manual stop failed:', e);
  }
}

// ── Main App Component ─────────────────────────────────
export default function App() {
  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [isTracking, setIsTracking] = useState(false);
  const [duration, setDuration] = useState(0);
  const [distance, setDistance] = useState(0);
  const [elevation, setElevation] = useState(0);
  const [route, setRoute] = useState<Location.LocationObject[]>([]);
  const [myRides, setMyRides] = useState<RideEvent[]>([]);
  const [globalRides, setGlobalRides] = useState<RideEvent[]>([]);
  const [scheduledRides, setScheduledRides] = useState<ScheduledRideEvent[]>([]);
  const [activeContests, setActiveContests] = useState<ContestEvent[]>([]);
  const [selectedContest, setSelectedContest] = useState<ContestEvent | null>(null);
  const [contestLeaderboard, setContestLeaderboard] = useState<{ pubkey: string, value: number }[]>([]);
  const [isLoadingLeaderboard, setIsLoadingLeaderboard] = useState(false);
  const [selectedRoute, setSelectedRoute] = useState<{ lat: number, lng: number }[]>([]);
  const [mapCenter, setMapCenter] = useState<{ lat: number, lng: number } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [profiles, setProfiles] = useState<Record<string, any>>({});
  const [loadingStatus, setLoadingStatus] = useState('');

  const [showHistory, setShowHistory] = useState(false);
  const [showFeed, setShowFeed] = useState(false);
  const [isFeedLoading, setIsFeedLoading] = useState(false);
  const [feedTab, setFeedTab] = useState<'contests' | 'rides' | 'feed' | 'drafts'>('feed');
  const [showSettings, setShowSettings] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);

  // Auto-detect drafts
  const [autoDetect, setAutoDetect] = useState(false);
  const [drafts, setDrafts] = useState<RideDraft[]>([]);
  const [liveRecording, setLiveRecording] = useState<{ startTime: number; points: number; distance: number } | null>(null);
  const [selectedDraft, setSelectedDraft] = useState<RideDraft | null>(null);

  const [viewingAuthor, setViewingAuthor] = useState<string | null>(null);
  const [authorRides, setAuthorRides] = useState<RideEvent[]>([]);
  const [isLoadingAuthor, setIsLoadingAuthor] = useState(false);

  const [editName, setEditName] = useState('');
  const [editAbout, setEditAbout] = useState('');
  const [editPicture, setEditPicture] = useState('');
  const [editNip05, setEditNip05] = useState('');
  const [editLud16, setEditLud16] = useState('');
  const [isPublishingProfile, setIsPublishingProfile] = useState(false);

  const [currentNsec, setCurrentNsec] = useState<string>('');
  const [currentNpub, setCurrentNpub] = useState<string>('');
  const [currentHex, setCurrentHex] = useState<string>('');
  const [newKeyInput, setNewKeyInput] = useState<string>('');
  const [shareRoute, setShareRoute] = useState(true);
  const trackingStartTimeRef = React.useRef<number | null>(null);

  const [showPostRideModal, setShowPostRideModal] = useState(false);
  const [postRideTitle, setPostRideTitle] = useState('');
  const [postRideDesc, setPostRideDesc] = useState('');
  const [postRideImageUrl, setPostRideImageUrl] = useState('');
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [postRidePrivacy, setPostRidePrivacy] = useState<'full' | 'hidden'>('full');
  const [postRideScheduleMode, setPostRideScheduleMode] = useState(false);
  const [trimTails, setTrimTails] = useState(true);
  const [postRideDate, setPostRideDate] = useState(new Date());
  const [postRideTime, setPostRideTime] = useState(new Date());
  const [postRideLocation, setPostRideLocation] = useState('');
  const [showPostRideDate, setShowPostRideDate] = useState(false);
  const [showPostRideTime, setShowPostRideTime] = useState(false);
  // Draft being reviewed in post modal
  const [postingFromDraft, setPostingFromDraft] = useState<RideDraft | null>(null);

  const [nwcURI, setNwcURI] = useState('');
  const [isNWCConnected, setIsNWCConnected] = useState(false);
  const [isZapping, setIsZapping] = useState(false);
  const [deletingRideId, setDeletingRideId] = useState<string | null>(null);

  const [showDiscussion, setShowDiscussion] = useState(false);
  const [selectedDiscussionRide, setSelectedDiscussionRide] = useState<RideEvent | ScheduledRideEvent | null>(null);
  const [comments, setComments] = useState<RideComment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [isPublishingComment, setIsPublishingComment] = useState(false);

  const [selectedMapRide, setSelectedMapRide] = useState<RideEvent | null>(null);
  const [activeDMUser, setActiveDMUser] = useState<string | null>(null);
  const [dmMessages, setDmMessages] = useState<DMessage[]>([]);
  const [newDMText, setNewDMText] = useState('');
  const [isSendingDM, setIsSendingDM] = useState(false);

  // Debug Logs
  const [showLogs, setShowLogs] = useState(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  const loadLogs = async () => {
    const raw = await AsyncStorage.getItem('bikel_logs');
    if (raw) setDebugLogs(JSON.parse(raw));
    else setDebugLogs([]);
  };

  const clearLogs = async () => {
    await AsyncStorage.removeItem('bikel_logs');
    setDebugLogs([]);
    await logEvent("Logs cleared");
  };

  useEffect(() => {
    if (activeDMUser) {
      setDmMessages([]);
      fetchDMs(activeDMUser).then(setDmMessages);
    }
  }, [activeDMUser]);

  const [schedName, setSchedName] = useState('');
  const [schedDesc, setSchedDesc] = useState('');
  const [schedImage, setSchedImage] = useState('');
  const [isUploadingSchedPhoto, setIsUploadingSchedPhoto] = useState(false);
  const [schedLocation, setSchedLocation] = useState('');
  const [schedType, setSchedType] = useState<'ride' | 'contest'>('ride');
  const [contestEndDays, setContestEndDays] = useState('7d');
  const [contestParam, setContestParam] = useState<'max_distance' | 'max_elevation' | 'fastest_mile'>('max_distance');
  const [contestFee, setContestFee] = useState('5000');
  const [contestInvites, setContestInvites] = useState('');
  const [schedCadence, setSchedCadence] = useState<'none' | 'weekly' | 'biweekly' | 'monthly'>('none');
  const [schedOccurrences, setSchedOccurrences] = useState(2);
  const [schedDate, setSchedDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [isGettingLocation, setIsGettingLocation] = useState(false);

  // ── Load drafts from storage ───────────────────────
  const loadDrafts = async () => {
    try {
      const raw = await AsyncStorage.getItem('bikel_drafts');
      if (raw) setDrafts(JSON.parse(raw));
      // Check if a recording is currently in progress
      const stateRaw = await AsyncStorage.getItem('bikel_draft_state');
      if (stateRaw) {
        const state = JSON.parse(stateRaw);
        if (state.phase === 'recording' && state.route?.length > 0) {
          // Compute live distance
          let dist = 0;
          for (let i = 1; i < state.route.length; i++) {
            dist += distanceMiles(state.route[i - 1].lat, state.route[i - 1].lng, state.route[i].lat, state.route[i].lng);
          }
          setLiveRecording({ startTime: state.startTime, points: state.route.length, distance: dist });
        } else {
          setLiveRecording(null);
        }
      } else {
        setLiveRecording(null);
      }
    } catch (e) {
      console.error('[Drafts] Failed to load:', e);
    }
  };

  const deleteDraft = async (draftId: string) => {
    const updated = drafts.filter(d => d.id !== draftId);
    setDrafts(updated);
    await AsyncStorage.setItem('bikel_drafts', JSON.stringify(updated));
  };

  // ── Sync auto-detect task with UI & storage ──────────
  const isSyncingRef = useRef(false);
  const pollerRef = useRef<NodeJS.Timeout | null>(null);
  const syncAutoDetectState = async (forceRestart = false) => {
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;
    try {
      const saved = await AsyncStorage.getItem('bikel_auto_detect');
      const isEnabled = saved === 'true';
      const isRunning = await Location.hasStartedLocationUpdatesAsync(DRAFT_TASK);
      const bgPerm = await Location.getBackgroundPermissionsAsync();

      if (isEnabled) {
        if (bgPerm.status === 'granted') {
          if (!isRunning || forceRestart) {
            if (isRunning && forceRestart) {
              await logEvent("🛑 Auto-detect reset (manual toggle)");
              await Location.stopLocationUpdatesAsync(DRAFT_TASK);
            }
            // Restart task if it should be running but isn't, or if we're forcing a refresh
            if (!isRunning) await logEvent("🔄 Auto-detect starting...");
            await Location.startLocationUpdatesAsync(DRAFT_TASK, {
              accuracy: Location.Accuracy.High,
              distanceInterval: 10,
              timeInterval: 8000,
              foregroundService: {
                notificationTitle: 'Bikel auto-detect active',
                notificationBody: 'Watching for bike rides in background…',
                notificationColor: '#444',
              },
              pausesUpdatesAutomatically: false,
              showsBackgroundLocationIndicator: false,
            });
          } else {
            // Already running and no force-restart needed
            // logEvent("✅ Auto-detect: ACTIVE"); // Silent verify
          }
          setAutoDetect(true);
        } else {
          // Permission lost
          await logEvent(`⚠️ Auto-detect disabled (missing permission: ${bgPerm.status})`);
          await AsyncStorage.setItem('bikel_auto_detect', 'false');
          if (isRunning) await Location.stopLocationUpdatesAsync(DRAFT_TASK);
          setAutoDetect(false);
        }
      } else {
        if (isRunning) {
          await logEvent("🛑 Auto-detect cleanup (lingering task)");
          await Location.stopLocationUpdatesAsync(DRAFT_TASK);
        }
        setAutoDetect(false);
      }
    } catch (e) { console.error('[Sync] Failed:', e); } finally {
      isSyncingRef.current = false;
    }
  };

  // ── Toggle auto-detect on/off ──────────────────────
  const toggleAutoDetect = async (value: boolean) => {
    setAutoDetect(value);
    await AsyncStorage.setItem('bikel_auto_detect', value ? 'true' : 'false');
    await syncAutoDetectState();
  };

  // ── Mount ──────────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    // Connect NDK first, then immediately start fetching feeds in the background.
    // This fires before the slow SecureStore/NWC/GPS awaits so relays have
    // maximum time to respond while the rest of init is happening.
    connectNDK().then(() => {
      if (mounted) {
        console.log('[NDK] Connected on load.');
        loadFeeds();
      }
    });

    (async () => {
      await logEvent("🚀 App Mount: Background System Sync Initiated");
      const savedNwc = await SecureStore.getItemAsync('bikel_nwc_uri');
      if (savedNwc) {
        setNwcURI(savedNwc);
        const success = await connectNWC(savedNwc);
        if (success) setIsNWCConnected(true);
      }

      try {
        const hex = await getPublicKeyHex();
        if (hex) setCurrentHex(hex);
      } catch (e) {
        console.error("Failed to fetch public key hex on mount:", e);
      }

      // Re-sync auto-detect task and UI state (forcing restart to ensure banner shows)
      await syncAutoDetectState(true);

      // Load drafts
      await loadDrafts();

      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      // Show last known position instantly so the map isn't blank while waiting
      const lastKnown = await Location.getLastKnownPositionAsync({});
      if (lastKnown) {
        setLocation(lastKnown);
        setMapCenter({ lat: lastKnown.coords.latitude, lng: lastKnown.coords.longitude });
      }
      // Then get a fresh fix in the background without blocking
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).then(loc => {
        setLocation(loc);
        setMapCenter({ lat: loc.coords.latitude, lng: loc.coords.longitude });
      }).catch(() => { /* non-fatal, last known is fine */ });
    })();

    // Poll for new drafts every 60s
    if (!pollerRef.current) {
      pollerRef.current = setInterval(() => {
        loadDrafts();
        logEvent("🔄 Periodic draft sync");
      }, 60000);
    }

    // Listen for AppState changes (to re-sync when coming back from background/settings)
    const appStateListener = AppState.addEventListener('change', async (nextAppState) => {
      if (nextAppState === 'active') {
        await syncAutoDetectState();
        await loadDrafts();
      }
    });

    return () => {
      mounted = false;
      if (pollerRef.current) {
        clearInterval(pollerRef.current);
        pollerRef.current = null;
      }
      appStateListener.remove();
    };
  }, []);

  // ── Hardware Back Button Handling ──────────────────
  useEffect(() => {
    const onBackPress = () => {
      // DMs (Inner view)
      if (activeDMUser) { setActiveDMUser(null); return true; }

      // Discussion (Inner view)
      if (showDiscussion) { setShowDiscussion(false); return true; }

      // Author Profile (Inner view)
      if (viewingAuthor) { setViewingAuthor(null); return true; }

      // Content Leaderboard (Inner view)
      if (selectedContest) { setSelectedContest(null); return true; }

      // Post Ride / Draft Review (Modals)
      if (showPostRideModal) { setShowPostRideModal(false); return true; }
      if (selectedDraft) { setSelectedDraft(null); return true; }

      // Settings / History / Schedule / Feed (Top-level views)
      if (showLogs) { setShowLogs(false); return true; }
      if (showSettings) { setShowSettings(false); return true; }
      if (showHistory) { setShowHistory(false); return true; }
      if (showSchedule) { setShowSchedule(false); return true; }
      if (showFeed) { setShowFeed(false); return true; }

      // Ride Detail Card (Map overlay) - checked last so it reappears when overlays close
      if (selectedMapRide) { setSelectedMapRide(null); return true; }

      // Route Preview (Map layer)
      if (selectedRoute.length > 0) { setSelectedRoute([]); return true; }

      // If none of the above are active, allow default behavior (exit app)
      return false;
    };

    const backHandler = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => backHandler.remove();
  }, [activeDMUser, showDiscussion, viewingAuthor, selectedRoute, selectedContest, showPostRideModal, selectedDraft, showSettings, showHistory, showSchedule, showFeed, showLogs, selectedMapRide]);

  // ── Map Sync Logic ──────────────────────────────────
  const rideAgeColor = (rideTime: number): { color: string; opacity: number } => {
    const ageMs = Date.now() - rideTime * 1000;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays <= 1) return { color: '#00ffaa', opacity: 0.7 };
    if (ageDays <= 14) {
      const t = (ageDays - 1) / 13;
      const r = Math.round(0x00 + t * (0xea - 0x00));
      const g = Math.round(0xff + t * (0xb3 - 0xff));
      const b = Math.round(0xaa + t * (0x08 - 0xaa));
      return { color: `rgb(${r},${g},${b})`, opacity: 0.6 - t * 0.2 };
    }
    const t = Math.min((ageDays - 14) / 46, 1);
    const r = Math.round(0xea + t * (0x3a - 0xea));
    const g = Math.round(0xb3 + t * (0x32 - 0xb3));
    const b = Math.round(0x08 + t * (0x00 - 0x08));
    return { color: `rgb(${r},${g},${b})`, opacity: 0.4 - t * 0.25 };
  };

  const filteredGlobalRides = useMemo(() => {
    return globalRides.filter(r =>
      r.visibility === 'full' &&
      r.route &&
      r.route.length > 0 &&
      (r.confidence === undefined || r.confidence >= 0.7)
    );
  }, [globalRides]);

  const mapMarkers = useMemo(() => {
    const markers: any[] = location ? [{
      id: 'current_pos',
      position: { lat: location.coords.latitude, lng: location.coords.longitude },
      icon: '🚴',
      size: [32, 32]
    }] : [];

    filteredGlobalRides.forEach(ride => {
      markers.push({
        id: `ride_${ride.id}`,
        position: { lat: ride.route[0][0], lng: ride.route[0][1] },
        icon: '📍',
        size: [24, 24],
      });
    });

    return markers;
  }, [location, filteredGlobalRides]);

  const mapShapes = useMemo(() => {
    const shapes: any[] = [];

    // 1. Draw all global rides first (bottom layers)
    filteredGlobalRides.forEach(ride => {
      const { color, opacity } = rideAgeColor(ride.time);
      shapes.push({
        id: `ride_${ride.id}`,
        shapeType: MapShapeType.POLYLINE,
        positions: ride.route.map(([lat, lng]) => ({ lat, lng })),
        color: color,
        width: 3,
        opacity: opacity,
      });
    });

    // 2. Draw the highlighted route last (top layer)
    if (selectedRoute.length > 0) {
      shapes.push({
        shapeType: MapShapeType.POLYLINE,
        positions: selectedRoute,
        color: "#ff3300", // Brighter Red-Orange
        width: 8, // Thicker
        opacity: 1.0,
      });
    }

    return shapes;
  }, [selectedRoute, filteredGlobalRides]);

  useEffect(() => {
    if (showDiscussion && selectedDiscussionRide) {
      setComments([]);
      fetchComments(selectedDiscussionRide.id).then((fetched) => {
        setComments(fetched);
        loadAuthorProfiles(fetched.map(c => c.hexPubkey || c.pubkey)).catch(console.error);
      });
    }
  }, [showDiscussion, selectedDiscussionRide]);

  const loadAuthorProfiles = async (pubkeys: string[]) => {
    const missingKeys = [...new Set(pubkeys)].filter(pk => !profiles[pk]);
    if (missingKeys.length === 0) return;
    try {
      const ndk = await connectNDK();
      const filter = { kinds: [0 as any], authors: missingKeys };
      const metadataEvents = await ndk.fetchEvents(filter);
      const newProfiles: Record<string, any> = {};
      for (const ev of metadataEvents) {
        try { newProfiles[ev.pubkey] = JSON.parse(ev.content); } catch (e) { }
      }
      setProfiles(prev => ({ ...prev, ...newProfiles }));
    } catch (e) {
      console.error("Failed to load author profiles", e);
    }
  };

  const loadFeeds = async (retryNum = 0) => {
    setIsFeedLoading(true);
    if (retryNum === 0) setLoadingStatus('Connecting to Nostr...');
    else setLoadingStatus(`Retrying feed sync (attempt ${retryNum})...`);

    try {
      setLoadingStatus('Fetching Recent Rides...');
      const recentRides = await fetchRecentRides();
      setGlobalRides(recentRides);

      setLoadingStatus('Fetching Group Rides...');
      const scheduled = await fetchScheduledRides();
      setScheduledRides(scheduled);

      setLoadingStatus('Fetching Challenges...');
      const contests = await fetchContests();
      setActiveContests(contests);

      setLoadingStatus('Fetching Personal Rides...');
      const my = await fetchMyRides();
      setMyRides(my);

      let extractedPubkeys: string[] = [];
      extractedPubkeys.push(...recentRides.map(r => r.hexPubkey || r.pubkey));
      extractedPubkeys.push(...scheduled.map(r => r.hexPubkey || r.pubkey));
      extractedPubkeys.push(...contests.map(c => c.hexPubkey || c.pubkey));

      if (extractedPubkeys.length > 0) {
        setLoadingStatus('Syncing Profiles...');
        loadAuthorProfiles(extractedPubkeys).catch(console.error);
      }

      // Check if we found anything. If empty across all global feeds, retry up to 3 times.
      const totalFound = recentRides.length + scheduled.length + contests.length;
      if (totalFound === 0 && retryNum < 3) {
        setLoadingStatus(`No rides found yet. Retrying in 3s...`);
        setTimeout(() => loadFeeds(retryNum + 1), 3000);
        return;
      }

      setLoadingStatus('');
    } catch (e) {
      console.error("Critical error in loadFeeds:", e);
      setLoadingStatus('Error loading feeds.');
    } finally {
      setIsFeedLoading(false);
    }
  };

  const handleRefreshFeeds = async () => {
    setIsRefreshing(true);
    await loadDrafts();
    try {
      await Promise.race([
        loadFeeds(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Network timeout')), 10000))
      ]);
    } catch (e) {
      console.error("Failed to refresh feeds before timeout", e);
    } finally {
      setIsRefreshing(false);
    }
  };

  const getDistanceMiles = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    return distanceMiles(lat1, lon1, lat2, lon2);
  };

  // ── Background task polling ────────────────────────
  useEffect(() => {
    let interval: NodeJS.Timeout;
    let timerInterval: NodeJS.Timeout;

    if (isTracking) {
      timerInterval = setInterval(() => {
        if (trackingStartTimeRef.current) {
          setDuration(Math.floor((Date.now() - trackingStartTimeRef.current) / 1000));
        }
      }, 1000);

      let lastRouteLength = 0;
      interval = setInterval(async () => {
        try {
          const stored = await AsyncStorage.getItem('bikel_route');
          if (!stored) return;
          const points: Location.LocationObject[] = JSON.parse(stored);
          if (points.length <= lastRouteLength) return;

          const newPoints = points.slice(lastRouteLength);
          lastRouteLength = points.length;

          const latest = newPoints[newPoints.length - 1];
          setLocation(latest);
          setMapCenter({ lat: latest.coords.latitude, lng: latest.coords.longitude });

          setRoute(prev => {
            const combined = [...prev, ...newPoints];
            const base = prev.length > 0 ? prev[prev.length - 1] : null;
            const calcPoints = base ? newPoints : newPoints.slice(1);
            let last = base ?? newPoints[0];
            let addedDist = 0;
            for (const pt of calcPoints) {
              addedDist += getDistanceMiles(
                last.coords.latitude, last.coords.longitude,
                pt.coords.latitude, pt.coords.longitude
              );
              last = pt;
            }
            setDistance(d => d + addedDist);
            return combined;
          });
        } catch (e) {
          console.error('[Tracking] Failed to read route from storage:', e);
        }
      }, 2000);
    }

    return () => {
      clearInterval(interval);
      clearInterval(timerInterval);
    };
  }, [isTracking]);

  // ── Manual tracking toggle ─────────────────────────
  const toggleTracking = async () => {
    if (isTracking) {
      try {
        const isRegistered = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
        if (isRegistered) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
      } catch (e) {
        console.warn('[Tracking] Error stopping location task:', e);
      }

      setIsTracking(false);
      trackingStartTimeRef.current = null;
      await AsyncStorage.setItem('bikel_manual_tracking', 'false');

      // Re-start auto-detect task if it was running before the manual ride
      try {
        const autoDetect = await AsyncStorage.getItem('bikel_auto_detect');
        if (autoDetect === 'true') {
          const isRunning = await Location.hasStartedLocationUpdatesAsync(DRAFT_TASK);
          if (!isRunning) {
            const now = Date.now();
            await AsyncStorage.setItem('bikel_draft_state', JSON.stringify({
              phase: 'warmup', warmupCount: 0, route: [], spikes: 0, startTime: now, lastMovingTime: now,
            }));
            await Location.startLocationUpdatesAsync(DRAFT_TASK, {
              accuracy: Location.Accuracy.High,
              distanceInterval: 10,
              timeInterval: 8000,
              foregroundService: {
                notificationTitle: 'Bikel auto-detect active',
                notificationBody: 'Watching for bike rides in background',
                notificationColor: '#444',
              },
              pausesUpdatesAutomatically: false,
              showsBackgroundLocationIndicator: false,
            });
            console.log('[Tracking] DRAFT_TASK re-started after manual ride');
          }
        }
      } catch (e) { console.warn('[Tracking] Could not re-start DRAFT_TASK:', e); }

      try {
        const stored = await AsyncStorage.getItem('bikel_route');
        const finalRoute: Location.LocationObject[] = stored ? JSON.parse(stored) : [];
        await AsyncStorage.removeItem('bikel_route');

        if (finalRoute.length > 1 && distance >= 0.02) {
          setRoute(finalRoute);
          setPostingFromDraft(null);
          setShowPostRideModal(true);
        } else {
          if (duration > 0 || finalRoute.length > 0) {
            Alert.alert("Stationary Ride Detected", "Not enough distance was covered.");
          }
          setDuration(0);
          setDistance(0);
          setRoute([]);
        }
      } catch (e) {
        console.error('[Tracking] Failed to read final route:', e);
      }

    } else {
      try {
        await AsyncStorage.removeItem('bikel_route');
        setDuration(0);
        setDistance(0);
        setRoute([]);

        const { status: fgStatus } = await Location.getForegroundPermissionsAsync();
        if (fgStatus !== 'granted') {
          const { status: requested } = await Location.requestForegroundPermissionsAsync();
          if (requested !== 'granted') {
            Alert.alert("Permission Required", "Location permission is needed to track rides.");
            return;
          }
        }

        try {
          const { status: bgStatus } = await Location.getBackgroundPermissionsAsync();
          if (bgStatus !== 'granted') {
            Location.requestBackgroundPermissionsAsync().catch(() => { });
            Alert.alert("Background Location", "For full screen-off tracking, grant 'Allow all the time' in Settings.", [{ text: "OK" }]);
          }
        } catch (bgErr) {
          console.warn('[Tracking] Background permission check failed (non-fatal):', bgErr);
        }

        try {
          const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
          if (alreadyRunning) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
          // Pause draft task while manual tracking is active
          const draftRunning = await Location.hasStartedLocationUpdatesAsync(DRAFT_TASK);
          if (draftRunning) {
            await Location.stopLocationUpdatesAsync(DRAFT_TASK);
            // Note: DRAFT_TASK will be re-started when manual tracking ends (if auto-detect is on)
          }
        } catch (e) { }

        await Location.startLocationUpdatesAsync(LOCATION_TASK, {
          accuracy: Location.Accuracy.BestForNavigation,
          distanceInterval: 5,
          timeInterval: 3000,
          showsBackgroundLocationIndicator: true,
          foregroundService: {
            notificationTitle: '🚴 Bikel is tracking your ride',
            notificationBody: 'Tap to return to the app',
            notificationColor: '#00ffaa',
          },
          pausesUpdatesAutomatically: false,
        });

        trackingStartTimeRef.current = Date.now();
        setIsTracking(true);
        await AsyncStorage.setItem('bikel_manual_tracking', 'true');
        console.log('[Tracking] Started successfully');

      } catch (e: any) {
        console.error('[Tracking] Failed to start:', e);
        Alert.alert("Could Not Start Tracking", `Error: ${e?.message || 'Unknown error'}.`);
      }
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const formatDuration = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };

  const confidenceColor = (c: number) => c >= 0.7 ? '#00ffaa' : c >= 0.4 ? '#eab308' : '#ff4d4f';
  const confidenceLabel = (c: number) => c >= 0.7 ? 'Good' : c >= 0.4 ? 'Fair' : 'Low';

  // ── Open draft in post-ride modal ─────────────────
  const openDraftForPosting = (draft: RideDraft) => {
    setPostingFromDraft(draft);
    setPostRideTitle('');
    setPostRideDesc('');
    setPostRideImageUrl('');
    setPostRidePrivacy('full');
    setPostRideScheduleMode(false);
    setTrimTails(true);
    setDistance(draft.distance);
    setDuration(draft.durationSeconds);
    setElevation(draft.elevationGain || 0);
    // Convert draft route to LocationObject-like for publishing
    const fakeRoute = draft.route.map(p => ({
      coords: { latitude: p.lat, longitude: p.lng, altitude: p.alt || null, accuracy: null, altitudeAccuracy: null, heading: null, speed: null },
      timestamp: draft.startTime * 1000,
    })) as Location.LocationObject[];
    setRoute(fakeRoute);
    setShowFeed(false);
    setShowPostRideModal(true);
  };

  const pickAndUploadSchedPhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') { Alert.alert('Permission Required', 'Allow photo library access to attach a photo.'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, quality: 0.8 });
    if (result.canceled || !result.assets?.length) return;
    setIsUploadingSchedPhoto(true);
    try {
      const url = await uploadPhoto(result.assets[0].uri);
      setSchedImage(url);
    } catch (e: any) {
      Alert.alert('Upload Failed', e.message || 'Unknown error.');
    } finally {
      setIsUploadingSchedPhoto(false);
    }
  };

  // ── Photo picker + Blossom upload ─────────────────
  const pickAndUploadPhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') { Alert.alert('Permission Required', 'Allow photo library access to attach a photo.'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, quality: 0.8 });
    if (result.canceled || !result.assets?.length) return;
    setIsUploadingPhoto(true);
    try {
      const url = await uploadPhoto(result.assets[0].uri);
      setPostRideImageUrl(url);
    } catch (e: any) {
      Alert.alert('Upload Failed', e.message || 'Unknown error.');
    } finally {
      setIsUploadingPhoto(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.map}>
        <LeafletView
          mapCenterPosition={
            mapCenter || (location ? { lat: location.coords.latitude, lng: location.coords.longitude } : { lat: 51.505, lng: -0.09 })
          }
          zoom={selectedRoute.length > 0 ? 12 : 13}
          mapLayers={[{
            baseLayerName: 'DarkMode',
            baseLayerIsChecked: true,
            layerType: MapLayerType.TILE_LAYER,
            baseLayer: true,
            url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          }]}
          mapMarkers={mapMarkers}
          mapShapes={mapShapes}
          onMessageReceived={(message: any) => {
            if (message.event === WebViewLeafletEvents.ON_MAP_MARKER_CLICKED) {
              const idStr = message.payload?.mapMarkerID;
              if (idStr && idStr.startsWith('ride_')) {
                const rideId = idStr.replace('ride_', '');
                const ride = filteredGlobalRides.find(r => r.id === rideId);
                if (ride) {
                  setSelectedMapRide(ride);
                  setSelectedRoute(ride.route.map(pt => ({ lat: pt[0], lng: pt[1] })));
                }
              }
            } else if (message.event === WebViewLeafletEvents.ON_MAP_TOUCHED) {
              const touch = message.payload?.touchLatLng;
              if (touch) {
                let nearestRide = null;
                let minDistance = 0.05; // ~80 meters threshold

                for (const ride of filteredGlobalRides) {
                  if (!ride.route) continue;
                  for (let i = 0; i < ride.route.length - 1; i++) {
                    const d = distToSegment(touch.lat, touch.lng, ride.route[i][0], ride.route[i][1], ride.route[i + 1][0], ride.route[i + 1][1]);
                    if (d < minDistance) {
                      minDistance = d;
                      nearestRide = ride;
                    }
                  }
                }

                if (nearestRide) {
                  setSelectedMapRide(nearestRide);
                  setSelectedRoute(nearestRide.route.map(pt => ({ lat: pt[0], lng: pt[1] })));
                }
              }
            }
          }}
        />
      </View>

      {/* Center Map Button */}
      <View style={{ position: 'absolute', bottom: 180, right: 20, gap: 12 }}>
        <TouchableOpacity
          style={{ backgroundColor: 'rgba(0,0,0,0.6)', padding: 12, borderRadius: 30 }}
          onPress={async () => {
            try {
              let loc = await Location.getLastKnownPositionAsync();
              if (!loc) loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
              if (loc) {
                setLocation(loc);
                setMapCenter({ lat: loc.coords.latitude, lng: loc.coords.longitude });
                // Just center, don't clear anything
              }
            } catch (e) { }
          }}
        >
          <LocateFixed size={24} color="#00ffaa" />
        </TouchableOpacity>

        {/* Reset Map Button */}
        <TouchableOpacity
          style={{ backgroundColor: 'rgba(0,0,0,0.6)', padding: 12, borderRadius: 30 }}
          onPress={async () => {
            try {
              setSelectedRoute([]);
              setSelectedMapRide(null);
            } catch (e) { }
          }}
        >
          <RotateCw size={24} color="#00ffaa" />
        </TouchableOpacity>
      </View>

      {/* Ride Detail Card */}
      {selectedMapRide && !showFeed && !showDiscussion && !activeDMUser && !viewingAuthor && !showSettings && !showHistory && !showSchedule && !showPostRideModal && (
        <View style={{ position: 'absolute', top: 180, left: 20, right: 20, backgroundColor: 'rgba(22, 26, 31, 0.95)', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: 'rgba(0, 255, 170, 0.2)', shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.5, shadowRadius: 15, elevation: 10 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#00ffaa', fontWeight: 'bold', fontSize: 16 }} numberOfLines={1}>{selectedMapRide.title || 'Untitled Ride'}</Text>
              <TouchableOpacity onPress={() => { setViewingAuthor(selectedMapRide.hexPubkey); setIsLoadingAuthor(true); fetchUserRides(selectedMapRide.hexPubkey).then(setAuthorRides).finally(() => setIsLoadingAuthor(false)); }}>
                <Text style={{ color: '#aaa', fontSize: 12, marginTop: 2 }}>
                  By <Text style={{ color: '#00ccff', textDecorationLine: 'underline' }}>{profiles[selectedMapRide.hexPubkey]?.nip05 || profiles[selectedMapRide.hexPubkey]?.name || selectedMapRide.pubkey.substring(0, 10) + '...'}</Text>
                </Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={() => setSelectedMapRide(null)} style={{ padding: 4 }}>
              <X size={20} color="#666" />
            </TouchableOpacity>
          </View>

          <View style={{ marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', gap: 12, marginBottom: 12 }}>
              <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.05)', padding: 10, borderRadius: 8, alignItems: 'center' }}>
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: 'bold' }}>{selectedMapRide.distance} mi</Text>
                <Text style={{ color: '#888', fontSize: 10 }}>DISTANCE</Text>
              </View>
              <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.05)', padding: 10, borderRadius: 8, alignItems: 'center' }}>
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: 'bold' }}>{selectedMapRide.duration}</Text>
                <Text style={{ color: '#888', fontSize: 10 }}>TIME</Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.05)', padding: 10, borderRadius: 8, alignItems: 'center' }}>
                <Text style={{ color: '#00ccff', fontSize: 16, fontWeight: 'bold' }}>
                  {selectedMapRide.rawDuration > 0 && parseFloat(selectedMapRide.distance) > 0 
                    ? (parseFloat(selectedMapRide.distance) / (selectedMapRide.rawDuration / 3600)).toFixed(1) 
                    : '0'}
                </Text>
                <Text style={{ color: '#888', fontSize: 10 }}>AVG MPH</Text>
              </View>
              <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.05)', padding: 10, borderRadius: 8, alignItems: 'center' }}>
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: 'bold' }}>{selectedMapRide.elevation || '--'}</Text>
                <Text style={{ color: '#888', fontSize: 10 }}>ELEVATION (FT)</Text>
              </View>
            </View>
          </View>

          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity
              style={{ flex: 1, backgroundColor: 'rgba(0,204,255,0.15)', paddingVertical: 10, borderRadius: 8, alignItems: 'center', borderColor: 'rgba(0,204,255,0.3)', borderWidth: 1 }}
              onPress={() => { setSelectedDiscussionRide(selectedMapRide); setShowDiscussion(true); }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <MessageSquare size={14} color="#00ccff" />
                <Text style={{ color: '#00ccff', fontWeight: 'bold', fontSize: 11 }}>DISCUSSION</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.08)', paddingVertical: 10, borderRadius: 8, alignItems: 'center' }}
              onPress={() => setActiveDMUser(selectedMapRide.hexPubkey)}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Mail size={14} color="#fff" />
                <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 11 }}>DM AUTHOR</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ paddingHorizontal: 12, backgroundColor: 'rgba(0,255,170,0.1)', paddingVertical: 10, borderRadius: 8, alignItems: 'center' }}
              onPress={() => {
                if (selectedMapRide.route && selectedMapRide.route.length > 0) {
                  setMapCenter({ lat: selectedMapRide.route[0][0], lng: selectedMapRide.route[0][1] });
                }
              }}
            >
              <LocateFixed size={18} color="#00ffaa" />
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Header */}
      <View style={styles.headerPanel}>
        <View style={styles.logoContainer}>
          <Image source={require('./assets/bikelLogo.jpg')} style={{ width: 32, height: 32, borderRadius: 16 }} />
          <Text style={styles.headerText}>Bikel</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center' }}>
          <TouchableOpacity onPress={() => { setShowSettings(false); setShowHistory(false); setShowFeed(false); setShowSchedule(!showSchedule); }}>
            <CalendarPlus size={24} color={showSchedule ? "#00ffaa" : "#fff"} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { setShowSettings(false); setShowSchedule(false); setShowHistory(false); setShowFeed(!showFeed); }}>
            <Globe size={24} color={showFeed ? "#00ffaa" : "#fff"} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { setShowSettings(false); setShowSchedule(false); setShowFeed(false); setShowHistory(!showHistory); }}>
            <History size={24} color={showHistory ? "#00ffaa" : "#fff"} />
          </TouchableOpacity>

          <TouchableOpacity onPress={async () => {
            setShowHistory(false); setShowSchedule(false); setShowFeed(false);
            if (!showSettings) {
              try {
                const nsec = await getPrivateKeyNsec();
                const npub = await getPublicKeyNpub();
                const hex = await getPublicKeyHex();
                if (nsec) setCurrentNsec(nsec);
                if (npub) setCurrentNpub(npub);
                if (hex) {
                  setCurrentHex(hex);
                  const p = profiles[hex];
                  if (p) { setEditName(p.name || ''); setEditAbout(p.about || ''); setEditPicture(p.picture || ''); setEditNip05(p.nip05 || ''); setEditLud16(p.lud16 || ''); }
                  else { setEditName(''); setEditAbout(''); setEditPicture(''); setEditNip05(''); setEditLud16(''); }
                }
              } catch (e) { console.error("Settings keys load error:", e); }
            }
            setShowSettings(!showSettings);
          }}>
            <Settings size={24} color={showSettings ? "#00ffaa" : "#fff"} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Settings Overlay */}
      {showSettings && (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.historyOverlay}>
          <Text style={styles.historyTitle}>Settings</Text>
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>

            {/* Auto-detect toggle */}
            <View style={[styles.settingsSection, { borderColor: autoDetect ? 'rgba(234,179,8,0.4)' : 'rgba(255,255,255,0.05)', borderWidth: 1 }]}>
              <Text style={[styles.settingsLabel, { color: '#eab308' }]}>AUTO-DETECT RIDES</Text>
              <Text style={{ color: '#9ba1a6', fontSize: 12, marginBottom: 16, lineHeight: 18 }}>
                Passively monitors your movement and automatically records bike rides in the background. Requires "Allow all the time" location permission.
              </Text>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: autoDetect ? 'rgba(234,179,8,0.15)' : 'rgba(255,255,255,0.05)', padding: 14, borderRadius: 10, borderWidth: 1, borderColor: autoDetect ? '#eab308' : 'rgba(255,255,255,0.1)' }}
                onPress={() => toggleAutoDetect(!autoDetect)}
              >
                <Text style={{ color: autoDetect ? '#eab308' : '#888', fontWeight: 'bold', fontSize: 15 }}>
                  {autoDetect ? '⚡ Auto-Detect ON' : 'Auto-Detect OFF'}
                </Text>
                <View style={{ width: 44, height: 24, borderRadius: 12, backgroundColor: autoDetect ? '#eab308' : 'rgba(255,255,255,0.1)', justifyContent: 'center', padding: 2 }}>
                  <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff', alignSelf: autoDetect ? 'flex-end' : 'flex-start' }} />
                </View>
              </TouchableOpacity>
            </View>

            <View style={styles.settingsSection}>
              <Text style={styles.settingsLabel}>YOUR NPUB (PUBLIC IDENTITY)</Text>
              <Text style={styles.settingsKeyText} selectable={true}>{currentNpub}</Text>
              <Text style={styles.settingsLabel}>YOUR NSEC (SECRET KEY)</Text>
              <TouchableOpacity onPress={async () => { await Clipboard.setStringAsync(currentNsec); Alert.alert("Copied", "Secret key copied to clipboard."); }}>
                <Text style={styles.settingsKeyText}>{currentNsec ? '•'.repeat(Math.min(currentNsec.length, 63)) : ''}</Text>
              </TouchableOpacity>
              <Text style={styles.settingsHelp}>Save your nsec somewhere safe. Never share it. Tap to copy.</Text>
            </View>

            <View style={styles.settingsSection}>
              <Text style={styles.settingsLabel}>IMPORT EXISTING KEY</Text>
              <TextInput style={styles.keyInput} placeholder="Paste nsec1... or hex key here" placeholderTextColor="rgba(255,255,255,0.3)" value={newKeyInput} onChangeText={setNewKeyInput} autoCapitalize="none" />
              <TouchableOpacity style={styles.saveButton} onPress={async () => {
                if (!newKeyInput) return;
                try {
                  await setPrivateKey(newKeyInput);
                  const newNsec = await getPrivateKeyNsec(); const newNpub = await getPublicKeyNpub(); const newHex = await getPublicKeyHex();
                  if (newNsec) setCurrentNsec(newNsec); if (newNpub) setCurrentNpub(newNpub); if (newHex) setCurrentHex(newHex);
                  setNewKeyInput('');
                  Alert.alert("Success", "Private key updated!");
                } catch (e: any) { Alert.alert("Error", e.message); }
              }}>
                <Text style={styles.saveButtonText}>SAVE KEY</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.settingsSection}>
              <Text style={styles.settingsLabel}>EDIT PROFILE</Text>
              <TextInput style={[styles.keyInput, { marginBottom: 8 }]} placeholder="Name" placeholderTextColor="rgba(255,255,255,0.3)" value={editName} onChangeText={setEditName} />
              <TextInput style={[styles.keyInput, { marginBottom: 8 }]} placeholder="About" placeholderTextColor="rgba(255,255,255,0.3)" value={editAbout} onChangeText={setEditAbout} multiline />
              <TextInput style={[styles.keyInput, { marginBottom: 8 }]} placeholder="Picture URL" placeholderTextColor="rgba(255,255,255,0.3)" value={editPicture} onChangeText={setEditPicture} autoCapitalize="none" />
              <TextInput style={[styles.keyInput, { marginBottom: 8 }]} placeholder="NIP-05 (e.g., alice@bikel.ink)" placeholderTextColor="rgba(255,255,255,0.3)" value={editNip05} onChangeText={setEditNip05} autoCapitalize="none" />
              <TextInput style={[styles.keyInput, { marginBottom: 12 }]} placeholder="Lightning Address (lud16)" placeholderTextColor="rgba(255,255,255,0.3)" value={editLud16} onChangeText={setEditLud16} autoCapitalize="none" />
              <TouchableOpacity style={[styles.saveButton, { backgroundColor: isPublishingProfile ? '#555' : '#00ccff' }]} disabled={isPublishingProfile} onPress={async () => {
                try {
                  setIsPublishingProfile(true);
                  const success = await publishProfile({ name: editName, about: editAbout, picture: editPicture, nip05: editNip05, lud16: editLud16 });
                  if (success) Alert.alert("Success", "Profile updated globally on Nostr!");
                  else Alert.alert("Error", "Failed to publish profile.");
                } catch (e: any) { Alert.alert("Error", e.message); } finally { setIsPublishingProfile(false); }
              }}>
                <Text style={styles.saveButtonText}>{isPublishingProfile ? 'SAVING...' : 'SAVE PROFILE'}</Text>
              </TouchableOpacity>
            </View>

            <View style={[styles.settingsSection, { marginBottom: 60 }]}>
              <Text style={styles.settingsLabel}>DEBUG & TROUBLESHOOTING</Text>
              <TouchableOpacity
                style={{ backgroundColor: 'rgba(255,255,255,0.05)', padding: 14, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', alignItems: 'center' }}
                onPress={() => { loadLogs(); setShowLogs(true); }}
              >
                <Text style={{ color: '#00ccff', fontWeight: 'bold' }}>🔍 VIEW DEBUG LOGS</Text>
              </TouchableOpacity>
              <Text style={{ color: '#666', fontSize: 11, marginTop: 8, textAlign: 'center' }}>Check here if the app isn't working as expected.</Text>
            </View>

            <View style={[styles.settingsSection, { marginBottom: 60 }]}>
              <Text style={styles.settingsLabel}>NOSTR WALLET CONNECT (NIP-47)</Text>
              <TextInput style={styles.keyInput} placeholder="nostr+walletconnect://..." placeholderTextColor="rgba(255,255,255,0.3)" value={nwcURI} onChangeText={setNwcURI} autoCapitalize="none" />
              <TouchableOpacity style={[styles.saveButton, { backgroundColor: '#eab308' }]} onPress={async () => {
                if (!nwcURI) return;
                const success = await connectNWC(nwcURI);
                if (success) { await SecureStore.setItemAsync('bikel_nwc_uri', nwcURI); setIsNWCConnected(true); Alert.alert("Success", "Lightning Wallet Connected!"); }
                else Alert.alert("Error", "Could not connect. Check NWC URI.");
              }}>
                <Text style={[styles.saveButtonText, { color: '#000' }]}>CONNECT WALLET</Text>
              </TouchableOpacity>
              {isNWCConnected && (
                <TouchableOpacity style={{ marginTop: 12, alignItems: 'center' }} onPress={async () => { await SecureStore.deleteItemAsync('bikel_nwc_uri'); setNwcURI(''); setIsNWCConnected(false); }}>
                  <Text style={{ color: '#ff4d4f', fontWeight: 'bold' }}>Disconnect Wallet</Text>
                </TouchableOpacity>
              )}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {/* Debug Logs Overlay */}
      {showLogs && (
        <View style={styles.historyOverlay}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <Text style={styles.historyTitle}>Debug Logs</Text>
            <TouchableOpacity onPress={() => setShowLogs(false)} style={{ padding: 4 }}><X size={24} color="#fff" /></TouchableOpacity>
          </View>
          <ScrollView style={{ flex: 1, backgroundColor: '#000', borderRadius: 8, padding: 10, borderWidth: 1, borderColor: '#222' }}>
            {debugLogs.length === 0 ? (
              <Text style={{ color: '#666', fontStyle: 'italic', textAlign: 'center', marginTop: 20 }}>No logs recorded yet.</Text>
            ) : (
              debugLogs.map((log, i) => (
                <Text key={i} style={{ color: '#0f0', fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', fontSize: 11, marginBottom: 4 }}>
                  {log}
                </Text>
              ))
            )}
          </ScrollView>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
            <TouchableOpacity
              style={{ flex: 1, backgroundColor: '#222', padding: 14, borderRadius: 10, alignItems: 'center' }}
              onPress={async () => {
                await Clipboard.setStringAsync(debugLogs.join('\n'));
                Alert.alert("Copied", "Logs copied to clipboard.");
              }}
            >
              <Text style={{ color: '#fff', fontWeight: 'bold' }}>COPY ALL</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ flex: 1, backgroundColor: 'rgba(255,77,79,0.1)', paddingVertical: 14, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,77,79,0.2)' }}
              onPress={clearLogs}
            >
              <Text style={{ color: '#ff4d4f', fontWeight: 'bold' }}>CLEAR</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Ride History Overlay */}
      {showHistory && (
        <View style={styles.historyOverlay}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <Text style={styles.historyTitle}>My Rides</Text>
            <Text style={{ color: '#9ba1a6', fontSize: 13 }}>{myRides.length} ride{myRides.length !== 1 ? 's' : ''}</Text>
          </View>
          <ScrollView style={{ flex: 1 }} refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefreshFeeds} tintColor="#fff" />}>
            {myRides.length === 0 ? (
              <Text style={styles.emptyText}>No rides recorded yet.</Text>
            ) : (
              myRides.map(r => {
                const distNum = parseFloat(r.distance || '0');
                const rideDate = new Date(r.time * 1000);
                const isDeletingThis = deletingRideId === r.id;
                return (
                  <View key={r.id} style={[styles.historyCard, { borderColor: 'rgba(0,255,170,0.1)', borderWidth: 1 }]}>
                    {/* Preview Image */}
                    <Image
                      source={r.image ? { uri: r.image } : ((r.client?.toLowerCase() === 'runstr' || r.kind === 1301 || r.kind === 1) && r.client?.toLowerCase() !== 'bikel') ? require('./assets/runstrLogo.jpg') : require('./assets/bikelLogo.jpg')}
                      style={{ width: '100%', height: 140, borderRadius: 8, marginBottom: 10 }}
                    />
                    {/* Title + date row */}
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                      <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 15, flex: 1, marginRight: 8 }} numberOfLines={1}>
                        {r.title || 'Untitled Ride'}
                      </Text>
                      <Text style={{ color: '#9ba1a6', fontSize: 11 }}>
                        {rideDate.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                      </Text>
                    </View>
                    {/* Time */}
                    <Text style={{ color: '#666', fontSize: 11, marginBottom: r.description ? 8 : 12 }}>
                      {rideDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                    {r.description ? (
                      <Text style={{ color: '#aaa', fontSize: 13, marginBottom: 12, lineHeight: 18 }} numberOfLines={2}>{r.description}</Text>
                    ) : null}
                    {/* Stats row */}
                    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                      <View style={{ flex: 1, backgroundColor: 'rgba(0,255,170,0.06)', padding: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(0,255,170,0.12)' }}>
                        <Text style={{ color: '#00ffaa', fontSize: 16, fontWeight: 'bold' }}>{distNum.toFixed(1)}</Text>
                        <Text style={{ color: '#9ba1a6', fontSize: 10, marginTop: 2 }}>MILES</Text>
                      </View>
                      <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.04)', padding: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
                        <Text style={{ color: '#fff', fontSize: 16, fontWeight: 'bold' }}>{r.duration}</Text>
                        <Text style={{ color: '#9ba1a6', fontSize: 10, marginTop: 2 }}>TIME</Text>
                      </View>
                      {r.elevation && (
                        <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.04)', padding: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
                          <Text style={{ color: '#fff', fontSize: 16, fontWeight: 'bold' }}>{r.elevation}</Text>
                          <Text style={{ color: '#9ba1a6', fontSize: 10, marginTop: 2 }}>GAIN (FT)</Text>
                        </View>
                      )}
                      {distNum > 0 && r.duration && (() => {
                        const parts = r.duration.match(/(\d+)h\s*(\d+)m|(\d+)m/);
                        let totalMins = 0;
                        if (parts) {
                          if (parts[1]) totalMins = parseInt(parts[1]) * 60 + parseInt(parts[2] || '0');
                          else if (parts[3]) totalMins = parseInt(parts[3]);
                        }
                        const avgSpeed = totalMins > 0 ? (distNum / (totalMins / 60)).toFixed(1) : null;
                        return avgSpeed ? (
                          <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.04)', padding: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
                            <Text style={{ color: '#fff', fontSize: 16, fontWeight: 'bold' }}>{avgSpeed}</Text>
                            <Text style={{ color: '#9ba1a6', fontSize: 10, marginTop: 2 }}>MPH AVG</Text>
                          </View>
                        ) : null;
                      })()}
                    </View>
                    {/* Action buttons */}
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      {r.route && r.route.length > 0 && (
                        <TouchableOpacity
                          style={{ flex: 1, backgroundColor: 'rgba(0,255,170,0.08)', paddingVertical: 9, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(0,255,170,0.2)' }}
                          onPress={() => {
                            setSelectedRoute(r.route!.map(pt => ({ lat: pt[0], lng: pt[1] })));
                            setSelectedMapRide(r);
                            setMapCenter({ lat: r.route![0][0], lng: r.route![0][1] });
                            setShowHistory(false);
                          }}
                        >
                          <Text style={{ color: '#00ffaa', fontWeight: 'bold', fontSize: 12 }}>🗺️ MAP</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity
                        style={{ flex: 1, backgroundColor: isDeletingThis ? 'rgba(255,77,79,0.05)' : 'rgba(255,77,79,0.1)', paddingVertical: 9, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,77,79,0.25)' }}
                        disabled={isDeletingThis}
                        onPress={() => Alert.alert('Delete Ride', 'Remove this ride from Nostr? This cannot be undone.', [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Delete', style: 'destructive', onPress: async () => {
                              setDeletingRideId(r.id);
                              try {
                                // publish kind 5 deletion
                                const ndk = await connectNDK();
                                const { NDKEvent } = await import('@nostr-dev-kit/ndk');
                                const delEvent = new NDKEvent(ndk);
                                delEvent.kind = 5;
                                delEvent.tags = [['e', r.id], ['k', '33301']];
                                delEvent.content = 'deleted';
                                await delEvent.publish();
                                setMyRides(prev => prev.filter(ride => ride.id !== r.id));
                              } catch (e: any) {
                                Alert.alert('Error', e.message || 'Could not delete ride');
                              } finally {
                                setDeletingRideId(null);
                              }
                            }
                          }
                        ])}
                      >
                        <Text style={{ color: isDeletingThis ? '#555' : '#ff4d4f', fontWeight: 'bold', fontSize: 12 }}>
                          {isDeletingThis ? '...' : '🗑️ DELETE'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>
        </View>
      )}

      {/* Global Feed + Drafts Overlay */}
      {showFeed && (
        <View style={styles.historyOverlay}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <Text style={styles.historyTitle}>Global Feed</Text>
            {isFeedLoading && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <ActivityIndicator size="small" color="#00ffaa" />
                <Text style={{ color: '#00ffaa', fontSize: 11 }}>{loadingStatus || 'Loading…'}</Text>
              </View>
            )}
          </View>
          {/* 4-tab bar */}
          <View style={{ marginBottom: 12 }}>
            <View style={{ flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 8, padding: 4, gap: 4 }}>
              {[
                { id: 'contests', label: 'CHALLENGES', activeColor: '#eab308' },
                { id: 'rides', label: 'GROUP RIDES', activeColor: '#00ffaa' },
                { id: 'feed', label: 'RECENT RIDES', activeColor: '#00ccff' },
                { id: 'drafts', label: `DRAFTS${drafts.length > 0 ? ` (${drafts.length})` : ''}`, activeColor: '#eab308' },
              ].map(tab => (
                <TouchableOpacity
                  key={tab.id}
                  style={{ flex: 1, paddingVertical: 8, paddingHorizontal: 2, backgroundColor: feedTab === tab.id ? tab.activeColor : 'transparent', borderRadius: 6, alignItems: 'center' }}
                  onPress={() => setFeedTab(tab.id as any)}
                >
                  <Text style={{ color: feedTab === tab.id ? '#000' : '#fff', fontWeight: 'bold', fontSize: 10 }} numberOfLines={1} adjustsFontSizeToFit>{tab.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefreshFeeds} tintColor="#fff" />}>

            {/* ── DRAFTS TAB ── */}
            {feedTab === 'drafts' && (
              <>
                {!autoDetect && (
                  <View style={{ backgroundColor: 'rgba(234,179,8,0.1)', borderWidth: 1, borderColor: 'rgba(234,179,8,0.3)', borderRadius: 10, padding: 14, marginBottom: 16 }}>
                    <Text style={{ color: '#eab308', fontWeight: 'bold', marginBottom: 4 }}>Auto-Detect is OFF</Text>
                    <Text style={{ color: '#9ba1a6', fontSize: 13 }}>Enable Auto-Detect in Settings to have Bikel automatically record bike rides in the background.</Text>
                  </View>
                )}

                {/* Ghost card — shown while a ride is actively being recorded */}
                {liveRecording && (
                  <View style={{ backgroundColor: 'rgba(0,255,170,0.04)', borderWidth: 1, borderColor: 'rgba(0,255,170,0.3)', borderRadius: 12, padding: 16, marginBottom: 12 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#00ffaa' }} />
                      <Text style={{ color: '#00ffaa', fontWeight: 'bold', fontSize: 14 }}>Recording in progress…</Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 16, marginBottom: 8 }}>
                      <Text style={{ color: '#fff', fontSize: 13 }}>🚴 {liveRecording.distance.toFixed(1)} mi</Text>
                      <Text style={{ color: '#fff', fontSize: 13 }}>⏱️ {formatDuration(Math.floor((Date.now() - liveRecording.startTime) / 1000))}</Text>
                      <Text style={{ color: '#555', fontSize: 13 }}>{liveRecording.points} pts</Text>
                    </View>
                    <Text style={{ color: '#555', fontSize: 11, marginBottom: 12 }}>Draft will save automatically when you stop riding.</Text>
                    <TouchableOpacity
                      style={{ backgroundColor: 'rgba(255,77,79,0.15)', paddingVertical: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,77,79,0.3)' }}
                      onPress={async () => {
                        Alert.alert("Stop Recording", "Save this ride draft and stop tracking now?", [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "STOP & SAVE", style: "destructive", onPress: async () => {
                              await stopRecordingManually();
                              await loadDrafts();
                            }
                          }
                        ]);
                      }}
                    >
                      <Text style={{ color: '#ff4d4f', fontWeight: 'bold', fontSize: 13 }}>🏁 STOP & SAVE DRAFT NOW</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {drafts.length === 0 ? (
                  <Text style={styles.emptyText}>{autoDetect ? 'No ride drafts yet. Keep riding!' : 'Enable Auto-Detect in Settings to start capturing drafts.'}</Text>
                ) : (
                  drafts.map(draft => {
                    const cc = confidenceColor(draft.confidence);
                    const cl = confidenceLabel(draft.confidence);
                    const startDate = new Date(draft.startTime * 1000);
                    return (
                      <View key={draft.id} style={[styles.historyCard, { borderColor: cc, borderWidth: 1 }]}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 15 }}>
                            {startDate.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
                          </Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <View style={{ backgroundColor: `${cc}22`, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1, borderColor: cc }}>
                              <Text style={{ color: cc, fontSize: 11, fontWeight: 'bold' }}>● {cl} ({(draft.confidence * 100).toFixed(0)}%)</Text>
                            </View>
                          </View>
                        </View>
                        <Text style={{ color: '#888', fontSize: 12, marginBottom: 10 }}>
                          {startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · auto-detected
                          {draft.speedSpikes > 0 ? ` · ${draft.speedSpikes} speed spike${draft.speedSpikes > 1 ? 's' : ''} detected` : ''}
                        </Text>
                        <View style={{ flexDirection: 'row', gap: 16, marginBottom: 14 }}>
                          <Text style={{ color: '#fff', fontSize: 14 }}>🚴 {draft.distance.toFixed(1)} mi</Text>
                          <Text style={{ color: '#fff', fontSize: 14 }}>⏱️ {formatDuration(draft.durationSeconds)}</Text>
                        </View>
                        {draft.route.length > 0 && (
                          <TouchableOpacity
                            style={{ backgroundColor: 'rgba(0,255,170,0.08)', padding: 8, borderRadius: 6, alignItems: 'center', marginBottom: 10 }}
                            onPress={() => { setSelectedRoute(draft.route); setShowFeed(false); }}
                          >
                            <Text style={{ color: '#00ffaa', fontWeight: 'bold', fontSize: 12 }}>🗺️ PREVIEW MAP</Text>
                          </TouchableOpacity>
                        )}
                        <View style={{ flexDirection: 'row', gap: 10 }}>
                          <TouchableOpacity
                            style={{ flex: 1, backgroundColor: 'rgba(255,77,79,0.15)', paddingVertical: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,77,79,0.3)' }}
                            onPress={() => Alert.alert('Delete Draft', 'Discard this ride draft?', [
                              { text: 'Cancel', style: 'cancel' },
                              { text: 'Delete', style: 'destructive', onPress: () => deleteDraft(draft.id) }
                            ])}
                          >
                            <Text style={{ color: '#ff4d4f', fontWeight: 'bold', fontSize: 13 }}>DELETE</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={{ flex: 2, backgroundColor: '#00ffaa', paddingVertical: 10, borderRadius: 8, alignItems: 'center' }}
                            onPress={() => openDraftForPosting(draft)}
                          >
                            <Text style={{ color: '#000', fontWeight: 'bold', fontSize: 13 }}>POST RIDE →</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    );
                  })
                )}
              </>
            )}

            {/* ── CONTESTS TAB ── */}
            {feedTab === 'contests' && (
              <>
                <Text style={{ color: '#00ffaa', fontSize: 16, fontWeight: 'bold', marginBottom: 12 }}>Active Community Challenges</Text>
                {activeContests.length === 0 ? (
                  <Text style={styles.emptyText}>No active challenges. Create one!</Text>
                ) : (
                  (() => {
                    const nowSeconds = Math.floor(Date.now() / 1000);
                    const upcomingContests = activeContests.filter(c => c.endTime >= nowSeconds).sort((a, b) => a.endTime - b.endTime);
                    const pastContests = activeContests.filter(c => c.endTime < nowSeconds).sort((a, b) => b.endTime - a.endTime);

                    const renderContest = (c: ContestEvent, isPast: boolean) => {
                      const isGlobal = c.invitedPubkeys.length === 0;
                      return (
                        <View key={c.id} style={[styles.historyCard, { borderColor: isPast ? '#555' : '#eab308', borderWidth: 1, opacity: isPast ? 0.6 : 1 }]}>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                            <Text style={{ color: isPast ? '#888' : '#eab308', fontWeight: 'bold', fontSize: 16 }}>🏆 {c.name}</Text>
                            <Text style={{ color: isGlobal ? '#00ccff' : '#ff4d4f', fontSize: 10, fontWeight: 'bold', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10, borderWidth: 1, borderColor: isGlobal ? '#00ccff' : '#ff4d4f' }}>
                              {isGlobal ? 'GLOBAL' : 'PRIVATE'}
                            </Text>
                          </View>
                          <Text style={{ color: '#aaa', fontSize: 12, marginBottom: 8 }}>Ends: {new Date(c.endTime * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</Text>
                          <Text style={{ color: '#fff', fontSize: 13, marginBottom: 8 }}>{c.description}</Text>
                          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
                            <View style={{ backgroundColor: 'rgba(255,255,255,0.05)', padding: 8, borderRadius: 6, flex: 1, alignItems: 'center' }}>
                              <Text style={{ color: '#9ba1a6', fontSize: 10, fontWeight: 'bold' }}>METRIC</Text>
                              <Text style={{ color: '#fff', fontSize: 12 }}>{c.parameter.replace('max_', '').toUpperCase()}</Text>
                            </View>
                            <View style={{ backgroundColor: 'rgba(255,255,255,0.05)', padding: 8, borderRadius: 6, flex: 1, alignItems: 'center' }}>
                              <Text style={{ color: '#9ba1a6', fontSize: 10, fontWeight: 'bold' }}>ENTRY FEE</Text>
                              <Text style={{ color: isPast ? '#888' : '#eab308', fontSize: 12, fontWeight: 'bold' }}>{c.feeSats} sats</Text>
                            </View>
                          </View>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                            <TouchableOpacity onPress={async () => {
                              setSelectedContest(c); setShowFeed(false); setIsLoadingLeaderboard(true);
                              const lb = await fetchRideLeaderboard(c.attendees, c.startTime, c.endTime, c.parameter);
                              setContestLeaderboard(lb); setIsLoadingLeaderboard(false);
                            }}>
                              <Text style={{ color: '#00ccff', fontSize: 12, textDecorationLine: 'underline' }}>Leaderboard ({c.attendees.length} Joined)</Text>
                            </TouchableOpacity>
                            {!isPast && (
                              <TouchableOpacity
                                style={{ backgroundColor: c.attendees.includes(currentHex) ? 'rgba(234, 179, 8, 0.2)' : '#eab308', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, flexDirection: 'row', alignItems: 'center', gap: 4 }}
                                disabled={c.attendees.includes(currentHex)}
                                onPress={async () => {
                                  if (!isNWCConnected && c.feeSats > 0) { Alert.alert("Wallet Required", "Connect your Lightning Wallet in Settings to pay the entry fee."); return; }
                                  try {
                                    if (c.feeSats > 0) { await zapRideEvent(c.id, ESCROW_PUBKEY, c.kind, Math.floor(c.feeSats), "Challenge Entry Fee"); Alert.alert("Payment Verified", `Joined challenge for ${c.feeSats} sats!`); }
                                    const joined = await publishRSVP(c);
                                    if (joined) { Alert.alert("Success", "You are entered into the challenge!"); setActiveContests(prev => prev.map(contest => contest.id === c.id ? { ...contest, attendees: [...contest.attendees, currentHex] } : contest)); }
                                  } catch (e: any) { Alert.alert("Error", e.message || "Failed to enter challenge"); }
                                }}
                              >
                                <Zap size={14} color={c.attendees.includes(currentHex) ? "#eab308" : "#000"} />
                                <Text style={{ color: c.attendees.includes(currentHex) ? '#eab308' : '#000', fontWeight: 'bold', fontSize: 12 }}>{c.attendees.includes(currentHex) ? 'ENTERED' : 'ENTER'}</Text>
                              </TouchableOpacity>
                            )}
                            {isPast && <Text style={{ color: '#aaa', fontSize: 12, fontWeight: 'bold' }}>EXPIRED</Text>}
                          </View>
                        </View>
                      );
                    };

                    return (
                      <>
                        {upcomingContests.length === 0 && (
                          <View style={{ alignItems: 'center', marginTop: 40 }}>
                            <Text style={styles.emptyText}>No active challenges right now.</Text>
                            <TouchableOpacity
                              style={{ marginTop: 12, backgroundColor: 'rgba(234,179,8,0.1)', paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(234,179,8,0.3)' }}
                              onPress={() => loadFeeds()}
                            >
                              <Text style={{ color: '#eab308', fontWeight: 'bold', fontSize: 12 }}>RETRY SYNC</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                        {upcomingContests.map(c => renderContest(c, false))}
                        {pastContests.length > 0 && <Text style={{ color: '#888', fontSize: 16, fontWeight: 'bold', marginTop: 24, marginBottom: 12 }}>Past Challenges</Text>}
                        {pastContests.map(c => renderContest(c, true))}
                      </>
                    );
                  })()
                )}
              </>
            )}

            {/* ── GROUP RIDES TAB ── */}
            {feedTab === 'rides' && (
              <>
                <Text style={{ color: '#00ffaa', fontSize: 16, fontWeight: 'bold', marginBottom: 12 }}>Upcoming Group Rides</Text>
                {scheduledRides.length === 0 ? (
                  <Text style={styles.emptyText}>No rides scheduled.</Text>
                ) : (
                  (() => {
                    const nowSeconds = Math.floor(Date.now() / 1000);
                    const upcomingRides = scheduledRides.filter(r => r.startTime >= nowSeconds).sort((a, b) => a.startTime - b.startTime);
                    const pastRides = scheduledRides.filter(r => r.startTime < nowSeconds).sort((a, b) => b.startTime - a.startTime);
                    return (
                      <>
                        {upcomingRides.length === 0 && (
                          <View style={{ alignItems: 'center', marginTop: 40 }}>
                            <Text style={styles.emptyText}>No upcoming rides.</Text>
                            <TouchableOpacity
                              style={{ marginTop: 12, backgroundColor: 'rgba(0,255,170,0.1)', paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(0,255,170,0.3)' }}
                              onPress={() => loadFeeds()}
                            >
                              <Text style={{ color: '#00ffaa', fontWeight: 'bold', fontSize: 12 }}>RETRY SYNC</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                        {upcomingRides.map(r => {
                          const profile = profiles[r.hexPubkey];
                          const displayName = profile?.nip05 || profile?.name || r.pubkey.substring(0, 10) + '...';
                          return (
                            <View key={r.id} style={styles.historyCard}>
                              <Image source={r.image ? { uri: r.image } : require('./assets/bikelLogo.jpg')} style={{ width: '100%', height: 150, borderRadius: 8, marginBottom: 12 }} />
                              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                <Text style={{ color: '#00ffaa', fontWeight: 'bold' }}>{r.name}</Text>
                                <TouchableOpacity onPress={() => { setViewingAuthor(r.hexPubkey); setIsLoadingAuthor(true); fetchUserRides(r.hexPubkey).then(setAuthorRides).finally(() => setIsLoadingAuthor(false)); }}>
                                  <Text style={{ color: '#00ccff', fontSize: 12, textDecorationLine: 'underline' }}>{displayName}</Text>
                                </TouchableOpacity>
                              </View>
                              <Text style={{ color: '#aaa', fontSize: 12, marginBottom: 8 }}>{new Date(r.startTime * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}{r.timezone ? ` (${r.timezone})` : ""}</Text>
                              <Text style={{ color: '#fff', fontSize: 13, marginBottom: 8 }}>{r.description}</Text>
                              <Text style={{ color: '#888', fontSize: 12, marginBottom: 12 }}>📍 {r.locationStr}</Text>

                              <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.05)', marginBottom: 12 }} />

                              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                                {/* Left: Secondary Icon Actions */}
                                <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
                                  {r.route && r.route.length > 0 && (
                                    <TouchableOpacity onPress={() => {
                                      setShowFeed(false);
                                      setSelectedRoute(r.route!.map(pt => ({ lat: pt[0], lng: pt[1] })));
                                      setSelectedMapRide(r as any);
                                      setMapCenter({ lat: r.route![0][0], lng: r.route![0][1] });
                                    }}>
                                      <Map size={18} color="#00ffaa" />
                                    </TouchableOpacity>
                                  )}
                                  <TouchableOpacity onPress={() => { setSelectedDiscussionRide(r); setShowDiscussion(true); }}>
                                    <MessageSquare size={18} color="#00ccff" />
                                  </TouchableOpacity>
                                  <TouchableOpacity onPress={() => setActiveDMUser(r.hexPubkey)}>
                                    <Mail size={18} color="#00ccff" />
                                  </TouchableOpacity>

                                  {r.hexPubkey === currentHex && (
                                    <TouchableOpacity
                                      onPress={() => Alert.alert('Delete Ride', 'Are you sure you want to delete this group ride?', [
                                        { text: 'Cancel', style: 'cancel' },
                                        {
                                          text: 'Delete', style: 'destructive', onPress: async () => {
                                            const deleted = await deleteRideEvent(r);
                                            if (deleted) {
                                              Alert.alert("Success", "Ride deleted.");
                                              setScheduledRides(await fetchScheduledRides());
                                            } else {
                                              Alert.alert("Error", "Could not delete ride event.");
                                            }
                                          }
                                        }
                                      ])}
                                    >
                                      <Trash2 size={18} color="#ff4d4f" />
                                    </TouchableOpacity>
                                  )}
                                </View>

                                {/* Right: Primary Actions (Zap & RSVP) */}
                                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                                  {isNWCConnected && (
                                    <TouchableOpacity
                                      disabled={isZapping}
                                      style={{ backgroundColor: 'rgba(234,179,8,0.1)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: 'rgba(234,179,8,0.2)' }}
                                      onPress={() => {
                                        Alert.alert('Send Zap', `Zap ${displayName} 21 sats?`, [
                                          { text: 'Cancel', style: 'cancel' },
                                          {
                                            text: 'Zap', onPress: async () => {
                                              if (isZapping) return; setIsZapping(true);
                                              try { await zapRideEvent(r.id, r.hexPubkey, r.kind, 21, "Thanks for organizing!"); Alert.alert("Zap Sent", "21 sats sent!"); }
                                              catch (e: any) { Alert.alert("Zap Failed", e.message || "Unknown error"); }
                                              setIsZapping(false);
                                            }
                                          }
                                        ]);
                                      }}
                                    >
                                      <Zap size={14} color={isZapping ? "#ccc" : "#eab308"} />
                                      <Text style={{ color: '#eab308', fontSize: 12, fontWeight: 'bold' }}>21</Text>
                                    </TouchableOpacity>
                                  )}

                                  <TouchableOpacity
                                    style={{
                                      backgroundColor: r.attendees.includes(currentHex) ? 'rgba(0,255,170,0.1)' : '#00ffaa',
                                      borderColor: r.attendees.includes(currentHex) ? '#00ffaa' : 'transparent',
                                      borderWidth: 1,
                                      paddingHorizontal: 16,
                                      paddingVertical: 6,
                                      borderRadius: 20
                                    }}
                                    disabled={r.attendees.includes(currentHex)}
                                    onPress={async () => {
                                      const joined = await publishRSVP(r);
                                      if (joined) { Alert.alert("Success", "You've RSVPd!"); setScheduledRides(await fetchScheduledRides()); }
                                      else Alert.alert("Error", "Could not RSVP.");
                                    }}>
                                    <Text style={{ color: r.attendees.includes(currentHex) ? '#00ffaa' : '#000', fontSize: 12, fontWeight: 'bold' }}>
                                      {r.attendees.includes(currentHex) ? 'Attending' : 'RSVP'}
                                    </Text>
                                  </TouchableOpacity>
                                </View>
                              </View>
                            </View>
                          );
                        })}
                        {pastRides.length > 0 && (
                          <>
                            <Text style={{ color: '#888', fontSize: 16, fontWeight: 'bold', marginTop: 24, marginBottom: 12 }}>Past Community Rides</Text>
                            {pastRides.map(r => (
                              <View key={r.id} style={[styles.historyCard, { opacity: 0.6 }]}>
                                <Image source={r.image ? { uri: r.image } : require('./assets/bikelLogo.jpg')} style={{ width: '100%', height: 150, borderRadius: 8, marginBottom: 12 }} />
                                <Text style={{ color: '#888', fontWeight: 'bold' }}>{r.name}</Text>
                                <Text style={{ color: '#666', fontSize: 12, marginBottom: 4 }}>{new Date(r.startTime * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</Text>
                                <Text style={{ color: '#888', fontSize: 13 }}>{r.description}</Text>
                                {r.hexPubkey === currentHex && (
                                  <>
                                    <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.05)', marginVertical: 12 }} />
                                    <TouchableOpacity
                                      style={{ alignSelf: 'flex-start' }}
                                      onPress={() => Alert.alert('Delete Past Ride', 'Are you sure you want to delete this past group ride?', [
                                        { text: 'Cancel', style: 'cancel' },
                                        {
                                          text: 'Delete', style: 'destructive', onPress: async () => {
                                            const deleted = await deleteRideEvent(r);
                                            if (deleted) {
                                              Alert.alert("Success", "Ride deleted.");
                                              setScheduledRides(await fetchScheduledRides());
                                            } else {
                                              Alert.alert("Error", "Could not delete ride event.");
                                            }
                                          }
                                        }
                                      ])}
                                    >
                                      <Trash2 size={18} color="#ff4d4f" />
                                    </TouchableOpacity>
                                  </>
                                )}
                              </View>
                            ))}
                          </>
                        )}
                      </>
                    );
                  })()
                )}
              </>
            )}

            {/* ── RECENT RIDES TAB ── */}
            {feedTab === 'feed' && (
              <>
                <Text style={{ color: '#00ffaa', fontSize: 16, fontWeight: 'bold', marginBottom: 12 }}>Recent Public Rides</Text>
                {globalRides.length === 0 ? (
                  <View style={{ alignItems: 'center', marginTop: 40 }}>
                    <Text style={styles.emptyText}>No public rides found.</Text>
                    <TouchableOpacity
                      style={{ marginTop: 12, backgroundColor: 'rgba(0,204,255,0.1)', paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(0,204,255,0.3)' }}
                      onPress={() => loadFeeds()}
                    >
                      <Text style={{ color: '#00ccff', fontWeight: 'bold', fontSize: 12 }}>RETRY SYNC</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  globalRides.map(r => {
                    const profile = profiles[r.hexPubkey];
                    const displayName = profile?.nip05 || profile?.name || r.pubkey.substring(0, 10) + '...';
                    return (
                      <View key={r.id} style={[styles.historyCard, { borderColor: 'rgba(255,255,255,0.05)' }]}>
                        <Image source={r.image ? { uri: r.image } : ((r.client?.toLowerCase() === 'runstr' || r.kind === 1301 || r.kind === 1) && r.client?.toLowerCase() !== 'bikel') ? require('./assets/runstrLogo.jpg') : require('./assets/bikelLogo.jpg')} style={{ width: '100%', height: 150, borderRadius: 8, marginBottom: 12 }} />
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                          <View>
                            <TouchableOpacity onPress={() => { setViewingAuthor(r.hexPubkey); setIsLoadingAuthor(true); fetchUserRides(r.hexPubkey).then(setAuthorRides).finally(() => setIsLoadingAuthor(false)); }}>
                              <Text style={{ color: '#00ccff', fontSize: 12, textDecorationLine: 'underline' }}>{displayName}</Text>
                            </TouchableOpacity>
                            {r.client && r.client !== 'bikel' && (
                              <Text style={{ color: '#00ccff', fontSize: 10, fontWeight: 'bold' }}>via {r.client.toLowerCase()}</Text>
                            )}
                          </View>
                          <Text style={styles.historyTime}>{r.title || new Date(r.time * 1000).toLocaleDateString()}</Text>
                        </View>
                        {r.description ? <Text style={{ color: '#ccc', fontSize: 13, marginBottom: 12 }}>{r.description}</Text> : null}
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                          <View style={{ width: '48%', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.03)', padding: 8, borderRadius: 6 }}>
                            <Route size={14} color="#00ffaa" />
                            <Text style={{ color: '#fff', fontSize: 13 }}>{r.distance} mi</Text>
                          </View>
                          <View style={{ width: '48%', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.03)', padding: 8, borderRadius: 6 }}>
                            <Clock size={14} color="#00ffaa" />
                            <Text style={{ color: '#fff', fontSize: 13 }}>{r.duration}</Text>
                          </View>
                          {r.rawDuration > 0 && parseFloat(r.distance) > 0 && (
                            <View style={{ width: '48%', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.03)', padding: 8, borderRadius: 6 }}>
                              <Gauge size={14} color="#00ccff" />
                              <Text style={{ color: '#fff', fontSize: 13 }}>{(parseFloat(r.distance) / (r.rawDuration / 3600)).toFixed(1)} mph</Text>
                            </View>
                          )}
                          {r.elevation && (
                            <View style={{ width: '48%', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.03)', padding: 8, borderRadius: 6 }}>
                              <ChevronUp size={14} color="#00ffaa" />
                              <Text style={{ color: '#fff', fontSize: 13 }}>{r.elevation} ft</Text>
                            </View>
                          )}
                        </View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingHorizontal: 4 }}>
                          <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>{r.client || 'Bikel'}</Text>
                          {isNWCConnected && (
                            <TouchableOpacity disabled={isZapping} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(234,179,8,0.1)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(234,179,8,0.3)' }} onPress={() => {
                              Alert.alert('Send Zap', `Zap ${displayName} 21 sats?`, [
                                { text: 'Cancel', style: 'cancel' },
                                {
                                  text: 'Zap', onPress: async () => {
                                    if (isZapping) return; setIsZapping(true);
                                    try { await zapRideEvent(r.id, r.hexPubkey, r.kind, 21, "Great ride!"); Alert.alert("Zap Sent", "21 sats sent!"); }
                                    catch (e: any) { Alert.alert("Zap Failed", e.message || "Unknown error"); }
                                    setIsZapping(false);
                                  }
                                }
                              ]);
                            }}>
                              <Zap size={12} color={isZapping ? "#ccc" : "#eab308"} />
                              <Text style={{ color: '#eab308', fontSize: 12, fontWeight: 'bold' }}>21</Text>
                            </TouchableOpacity>
                          )}
                        </View>
                        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                          <TouchableOpacity style={{ backgroundColor: 'rgba(0,204,255,0.1)', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6, alignItems: 'center', flex: 1 }} onPress={() => { setSelectedDiscussionRide(r); setShowDiscussion(true); }}>
                            <Text style={{ color: '#00ccff', fontWeight: 'bold', fontSize: 12 }}>💬 DISCUSS</Text>
                          </TouchableOpacity>
                          {r.route && r.route.length > 0 && (
                            <TouchableOpacity style={{ backgroundColor: 'rgba(0,255,170,0.1)', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6, alignItems: 'center', flex: 1 }} onPress={() => {
                              setShowFeed(false);
                              setSelectedRoute(r.route!.map(pt => ({ lat: pt[0], lng: pt[1] })));
                              setSelectedMapRide(r);
                              setMapCenter({ lat: r.route![0][0], lng: r.route![0][1] });
                            }}>
                              <Text style={{ color: '#00ffaa', fontWeight: 'bold', fontSize: 12 }}>🗺️ MAP</Text>
                            </TouchableOpacity>
                          )}
                        </View>
                      </View>
                    );
                  })
                )}
              </>
            )}
          </ScrollView>
        </View>
      )}

      {/* Schedule Overlay */}
      {showSchedule && (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.historyOverlay}>
          <Text style={styles.historyTitle}>{schedType === 'ride' ? 'Schedule Group Ride' : 'Create Community Challenge'}</Text>
          <View style={{ flexDirection: 'row', marginBottom: 16, gap: 10 }}>
            <TouchableOpacity style={{ flex: 1, backgroundColor: schedType === 'ride' ? '#00ffaa' : 'rgba(255,255,255,0.1)', paddingVertical: 10, borderRadius: 8, alignItems: 'center' }} onPress={() => setSchedType('ride')}>
              <Text style={{ color: schedType === 'ride' ? '#000' : '#fff', fontWeight: 'bold' }}>GROUP RIDE</Text>
            </TouchableOpacity>
            <TouchableOpacity style={{ flex: 1, backgroundColor: schedType === 'contest' ? '#eab308' : 'rgba(255,255,255,0.1)', paddingVertical: 10, borderRadius: 8, alignItems: 'center' }} onPress={() => setSchedType('contest')}>
              <Text style={{ color: schedType === 'contest' ? '#000' : '#fff', fontWeight: 'bold' }}>CHALLENGE</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            <View style={styles.settingsSection}>
              <Text style={styles.settingsLabel}>{schedType === 'ride' ? 'RIDE NAME' : 'CHALLENGE TITLE'}</Text>
              <TextInput style={styles.keyInput} placeholder="e.g. Saturday Morning Coffee Ride" placeholderTextColor="rgba(255,255,255,0.3)" value={schedName} onChangeText={setSchedName} />
              <Text style={styles.settingsLabel}>DESCRIPTION</Text>
              <TextInput style={[styles.keyInput, { height: 80 }]} placeholder="Pace, expected distance, drop/no-drop..." placeholderTextColor="rgba(255,255,255,0.3)" multiline value={schedDesc} onChangeText={setSchedDesc} />
              {schedType === 'ride' && (
                <>
                  <Text style={styles.settingsLabel}>PHOTO (OPTIONAL)</Text>
                  {schedImage ? (
                    <View style={{ marginBottom: 12 }}>
                      <Image source={{ uri: schedImage }} style={{ width: '100%', height: 140, borderRadius: 8, marginBottom: 8 }} />
                      <TouchableOpacity onPress={() => setSchedImage('')} style={{ alignItems: 'center' }}>
                        <Text style={{ color: '#ff4d4f', fontSize: 12 }}>✕ Remove photo</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <TouchableOpacity
                      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', borderRadius: 8, paddingVertical: 14, marginBottom: 12 }}
                      disabled={isUploadingSchedPhoto}
                      onPress={pickAndUploadSchedPhoto}
                    >
                      {isUploadingSchedPhoto
                        ? <><ActivityIndicator size="small" color="#00ffaa" /><Text style={{ color: '#00ffaa', fontWeight: 'bold' }}>Uploading…</Text></>
                        : <Text style={{ color: '#00ffaa', fontWeight: 'bold' }}>📷 Pick Photo from Gallery</Text>
                      }
                    </TouchableOpacity>
                  )}
                </>
              )}
              <Text style={styles.settingsLabel}>START TIME/DATE</Text>
              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
                <TouchableOpacity style={[styles.keyInput, { flex: 1, alignItems: 'center', justifyContent: 'center' }]} onPress={() => setShowDatePicker(true)}>
                  <Text style={{ color: '#fff' }}>{schedDate.toLocaleDateString()}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.keyInput, { flex: 1, alignItems: 'center', justifyContent: 'center' }]} onPress={() => setShowTimePicker(true)}>
                  <Text style={{ color: '#fff' }}>{schedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
                </TouchableOpacity>
              </View>
              {showDatePicker && <DateTimePicker value={schedDate} mode="date" display="default" onChange={(event: DateTimePickerEvent, selectedDate?: Date) => { setShowDatePicker(Platform.OS === 'ios'); if (selectedDate) setSchedDate(selectedDate); }} />}
              {showTimePicker && <DateTimePicker value={schedDate} mode="time" display="default" onChange={(event: DateTimePickerEvent, selectedDate?: Date) => { setShowTimePicker(Platform.OS === 'ios'); if (selectedDate) setSchedDate(selectedDate); }} />}

              {schedType === 'ride' && (
                <>
                  <Text style={styles.settingsLabel}>MEETING LOCATION</Text>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <TextInput style={[styles.keyInput, { flex: 1, marginBottom: 0 }]} placeholder="e.g. 123 Main St Coffee Shop" placeholderTextColor="rgba(255,255,255,0.3)" value={schedLocation} onChangeText={setSchedLocation} />
                    <TouchableOpacity style={{ backgroundColor: 'rgba(255,255,255,0.1)', paddingHorizontal: 16, borderRadius: 8, justifyContent: 'center', borderColor: 'rgba(255,255,255,0.3)', borderWidth: 1 }} disabled={isGettingLocation} onPress={async () => {
                      setIsGettingLocation(true);
                      try {
                        let loc = await Location.getLastKnownPositionAsync();
                        if (!loc) loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
                        if (loc) setSchedLocation(`geo:${loc.coords.latitude.toFixed(5)},${loc.coords.longitude.toFixed(5)}`);
                      } catch (e) { Alert.alert("Location Error", "Could not fetch current GPS location."); }
                      setIsGettingLocation(false);
                    }}>
                      {isGettingLocation ? <ActivityIndicator color="#00ffaa" size="small" /> : <Text style={{ color: '#00ffaa' }}>Use GPS</Text>}
                    </TouchableOpacity>
                  </View>
                  <Text style={[styles.settingsLabel, { marginTop: 16 }]}>REPEAT CADENCE</Text>
                  <View style={{ flexDirection: 'row', gap: 5, marginBottom: 16 }}>
                    {[{ id: 'none', label: 'None' }, { id: 'weekly', label: 'Weekly' }, { id: 'biweekly', label: 'Bi-Weekly' }, { id: 'monthly', label: 'Monthly' }].map(opt => (
                      <TouchableOpacity key={opt.id} style={{ flex: 1, backgroundColor: schedCadence === opt.id ? '#00ffaa' : 'rgba(255,255,255,0.1)', paddingVertical: 12, borderRadius: 8, alignItems: 'center', borderColor: 'rgba(255,255,255,0.3)', borderWidth: 1 }} onPress={() => setSchedCadence(opt.id as any)}>
                        <Text style={{ color: schedCadence === opt.id ? '#000' : '#fff', fontWeight: 'bold', fontSize: 12 }}>{opt.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  {schedCadence !== 'none' && (
                    <View style={{ marginBottom: 16 }}>
                      <Text style={styles.settingsLabel}>NUMBER OF EVENTS (MAX 6)</Text>
                      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                        {[2, 3, 4, 5, 6].map(num => (
                          <TouchableOpacity key={num} style={{ flex: 1, backgroundColor: schedOccurrences === num ? '#00ffaa' : 'rgba(255,255,255,0.1)', paddingVertical: 12, borderRadius: 8, alignItems: 'center', borderColor: 'rgba(255,255,255,0.3)', borderWidth: 1 }} onPress={() => setSchedOccurrences(num)}>
                            <Text style={{ color: schedOccurrences === num ? '#000' : '#fff', fontWeight: 'bold' }}>{num}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>
                  )}
                </>
              )}

              {schedType === 'contest' && (
                <>
                  <Text style={[styles.settingsLabel, { marginTop: 16 }]}>CHALLENGE DURATION</Text>
                  <Text style={[styles.settingsHelp, { marginBottom: 8 }]}>Hours</Text>
                  <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                    {['1h', '2h', '4h', '8h'].map(opt => (
                      <TouchableOpacity
                        key={opt}
                        style={{ flex: 1, backgroundColor: contestEndDays === opt ? '#00ffaa' : 'rgba(255,255,255,0.1)', paddingVertical: 10, borderRadius: 8, alignItems: 'center', borderColor: 'rgba(255,255,255,0.3)', borderWidth: 1 }}
                        onPress={() => setContestEndDays(opt)}
                      >
                        <Text style={{ color: contestEndDays === opt ? '#000' : '#fff', fontWeight: 'bold', fontSize: 13 }}>{opt}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={[styles.settingsHelp, { marginBottom: 8 }]}>Days</Text>
                  <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
                    {['1d', '3d', '7d', '14d'].map(opt => (
                      <TouchableOpacity
                        key={opt}
                        style={{ flex: 1, backgroundColor: contestEndDays === opt ? '#00ffaa' : 'rgba(255,255,255,0.1)', paddingVertical: 10, borderRadius: 8, alignItems: 'center', borderColor: 'rgba(255,255,255,0.3)', borderWidth: 1 }}
                        onPress={() => setContestEndDays(opt)}
                      >
                        <Text style={{ color: contestEndDays === opt ? '#000' : '#fff', fontWeight: 'bold', fontSize: 13 }}>{opt}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={[styles.settingsLabel, { marginTop: 8 }]}>WINNING METRIC</Text>
                  <View style={{ flexDirection: 'row', gap: 5, marginBottom: 16 }}>
                    {[{ id: 'max_distance', label: 'Furthest' }, { id: 'max_elevation', label: 'Elevation' }, { id: 'fastest_mile', label: 'Fastest' }].map(opt => (
                      <TouchableOpacity key={opt.id} style={{ flex: 1, backgroundColor: contestParam === opt.id ? '#00ffaa' : 'rgba(255,255,255,0.1)', paddingVertical: 12, borderRadius: 8, alignItems: 'center', borderColor: 'rgba(255,255,255,0.3)', borderWidth: 1 }} onPress={() => setContestParam(opt.id as any)}>
                        <Text style={{ color: contestParam === opt.id ? '#000' : '#fff', fontWeight: 'bold', fontSize: 12 }}>{opt.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={[styles.settingsLabel, { marginTop: 8 }]}>ENTRY FEE (SATS)</Text>
                  <TextInput style={[styles.keyInput, { marginBottom: 16 }]} keyboardType="number-pad" value={contestFee} onChangeText={setContestFee} placeholder="e.g. 5000" />
                  <Text style={[styles.settingsLabel, { marginTop: 8 }]}>PRIVATE INVITES (OPTIONAL NPUBS)</Text>
                  <Text style={styles.settingsHelp}>Leave blank for Global. Comma-separated npubs to restrict entry.</Text>
                  <TextInput style={[styles.keyInput, { marginBottom: 16, marginTop: 8, height: 60 }]} multiline placeholder="npub1..., npub1..." placeholderTextColor="#666" value={contestInvites} onChangeText={setContestInvites} />
                </>
              )}

              <TouchableOpacity style={[styles.saveButton, { marginTop: 8 }]} onPress={async () => {
                if (!schedName || !schedDate) { Alert.alert("Missing Fields", "Please fill in the Name and Date."); return; }
                if (schedType === 'ride' && !schedLocation) { Alert.alert("Missing Fields", "Please specify a location."); return; }
                try {
                  let startUnix = Math.floor(schedDate.getTime() / 1000);
                  if (schedType === 'ride') {
                    let eventsToCreate = schedCadence === 'none' ? 1 : schedOccurrences;
                    for (let i = 0; i < eventsToCreate; i++) {
                      await publishScheduledRide(schedName, schedCadence !== 'none' ? `${schedDesc}\n\n(Recurring Ride)` : schedDesc, startUnix, schedLocation, undefined, schedImage || undefined);
                      if (schedCadence === 'weekly') startUnix += 7 * 24 * 60 * 60;
                      else if (schedCadence === 'biweekly') startUnix += 14 * 24 * 60 * 60;
                      else if (schedCadence === 'monthly') startUnix += 28 * 24 * 60 * 60;
                    }
                  } else {
                    const durStr = contestEndDays;
                    const durSeconds = durStr.endsWith('h')
                      ? parseInt(durStr) * 3600
                      : (parseInt(durStr) || 1) * 86400;
                    const endUnix = startUnix + durSeconds;
                    const feeInt = parseInt(contestFee) || 0;
                    const pubkeys = contestInvites.split(',').map(s => s.trim()).filter(s => s.startsWith('npub'));
                    await publishContestEvent(schedName, schedDesc, startUnix, endUnix, contestParam, feeInt, pubkeys);
                  }
                  setSchedName(''); setSchedDesc(''); setSchedLocation(''); setSchedImage(''); setSchedCadence('none'); setSchedOccurrences(2); setContestInvites(''); setShowSchedule(false);
                  Alert.alert("Success", "Published to Nostr!");
                  try {
                    if (schedType === 'ride') { setScheduledRides(await fetchScheduledRides()); setShowFeed(true); setFeedTab('rides'); }
                    else { setActiveContests(await fetchContests()); setShowFeed(true); setFeedTab('contests'); }
                  } catch (fetchErr) { console.error("Failed to refresh feeds after publish", fetchErr); }
                } catch (e: any) { Alert.alert("Error", e.message); }
              }}>
                <Text style={styles.saveButtonText}>{schedType === 'ride' ? 'PUBLISH SCHEDULED RIDE' : 'CREATE CHALLENGE'}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {/* Contest Leaderboard */}
      {selectedContest && (
        <View style={styles.historyOverlay}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <Text style={styles.historyTitle}>{selectedContest.name}</Text>
            <TouchableOpacity onPress={() => { setSelectedContest(null); setShowFeed(true); }} style={{ padding: 4 }}><X size={24} color="#fff" /></TouchableOpacity>
          </View>
          <Text style={{ color: '#aaa', fontSize: 12, marginBottom: 16 }}>Winner: {selectedContest.parameter.replace('max_', '').toUpperCase()}</Text>
          {isLoadingLeaderboard ? (
            <ActivityIndicator size="large" color="#00ffaa" style={{ marginTop: 40 }} />
          ) : (
            <ScrollView style={{ flex: 1 }}>
              {contestLeaderboard.length === 0 ? <Text style={styles.emptyText}>No rides submitted yet.</Text> : contestLeaderboard.map((lb, index) => {
                const profile = profiles[lb.pubkey];
                const displayName = profile?.nip05 || profile?.name || lb.pubkey.substring(0, 8) + '...';
                return (
                  <TouchableOpacity key={lb.pubkey} style={[styles.historyCard, index === 0 ? { borderColor: '#eab308', borderWidth: 1 } : {}]}
                    onPress={() => { setViewingAuthor(lb.pubkey); setIsLoadingAuthor(true); fetchUserRides(lb.pubkey).then(setAuthorRides).finally(() => setIsLoadingAuthor(false)); }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ color: index === 0 ? '#eab308' : '#fff', fontWeight: 'bold', fontSize: 16 }}>#{index + 1} {displayName}</Text>
                      <Text style={{ color: '#00ffaa', fontSize: 16, fontWeight: 'bold' }}>{lb.value.toFixed(1)} {selectedContest.parameter.includes('distance') ? 'mi' : ''}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </View>
      )}

      {/* Author Profile */}
      {viewingAuthor && (
        <View style={styles.historyOverlay}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <Text style={styles.historyTitle}>Rider Profile</Text>
            <TouchableOpacity onPress={() => { setViewingAuthor(null); setAuthorRides([]); }} style={{ padding: 4 }}><X size={24} color="#fff" /></TouchableOpacity>
          </View>
          <View style={{ alignItems: 'center', marginBottom: 24, backgroundColor: 'rgba(255,255,255,0.05)', padding: 16, borderRadius: 12 }}>
            <Image source={profiles[viewingAuthor]?.picture ? { uri: profiles[viewingAuthor].picture } : require('./assets/bikelLogo.jpg')} style={{ width: 80, height: 80, borderRadius: 40, marginBottom: 12, borderWidth: 2, borderColor: '#00ffaa' }} />
            <Text style={{ color: '#00ffaa', fontWeight: 'bold', fontSize: 20 }}>{profiles[viewingAuthor]?.nip05 || profiles[viewingAuthor]?.name || viewingAuthor.substring(0, 10)}</Text>
            {profiles[viewingAuthor]?.about && <Text style={{ color: '#aaa', fontSize: 14, textAlign: 'center', marginTop: 8 }}>{profiles[viewingAuthor].about}</Text>}
            <TouchableOpacity style={{ marginTop: 16, backgroundColor: '#00ccff', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20, flexDirection: 'row', alignItems: 'center', gap: 6 }} onPress={() => { setViewingAuthor(null); setActiveDMUser(viewingAuthor); }}>
              <MessageSquare size={16} color="#000" />
              <Text style={{ color: '#000', fontWeight: 'bold' }}>MESSAGE RIDER</Text>
            </TouchableOpacity>
          </View>
          <Text style={{ color: '#00ffaa', fontSize: 16, fontWeight: 'bold', marginBottom: 12 }}>Tracked Routes</Text>
          {isLoadingAuthor ? <ActivityIndicator size="large" color="#00ffaa" style={{ marginTop: 20 }} /> : (
            <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
              {authorRides.length === 0 ? <Text style={styles.emptyText}>No public routes yet.</Text> : authorRides.map(r => (
                <View key={r.id} style={styles.historyCard}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                    <Text style={{ color: '#00ffaa', fontWeight: 'bold' }}>{r.title || 'Untitled Ride'}</Text>
                    <Text style={{ color: '#888', fontSize: 12 }}>{new Date(r.time * 1000).toLocaleDateString()}</Text>
                  </View>
                  {r.description && <Text style={{ color: '#aaa', fontSize: 12, marginBottom: 8 }}>{r.description}</Text>}
                  <View style={{ marginTop: 8, gap: 4 }}>
                    <View style={{ flexDirection: 'row', gap: 12 }}>
                      <Text style={{ color: '#fff', fontSize: 13 }}>🚴 {r.distance} mi</Text>
                      <Text style={{ color: '#fff', fontSize: 13 }}>⏱️ {r.duration}</Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 12 }}>
                      {r.rawDuration > 0 && parseFloat(r.distance) > 0 && (
                        <Text style={{ color: '#00ccff', fontSize: 13 }}>💨 {(parseFloat(r.distance) / (r.rawDuration / 3600)).toFixed(1)} mph</Text>
                      )}
                      {r.elevation && (
                        <Text style={{ color: '#fff', fontSize: 13 }}>⛰️ {r.elevation} ft</Text>
                      )}
                    </View>
                  </View>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      )}

      {/* Stats Overlay when tracking */}
      <View style={[styles.statsOverlay, { opacity: isTracking ? 1 : 0 }]} pointerEvents={isTracking ? 'auto' : 'none'}>
        <View style={styles.statBox}>
          <Text style={styles.statValue}>{formatTime(duration)}</Text>
          <Text style={styles.statLabel}>TIME</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statBox}>
          <Text style={styles.statValue}>{distance.toFixed(1)}</Text>
          <Text style={styles.statLabel}>MILES</Text>
        </View>
      </View>

      {/* Bottom Controls */}
      {!showPostRideModal && (
        <View style={styles.bottomPanel}>
          <TouchableOpacity style={[styles.recordButton, isTracking && styles.stopButton]} onPress={toggleTracking} activeOpacity={0.8}>
            <View style={{ position: 'absolute', opacity: isTracking ? 1 : 0 }}>
              <Square size={24} color="#ff4d4f" fill="#ff4d4f" />
            </View>
            <View style={{ opacity: isTracking ? 0 : 1 }}>
              <Play size={24} color="#000" fill="#000" />
            </View>
            <Text style={[styles.recordButtonText, isTracking && { color: '#ff4d4f' }]}>
              {isTracking ? 'FINISH RIDE' : 'RECORD RIDE'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Post-Ride Modal */}
      {showPostRideModal && (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.historyOverlay, { zIndex: 2000 }]}>
          <Text style={styles.historyTitle}>{postingFromDraft ? 'Post Draft Ride' : 'Finish Ride'}</Text>
          {postingFromDraft && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, backgroundColor: `${confidenceColor(postingFromDraft.confidence)}22`, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: confidenceColor(postingFromDraft.confidence) }}>
              <Text style={{ color: confidenceColor(postingFromDraft.confidence), fontWeight: 'bold', fontSize: 13 }}>
                ● Confidence: {confidenceLabel(postingFromDraft.confidence)} ({(postingFromDraft.confidence * 100).toFixed(0)}%)
              </Text>
              {postingFromDraft.speedSpikes > 0 && (
                <Text style={{ color: '#9ba1a6', fontSize: 11 }}> · {postingFromDraft.speedSpikes} speed spike{postingFromDraft.speedSpikes > 1 ? 's' : ''}</Text>
              )}
            </View>
          )}
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            <View style={styles.settingsSection}>
              <Text style={styles.settingsLabel}>TITLE (OPTIONAL)</Text>
              <TextInput style={styles.keyInput} placeholder="Morning Commute, Personal Record, etc." placeholderTextColor="rgba(255,255,255,0.3)" value={postRideTitle} onChangeText={setPostRideTitle} />
              <Text style={styles.settingsLabel}>DESCRIPTION (OPTIONAL)</Text>
              <TextInput style={[styles.keyInput, { height: 80 }]} placeholder="How was the ride? Any notes?" placeholderTextColor="rgba(255,255,255,0.3)" multiline value={postRideDesc} onChangeText={setPostRideDesc} />
              <Text style={styles.settingsLabel}>PHOTO (OPTIONAL)</Text>
              {postRideImageUrl ? (
                <View style={{ marginBottom: 12 }}>
                  <Image source={{ uri: postRideImageUrl }} style={{ width: '100%', height: 140, borderRadius: 8, marginBottom: 8 }} />
                  <TouchableOpacity onPress={() => setPostRideImageUrl('')} style={{ alignItems: 'center' }}>
                    <Text style={{ color: '#ff4d4f', fontSize: 12 }}>✕ Remove photo</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', borderRadius: 8, paddingVertical: 14, marginBottom: 12 }}
                  disabled={isUploadingPhoto}
                  onPress={pickAndUploadPhoto}
                >
                  {isUploadingPhoto
                    ? <><ActivityIndicator size="small" color="#00ffaa" /><Text style={{ color: '#00ffaa', fontWeight: 'bold' }}>Uploading…</Text></>
                    : <Text style={{ color: '#00ffaa', fontWeight: 'bold' }}>📷 Pick Photo from Gallery</Text>
                  }
                </TouchableOpacity>
              )}
              <Text style={styles.settingsLabel}>PRIVACY</Text>
              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
                <TouchableOpacity style={{ flex: 1, backgroundColor: postRidePrivacy === 'full' ? '#00ffaa' : 'rgba(255,255,255,0.1)', paddingVertical: 10, borderRadius: 8, alignItems: 'center' }} onPress={() => setPostRidePrivacy('full')}>
                  <Text style={{ color: postRidePrivacy === 'full' ? '#000' : '#fff', fontWeight: 'bold' }}>PUBLIC ROUTE</Text>
                </TouchableOpacity>
                <TouchableOpacity style={{ flex: 1, backgroundColor: postRidePrivacy === 'hidden' ? '#00ccff' : 'rgba(255,255,255,0.1)', paddingVertical: 10, borderRadius: 8, alignItems: 'center' }} onPress={() => setPostRidePrivacy('hidden')}>
                  <Text style={{ color: postRidePrivacy === 'hidden' ? '#000' : '#fff', fontWeight: 'bold' }}>STATS ONLY</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.settingsLabel}>SCHEDULE AS GROUP RIDE?</Text>
              <TouchableOpacity style={{ backgroundColor: postRideScheduleMode ? '#00ffaa' : 'rgba(255,255,255,0.1)', paddingVertical: 12, borderRadius: 8, alignItems: 'center', marginBottom: postRideScheduleMode ? 16 : 24 }} onPress={() => setPostRideScheduleMode(!postRideScheduleMode)}>
                <Text style={{ color: postRideScheduleMode ? '#000' : '#fff', fontWeight: 'bold' }}>{postRideScheduleMode ? 'Yes, Schedule Future Ride' : 'No, Post as Past Ride'}</Text>
              </TouchableOpacity>
              {postRideScheduleMode && (
                <View style={{ marginBottom: 16 }}>
                  <Text style={styles.settingsLabel}>MEETING LOCATION</Text>
                  <TextInput style={styles.keyInput} placeholder="E.g., Central Park Entrance" placeholderTextColor="rgba(255,255,255,0.3)" value={postRideLocation} onChangeText={setPostRideLocation} />
                  <Text style={styles.settingsLabel}>DATE & TIME</Text>
                  <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
                    <TouchableOpacity style={[styles.keyInput, { flex: 1, paddingVertical: 12 }]} onPress={() => setShowPostRideDate(true)}>
                      <Text style={{ color: '#fff', textAlign: 'center' }}>{postRideDate.toLocaleDateString()}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.keyInput, { flex: 1, paddingVertical: 12 }]} onPress={() => setShowPostRideTime(true)}>
                      <Text style={{ color: '#fff', textAlign: 'center' }}>{postRideTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
                    </TouchableOpacity>
                  </View>
                  {showPostRideDate && <DateTimePicker value={postRideDate} mode="date" onChange={(event: DateTimePickerEvent, d?: Date) => { setShowPostRideDate(Platform.OS === 'ios'); if (d) setPostRideDate(d); }} />}
                  {showPostRideTime && <DateTimePicker value={postRideTime} mode="time" onChange={(event: DateTimePickerEvent, d?: Date) => { setShowPostRideTime(Platform.OS === 'ios'); if (d) setPostRideTime(d); }} />}
                </View>
              )}
              <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16, backgroundColor: 'rgba(255,255,255,0.05)', padding: 12, borderRadius: 8 }} onPress={() => setTrimTails(!trimTails)}>
                <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: trimTails ? '#00ffaa' : 'rgba(255,255,255,0.3)', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
                  {trimTails && <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#00ffaa' }} />}
                </View>
                <Text style={{ color: '#fff', flex: 1 }}>Trim 0.1 miles from Start/End of Route for Privacy</Text>
              </TouchableOpacity>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                <TouchableOpacity style={[styles.saveButton, { flex: 1, backgroundColor: 'rgba(255,255,255,0.1)' }]} onPress={() => {
                  Alert.alert("Discard", postingFromDraft ? "Discard this draft? It will remain in your Drafts tab." : "Discard this ride?", [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Discard", style: "destructive", onPress: () => {
                        setShowPostRideModal(false); setPostingFromDraft(null);
                        setDuration(0); setDistance(0); setRoute([]);
                        setPostRideTitle(''); setPostRideDesc(''); setPostRideImageUrl('');
                        setPostRidePrivacy('full'); setPostRideScheduleMode(false); setTrimTails(true);
                      }
                    }
                  ]);
                }}>
                  <Text style={styles.saveButtonText}>DISCARD</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.saveButton, { flex: 2, backgroundColor: '#00ffaa' }]} onPress={async () => {
                  try {
                    let routePoints = route.map(r => ({ lat: r.coords.latitude, lng: r.coords.longitude }));
                    if (trimTails && routePoints.length > 2) {
                      const TRIM_MILES = Math.min(0.1, distance * 0.15);
                      let startTrimIndex = 0;
                      let accumulatedStartDist = 0;
                      for (let i = 0; i < routePoints.length - 1; i++) {
                        accumulatedStartDist += getDistanceMiles(routePoints[i].lat, routePoints[i].lng, routePoints[i + 1].lat, routePoints[i + 1].lng);
                        if (accumulatedStartDist >= TRIM_MILES) { startTrimIndex = i + 1; break; }
                      }
                      if (startTrimIndex < routePoints.length - 1) {
                        routePoints = routePoints.slice(startTrimIndex);
                        let endTrimIndex = routePoints.length - 1;
                        let accumulatedEndDist = 0;
                        for (let i = routePoints.length - 1; i > 0; i--) {
                          accumulatedEndDist += getDistanceMiles(routePoints[i].lat, routePoints[i].lng, routePoints[i - 1].lat, routePoints[i - 1].lng);
                          if (accumulatedEndDist >= TRIM_MILES) { endTrimIndex = i - 1; break; }
                        }
                        routePoints = endTrimIndex > 0 ? routePoints.slice(0, endTrimIndex + 1) : [];
                      } else { routePoints = []; }
                    }

                    // Use draft confidence if posting from draft
                    const confidenceToPost = postingFromDraft ? postingFromDraft.confidence : 1.0;

                    if (postRideScheduleMode) {
                      if (!postRideLocation) { Alert.alert("Missing Fields", "Please specify a meeting location."); return; }
                      const startUnix = Math.floor(new Date(postRideDate.getFullYear(), postRideDate.getMonth(), postRideDate.getDate(), postRideTime.getHours(), postRideTime.getMinutes()).getTime() / 1000);
                      await publishScheduledRide(postRideTitle || "Group Ride", postRideDesc || "Join my ride!", startUnix, postRideLocation, routePoints, postRideImageUrl, distance, duration);
                      await publishRide(distance, duration, routePoints, postRidePrivacy, postRideTitle, postRideDesc, postRideImageUrl, confidenceToPost, elevation);
                      Alert.alert("Ride Scheduled!", "Your group ride was published.");
                    } else {
                      await publishRide(distance, duration, routePoints, postRidePrivacy, postRideTitle, postRideDesc, postRideImageUrl, confidenceToPost, elevation);
                      Alert.alert("Ride Published!", "Your ride was published to Nostr.");
                    }

                    // If posting from draft, delete the draft
                    if (postingFromDraft) {
                      await deleteDraft(postingFromDraft.id);
                    }

                    setShowPostRideModal(false); setPostingFromDraft(null);
                    setDuration(0); setDistance(0); setElevation(0); setRoute([]);
                    setPostRideTitle(''); setPostRideDesc(''); setPostRideImageUrl('');
                    setPostRidePrivacy('full'); setPostRideScheduleMode(false);
                    try { setMyRides(await fetchMyRides()); setGlobalRides(await fetchRecentRides()); } catch (e) { }
                  } catch (e: any) {
                    Alert.alert("Failed to publish ride", e.message || "Unknown error.");
                    console.error("Failed to publish ride", e);
                  }
                }}>
                  <Text style={[styles.saveButtonText, { color: '#000' }]}>POST RIDE</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {/* Discussion Overlay */}
      {showDiscussion && selectedDiscussionRide && (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.historyOverlay, { zIndex: 1000 }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <Text style={styles.historyTitle}>Discussion</Text>
            <TouchableOpacity onPress={() => { setShowDiscussion(false); setSelectedDiscussionRide(null); }} style={{ padding: 4 }}><X size={24} color="#fff" /></TouchableOpacity>
          </View>
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            {comments.length === 0 ? <Text style={styles.emptyText}>No comments yet. Be the first!</Text> : comments.map(c => (
              <View key={c.id} style={[styles.historyCard, { backgroundColor: 'rgba(0,0,0,0.3)', borderColor: 'rgba(255,255,255,0.05)' }]}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                  <TouchableOpacity onPress={() => {
                    const targetKey = c.hexPubkey || c.pubkey;
                    setShowDiscussion(false); setViewingAuthor(targetKey); setIsLoadingAuthor(true);
                    fetchUserRides(targetKey).then(setAuthorRides).finally(() => setIsLoadingAuthor(false));
                  }}>
                    <Text style={{ color: '#00ffaa', fontSize: 12, fontWeight: 'bold', textDecorationLine: 'underline' }}>
                      {profiles[c.hexPubkey || c.pubkey]?.nip05 || profiles[c.hexPubkey || c.pubkey]?.name || (c.hexPubkey || c.pubkey).substring(0, 10) + '...'}
                    </Text>
                  </TouchableOpacity>
                  <Text style={{ color: '#888', fontSize: 12 }}>{new Date(c.createdAt * 1000).toLocaleDateString()}</Text>
                </View>
                <Text style={{ color: '#eee', fontSize: 14 }}>{c.content}</Text>
              </View>
            ))}
          </ScrollView>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 12, alignItems: 'center' }}>
            <TextInput style={[styles.keyInput, { flex: 1, marginBottom: 0 }]} placeholder="Write a comment..." placeholderTextColor="rgba(255,255,255,0.3)" value={newComment} onChangeText={setNewComment} editable={!isPublishingComment} />
            <TouchableOpacity style={{ backgroundColor: '#00ffaa', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8 }} disabled={isPublishingComment || !newComment.trim()} onPress={async () => {
              if (!newComment.trim()) return;
              setIsPublishingComment(true);
              const success = await publishComment(selectedDiscussionRide.id, newComment.trim());
              if (success) { setNewComment(''); fetchComments(selectedDiscussionRide.id).then(fetched => { setComments(fetched); loadAuthorProfiles(fetched.map(c => c.hexPubkey || c.pubkey)).catch(console.error); }); }
              else Alert.alert("Error", "Failed to publish comment");
              setIsPublishingComment(false);
            }}>
              <Text style={{ color: '#000', fontWeight: 'bold' }}>{isPublishingComment ? '...' : 'POST'}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      )}

      {/* DM Overlay */}
      {activeDMUser && (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.historyOverlay, { zIndex: 1000 }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <Text style={styles.historyTitle}>Chat with {profiles[activeDMUser]?.nip05 || profiles[activeDMUser]?.name || activeDMUser.substring(0, 10)}...</Text>
            <TouchableOpacity onPress={() => setActiveDMUser(null)} style={{ padding: 4 }}><X size={24} color="#fff" /></TouchableOpacity>
          </View>
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            {dmMessages.length === 0 ? <Text style={styles.emptyText}>No messages yet. Say hello!</Text> : dmMessages.map(msg => {
              const isMe = msg.sender !== activeDMUser;
              return (
                <View key={msg.id} style={{ maxWidth: '80%', alignSelf: isMe ? 'flex-end' : 'flex-start', backgroundColor: isMe ? 'rgba(0,204,255,0.2)' : 'rgba(255,255,255,0.1)', padding: 12, borderRadius: 12, borderBottomRightRadius: isMe ? 2 : 12, borderBottomLeftRadius: isMe ? 12 : 2, marginBottom: 12 }}>
                  <Text style={{ color: '#fff', fontSize: 14 }}>{msg.text}</Text>
                  <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, marginTop: 4, textAlign: isMe ? 'right' : 'left' }}>
                    {new Date(msg.createdAt * 1000).toLocaleDateString()} {new Date(msg.createdAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </Text>
                </View>
              );
            })}
          </ScrollView>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 12, alignItems: 'center' }}>
            <TextInput style={[styles.keyInput, { flex: 1, marginBottom: 0 }]} placeholder="Type a message..." placeholderTextColor="rgba(255,255,255,0.3)" value={newDMText} onChangeText={setNewDMText} editable={!isSendingDM} />
            <TouchableOpacity style={{ backgroundColor: '#00ccff', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8 }} disabled={isSendingDM || !newDMText.trim()} onPress={async () => {
              if (!newDMText.trim()) return;
              setIsSendingDM(true);
              const success = await sendDM(activeDMUser, newDMText.trim());
              if (success) { setNewDMText(''); fetchDMs(activeDMUser).then(setDmMessages); }
              else Alert.alert("Error", "Failed to send message");
              setIsSendingDM(false);
            }}>
              <Text style={{ color: '#000', fontWeight: 'bold' }}>{isSendingDM ? '...' : 'SEND'}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0d0f12' },
  map: { position: 'absolute', top: 110, left: 0, right: 0, bottom: 0, borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden', backgroundColor: '#161a1f' },
  headerPanel: { position: 'absolute', top: Platform.OS === 'ios' ? 60 : 40, left: 20, right: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'rgba(22, 26, 31, 0.85)', padding: 16, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.05)' },
  logoContainer: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerText: { color: '#fff', fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  statsOverlay: { position: 'absolute', top: 140, left: 20, right: 20, flexDirection: 'row', backgroundColor: 'rgba(22, 26, 31, 0.85)', borderRadius: 16, padding: 20, borderWidth: 1, borderColor: 'rgba(0, 255, 170, 0.3)' },
  statBox: { flex: 1, alignItems: 'center' },
  statDivider: { width: 1, backgroundColor: 'rgba(255, 255, 255, 0.1)' },
  statValue: { color: '#00ffaa', fontSize: 32, fontWeight: '800' },
  statLabel: { color: '#9aa5b1', fontSize: 12, fontWeight: '600', marginTop: 4, letterSpacing: 1 },
  bottomPanel: { position: 'absolute', bottom: 60, left: 20, right: 20 },
  recordButton: { backgroundColor: '#00ffaa', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 20, borderRadius: 20, gap: 12, shadowColor: '#00ffaa', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10, elevation: 8 },
  stopButton: { backgroundColor: '#161a1f', borderColor: '#ff4d4f', borderWidth: 2, shadowColor: '#ff4d4f' },
  recordButtonText: { color: '#000', fontSize: 18, fontWeight: '800', letterSpacing: 1 },
  historyOverlay: { position: 'absolute', top: Platform.OS === 'ios' ? 120 : 100, left: 20, right: 20, bottom: 120, backgroundColor: 'rgba(13, 15, 18, 0.95)', borderRadius: 20, padding: 20, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.1)' },
  historyTitle: { color: '#00ffaa', fontSize: 24, fontWeight: '800', marginBottom: 16 },
  historyCard: { backgroundColor: 'rgba(255,255,255,0.05)', padding: 16, borderRadius: 12, marginBottom: 12 },
  historyTime: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 8 },
  historyStats: { flexDirection: 'row', gap: 16 },
  historyStat: { color: '#9ba1a6', fontSize: 14 },
  emptyText: { color: '#9ba1a6', textAlign: 'center', marginTop: 40 },
  settingsSection: { backgroundColor: 'rgba(255,255,255,0.05)', padding: 16, borderRadius: 12, marginBottom: 20 },
  settingsLabel: { color: '#00ffaa', fontSize: 12, fontWeight: '800', letterSpacing: 1, marginBottom: 12 },
  settingsKeyText: { color: '#fff', fontSize: 14, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', padding: 12, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 8, marginBottom: 8 },
  settingsHelp: { color: '#9ba1a6', fontSize: 12, fontStyle: 'italic' },
  keyInput: { color: '#fff', backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 8, padding: 12, fontSize: 14, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginBottom: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  saveButton: { backgroundColor: '#ff4d4f', padding: 12, borderRadius: 8, alignItems: 'center' },
  saveButtonText: { color: '#fff', fontWeight: '800', fontSize: 14, letterSpacing: 1 },
  privacyToggle: { backgroundColor: 'rgba(22, 26, 31, 0.85)', padding: 12, borderRadius: 16, marginBottom: 12, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.1)' },
  privacyToggleText: { color: '#00ffaa', fontWeight: '700', fontSize: 14 },
});