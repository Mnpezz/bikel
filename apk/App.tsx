import React, { useState, useEffect, useMemo, useRef } from 'react';
import { NDKEvent, NDKUser, NDKFilter } from '@nostr-dev-kit/ndk';
import { format } from 'date-fns';
import { StyleSheet, Text, View, TouchableOpacity, Dimensions, Platform, ScrollView, TextInput, Alert, KeyboardAvoidingView, ActivityIndicator, Image, RefreshControl, BackHandler, AppState, Switch, NativeModules, Linking, InteractionManager } from 'react-native';
import * as Location from 'expo-location';
import { LeafletView, MapLayerType, MapShapeType, WebViewLeafletEvents } from 'react-native-leaflet-view';
import { Bike, Square, Play, Zap, History, Settings, CirclePlus, X, MessageSquare, Globe, LocateFixed, Map, Mail, Trash2, RotateCw, ChevronUp, Route, Clock, Gauge, Calendar, Navigation } from 'lucide-react-native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import * as Notifications from 'expo-notifications';
import { nip19 } from 'nostr-tools';
import { connectNDK, publishRide, publishSocialNote, publishChannelMessage, fetchChannelMessages, fetchAllBikelSocial, fetchMyRides, fetchUserRides, getPrivateKeyNsec, getPublicKeyNpub, getPublicKeyHex, setPrivateKey, useAmberSigner, useLocalSigner, AUTH_METHOD_KEY, AMBER_PUBKEY_KEY, publishScheduledRide, publishContestEvent, prepareContestEvent, fetchContests, fetchRecentRides, fetchScheduledRides, deleteRideEvent, publishRSVP, connectNWC, zapRideEvent, fetchComments, publishComment, fetchDMs, sendDM, publishProfile, fetchRideLeaderboard, fetchProfiles, uploadPhoto, fetchRideById, fetchReactions, publishReaction, deleteReaction, fetchCheckpoints, prepareCheckpointEvent, publishCheckpoint, fetchApprovedBots, fetchEventsWithTimeout, fetchMyClaims, ESCROW_PUBKEY, BIKEL_GLOBAL_CHANNEL_ID, RideEvent, ScheduledRideEvent, ContestEvent, CheckpointEvent, RideComment, ReactionSummary, DMessage, ApprovedBot, Claim } from './src/lib/nostr';

import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';

const LOCATION_TASK = 'BIKEL_LOCATION_TASK';
const PASSIVE_SCAN_TASK = 'BIKEL_PASSIVE_SCAN'; // legacy name kept for stop-cleanup only
const DRAFT_TASK = 'BIKEL_DRAFT_TASK';

const MAX_DRAFTS = 21;
const BIKE_SPEED_MIN_MPH = 2.5; // Lowered to 2.5mph for crawling in city traffic
const BIKE_SPEED_MAX_MPH = 25;
const CAR_SPEED_THRESHOLD_MPH = 30;
const CAR_SPIKE_LIMIT = 5;      // Increased to 5 to allow for GPS jitter in cities
const IDLE_STOP_SECONDS = 50; // Reverted to 50s for better accuracy in urban environments
// Warmup: must see N readings in bike range before committing route points
const WARMUP_NEEDED = 2;

const POI_LAT_OFFSET = 0.001; // Shift map center down to move POI further up on screen
const MAP_LAYERS = [{
  baseLayerName: 'DarkMode',
  baseLayerIsChecked: true,
  layerType: MapLayerType.TILE_LAYER,
  baseLayer: true,
  url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
}];

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

export interface GroupedCheckpoint {
  id: string;
  lat: number;
  lng: number;
  events: CheckpointEvent[];
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
  if (error) {
    await logEvent(`📍 [GPS] Task Error: ${error.message}`);
    console.error('[BackgroundLocation] Task error:', error.message);
    return;
  }
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
      route: [] as any[],
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
    const err = e.message || String(e);
    console.error('[DraftTask] Failed:', err);
    await logEvent(`⚠️ [Auto-detect] Error: ${err}`);
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
  const [myClaims, setMyClaims] = useState<Claim[]>([]);
  const [globalRides, setGlobalRides] = useState<RideEvent[]>([]);
  const [scheduledRides, setScheduledRides] = useState<ScheduledRideEvent[]>([]);
  const [activeContests, setActiveContests] = useState<ContestEvent[]>([]);
  const [selectedContest, setSelectedContest] = useState<ContestEvent | null>(null);
  const [contestLeaderboard, setContestLeaderboard] = useState<{ pubkey: string, value: number }[]>([]);
  const [isLoadingLeaderboard, setIsLoadingLeaderboard] = useState(false);
  const [selectedRoute, setSelectedRoute] = useState<{ lat: number, lng: number }[]>([]);
  const [mapCenter, setMapCenter] = useState<{ lat: number, lng: number } | null>(null);
  const [mapZoom, setMapZoom] = useState(13);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [profiles, setProfiles] = useState<Record<string, any>>({});
  const [checkpoints, setCheckpoints] = useState<CheckpointEvent[]>([]);
  const [nearestCheckpoint, setNearestCheckpoint] = useState<{ cp: CheckpointEvent; distance: number } | null>(null);
  const [sessionCheckpointHit, setSessionCheckpointHit] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState('');

  const [showHistory, setShowHistory] = useState(false);
  const [showFeed, setShowFeed] = useState(false);
  const [isFeedLoading, setIsFeedLoading] = useState(false);
  const [isSocialLoading, setIsSocialLoading] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [feedTab, setFeedTab] = useState<'contests' | 'rides' | 'feed' | 'drafts' | 'chat' | 'activity' | 'sponsors'>('feed');
  const [showSettings, setShowSettings] = useState(false);
  const [customRelays, setCustomRelays] = useState<string[]>([]);
  const [newRelayUrl, setNewRelayUrl] = useState('');

  // ── Load Custom Relays ──────────────────
  useEffect(() => {
    import('./src/lib/nostr').then(({ getRelays, fetchApprovedBots }) => {
      getRelays().then(setCustomRelays);
      fetchApprovedBots().then(setApprovedBots).catch(console.error);
    });
  }, []);

  const handleAddRelay = async () => {
    if (!newRelayUrl.trim().startsWith('ws')) {
      Alert.alert("Invalid URL", "Relay URL must start with ws:// or wss://");
      return;
    }
    const updated = [...customRelays, newRelayUrl.trim()];
    setCustomRelays(updated);
    setNewRelayUrl('');
    const { saveRelays } = await import('./src/lib/nostr');
    await saveRelays(updated);
  };

  const handleRemoveRelay = async (url: string) => {
    const updated = customRelays.filter(r => r !== url);
    setCustomRelays(updated);
    const { saveRelays } = await import('./src/lib/nostr');
    await saveRelays(updated);
  };

  // ── AsyncStorage Data Hydration ──────────────────
  useEffect(() => {
    const hydrate = async () => {
      try {
        const [rides, contests, cps, scheduled] = await Promise.all([
          AsyncStorage.getItem('bikel_cache_global_rides'),
          AsyncStorage.getItem('bikel_cache_contests'),
          AsyncStorage.getItem('bikel_cache_checkpoints'),
          AsyncStorage.getItem('bikel_cache_scheduled')
        ]);
        if (rides) setGlobalRides(JSON.parse(rides));
        if (contests) setActiveContests(JSON.parse(contests));
        if (cps) setCheckpoints(JSON.parse(cps));
        if (scheduled) setScheduledRides(JSON.parse(scheduled));
        console.log('[Hydration] Instant UI populated from cache');
      } catch (e) {
        console.warn('[Hydration] Failed to load cache:', e);
      }
    };
    hydrate();
  }, []);

  // ── AsyncStorage Data Persistence ────────────────
  useEffect(() => {
    if (globalRides.length > 0) {
      AsyncStorage.setItem('bikel_cache_global_rides', JSON.stringify(globalRides.slice(0, 50))).catch(() => {});
    }
  }, [globalRides]);

  useEffect(() => {
    if (activeContests.length > 0) {
      AsyncStorage.setItem('bikel_cache_contests', JSON.stringify(activeContests.slice(0, 50))).catch(() => {});
    }
  }, [activeContests]);

  useEffect(() => {
    if (checkpoints.length > 0) {
      AsyncStorage.setItem('bikel_cache_checkpoints', JSON.stringify(checkpoints)).catch(() => {});
    }
  }, [checkpoints]);

  useEffect(() => {
    if (scheduledRides.length > 0) {
      AsyncStorage.setItem('bikel_cache_scheduled', JSON.stringify(scheduledRides.slice(0, 50))).catch(() => {});
    }
  }, [scheduledRides]);

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
  const [authMethod, setAuthMethod] = useState<'local' | 'amber'>('local');
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
  const [postRideSponsorMode, setPostRideSponsorMode] = useState(false);
  const [sponsorTitle, setSponsorTitle] = useState('');
  const [sponsorDesc, setSponsorDesc] = useState('');
  const [sponsorReward, setSponsorReward] = useState('100');
  const [sponsorRadius, setSponsorRadius] = useState('25');
  const [sponsorLocation, setSponsorLocation] = useState<{ lat: number, lng: number } | null>(null);
  const [sponsorEndDays, setSponsorEndDays] = useState('30d');
  const [sponsorBot, setSponsorBot] = useState(ESCROW_PUBKEY); // Bikel Bot
  const [isManualBot, setIsManualBot] = useState(false);
  const [sponsorFreq, setSponsorFreq] = useState<'once' | 'daily' | 'hourly'>('daily');
  const [sponsorLimit, setSponsorLimit] = useState('100'); // Max zaps total
  const [isSponsoring, setIsSponsoring] = useState(false);
  const [isCampaign, setIsCampaign] = useState(false);
  const [sponsorStreak, setSponsorStreak] = useState(false);
  const [streakReward, setStreakReward] = useState('500');
  const [sponsorDays, setSponsorDays] = useState('3');
  const [setBonus, setSetBonus] = useState('0');
  const [rsvpRequired, setRsvpRequired] = useState(true);
  const [cpSetName, setCpSetName] = useState('');
  const [cpRouteIndex, setCpRouteIndex] = useState('0');

  // Wizard States
  const [isWizard, setIsWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [wizardPoints, setWizardPoints] = useState<any[]>([]); // { id, title, type: 'existing' | 'new', lat?, lng? }
  const [activeNewPoint, setActiveNewPoint] = useState<any | null>(null);
  const [isSelectingLocation, setIsSelectingLocation] = useState(false);
  const [trimTails, setTrimTails] = useState(true);
  const [shareToFeed, setShareToFeed] = useState(false);
  const [shareToChat, setShareToChat] = useState(false);
  const [postRideDate, setPostRideDate] = useState(new Date());
  const [postRideTime, setPostRideTime] = useState(new Date());
  const [postRideLocation, setPostRideLocation] = useState('');
  const [showPostRideDate, setShowPostRideDate] = useState(false);
  const [showPostRideTime, setShowPostRideTime] = useState(false);
  // Draft being reviewed in post modal
  const [postingFromDraft, setPostingFromDraft] = useState<RideDraft | null>(null);

  const [isSelectingPostRideLocation, setIsSelectingPostRideLocation] = useState(false);
  const [isSelectingSchedRideLocation, setIsSelectingSchedRideLocation] = useState(false);
  const [nwcURI, setNwcURI] = useState('');
  const [isNWCConnected, setIsNWCConnected] = useState(false);
  const [isZapping, setIsZapping] = useState(false);
  const [deletingRideId, setDeletingRideId] = useState<string | null>(null);

  const [showDiscussion, setShowDiscussion] = useState(false);
  const [selectedDiscussionRide, setSelectedDiscussionRide] = useState<RideEvent | ScheduledRideEvent | null>(null);
  const [joinedIds, setJoinedIds] = useState<Set<string>>(new Set());
  const [comments, setComments] = useState<RideComment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [isPublishingComment, setIsPublishingComment] = useState(false);
  const [globalMessages, setGlobalMessages] = useState<NDKEvent[]>([]);
  const [approvedBots, setApprovedBots] = useState<ApprovedBot[]>([{ name: 'Bikel Bot', pubkey: ESCROW_PUBKEY }]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [showSocialOverlay, setShowSocialOverlay] = useState(false);
  const [socialTab, setSocialTab] = useState<'chat' | 'activity'>('chat');
  const [newChatText, setNewChatText] = useState('');
  const [isSendingChat, setIsSendingChat] = useState(false);

  const [globalComments, setGlobalComments] = useState<RideComment[]>([]);
  const [reactions, setReactions] = useState<Record<string, ReactionSummary[]>>({});
  const [expandedComments, setExpandedComments] = useState<Record<string, boolean>>({});
  const [reactingId, setReactingId] = useState<string | null>(null);

  const [selectedMapRide, setSelectedMapRide] = useState<RideEvent | null>(null);
  const [selectedMapGroup, setSelectedMapGroup] = useState<GroupedCheckpoint | null>(null);
  const [activeDMUser, setActiveDMUser] = useState<string | null>(null);
  const [dmMessages, setDmMessages] = useState<DMessage[]>([]);
  const [newDMText, setNewDMText] = useState('');
  const [isSendingDM, setIsSendingDM] = useState(false);
  const [backToSocialHub, setBackToSocialHub] = useState(false);
  const [discussionFromSocial, setDiscussionFromSocial] = useState(false);
  const socialScrollRef = useRef<any>(null);
  const socialCardOffsets = useRef<Record<string, number>>({});

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

  // Scroll chat to bottom when new messages arrive
  useEffect(() => {
    if (globalMessages.length > 0 && chatScrollRef.current) {
      setTimeout(() => chatScrollRef.current?.scrollToEnd({ animated: false }), 100);
    }
  }, [globalMessages.length]);

  const [schedName, setSchedName] = useState('');
  const [schedDesc, setSchedDesc] = useState('');
  const [schedImage, setSchedImage] = useState('');
  const [isUploadingSchedPhoto, setIsUploadingSchedPhoto] = useState(false);
  const [schedLocation, setSchedLocation] = useState('');
  const [schedType, setSchedType] = useState<'ride' | 'contest' | 'sponsor'>('ride');
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
  const mountedRef = useRef(true);
  const isSyncingRef = useRef(false);
  const pollerRef = useRef<NodeJS.Timeout | null>(null);
  const chatScrollRef = useRef<any>(null);
  const pendingPubkeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (selectedRoute.length > 0) setMapZoom(12);
    else setMapZoom(13);
  }, [selectedRoute.length]);

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
          // Always call start to ensure notification is visible on launch, 
          // but only stop/restart if forceRestart is explicitly true.
          if (isRunning && forceRestart) {
            await logEvent("🛑 Auto-detect reset (manual toggle)");
            await Location.stopLocationUpdatesAsync(DRAFT_TASK);
            await new Promise(r => setTimeout(r, 400));
          }

          if (!isRunning) await logEvent("🔄 Auto-detect starting...");
          else await logEvent("✅ Auto-detect sync: already running");

          // Android 12+ Restriction: Cannot start foreground service if app is not active.
          if (AppState.currentState !== 'active') {
            await logEvent("⚠️ Skipping foreground service refresh (app in background)");
            setAutoDetect(true);
            return;
          }

          if (!isRunning || forceRestart) {
            await Location.startLocationUpdatesAsync(DRAFT_TASK, {
              accuracy: Location.Accuracy.High,
              distanceInterval: 10,
              timeInterval: 5000,
              foregroundService: {
                notificationTitle: '🚴 Bikel auto-detect is active',
                notificationBody: 'Watching for bike rides in background…',
                notificationColor: '#444',
              },
              pausesUpdatesAutomatically: false,
              showsBackgroundLocationIndicator: false,
            });
          }
          setAutoDetect(true);
        } else {
          await logEvent(`⚠️ Auto-detect disabled (missing permission: ${bgPerm.status})`);
          await AsyncStorage.setItem('bikel_auto_detect', 'false');
          if (isRunning) await Location.stopLocationUpdatesAsync(DRAFT_TASK);
          setAutoDetect(false);
        }
      } else {
        if (isRunning) {
          if (!forceRestart) {
            // Healing: If it's running but state is unknown, sync UP instead of DOWN
            await logEvent("🩹 Auto-detect healing (found active ride)");
            await AsyncStorage.setItem('bikel_auto_detect', 'true');
            setAutoDetect(true);
          } else {
            await logEvent("🛑 Auto-detect cleanup (manual off)");
            await Location.stopLocationUpdatesAsync(DRAFT_TASK);
            setAutoDetect(false);
          }
        } else {
          setAutoDetect(false);
        }
      }
    } catch (e) { console.error('[Sync] Failed:', e); } finally {
      isSyncingRef.current = false;
    }
  };

  // ── Toggle auto-detect on/off ──────────────────────
  const toggleAutoDetect = async (value: boolean) => {
    setAutoDetect(value);
    await AsyncStorage.setItem('bikel_auto_detect', value ? 'true' : 'false');
    await syncAutoDetectState(true); // Pass true to force stop/start logic
  };


  // ── Mount ──────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;

    // 1. Initial State Hydration (Immediate)
    getPublicKeyHex().then(hex => { if (hex && mountedRef.current) setCurrentHex(hex); }).catch(() => { });

    // 2. Foreground Permission & Data Healing
    const appStateListener = AppState.addEventListener('change', async (status) => {
      if (status === 'active' && mountedRef.current) {
        await logEvent("📱 App active — syncing permissions & drafts");
        const { status: bgStatus } = await Location.getBackgroundPermissionsAsync();
        const autoSetting = await AsyncStorage.getItem('bikel_auto_detect');
        const isRunning = await Location.hasStartedLocationUpdatesAsync(DRAFT_TASK);

        if (bgStatus === 'granted' && autoSetting === 'true' && !isRunning) {
          await syncAutoDetectState(true);
        }
        await loadDrafts();
        fetchCheckpoints().then(setCheckpoints).catch(() => { });
      }
    });

    // 3. Staggered Background Initialization (Future-proofed replacement for deprecated InteractionManager)
    const initStagger = setTimeout(async () => {
      if (!mountedRef.current) return;
      await logEvent("🚀 Interactive session ready — starting staggered background sync");

      try {
        const { status: locStatus } = await Location.requestForegroundPermissionsAsync();
        if (locStatus === 'granted') {
          const { status: bgStatus } = await Location.getBackgroundPermissionsAsync();
          if (bgStatus !== 'granted') Location.requestBackgroundPermissionsAsync().catch(() => {});
          
          const lastKnown = await Location.getLastKnownPositionAsync({});
          if (lastKnown && mountedRef.current) {
            setLocation(lastKnown);
            setMapCenter({ lat: lastKnown.coords.latitude, lng: lastKnown.coords.longitude });
          }
        }
      } catch (e) {}

      await connectNDK();
      if (mountedRef.current) {
        loadFeeds();
        loadDrafts();
        syncAutoDetectState(false);
      }

      const secondaryStagger = setTimeout(async () => {
        if (!mountedRef.current) return;
        const { status: nStatus } = await Notifications.getPermissionsAsync();
        if (nStatus !== 'granted') Notifications.requestPermissionsAsync().catch(() => {});

        try {
          const savedNwc = await SecureStore.getItemAsync('bikel_nwc_uri');
          if (savedNwc) {
            setNwcURI(savedNwc);
            connectNWC(savedNwc).then(success => {
              if (success && mountedRef.current) setIsNWCConnected(true);
            }).catch(() => { });
          }
        } catch (e) {}
      }, 5000);

      return () => clearTimeout(secondaryStagger);
    }, 1000);

    // 4. Cleanup
    return () => {
      mountedRef.current = false;
      appStateListener.remove();
      clearTimeout(initStagger);
      if (pollerRef.current) {
        clearInterval(pollerRef.current);
        pollerRef.current = null;
      }
    };
  }, []);

  // ── Hardware Back Button Handling ──────────────────
  useEffect(() => {
    const onBackPress = () => {
      // DMs (Inner view)
      if (activeDMUser) { setActiveDMUser(null); return true; }

      // Discussion (Inner view)
      if (showDiscussion) {
        setShowDiscussion(false);
        setDiscussionFromSocial(false);
        return true;
      }

      // Author Profile (Inner view)
      if (viewingAuthor) { setViewingAuthor(null); return true; }

      // Content Leaderboard (Inner view)
      if (selectedContest) { setSelectedContest(null); return true; }

      // Post Ride / Draft Review (Modals)
      if (showPostRideModal) {
        setShowPostRideModal(false);
        if (postingFromDraft) {
          setPostingFromDraft(null);
          setFeedTab('drafts');
          setShowFeed(true); // Return to drafts list
        }
        return true;
      }
      if (selectedDraft) { setSelectedDraft(null); return true; }

      // Settings / History / Schedule / Feed (Top-level views)
      if (showLogs) { setShowLogs(false); return true; }
      if (showSettings) { setShowSettings(false); return true; }
      if (showHistory) { setShowHistory(false); return true; }
      if (showSchedule) { setShowSchedule(false); return true; }
      if (showFeed) { setShowFeed(false); return true; }
      if (showSocialOverlay) { setShowSocialOverlay(false); return true; }

      // Ride Detail Card (Map overlay) - checked last so it reappears when overlays close
      if (selectedMapRide) {
        setSelectedMapRide(null);
        if (backToSocialHub) {
          setBackToSocialHub(false);
          setShowSocialOverlay(true);
        }
        return true;
      }

      // Route Preview (Map layer)
      if (selectedRoute.length > 0) { setSelectedRoute([]); return true; }

      // If none of the above are active, allow default behavior (exit app)
      return false;
    };

    const backHandler = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => backHandler.remove();
  }, [activeDMUser, showDiscussion, viewingAuthor, selectedRoute, selectedContest, showPostRideModal, selectedDraft, showSettings, showHistory, showSchedule, showFeed, showLogs, selectedMapRide, showSocialOverlay, backToSocialHub]);

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
      (r.confidence === undefined || r.confidence >= 0.5)
    );
  }, [globalRides]);

  const groupedCheckpoints = useMemo(() => {
    const groups: { [key: string]: GroupedCheckpoint } = {};
    const now = Math.floor(Date.now() / 1000);

    checkpoints.forEach(cp => {
      // 1. Filter out expired checkpoints
      if (cp.endTime && cp.endTime < now) return;

      // 2. Grouping precision: 6 decimal places (~11cm)
      const lat = parseFloat(cp.location.lat.toFixed(6));
      const lng = parseFloat(cp.location.lng.toFixed(6));
      const key = `${lat},${lng}`;

      if (!groups[key]) {
        groups[key] = {
          id: `group_${key}`,
          lat,
          lng,
          events: []
        };
      }
      groups[key].events.push(cp);
    });

    return Object.values(groups);
  }, [checkpoints, activeContests]);

  const mapMarkers = useMemo(() => {
    const markers: any[] = location ? [{
      id: 'current_pos',
      position: { lat: location.coords.latitude, lng: location.coords.longitude },
      icon: '🚴',
      size: [32, 32]
    }] : [];

    // 2. Click detection for POI groups is now handled by coordinate hit-testing in ON_MAP_TOUCHED.
    // This avoids misleading clustering (green/yellow bubbles).
    return markers;
  }, [location, groupedCheckpoints]);

  useEffect(() => {
    if (!location || checkpoints.length === 0) return;

    // Check for nearby checkpoints
    let nearest: { cp: CheckpointEvent; distance: number } | null = null;
    const now = Date.now() / 1000;
    for (const cp of checkpoints) {
      // Filter out expired checkpoints
      if (cp.endTime && cp.endTime < now) continue;

      const dist = distanceMiles(location.coords.latitude, location.coords.longitude, cp.location.lat, cp.location.lng) * 1609.34; // to meters
      if (!nearest || dist < nearest.distance) {
        nearest = { cp, distance: dist };
      }
    }

    if (nearest && nearest.distance < 1000) {
      if (!nearestCheckpoint || nearestCheckpoint.cp.id !== nearest.cp.id || Math.abs(nearestCheckpoint.distance - nearest.distance) > 5) {
        setNearestCheckpoint(nearest);

        // Radius trigger (Ding!)
        const radius = nearest.cp.radius || 20;
        if (nearest.distance <= radius && (!nearestCheckpoint || nearestCheckpoint.distance > radius)) {
          logEvent(`🎯 [HUD] Checkpoint Hit: ${nearest.cp.title}`);
          setSessionCheckpointHit(nearest.cp.id);
          Notifications.scheduleNotificationAsync({
            content: {
              title: '🎯 Checkpoint Found!',
              body: `You've reached "${nearest.cp.title}"! Bikel-bot is verifying your visit... ⚡`,
              data: { type: 'checkpoint' },
            },
            trigger: null,
          });
        }
      }
    } else if (nearestCheckpoint) {
      setNearestCheckpoint(null);
    }
  }, [location, checkpoints]);

  // Group activity feed comments by the event they reference.
  // This lets us show nested comments under ride/post cards without extra relay queries.
  const commentsByEventId = useMemo(() => {
    const map: Record<string, RideComment[]> = {};
    globalComments.forEach(c => {
      if (!c.isRide && c.rideId) {
        if (!map[c.rideId]) map[c.rideId] = [];
        map[c.rideId].push(c);
      }
    });
    // Sort each thread oldest-first
    Object.values(map).forEach(arr => arr.sort((a, b) => a.createdAt - b.createdAt));
    return map;
  }, [globalComments]);

  const mapShapes = useMemo(() => {
    const shapes: any[] = [];

    // 1. Draw all global rides first (bottom layers)
    // LIMIT to top 300 recent rides to ensure Map fluidity on mobile.
    filteredGlobalRides.slice(0, 300).forEach(ride => {
      if (!ride.route || ride.route.length === 0) return;

      const { color, opacity } = rideAgeColor(ride.time);
      // Main polyline
      shapes.push({
        id: `ride_${ride.id}`,
        shapeType: MapShapeType.POLYLINE,
        positions: ride.route.map(pt => ({
          lat: parseFloat(pt[0] as any),
          lng: parseFloat(pt[1] as any)
        })).filter(p => !isNaN(p.lat) && !isNaN(p.lng)),
        color: color,
        width: 3,
        opacity: opacity,
      });

      // Small start circle for visibility (Web style)
      const startPt = ride.route[0];
      if (startPt && startPt.length >= 2) {
        shapes.push({
          id: `ride_start_v_${ride.id}`,
          shapeType: MapShapeType.CIRCLE_MARKER,
          center: {
            lat: parseFloat(startPt[0] as any),
            lng: parseFloat(startPt[1] as any)
          },
          color: color,
          radius: 3,
        });
      }
    });

    // 3. Draw POI Circles (Replacement for emojis)
    groupedCheckpoints.forEach(group => {
      const isHunt = group.events.some(e => !!e.set);
      shapes.push({
        id: group.id,
        shapeType: MapShapeType.CIRCLE_MARKER,
        center: { lat: group.lat, lng: group.lng },
        color: isHunt ? "#ff33a1" : "#a855f7",
        radius: 12, // Larger circles for visual impact
        opacity: 0.8,
      });
    });

    // 4. Draw Selected Route (Preview/High Visibility) - Draw on top
    if (selectedRoute && selectedRoute.length > 0) {
      shapes.push({
        id: 'selected_route_line',
        shapeType: MapShapeType.POLYLINE,
        positions: selectedRoute,
        color: "#00ccff",
        width: 6,
        opacity: 1,
      });

      // Selected Start Marker
      shapes.push({
        id: 'selected_start',
        shapeType: MapShapeType.CIRCLE_MARKER,
        center: selectedRoute[0],
        color: "#00ffaa", // Neon Green
        radius: 8,
        opacity: 1,
      });

      // Selected End Marker
      shapes.push({
        id: 'selected_end',
        shapeType: MapShapeType.CIRCLE_MARKER,
        center: selectedRoute[selectedRoute.length - 1],
        color: "#ff4d4f", // Neon Red
        radius: 8,
        opacity: 1,
      });
    }

    return shapes;
  }, [selectedRoute, filteredGlobalRides, groupedCheckpoints]);

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
    // 1. Deduplicate against existing profiles AND pending requests
    const toFetch = [...new Set(pubkeys)].filter(pk => !profiles[pk] && !pendingPubkeysRef.current.has(pk));
    if (toFetch.length === 0) return;

    // 2. Mark as pending immediately
    toFetch.forEach(pk => pendingPubkeysRef.current.add(pk));

    try {
      const newProfiles = await fetchProfiles(toFetch);
      setProfiles(prev => ({ ...prev, ...newProfiles }));
    } catch (e) {
      console.error("Failed to load author profiles", e);
    } finally {
      // 3. Keep in pending for a bit (5s) to prevent immediate re-fetch if first one failed or is slow to propagate to state
      setTimeout(() => {
        toFetch.forEach(pk => pendingPubkeysRef.current.delete(pk));
      }, 5000);
    }
  };


  const loadReactions = async (eventId: string) => {
    try {
      const r = await fetchReactions(eventId);
      setReactions(prev => ({ ...prev, [eventId]: r }));
    } catch (e) { console.warn('Failed to load reactions:', e); }
  };

  // ── Profile Auto-Sync into Settings Fields ───────────────────
  // This ensures that when the user's profile is fetched (or arrives late)
  // it automatically populates the Edit Profile fields in Settings.
  useEffect(() => {
    if (showSettings && currentHex && profiles[currentHex]) {
      const p = profiles[currentHex];
      if (p.name && !editName) setEditName(p.name);
      if (p.about && !editAbout) setEditAbout(p.about);
      if (p.picture && !editPicture) setEditPicture(p.picture);
      if (p.nip05 && !editNip05) setEditNip05(p.nip05);
      if (p.lud16 && !editLud16) setEditLud16(p.lud16);
    }
  }, [showSettings, currentHex, profiles, editName, editAbout, editPicture, editNip05, editLud16]);

  const loadEssentialFeeds = async () => {
    if (isFeedLoading) return;
    setIsFeedLoading(true);
    setLoadingStatus('RIDES');

    try {
      // 1. Recent Rides (STREAMING LOAD)
      fetchRecentRides((incrementalRides) => {
        if (incrementalRides.length > 0) {
          setGlobalRides(prev => {
            const obj: { [key: string]: RideEvent } = {};
            prev.forEach(r => obj[r.id] = r);
            incrementalRides.forEach(r => obj[r.id] = r);
            return Object.values(obj).sort((a, b) => b.time - a.time);
          });
          setLoadingStatus('');
          const topPubkeys = incrementalRides.slice(0, 10).map(ride => ride.hexPubkey || ride.pubkey);
          loadAuthorProfiles(topPubkeys).catch(() => { });
        }
      }).then(finalRides => {
        if (finalRides.length > 0) {
          setGlobalRides(prev => {
            const obj: { [key: string]: RideEvent } = {};
            prev.forEach(r => obj[r.id] = r);
            finalRides.forEach(r => obj[r.id] = r);
            return Object.values(obj).sort((a, b) => b.time - a.time);
          });
          const topPubkeys = finalRides.slice(0, 30).map(ride => ride.hexPubkey || ride.pubkey);
          loadAuthorProfiles(topPubkeys).catch(() => { });
        }
      }).catch(() => { });

      // ── Micro-Staggering: 500ms gaps between streams ───────────
      await new Promise(r => setTimeout(r, 600));

      // 2. Scheduled Rides
      if (mountedRef.current) fetchScheduledRides().then(r => {
        setScheduledRides(prev => {
          const obj: { [key: string]: ScheduledRideEvent } = {};
          prev.forEach(s => obj[s.id] = s);
          r.forEach(s => obj[s.id] = s);
          return Object.values(obj).sort((a, b) => a.startTime - b.startTime);
        });
        loadAuthorProfiles(r.map(s => s.hexPubkey || s.pubkey)).catch(() => { });
      }).catch(() => { });

      fetchContests((incremental) => {
        if (incremental.length > 0) {
          setActiveContests(prev => {
            const obj: { [key: string]: ContestEvent } = {};
            prev.forEach(c => obj[c.id] = c);
            incremental.forEach(c => obj[c.id] = c);
            return Object.values(obj).sort((a, b) => b.createdAt - a.createdAt);
          });
        }
      }).then(r => {
        setActiveContests(prev => {
          const obj: { [key: string]: ContestEvent } = {};
          prev.forEach(c => obj[c.id] = c);
          r.forEach(c => obj[c.id] = c);
          return Object.values(obj).sort((a, b) => b.createdAt - a.createdAt);
        });
        loadAuthorProfiles(r.map(c => c.hexPubkey || c.pubkey)).catch(() => { });
      }).catch(() => { });

      // 3. Checkpoints (Map POIs)
      fetchCheckpoints((incremental) => {
        if (incremental.length > 0) {
          setCheckpoints(prev => {
            const obj: { [key: string]: CheckpointEvent } = {};
            prev.forEach(cp => obj[cp.id] = cp);
            incremental.forEach(cp => obj[cp.id] = cp);
            return Object.values(obj).sort((a, b) => b.rewardSats - a.rewardSats);
          });
        }
      }).then(setCheckpoints).catch(() => { });

      // 4. Fetch User RSVPs (to show "JOINED")
      getPublicKeyHex().then(async (hex) => {
        if (!hex) return;
        try {
          const ndk = await connectNDK();
          const rsvps = await fetchEventsWithTimeout(ndk, [{ kinds: [31925 as any], authors: [hex], '#t': ['bikel-rsvp'] }], 4000);
          const ids = new Set<string>();
          rsvps.forEach(ev => {
            const aTag = ev.getMatchingTags('a')[0]?.[1];
            if (aTag) ids.add(aTag);
            const eTag = ev.getMatchingTags('e')[0]?.[1];
            if (eTag) (ids as any).add(eTag);
          });
          setJoinedIds(ids);
        } catch (e) { }
      }).catch(() => { });

    } catch (e) {
      console.error("Error in loadEssentialFeeds:", e);
    } finally {
      setIsFeedLoading(false);
    }
  };

  const loadSocialFeeds = async () => {
    if (isSocialLoading) return;
    setIsSocialLoading(true);
    logEvent("🔄 Social Refresh: starting...");
    try {
      fetchAllBikelSocial((comms) => {
        if (comms && comms.length > 0) {
          setGlobalComments(comms);
          loadAuthorProfiles(comms.slice(0, 15).map(c => c.pubkey)).catch(() => { });
        }
      }, []).catch(() => { });
    } catch (e) {
      console.error("Error in loadSocialFeeds:", e);
    } finally {
      setIsSocialLoading(false);
    }
  };

  const loadHistoryFeeds = async () => {
    if (isHistoryLoading) return;
    setIsHistoryLoading(true);
    logEvent("🔄 History Refresh: starting...");
    try {
      fetchMyRides().then(r => {
        setMyRides(prev => {
          const obj: { [key: string]: RideEvent } = {};
          prev.forEach(ride => obj[ride.id] = ride);
          r.forEach(ride => obj[ride.id] = ride);
          return Object.values(obj).sort((a, b) => b.time - a.time);
        });
      }).catch(() => { });

      fetchMyClaims().then(setMyClaims).catch(() => { });
    } catch (e) {
      console.error("Error in loadHistoryFeeds:", e);
    } finally {
      setIsHistoryLoading(false);
    }
  };

  const loadFeeds = loadEssentialFeeds;

  const handleRefreshFeeds = async () => {
    setIsRefreshing(true);
    await loadDrafts();
    try {
      await Promise.race([
        loadFeeds(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Network timeout')), 30000))
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

  const handleSocialRefresh = async () => {
    if (isSocialLoading) return;
    await logEvent(`🔄 Social Refresh: ${socialTab} (Starting)`);
    setIsSocialLoading(true);
    try {
      if (socialTab === 'chat') {
        const msgs = await fetchChannelMessages();
        await logEvent(`📥 Chat: fetched ${msgs.length} messages`);
        setGlobalMessages(msgs);
        loadAuthorProfiles(msgs.map(m => m.pubkey).filter(Boolean) as string[]).catch(console.error);
      } else {
        const rideIds = globalRides.slice(0, 20).map(r => r.id);
        fetchAllBikelSocial((comms) => {
          const sliced = comms.slice(0, 150);
          setGlobalComments(sliced);
          loadAuthorProfiles(sliced.map((c: RideComment) => c.pubkey).filter(Boolean) as string[]).catch(console.error);

          // Staggered reaction load for visible items
          sliced.slice(0, 10).forEach((item: RideComment, i: number) => {
            setTimeout(() => loadReactions(item.id), i * 150);
          });
        }, rideIds).then(() => {
          setIsSocialLoading(false);
        }).catch(() => {
          setIsSocialLoading(false);
        });
        return; // handleSocialRefresh is now handled via the promise/callback
      }
    } catch (e: any) {
      const err = e.message || String(e);
      await logEvent(`❌ Social refresh error: ${err}`);
      console.error("Social refresh failed:", e);
    }
    setIsSocialLoading(false);
  }

  // ── Social Refresh Triggers ────────────────────
  // These must be defined AFTER handleSocialRefresh (const functions are not hoisted)
  useEffect(() => {
    if (showSocialOverlay) {
      handleSocialRefresh();
    }
  }, [showSocialOverlay, socialTab]);

  // Activity feed is now pre-loaded in loadFeeds() — no separate trigger needed

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
          accuracy: Location.Accuracy.High,
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
        const err = e?.message || 'Unknown error';
        await logEvent(`❌ [Tracking] Failed to start: ${err}`);
        console.error('[Tracking] Failed to start:', e);
        Alert.alert("Could Not Start Tracking", `Error: ${err}.`);
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
          zoom={mapZoom}
          mapLayers={MAP_LAYERS}
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
                  setSelectedMapGroup(null);
                  setSelectedRoute(ride.route.map(pt => ({ lat: pt[0], lng: pt[1] })));
                }
              } else if (idStr && idStr.startsWith('cp_target_')) {
                const groupId = idStr.replace('cp_target_', '');
                const group = groupedCheckpoints.find(g => g.id === groupId);
                if (group) {
                  setSelectedMapGroup(group);
                  setSelectedMapRide(null);
                }
              } else if (idStr && idStr.startsWith('cp_')) {
                // Legacy / single point fallback
                const cpId = idStr.replace('cp_', '');
                const cp = checkpoints.find(c => c.id === cpId);
                if (cp) {
                  setSelectedMapGroup(groupedCheckpoints.find(g => Math.abs(g.lat - cp.location.lat) < 0.0001 && Math.abs(g.lng - cp.location.lng) < 0.0001) || null);
                  setSelectedMapRide(null);
                }
              }
            } else if (message.event === WebViewLeafletEvents.ON_MAP_TOUCHED) {
              const touch = message.payload?.touchLatLng;
              if (touch) {
                if (isSelectingLocation) {
                  if (activeNewPoint) {
                    // Scavenger Hunt Wizard Mode
                    const newPt = {
                      id: 'new_' + Date.now(),
                      title: `Checkpoint ${wizardPoints.length + 1}`,
                      lat: touch.lat,
                      lng: touch.lng,
                      type: 'new'
                    };
                    setWizardPoints(prev => [...prev, newPt]);
                    setActiveNewPoint(null);
                  } else {
                    // Single POI Mode
                    setSponsorLocation(touch);
                  }
                  setIsSelectingLocation(false);
                  if (schedType === 'sponsor') setShowSchedule(true);
                  else setShowPostRideModal(true);
                  return;
                }

                if (isSelectingPostRideLocation) {
                  setPostRideLocation(`${touch.lat.toFixed(5)}, ${touch.lng.toFixed(5)}`);
                  setIsSelectingPostRideLocation(false);
                  setShowPostRideModal(true);
                  // Reverse geocode
                  Location.reverseGeocodeAsync({ latitude: touch.lat, longitude: touch.lng })
                    .then(addr => {
                      if (addr.length > 0) {
                        const a = addr[0];
                        const str = [a.name, a.street, a.city].filter(Boolean).join(', ');
                        if (str) setPostRideLocation(str);
                      }
                    }).catch(err => {
                      console.warn('[MapTap] Reverse geocoding failed:', err);
                    });
                  return;
                }

                if (isSelectingSchedRideLocation) {
                  setSchedLocation(`${touch.lat.toFixed(5)}, ${touch.lng.toFixed(5)}`);
                  setIsSelectingSchedRideLocation(false);
                  setShowSchedule(true);
                  // Reverse geocode
                  Location.reverseGeocodeAsync({ latitude: touch.lat, longitude: touch.lng })
                    .then(addr => {
                      if (addr.length > 0) {
                        const a = addr[0];
                        const str = [a.name, a.street, a.city].filter(Boolean).join(', ');
                        if (str) setSchedLocation(str);
                      }
                    }).catch(err => {
                      console.warn('[MapTap] Reverse geocoding failed:', err);
                    });
                  return;
                }

                // POI Hit-testing (Approx 60 meters for comfortable mobile tap)
                const hitGroup = groupedCheckpoints.find(g =>
                  distanceMiles(touch.lat, touch.lng, g.lat, g.lng) * 1609.34 < 60
                );
                if (hitGroup) {
                  setSelectedMapGroup(hitGroup);
                  setSelectedMapRide(null);
                  return;
                }
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
                  setSelectedMapGroup(null);
                  setSelectedRoute(nearestRide.route.map(pt => ({ lat: pt[0], lng: pt[1] })));
                }
              }
            }
          }}
        />
      </View>

      {/* Map Picker Selection Hint */}
      {(isSelectingLocation || isSelectingPostRideLocation || isSelectingSchedRideLocation) && (
        <View style={{ position: 'absolute', top: 100, left: 20, right: 20, backgroundColor: 'rgba(0,0,0,0.8)', padding: 15, borderRadius: 12, borderWidth: 1, borderColor: (isSelectingPostRideLocation || isSelectingSchedRideLocation) ? '#00ffaa' : '#eab308', alignItems: 'center', zIndex: 2000 }}>
          <Text style={{ color: (isSelectingPostRideLocation || isSelectingSchedRideLocation) ? '#00ffaa' : '#eab308', fontWeight: 'bold', fontSize: 16, marginBottom: 8 }}>Select Location</Text>
          <Text style={{ color: '#ccc', textAlign: 'center', marginBottom: 12 }}>Tap anywhere on the map to set the meeting point.</Text>
          <TouchableOpacity
            style={{ backgroundColor: 'rgba(255,255,255,0.1)', paddingHorizontal: 20, paddingVertical: 8, borderRadius: 20 }}
            onPress={() => {
              setIsSelectingLocation(false);
              setIsSelectingPostRideLocation(false);
              setIsSelectingSchedRideLocation(false);
              if (schedType === 'sponsor') setShowSchedule(true);
              else if (isSelectingSchedRideLocation) setShowSchedule(true);
              else setShowPostRideModal(true);
            }}
          >
            <Text style={{ color: '#fff', fontWeight: 'bold' }}>CANCEL</Text>
          </TouchableOpacity>
        </View>
      )}

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

      {/* Checkpoint Detail Overlay */}
      {selectedMapGroup && !showFeed && !showDiscussion && !activeDMUser && !viewingAuthor && !showSettings && !showHistory && !showSchedule && !showPostRideModal && !showSocialOverlay && (
        <View style={{ position: 'absolute', bottom: 100, left: 15, right: 15, backgroundColor: 'rgba(22, 26, 31, 1)', borderRadius: 20, padding: 16, borderWidth: 1, borderColor: 'rgba(255, 51, 161, 0.4)', shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.6, shadowRadius: 20, elevation: 20, zIndex: 1000, maxHeight: Dimensions.get('window').height * 0.38 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={{ width: 4, height: 16, backgroundColor: '#ff33a1', borderRadius: 2 }} />
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: 0.5 }}>{selectedMapGroup.events.length} Rewards Active</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <TouchableOpacity
                onPress={() => {
                  setMapCenter({ lat: selectedMapGroup.lat - POI_LAT_OFFSET, lng: selectedMapGroup.lng });
                  setMapZoom(18);
                }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  backgroundColor: 'rgba(255, 51, 161, 0.1)',
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: 'rgba(255, 51, 161, 0.3)'
                }}
              >
                <LocateFixed size={14} color="#ff33a1" />
                <Text style={{ color: '#ff33a1', fontSize: 11, fontWeight: 'bold' }}>CENTER</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setSelectedMapGroup(null)} style={{ padding: 4 }}>
                <X color="#666" size={20} />
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 10 }}>
            {(() => {
              const groupedInOverlay: { type: 'set' | 'standalone', name?: string, items?: any[], item?: any }[] = [];
              const setGroups: Record<string, any[]> = {};

              selectedMapGroup.events.forEach(cp => {
                const s = cp.set;
                if (s) {
                  if (!setGroups[s]) {
                    setGroups[s] = [];
                    groupedInOverlay.push({ type: 'set', name: s, items: setGroups[s] });
                  }
                  setGroups[s].push(cp);
                } else {
                  groupedInOverlay.push({ type: 'standalone', item: cp });
                }
              });

              return groupedInOverlay.map((group, gIdx) => {
                if (group.type === 'standalone') {
                  const cp = group.item;
                  const themeColor = '#a855f7';
                  return (
                    <View key={cp.id} style={{ marginBottom: 16, padding: 12, borderRadius: 12, backgroundColor: 'rgba(168, 85, 247, 0.05)', borderLeftWidth: 3, borderLeftColor: themeColor }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: themeColor, fontWeight: '800', fontSize: 10, textTransform: 'uppercase', marginBottom: 4 }}>SPONSORED POI</Text>
                          <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 16 }}>{cp.title}</Text>
                          <Text style={{ color: '#aaa', fontSize: 13, marginTop: 4, lineHeight: 18 }}>{cp.description}</Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10, opacity: 0.8 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                              <Calendar size={12} color={themeColor} />
                              <Text style={{ color: '#bbb', fontSize: 11 }}>
                                {format(new Date(cp.startTime * 1000), 'MMM d, h:mm a')} — {format(new Date(cp.endTime * 1000), 'MMM d, h:mm a')}
                              </Text>
                            </View>
                            {cp.frequency && cp.frequency !== 'once' && (
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.05)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                                <Clock size={10} color={themeColor} />
                                <Text style={{ color: themeColor, fontSize: 10, fontWeight: 'bold' }}>{cp.frequency.toUpperCase()}</Text>
                              </View>
                            )}
                          </View>
                        </View>
                        <View style={{ alignItems: 'flex-end', marginLeft: 12 }}>
                          <Text style={{ color: themeColor, fontWeight: 'bold', fontSize: 18 }}>{cp.rewardSats}</Text>
                          <Text style={{ color: themeColor, fontSize: 10, fontWeight: 'bold' }}>SATS</Text>
                        </View>
                      </View>

                      {cp.rsvp === 'required' && (
                        <TouchableOpacity
                          style={{ backgroundColor: themeColor, paddingVertical: 10, borderRadius: 8, alignItems: 'center', marginTop: 12 }}
                          onPress={async () => { setIsZapping(true); const success = await publishRSVP(cp.id, cp.hexPubkey); setIsZapping(false); if (success) Alert.alert("Joined!"); }}
                        >
                          <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 13 }}>JOIN POI</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                } else {
                   const items = group.items!;
                  const firstItem = items[0];
                  const streakReward = firstItem.streakReward || 0;
                  const rsvpRequired = items.some(i => i.rsvp === 'required');
                  const aTag = `${firstItem.kind || 33402}:${firstItem.hexPubkey}:${firstItem.dTag}`;
                  const isJoined = joinedIds.has(firstItem.id) || joinedIds.has(aTag);

                  return (
                    <View key={group.name} style={{ marginBottom: 16, padding: 12, borderRadius: 12, backgroundColor: 'rgba(255, 51, 161, 0.05)', borderLeftWidth: 3, borderLeftColor: '#ff33a1' }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                        <View style={{ flex: 1 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            <Text style={{ color: '#ff33a1', fontSize: 10, fontWeight: '800', textTransform: 'uppercase' }}>SCAVENGER HUNT</Text>
                            {isJoined && <View style={{ backgroundColor: 'rgba(0, 255, 170, 0.1)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}><Text style={{ color: '#00ffaa', fontSize: 9, fontWeight: 'bold' }}>JOINED</Text></View>}
                          </View>
                          <Text style={{ color: '#fff', fontSize: 18, fontWeight: 'bold' }}>{group.name}</Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6, opacity: 0.8 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                              <Calendar size={12} color="#ff33a1" />
                              <Text style={{ color: '#bbb', fontSize: 11 }}>
                                {format(new Date(firstItem.startTime * 1000), 'MMM d, p')} — {format(new Date(firstItem.endTime * 1000), 'MMM d, p')}
                              </Text>
                            </View>
                            {firstItem.frequency && firstItem.frequency !== 'once' && (
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,51,161,0.1)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                                <Clock size={10} color="#ff33a1" />
                                <Text style={{ color: '#ff33a1', fontSize: 10, fontWeight: 'bold' }}>{firstItem.frequency.toUpperCase()}</Text>
                              </View>
                            )}
                          </View>
                        </View>
                        {!isJoined && rsvpRequired && (
                          <TouchableOpacity
                            style={{ backgroundColor: '#ff33a1', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 }}
                            onPress={async () => {
                              setIsZapping(true);
                              const success = await publishRSVP(firstItem.id, firstItem.event.pubkey);
                              setIsZapping(false);
                              if (success) {
                                Alert.alert("Joined!", "Successfully joined! 🚲🔥");
                                setJoinedIds(prev => {
                                  const next = new Set(prev);
                                  next.add(firstItem.id);
                                  next.add(aTag);
                                  return next;
                                });
                              }
                            }}
                          >
                            <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 13 }}>JOIN</Text>
                          </TouchableOpacity>
                        )}
                      </View>

                      {items.map((cp, idx) => (
                        <View key={cp.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderTopWidth: idx === 0 ? 0 : 1, borderTopColor: 'rgba(255, 51, 161, 0.1)' }}>
                          <View style={{ flex: 1 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                              <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(255, 51, 161, 0.2)', alignItems: 'center', justifyContent: 'center' }}>
                                <Text style={{ color: '#ff33a1', fontSize: 10, fontWeight: 'bold' }}>{(cp.routeIndex !== undefined ? cp.routeIndex : idx) + 1}</Text>
                              </View>
                              <Text style={{ color: '#eee', fontWeight: 'bold', fontSize: 14 }}>{cp.title}</Text>
                            </View>
                            <Text style={{ color: '#888', fontSize: 11, marginTop: 2, marginLeft: 26 }}>{cp.description}</Text>
                          </View>
                          <Text style={{ color: '#ff33a1', fontWeight: 'bold', fontSize: 14, marginLeft: 12 }}>{cp.rewardSats} sats</Text>
                        </View>
                      ))}

                      {streakReward > 0 && (
                        <View style={{ marginTop: 10, padding: 10, backgroundColor: 'rgba(0,255,170,0.05)', borderRadius: 8, borderColor: 'rgba(0,255,170,0.1)', borderWidth: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <View>
                            <Text style={{ color: '#00ccff', fontWeight: 'bold', fontSize: 10 }}>⚡ STREAK BONUS</Text>
                            <Text style={{ color: '#999', fontSize: 10, marginTop: 1 }}>{firstItem.streakDays || 5} days visit in a row.</Text>
                          </View>
                          <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 14 }}>{streakReward} sats</Text>
                        </View>
                      )}
                    </View>
                  );
                }
              });
            })()}
          </ScrollView>

          <TouchableOpacity
            style={{ backgroundColor: 'rgba(255,255,255,0.05)', paddingVertical: 12, borderRadius: 12, alignItems: 'center', marginTop: 12 }}
            onPress={() => setSelectedMapGroup(null)}
          >
            <Text style={{ color: '#666', fontWeight: 'bold', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>DISMISS</Text>
          </TouchableOpacity>
        </View>
      )}

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
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold', textAlign: 'center' }}>{selectedMapRide.distance} mi</Text>
                <Text style={{ color: '#888', fontSize: 10, textAlign: 'center' }}>DISTANCE</Text>
              </View>
              <View style={{ flex: 1.2, backgroundColor: 'rgba(255,255,255,0.05)', padding: 10, borderRadius: 8, alignItems: 'center' }}>
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold', textAlign: 'center' }}>{selectedMapRide.duration}</Text>
                <Text style={{ color: '#888', fontSize: 10, textAlign: 'center' }}>TIME</Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.05)', padding: 10, borderRadius: 8, alignItems: 'center' }}>
                <Text style={{ color: '#00ccff', fontSize: 14, fontWeight: 'bold', textAlign: 'center' }}>
                  {selectedMapRide.rawDuration > 0 && parseFloat(selectedMapRide.distance) > 0
                    ? (parseFloat(selectedMapRide.distance) / (selectedMapRide.rawDuration / 3600)).toFixed(1)
                    : '0'}
                </Text>
                <Text style={{ color: '#888', fontSize: 10, textAlign: 'center' }}>AVG MPH</Text>
              </View>
              <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.05)', padding: 10, borderRadius: 8, alignItems: 'center' }}>
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold', textAlign: 'center' }}>{selectedMapRide.elevation || '--'}</Text>
                <Text style={{ color: '#888', fontSize: 10, textAlign: 'center' }}>ELEVATION (FT)</Text>
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
              style={{ paddingHorizontal: 12, backgroundColor: selectedMapRide?.route && selectedMapRide.route.length > 0 ? 'rgba(0,255,170,0.1)' : 'rgba(255,255,255,0.1)', paddingVertical: 10, borderRadius: 8, alignItems: 'center', minWidth: 80 }}
              onPress={() => {
                if (selectedMapRide?.route && selectedMapRide.route.length > 0) {
                  setMapCenter({ lat: selectedMapRide.route[0][0], lng: selectedMapRide.route[0][1] });
                }
              }}
            >
              {selectedMapRide?.route && selectedMapRide.route.length > 0 ? (
                <LocateFixed size={18} color="#00ffaa" />
              ) : (
                <Text style={{ color: '#888', fontWeight: 'bold', fontSize: 10 }}>DATA ONLY</Text>
              )}
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
          <TouchableOpacity onPress={() => {
            setShowPostRideModal(false); setPostingFromDraft(null); setSelectedMapRide(null);
            setShowSettings(false); setShowHistory(false); setShowFeed(false); setShowSocialOverlay(false);
            setSelectedContest(null);
            setShowSchedule(!showSchedule);
          }}>
            <CirclePlus size={24} color={showSchedule ? "#00ffaa" : "#fff"} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => {
            setShowPostRideModal(false); setPostingFromDraft(null); setSelectedMapRide(null);
            setShowSettings(false); setShowSchedule(false); setShowHistory(false); setShowFeed(false);
            setSelectedContest(null);
            const next = !showSocialOverlay;
            setShowSocialOverlay(next);
            if (next) loadSocialFeeds();
          }}>
            <MessageSquare size={24} color={showSocialOverlay ? "#00ffaa" : "#fff"} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => {
            setShowPostRideModal(false); setPostingFromDraft(null); setSelectedMapRide(null);
            setShowSettings(false); setShowSchedule(false); setShowHistory(false); setShowSocialOverlay(false);
            setSelectedContest(null);
            setShowFeed(!showFeed);
          }}>
            <Globe size={24} color={showFeed ? "#00ffaa" : "#fff"} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => {
            setShowPostRideModal(false); setPostingFromDraft(null); setSelectedMapRide(null);
            setShowSettings(false); setShowSchedule(false); setShowFeed(false); setShowSocialOverlay(false);
            setSelectedContest(null);
            const next = !showHistory;
            setShowHistory(next);
            if (next) loadHistoryFeeds();
          }}>
            <History size={24} color={showHistory ? "#00ffaa" : "#fff"} />
          </TouchableOpacity>

          <TouchableOpacity onPress={async () => {
            setShowPostRideModal(false); setPostingFromDraft(null); setSelectedMapRide(null);
            setShowHistory(false); setShowSchedule(false); setShowFeed(false); setShowSocialOverlay(false);
            setSelectedContest(null);
            if (!showSettings) {
              try {
                const nsec = await getPrivateKeyNsec();
                const npub = await getPublicKeyNpub();
                const hex = await getPublicKeyHex();
                const method = await SecureStore.getItemAsync(AUTH_METHOD_KEY) as 'local' | 'amber' || 'local';
                setAuthMethod(method);
                if (nsec) setCurrentNsec(nsec);
                if (npub) setCurrentNpub(npub);
                  if (hex) {
                    setCurrentHex(hex);
                    // 1. Trigger background fetch for latest profile
                    loadAuthorProfiles([hex]).catch(() => { });

                    // 2. Initial populate (if already cached) - subsequent sync handled by useEffect
                    const p = profiles[hex];
                    if (p) {
                      if (!editName) setEditName(p.name || '');
                      if (!editAbout) setEditAbout(p.about || '');
                      if (!editPicture) setEditPicture(p.picture || '');
                      if (!editNip05) setEditNip05(p.nip05 || '');
                      if (!editLud16) setEditLud16(p.lud16 || '');
                    }
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

            {/* Battery Optimization */}
            <View style={[styles.settingsSection, { borderColor: 'rgba(255,153,0,0.1)' }]}>
              <Text style={[styles.settingsLabel, { color: '#ff9900' }]}>BATTERY OPTIMIZATION (ANDROID)</Text>
              <Text style={{ color: '#9ba1a6', fontSize: 12, marginBottom: 12, lineHeight: 18 }}>
                Android may kill background recording to save power. For reliable auto-detect, set Bikel to "Unrestricted" or "Don't Optimize".
              </Text>
              <TouchableOpacity
                style={{ backgroundColor: 'rgba(255,153,0,0.1)', paddingVertical: 14, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,153,0,0.3)', alignItems: 'center' }}
                onPress={() => Linking.openSettings()}
              >
                <Text style={{ color: '#ff9900', fontWeight: 'bold', fontSize: 13 }}>🔍 CONFIGURE APP PERMISSIONS</Text>
              </TouchableOpacity>
              <Text style={{ color: '#666', fontSize: 10, marginTop: 10, textAlign: 'center' }}>
                Ensure "Location" is "Always" and "Notifications" are "ON".
              </Text>
            </View>

            <View style={styles.settingsSection}>
              <Text style={styles.settingsLabel}>AUTHENTICATION METHOD</Text>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
                <TouchableOpacity 
                  style={{ flex: 1, backgroundColor: authMethod === 'local' ? '#00ffaa' : 'rgba(255,255,255,0.05)', padding: 12, borderRadius: 10, alignItems: 'center' }}
                  onPress={async () => {
                    await useLocalSigner();
                    setAuthMethod('local');
                    const nsec = await getPrivateKeyNsec();
                    const npub = await getPublicKeyNpub();
                    if (nsec) setCurrentNsec(nsec);
                    if (npub) setCurrentNpub(npub);
                  }}
                >
                  <Text style={{ color: authMethod === 'local' ? '#000' : '#fff', fontWeight: 'bold' }}>LOCAL KEY</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={{ flex: 1, backgroundColor: authMethod === 'amber' ? '#00ffaa' : 'rgba(255,255,255,0.05)', padding: 12, borderRadius: 10, alignItems: 'center' }}
                  onPress={async () => {
                    try {
                      if (!NativeModules.AmberSignerModule) {
                        Alert.alert("Error", "Amber Signer module not found. Is this Android?");
                        return;
                      }
                      const rawPubkey = await NativeModules.AmberSignerModule.getPublicKey();
                      if (rawPubkey) {
                        let hex = rawPubkey;
                        if (hex.startsWith('npub1') || hex.startsWith('nprofile1')) {
                          try {
                            const decoded = nip19.decode(hex) as any;
                            if (decoded.type === 'npub') {
                              hex = decoded.data;
                            } else if (decoded.type === 'nprofile') {
                              hex = decoded.data.pubkey;
                            }
                          } catch (e) {
                            console.error('Failed to decode key from Amber:', e);
                          }
                        }
                        await useAmberSigner(hex);
                        setAuthMethod('amber');
                        setCurrentNpub(rawPubkey);
                        setCurrentHex(hex);
                        loadAuthorProfiles([hex]).catch(() => { });
                        setCurrentNsec('');
                        Alert.alert("Success", "Signed in with Amber!");
                      }
                    } catch (e: any) {
                      Alert.alert("Amber Error", e.message || String(e));
                    }
                  }}
                >
                  <Text style={{ color: authMethod === 'amber' ? '#000' : '#fff', fontWeight: 'bold' }}>AMBER SIGNER</Text>
                </TouchableOpacity>
              </View>
              {authMethod === 'amber' && (
                <Text style={styles.settingsHelp}>Using external Android signer (NIP-55).</Text>
              )}
            </View>

            <View style={styles.settingsSection}>
              <Text style={styles.settingsLabel}>YOUR NPUB (PUBLIC IDENTITY)</Text>
              <Text style={styles.settingsKeyText} selectable={true}>{currentNpub}</Text>
              {authMethod === 'local' && (
                <>
                  <Text style={styles.settingsLabel}>YOUR NSEC (SECRET KEY)</Text>
                  <TouchableOpacity onPress={async () => { await Clipboard.setStringAsync(currentNsec); Alert.alert("Copied", "Secret key copied to clipboard."); }}>
                    <Text style={styles.settingsKeyText}>{currentNsec ? '•'.repeat(Math.min(currentNsec.length, 63)) : ''}</Text>
                  </TouchableOpacity>
                  <Text style={styles.settingsHelp}>Save your nsec somewhere safe. Never share it. Tap to copy.</Text>
                </>
              )}
            </View>

            {authMethod === 'local' && (
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
            )}

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

            <View style={styles.settingsSection}>
              <Text style={styles.settingsLabel}>RELAY MANAGEMENT</Text>
              {customRelays.map(url => (
                <View key={url} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.3)', padding: 10, borderRadius: 8, marginBottom: 6 }}>
                  <Text style={{ color: '#fff', fontSize: 13, flex: 1 }} numberOfLines={1}>{url}</Text>
                  <TouchableOpacity onPress={() => handleRemoveRelay(url)} style={{ padding: 4 }}>
                    <Trash2 size={18} color="#ff4d4f" />
                  </TouchableOpacity>
                </View>
              ))}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <TextInput
                  style={[styles.keyInput, { flex: 1, marginBottom: 0 }]}
                  placeholder="wss://relay..."
                  placeholderTextColor="rgba(255,255,255,0.3)"
                  value={newRelayUrl}
                  onChangeText={setNewRelayUrl}
                  autoCapitalize="none"
                />
                <TouchableOpacity
                  style={{ backgroundColor: '#00ccff', padding: 12, borderRadius: 8, justifyContent: 'center' }}
                  onPress={handleAddRelay}
                >
                  <Text style={{ color: '#000', fontWeight: 'bold' }}>ADD</Text>
                </TouchableOpacity>
              </View>
              <Text style={[styles.settingsHelp, { marginTop: 10 }]}>Wait a few seconds after adding/removing for the app to reconnect.</Text>
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
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Text style={styles.historyTitle}>My Rides</Text>
              {isHistoryLoading && <ActivityIndicator size="small" color="#00ffaa" />}
            </View>
            <Text style={{ color: '#9ba1a6', fontSize: 13 }}>{myRides.length} ride{myRides.length !== 1 ? 's' : ''}</Text>
          </View>
          <ScrollView style={{ flex: 1 }} refreshControl={<RefreshControl refreshing={isHistoryLoading} onRefresh={loadHistoryFeeds} tintColor="#fff" />}>
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
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 15 }} numberOfLines={1}>
                          {r.title || 'Untitled Ride'}
                        </Text>
                        <View style={{ marginTop: 2, alignSelf: 'flex-start', backgroundColor: r.route && r.route.length > 0 ? 'rgba(0,255,170,0.1)' : 'rgba(0,204,255,0.1)', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, borderWidth: 1, borderColor: r.route && r.route.length > 0 ? 'rgba(0,255,170,0.2)' : 'rgba(0,204,255,0.2)' }}>
                          <Text style={{ color: r.route && r.route.length > 0 ? '#00ffaa' : '#00ccff', fontSize: 8, fontWeight: 'bold' }}>{r.route && r.route.length > 0 ? 'GPS ROUTE' : 'DATA ONLY'}</Text>
                        </View>
                      </View>
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
                        <Text style={{ color: '#00ffaa', fontSize: 13, fontWeight: 'bold', textAlign: 'center' }}>{distNum.toFixed(1)}</Text>
                        <Text style={{ color: '#9ba1a6', fontSize: 10, marginTop: 2, textAlign: 'center' }}>MILES</Text>
                      </View>
                      <View style={{ flex: 1.3, backgroundColor: 'rgba(255,255,255,0.04)', padding: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
                        <Text style={{ color: '#fff', fontSize: 13, fontWeight: 'bold', textAlign: 'center' }}>{r.duration}</Text>
                        <Text style={{ color: '#9ba1a6', fontSize: 10, marginTop: 2, textAlign: 'center' }}>TIME</Text>
                      </View>
                      {r.elevation && (
                        <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.04)', padding: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
                          <Text style={{ color: '#fff', fontSize: 13, fontWeight: 'bold', textAlign: 'center' }}>{r.elevation}</Text>
                          <Text style={{ color: '#9ba1a6', fontSize: 10, marginTop: 2, textAlign: 'center' }}>GAIN (FT)</Text>
                        </View>
                      )}
                      {distNum > 0 && r.duration && (() => {
                        let totalMins = 0;
                        if (r.duration.includes(':')) {
                          const parts = r.duration.split(':').reverse();
                          const secs = parseInt(parts[0] || '0');
                          const mins = parseInt(parts[1] || '0');
                          const hrs = parseInt(parts[2] || '0');
                          totalMins = (hrs * 60) + mins + (secs / 60);
                        } else {
                          // Legacy fallback for "3m 48s" or similar
                          const parts = r.duration.match(/(\d+)h\s*(\d+)m|(\d+)m/);
                          if (parts) {
                            if (parts[1]) totalMins = parseInt(parts[1]) * 60 + parseInt(parts[2] || '0');
                            else if (parts[3]) totalMins = parseInt(parts[3]);
                          }
                        }
                        const avgSpeed = totalMins > 0 ? (distNum / (totalMins / 60)).toFixed(1) : null;
                        return avgSpeed ? (
                          <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.04)', padding: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
                            <Text style={{ color: '#fff', fontSize: 13, fontWeight: 'bold', textAlign: 'center' }}>{avgSpeed}</Text>
                            <Text style={{ color: '#9ba1a6', fontSize: 10, marginTop: 2, textAlign: 'center' }}>MPH AVG</Text>
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
                        style={{ flex: 1, backgroundColor: 'rgba(0,204,255,0.08)', paddingVertical: 9, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(0,204,255,0.2)' }}
                        onPress={() => {
                          setSelectedDiscussionRide(r);
                          setShowDiscussion(true);
                        }}
                      >
                        <Text style={{ color: '#00ccff', fontWeight: 'bold', fontSize: 12 }}>💬 DISCUSS</Text>
                      </TouchableOpacity>
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
            {(isFeedLoading || loadingStatus !== '') && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <ActivityIndicator size="small" color="#00ffaa" style={{ opacity: 0.8 }} />
                <Text style={{ color: '#00ffaa', fontSize: 10, fontWeight: 'bold' }}>{(loadingStatus || 'SYNCING').toUpperCase()}</Text>
              </View>
            )}
          </View>
          {/* 4-tab bar */}
          <View style={{ marginBottom: 12 }}>
            <View style={{ flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 8, padding: 4, gap: 4 }}>
              {[
                { id: 'feed', label: 'RIDES', activeColor: '#00ccff' },
                { id: 'rides', label: 'GROUP', activeColor: '#00ffaa' },
                { id: 'contests', label: 'BEST', activeColor: '#eab308' },
                { id: 'drafts', label: 'DRAFTS', activeColor: '#eab308' },
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
                        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                          <View style={{ flex: 1, backgroundColor: 'rgba(0,255,170,0.06)', padding: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(0,255,170,0.12)' }}>
                            <Text style={{ color: '#00ffaa', fontSize: 13, fontWeight: 'bold', textAlign: 'center' }}>{draft.distance.toFixed(1)}</Text>
                            <Text style={{ color: '#9ba1a6', fontSize: 10, marginTop: 2, textAlign: 'center' }}>MILES</Text>
                          </View>
                          <View style={{ flex: 1.3, backgroundColor: 'rgba(255,255,255,0.04)', padding: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
                            <Text style={{ color: '#fff', fontSize: 13, fontWeight: 'bold', textAlign: 'center' }}>{formatDuration(draft.durationSeconds)}</Text>
                            <Text style={{ color: '#9ba1a6', fontSize: 10, marginTop: 2, textAlign: 'center' }}>TIME</Text>
                          </View>
                          <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.04)', padding: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
                            <Text style={{ color: '#fff', fontSize: 13, fontWeight: 'bold', textAlign: 'center' }}>{draft.elevationGain || '0'}</Text>
                            <Text style={{ color: '#9ba1a6', fontSize: 10, marginTop: 2, textAlign: 'center' }}>GAIN (FT)</Text>
                          </View>
                          <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.04)', padding: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
                            <Text style={{ color: '#fff', fontSize: 13, fontWeight: 'bold', textAlign: 'center' }}>
                              {draft.durationSeconds > 0 ? (draft.distance / (draft.durationSeconds / 3600)).toFixed(1) : '0.0'}
                            </Text>
                            <Text style={{ color: '#9ba1a6', fontSize: 10, marginTop: 2, textAlign: 'center' }}>MPH AVG</Text>
                          </View>
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

            {/* ── BEST FEED (Unifying Checkpoints & Challenges) ── */}
            {feedTab === 'contests' && (
              <>
                {(() => {
                  const nowSeconds = Math.floor(Date.now() / 1000);
                  const nowMs = Date.now();

                  const isHitWithinFrequency = (timestamp: number, frequency?: string) => {
                    if (!frequency || frequency === 'once') return true;
                    if (frequency === 'daily') {
                      const startOfToday = new Date().setHours(0, 0, 0, 0);
                      return (timestamp * 1000) >= startOfToday;
                    }
                    if (frequency === 'hourly') {
                      const startOfHour = new Date().setMinutes(0, 0, 0);
                      return (timestamp * 1000) >= startOfHour;
                    }
                    return true;
                  };

                  // Group checkpoints by set
                  const setsMap: { [key: string]: any[] } = {};
                  const standaloneCheckpoints: any[] = [];
                  checkpoints.forEach(cp => {
                    if (cp.set) {
                      if (!setsMap[cp.set]) setsMap[cp.set] = [];
                      setsMap[cp.set].push(cp);
                    } else {
                      standaloneCheckpoints.push(cp);
                    }
                  });

                  const unified = [
                    ...Object.entries(setsMap).map(([setName, items]) => ({
                      type: 'set' as const,
                      name: setName,
                      items: items.sort((a, b) => (a.routeIndex ?? 0) - (b.routeIndex ?? 0)),
                      reward: (items[0].setReward || 0),
                      startTime: Math.min(...items.map(i => i.startTime || 0)),
                      endTime: Math.max(...items.map(i => i.endTime || 0)),
                      sortKey: (items[0].setReward || items[0].rewardSats || 0)
                    })),
                    ...standaloneCheckpoints.map(cp => ({ ...cp, type: 'checkpoint' as const, sortKey: (cp.rewardSats || 0) })),
                    ...activeContests.map(c => ({ ...c, type: 'contest' as const, sortKey: (c.feeSats || 0) }))
                  ].filter(item => (item.endTime || 0) > nowSeconds).sort((a, b) => (b.sortKey || 0) - (a.sortKey || 0));

                  if (unified.length === 0) {
                    return (
                      <View style={{ alignItems: 'center', marginTop: 40 }}>
                        <Text style={styles.emptyText}>No active campaigns or challenges.</Text>
                        <TouchableOpacity
                          style={{ marginTop: 12, backgroundColor: 'rgba(234,179,8,0.1)', paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(234,179,8,0.3)' }}
                          onPress={() => loadFeeds()}
                        >
                          <Text style={{ color: '#eab308', fontWeight: 'bold', fontSize: 12 }}>RETRY SYNC</Text>
                        </TouchableOpacity>
                      </View>
                    );
                  }

                  const renderCheckpoint = (cp: any) => {
                    const isHunt = !!cp.set;
                    const themeColor = isHunt ? '#ff33a1' : '#a855f7';
                    return (
                      <View key={cp.id} style={[styles.historyCard, { borderColor: themeColor, borderWidth: 1, backgroundColor: isHunt ? 'rgba(255,51,161,0.05)' : 'rgba(168,85,247,0.05)' }]}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                            <Text style={{ color: themeColor, fontWeight: 'bold', fontSize: 16, flex: 1 }}>{cp.title.toUpperCase()}</Text>
                            <View style={{ backgroundColor: isHunt ? 'rgba(255,51,161,0.2)' : 'rgba(168,85,247,0.2)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                              <Text style={{ color: themeColor, fontSize: 9, fontWeight: 'bold' }}>{isHunt ? 'CAMPAIGN' : 'POI'}</Text>
                            </View>
                          </View>
                          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <Zap color={themeColor} size={14} fill={themeColor} />
                            <Text style={{ color: themeColor, fontWeight: 'bold', fontSize: 14, marginLeft: 2 }}>{cp.rewardSats}</Text>
                          </View>
                        </View>
                        <Text style={{ color: '#ccc', fontSize: 13, marginBottom: 8 }}>{cp.description}</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12, opacity: 0.7 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Calendar size={12} color={themeColor} />
                            <Text style={{ color: '#aaa', fontSize: 11 }}>
                              {format(new Date(cp.startTime * 1000), 'MMM d, h:mm a')} — {format(new Date(cp.endTime * 1000), 'MMM d, h:mm a')}
                            </Text>
                          </View>
                          {cp.frequency && (
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.05)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                              <Clock size={10} color={themeColor} />
                              <Text style={{ color: themeColor, fontSize: 10, fontWeight: 'bold' }}>
                                {cp.frequency === 'once' ? 'ONE-TIME' : cp.frequency.toUpperCase() + ' RESET'}
                              </Text>
                            </View>
                          )}
                        </View>

                        {cp.streakReward && (() => {
                          const streakDays = cp.streakDays || 5;
                          const rideHits = myRides.filter(r => r.checkpointHitId === cp.id).map(r => r.time || 0);
                          const claimHits = myClaims.filter(c => c.checkpointId === cp.id).map(c => c.timestamp);
                          const myHits = [...rideHits, ...claimHits].sort((a, b) => b - a);

                          let currentStreak = 0;
                          if (myHits.length > 0) {
                            currentStreak = 1;
                            let last = myHits[0];
                            for (let i = 1; i < myHits.length; i++) {
                              if (last - myHits[i] >= 82800 && last - myHits[i] <= 176400) { currentStreak++; last = myHits[i]; }
                              else if (last - myHits[i] < 82800) continue;
                              else break;
                            }
                          }
                          return (
                            <View style={{ backgroundColor: 'rgba(255,255,255,0.03)', padding: 10, borderRadius: 8, marginBottom: 12, borderLeftWidth: 3, borderLeftColor: themeColor }}>
                              <Text style={{ color: themeColor, fontWeight: 'bold', fontSize: 12, marginBottom: 4 }}>🎁 STREAK BONUS: {cp.streakReward} sats</Text>
                              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Text style={{ color: '#888', fontSize: 10 }}>Visit {streakDays} days in a row</Text>
                                <Text style={{ color: themeColor, fontSize: 10, fontWeight: 'bold' }}>DAY {currentStreak}/{streakDays}</Text>
                              </View>
                            </View>
                          );
                        })()}

                        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                          {!isHunt && cp.rsvp === 'required' && (() => {
                            const aTag = `${cp.kind}:${cp.hexPubkey}:${cp.dTag}`;
                            const isJoined = joinedIds.has(cp.id) || joinedIds.has(aTag);
                            return (
                              <TouchableOpacity
                                style={{ flex: 1.2, backgroundColor: isJoined ? '#333' : themeColor, paddingVertical: 10, borderRadius: 8, alignItems: 'center', opacity: isJoined ? 0.7 : 1 }}
                                disabled={isJoined}
                                onPress={async () => {
                                  setIsZapping(true);
                                  const success = await publishRSVP(cp.id, cp.hexPubkey);
                                  setIsZapping(false);
                                  if (success) {
                                    Alert.alert("Success!", "Joined the hunt!");
                                    setJoinedIds(prev => new Set([...prev, cp.id]));
                                  } else {
                                    Alert.alert("RSVP Failed", "Check keys/NWC.");
                                  }
                                }}
                              >
                                <Text style={{ color: isJoined ? '#888' : '#000', fontWeight: 'bold', fontSize: 13 }}>{isJoined ? '✅ JOINED' : '🚀 JOIN'}</Text>
                              </TouchableOpacity>
                            );
                          })()}
                          <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.05)', paddingVertical: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' }} onPress={() => {
                            setMapCenter({ lat: cp.location.lat - POI_LAT_OFFSET, lng: cp.location.lng });
                            setMapZoom(18);
                            setSelectedMapGroup(groupedCheckpoints.find(g => Math.abs(g.lat - cp.location.lat) < 0.0001 && Math.abs(g.lng - cp.location.lng) < 0.0001) || null);
                            setShowFeed(false);
                          }}>
                            <Text style={{ color: '#fff', fontSize: 12, fontWeight: 'bold' }}>📡 MAP</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    );
                  };

                  const renderSet = (set: any) => {
                    const totalItems = set.items.length;
                    const hitCount = set.items.filter((cp: any) =>
                      myRides.some(r => r.checkpointHitId === cp.id && isHitWithinFrequency(r.time || 0, cp.frequency)) ||
                      myClaims.some(c => c.checkpointId === cp.id && isHitWithinFrequency(c.timestamp, cp.frequency))
                    ).length;
                    const isComplete = hitCount === totalItems;
                    return (
                      <View key={set.name} style={{ backgroundColor: 'rgba(255,51,161,0.05)', borderRadius: 16, padding: 16, borderStyle: 'dashed', borderWidth: 1, borderColor: isComplete ? '#00ffaa' : '#ff33a1', marginBottom: 16 }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: isComplete ? '#00ffaa' : '#ff33a1', fontWeight: 'bold', fontSize: 11, letterSpacing: 1 }}>SCAVENGER HUNT</Text>
                            <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 20 }}>{set.name}</Text>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 }}>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <Calendar size={12} color="#ff33a1" />
                                <Text style={{ color: '#888', fontSize: 11 }}>
                                  {format(new Date(set.startTime * 1000), 'MMM d')} — {format(new Date(set.endTime * 1000), 'MMM d')}
                                </Text>
                              </View>
                              {set.items[0]?.frequency && (
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,51,161,0.1)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                                  <Clock size={10} color="#ff33a1" />
                                  <Text style={{ color: '#ff33a1', fontSize: 10, fontWeight: 'bold' }}>
                                    {set.items[0].frequency === 'once' ? 'ONE-TIME' : set.items[0].frequency.toUpperCase() + ' RESET'}
                                  </Text>
                                </View>
                              )}
                            </View>
                          </View>
                          <View style={{ alignItems: 'flex-end' }}>
                            <View style={{ backgroundColor: isComplete ? '#00ffaa' : '#ff33a1', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 }}>
                              <Text style={{ color: '#000', fontWeight: 'bold', fontSize: 14 }}>{hitCount}/{totalItems}</Text>
                            </View>
                          </View>
                        </View>
                        <View style={{ gap: 10 }}>
                          {set.items.map((cp: any) => {
                            const isHit = myRides.some(r => r.checkpointHitId === cp.id && isHitWithinFrequency(r.time || 0, cp.frequency)) ||
                              myClaims.some(c => c.checkpointId === cp.id && isHitWithinFrequency(c.timestamp, cp.frequency));
                            return (
                              <View key={cp.id} style={{ opacity: isHit ? 0.5 : 1 }}>
                                {renderCheckpoint(cp)}
                              </View>
                            );
                          })}
                        </View>
                        {(() => {
                          const firstItem = set.items[0];
                          const aTag = `${firstItem.kind}:${firstItem.hexPubkey}:${firstItem.dTag}`;
                          const isJoined = joinedIds.has(firstItem.id) || joinedIds.has(aTag);
                          return (
                            <TouchableOpacity
                              style={{ backgroundColor: isJoined ? '#333' : '#ff33a1', paddingVertical: 14, borderRadius: 12, alignItems: 'center', marginTop: 16, shadowColor: isJoined ? 'transparent' : '#ff33a1', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: isJoined ? 0 : 5, opacity: isJoined ? 0.7 : 1 }}
                              disabled={isJoined}
                              onPress={async () => {
                                setIsZapping(true);
                                const success = await publishRSVP(set.items[0].id, set.items[0].hexPubkey);
                                setIsZapping(false);
                                if (success) {
                                  Alert.alert("Joined!", "Successfully joined this scavenger hunt! 🚲🔥");
                                  setJoinedIds(prev => new Set([...prev, set.items[0].id]));
                                } else {
                                  Alert.alert("Join Failed", "Check your connection and keys.");
                                }
                              }}
                            >
                              <Text style={{ color: isJoined ? '#888' : '#000', fontWeight: 'bold', fontSize: 15 }}>{isJoined ? '✅ JOINED' : '🚀 JOIN SCAVENGER HUNT'}</Text>
                            </TouchableOpacity>
                          );
                        })()}
                      </View>
                    );
                  };

                  const renderContest = (c: any) => {
                    const isPast = c.endTime < nowSeconds;
                    return (
                      <View key={c.id} style={[styles.historyCard, { borderColor: isPast ? '#444' : '#00ffaa', borderWidth: 1, backgroundColor: isPast ? 'transparent' : 'rgba(0,255,170,0.05)' }]}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <Text style={{ color: isPast ? '#888' : '#00ffaa', fontWeight: 'bold', fontSize: 16 }}>{c.name.toUpperCase()}</Text>
                          <View style={{ backgroundColor: isPast ? '#333' : 'rgba(0,255,170,0.2)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                            <Text style={{ color: isPast ? '#888' : '#00ffaa', fontSize: 9, fontWeight: 'bold' }}>CHALLENGE</Text>
                          </View>
                        </View>
                        <Text style={{ color: '#ccc', fontSize: 13, marginBottom: 8 }}>{c.description}</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12, opacity: 0.8 }}>
                          <Calendar size={12} color="#00ffaa" />
                          <Text style={{ color: '#aaa', fontSize: 11 }}>
                            {format(new Date(c.startTime * 1000), 'MMM d, h:mm a')} — {format(new Date(c.endTime * 1000), 'MMM d, h:mm a')}
                          </Text>
                        </View>
                        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
                          <View style={{ backgroundColor: 'rgba(255,255,255,0.03)', padding: 10, borderRadius: 10, flex: 1, alignItems: 'center' }}>
                            <Text style={{ color: '#666', fontSize: 10, fontWeight: 'bold' }}>FEE</Text>
                            <Text style={{ color: '#eab308', fontSize: 14, fontWeight: 'bold' }}>{c.feeSats}</Text>
                          </View>
                          <View style={{ backgroundColor: 'rgba(255,255,255,0.03)', padding: 10, borderRadius: 10, flex: 1, alignItems: 'center' }}>
                            <Text style={{ color: '#666', fontSize: 10, fontWeight: 'bold' }}>METRIC</Text>
                            <Text style={{ color: '#fff', fontSize: 12 }}>{c.parameter.toUpperCase()}</Text>
                          </View>
                        </View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <TouchableOpacity onPress={async () => { setSelectedContest(c); setShowFeed(false); setIsLoadingLeaderboard(true); const lb = await fetchRideLeaderboard(c.attendees, c.startTime, c.endTime, c.parameter); setContestLeaderboard(lb); setIsLoadingLeaderboard(false); }}>
                            <Text style={{ color: '#00ccff', fontSize: 12, textDecorationLine: 'underline' }}>Leaderboard ({c.attendees.length})</Text>
                          </TouchableOpacity>
                          {!isPast && (
                            <TouchableOpacity
                              style={{ backgroundColor: c.attendees.includes(currentHex) ? 'rgba(0, 255, 170, 0.1)' : '#00ffaa', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12 }}
                              disabled={c.attendees.includes(currentHex)}
                              onPress={async () => {
                                if (c.feeSats > 0) {
                                  const confirmed = await new Promise<boolean>(resolve => Alert.alert("Enter Challenge", `Zap ${c.feeSats} sats?`, [{ text: "Cancel", style: "cancel", onPress: () => resolve(false) }, { text: "⚡ Confirm", onPress: () => resolve(true) }]));
                                  if (!confirmed) return;
                                  await zapRideEvent(c.id, ESCROW_PUBKEY, c.kind, c.feeSats, `Enter ${c.id}`);
                                }
                                if (await publishRSVP(c)) { Alert.alert("🏆 Entered!"); setActiveContests(prev => prev.map(con => con.id === c.id ? { ...con, attendees: [...con.attendees, currentHex] } : con)); }
                              }}
                            >
                              <Text style={{ color: c.attendees.includes(currentHex) ? '#00ffaa' : '#000', fontWeight: 'bold', fontSize: 13 }}>{c.attendees.includes(currentHex) ? 'ENTERED' : 'ENTER'}</Text>
                            </TouchableOpacity>
                          )}
                        </View>
                      </View>
                    );
                  };

                  return (
                    <View style={{ gap: 12, paddingBottom: 20 }}>
                      {unified.map(item => {
                        if (item.type === 'set') return renderSet(item);
                        if (item.type === 'checkpoint') return renderCheckpoint(item);
                        return renderContest(item);
                      })}
                    </View>
                  );
                })()}
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

                        {/* Title Row */}
                        <View style={{ marginBottom: 4, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text style={[styles.historyTime, { fontSize: 18, marginBottom: 2, flex: 1 }]}>{r.title || new Date(r.time * 1000).toLocaleDateString()}</Text>
                          <View style={{ backgroundColor: r.route && r.route.length > 0 ? 'rgba(0,255,170,0.1)' : 'rgba(0,204,255,0.1)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, borderColor: r.route && r.route.length > 0 ? 'rgba(0,255,170,0.3)' : 'rgba(0,204,255,0.3)' }}>
                            <Text style={{ color: r.route && r.route.length > 0 ? '#00ffaa' : '#00ccff', fontSize: 9, fontWeight: 'bold' }}>{r.route && r.route.length > 0 ? 'GPS ROUTE' : 'DATA ONLY'}</Text>
                          </View>
                        </View>

                        {/* Author Row */}
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                          <TouchableOpacity onPress={() => { setViewingAuthor(r.hexPubkey); setIsLoadingAuthor(true); fetchUserRides(r.hexPubkey).then(setAuthorRides).finally(() => setIsLoadingAuthor(false)); }}>
                            <Text style={{ color: '#00ccff', fontSize: 13, textDecorationLine: 'underline', fontWeight: 'bold' }}>{displayName}</Text>
                          </TouchableOpacity>
                          {r.client && r.client !== 'bikel' && (
                            <Text style={{ color: '#666', fontSize: 10, fontWeight: 'bold' }}>via {r.client.toLowerCase()}</Text>
                          )}
                        </View>

                        {/* Description */}
                        {r.description ? <Text style={{ color: '#ccc', fontSize: 13, marginBottom: 12, lineHeight: 18 }}>{r.description}</Text> : null}
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.03)', padding: 8, borderRadius: 6 }}>
                            <Route size={14} color="#00ffaa" />
                            <Text style={{ color: '#fff', fontSize: 13 }}>{r.distance} mi</Text>
                          </View>
                          <View style={{ flex: 1.2, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.03)', padding: 8, borderRadius: 6 }}>
                            <Clock size={14} color="#00ffaa" />
                            <Text style={{ color: '#fff', fontSize: 13 }}>{r.duration}</Text>
                          </View>
                          {r.rawDuration > 0 && parseFloat(r.distance) > 0 && (
                            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.03)', padding: 8, borderRadius: 6 }}>
                              <Gauge size={14} color="#00ccff" />
                              <Text style={{ color: '#fff', fontSize: 13 }}>{(parseFloat(r.distance) / (r.rawDuration / 3600)).toFixed(1)} mph</Text>
                            </View>
                          )}
                          {r.elevation && (
                            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.03)', padding: 8, borderRadius: 6 }}>
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
                <View style={{ height: 80 }} />
              </>
            )}
          </ScrollView>
        </View>
      )}

      {nearestCheckpoint && !showFeed && !showDiscussion && !activeDMUser && !viewingAuthor && !showSettings && !showHistory && !showSocialOverlay && !showSchedule && !showPostRideModal && (
        <TouchableOpacity
          onPress={() => setSelectedMapGroup(groupedCheckpoints.find(g => Math.abs(g.lat - nearestCheckpoint.cp.location.lat) < 0.0001 && Math.abs(g.lng - nearestCheckpoint.cp.location.lng) < 0.0001) || null)}
          style={{ position: 'absolute', top: Platform.OS === 'ios' ? 150 : 130, left: 60, right: 60, backgroundColor: 'rgba(0,0,0,0.92)', padding: 12, borderRadius: 16, borderWidth: 1, borderColor: nearestCheckpoint.distance < (nearestCheckpoint.cp.radius || 20) ? '#00ffaa' : 'rgba(255,255,255,0.2)', flexDirection: 'row', alignItems: 'center', gap: 10, zIndex: 1000 }}
        >
          <View style={{ backgroundColor: nearestCheckpoint.cp.set ? 'rgba(255,51,161,0.15)' : 'rgba(168,85,247,0.15)', padding: 8, borderRadius: 12 }}>
            <Zap size={18} color={nearestCheckpoint.cp.set ? '#ff33a1' : '#a855f7'} fill={nearestCheckpoint.distance < (nearestCheckpoint.cp.radius || 20) ? (nearestCheckpoint.cp.set ? '#ff33a1' : '#a855f7') : 'transparent'} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold' }} numberOfLines={1}>{nearestCheckpoint.cp.title.toUpperCase()}</Text>
            <Text style={{ color: nearestCheckpoint.cp.set ? '#ff33a1' : '#a855f7', fontSize: 11, fontWeight: 'bold' }}>
              {nearestCheckpoint.distance < (nearestCheckpoint.cp.radius || 20) ? '🎯 AT LOCATION' : `${Math.round(nearestCheckpoint.distance)}m AWAY`}
            </Text>
          </View>
          {nearestCheckpoint.cp.rewardSats > 0 && (
            <View style={{ backgroundColor: 'rgba(234,179,8,0.1)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(234,179,8,0.3)' }}>
              <Text style={{ color: '#eab308', fontWeight: 'bold', fontSize: 13 }}>⚡ {nearestCheckpoint.cp.rewardSats}</Text>
            </View>
          )}
        </TouchableOpacity>
      )}

      {showSocialOverlay && (
        <View style={styles.historyOverlay}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <Text style={styles.historyTitle}>Social Hub</Text>
            {isSocialLoading && <ActivityIndicator size="small" color="#00ffaa" />}
          </View>

          <View style={{ flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 8, padding: 4, gap: 4, marginBottom: 12 }}>
            <TouchableOpacity style={{ flex: 1, paddingVertical: 8, backgroundColor: socialTab === 'chat' ? '#00ccff' : 'transparent', borderRadius: 6, alignItems: 'center' }} onPress={() => setSocialTab('chat')}>
              <Text style={{ color: socialTab === 'chat' ? '#000' : '#fff', fontWeight: 'bold', fontSize: 12 }}>CHAT</Text>
            </TouchableOpacity>
            <TouchableOpacity style={{ flex: 1, paddingVertical: 8, backgroundColor: socialTab === 'activity' ? '#00ccff' : 'transparent', borderRadius: 6, alignItems: 'center' }} onPress={() => setSocialTab('activity')}>
              <Text style={{ color: socialTab === 'activity' ? '#000' : '#fff', fontWeight: 'bold', fontSize: 12 }}>ACTIVITY</Text>
            </TouchableOpacity>
          </View>

          <ScrollView ref={socialTab === 'chat' ? chatScrollRef : socialScrollRef} style={{ flex: 1 }} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={isSocialLoading} onRefresh={loadSocialFeeds} tintColor="#fff" />}>
            {socialTab === 'chat' ? (
              globalMessages.length === 0 && !isSocialLoading ? (
                <Text style={{ color: '#666', textAlign: 'center', marginTop: 40 }}>No chat messages yet...</Text>
              ) : (
                globalMessages.map(m => {
                  const profile = profiles[m.pubkey];
                  const nick = profile?.nip05 || profile?.name || m.pubkey.substring(0, 8);
                  return (
                    <View key={m.id} style={{ marginBottom: 16, backgroundColor: 'rgba(255,255,255,0.03)', padding: 10, borderRadius: 8 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                        <Text style={{ color: '#00ccff', fontSize: 12, fontWeight: 'bold' }}>{nick}</Text>
                        <Text style={{ color: '#666', fontSize: 10 }}>{new Date(m.created_at! * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
                      </View>
                      <Text style={{ color: '#fff', fontSize: 14 }}>{m.content}</Text>
                    </View>
                  );
                })
              )
            ) : (
              globalComments.length === 0 && !isSocialLoading ? (
                <Text style={{ color: '#666', textAlign: 'center', marginTop: 40 }}>No recent activity found.</Text>
              ) : (
                globalComments.map(c => {
                  const profile = profiles[c.hexPubkey || c.pubkey];
                  const nick = profile?.nip05 || profile?.name || (c.hexPubkey || c.pubkey).substring(0, 8) + '...';
                  const avatar = profile?.picture;

                  const isRide = !!c.isRide;
                  const isComment = !c.isRide && !!c.rideId;
                  // Only show VIEW RIDE if it's a bikel ride (has distance) or a comment on one
                  // MAP button: only for ride cards that have confirmed route data.
                  // Comments just get Discussion — the route lives on the ride itself.
                  const canViewRide = isRide && !!c.hasRoute;
                  const discussId = isComment ? c.rideId! : c.id;

                  // Skip standalone comment cards — they render nested under their parent ride/post
                  if (isComment) return null;

                  const nestedComments = commentsByEventId[c.id] || [];
                  const isExpanded = !!expandedComments[c.id];
                  const visibleComments = isExpanded ? nestedComments : nestedComments.slice(0, 2);

                  return (
                    <View
                      key={c.id}
                      onLayout={(e) => { socialCardOffsets.current[c.id] = e.nativeEvent.layout.y; }}
                      style={{ marginBottom: 12, backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: isRide ? 'rgba(0,255,170,0.12)' : 'rgba(255,255,255,0.06)' }}>

                      {/* Full-width photo — taller for Instagram feel */}
                      {c.image && (
                        <Image source={{ uri: c.image }} style={{ width: '100%', height: 220, backgroundColor: '#111' }} resizeMode="cover" />
                      )}

                      <View style={{ padding: 12 }}>
                        {/* Author row */}
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <TouchableOpacity
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
                            onPress={() => {
                              setViewingAuthor(c.hexPubkey || c.pubkey);
                              setIsLoadingAuthor(true);
                              fetchUserRides(c.hexPubkey || c.pubkey).then(setAuthorRides).finally(() => setIsLoadingAuthor(false));
                              setShowSocialOverlay(false);
                            }}
                          >
                            {avatar
                              ? <Image source={{ uri: avatar }} style={{ width: 32, height: 32, borderRadius: 16, borderWidth: 1, borderColor: isRide ? '#00ffaa' : '#444' }} />
                              : <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: isRide ? 'rgba(0,255,170,0.2)' : 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center' }}>
                                <Text style={{ color: isRide ? '#00ffaa' : '#888', fontSize: 12, fontWeight: 'bold' }}>{nick.substring(0, 1).toUpperCase()}</Text>
                              </View>
                            }
                            <View>
                              <Text style={{ color: '#fff', fontSize: 13, fontWeight: 'bold' }}>{nick}</Text>
                              <Text style={{ color: '#555', fontSize: 10 }}>
                                {isRide ? '🚲 shared a ride' : '📝 posted'} · {new Date(c.createdAt * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                              </Text>
                            </View>
                          </TouchableOpacity>
                        </View>

                        {/* Ride: title + compact stats in one line */}
                        {isRide && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                            {c.title && (
                              <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 14 }}>{c.title}</Text>
                            )}
                            {c.distance && parseFloat(c.distance) > 0 && (
                              <Text style={{ color: '#00ffaa', fontSize: 13, fontWeight: 'bold' }}>{parseFloat(c.distance).toFixed(1)} mi</Text>
                            )}
                            {c.duration && c.duration !== '0m' && c.duration !== '0:00' && (
                              <Text style={{ color: '#888', fontSize: 12 }}>{c.duration}</Text>
                            )}
                          </View>
                        )}

                        {/* Post content — skip for rides where content just repeats the title */}
                        {c.content && !(isRide && c.title && c.content.startsWith(c.title)) && (
                          <Text style={{ color: '#ccc', fontSize: 14, lineHeight: 20, marginBottom: 8 }} numberOfLines={isRide ? 2 : undefined}>
                            {c.content}
                          </Text>
                        )}

                        {/* Reaction counts row */}
                        {(() => {
                          const QUICK = ['🔥', '🚴', '💪', '👍', '⚡'];
                          const itemReactions = reactions[c.id] || [];
                          return (
                            <View style={{ marginBottom: 8 }}>
                              {itemReactions.length > 0 && (
                                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                                  {itemReactions.map(r => (
                                    <TouchableOpacity
                                      key={r.emoji}
                                      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: r.reactedByMe ? 'rgba(0,255,170,0.15)' : 'rgba(255,255,255,0.07)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderWidth: 1, borderColor: r.reactedByMe ? 'rgba(0,255,170,0.4)' : 'rgba(255,255,255,0.1)' }}
                                      onPress={async () => {
                                        if (r.reactedByMe && r.myReactionId) { await deleteReaction(r.myReactionId); }
                                        else { await publishReaction(c.id, c.hexPubkey || c.pubkey, r.emoji); }
                                        loadReactions(c.id);
                                      }}
                                    >
                                      <Text style={{ fontSize: 14 }}>{r.emoji}</Text>
                                      <Text style={{ color: r.reactedByMe ? '#00ffaa' : '#888', fontSize: 12, fontWeight: 'bold' }}>{r.count}</Text>
                                    </TouchableOpacity>
                                  ))}
                                </View>
                              )}
                              {/* Quick-react bar */}
                              <View style={{ flexDirection: 'row', gap: 5, alignItems: 'center' }}>
                                {QUICK.map(emoji => {
                                  const ex = itemReactions.find(r => r.emoji === emoji);
                                  return (
                                    <TouchableOpacity
                                      key={emoji}
                                      disabled={reactingId === c.id}
                                      style={{ paddingHorizontal: 7, paddingVertical: 4, borderRadius: 14, backgroundColor: ex?.reactedByMe ? 'rgba(0,255,170,0.15)' : 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: ex?.reactedByMe ? 'rgba(0,255,170,0.35)' : 'transparent' }}
                                      onPress={async () => {
                                        if (emoji === '⚡') {
                                          if (!isNWCConnected) { Alert.alert('Wallet Required', 'Connect your Lightning Wallet in Settings to send zaps.'); return; }
                                          const author = c.hexPubkey || c.pubkey;
                                          const kind = (c.kind || 1) as number;
                                          const displayName = profiles[author]?.nip05 || profiles[author]?.name || author.substring(0, 10) + '...';
                                          Alert.alert('⚡ Send Zap', `Zap ${displayName} 21 sats?`, [
                                            { text: 'Cancel', style: 'cancel' },
                                            {
                                              text: 'Zap ⚡', onPress: async () => {
                                                setReactingId(c.id);
                                                try {
                                                  await zapRideEvent(c.id, author, kind, 21, '⚡ Great post!');
                                                  Alert.alert('⚡ Zapped!', `21 sats sent to ${displayName}!`);
                                                } catch (e: any) { Alert.alert('Zap Failed', e.message || 'Unknown error'); }
                                                setReactingId(null);
                                              }
                                            },
                                          ]);
                                          return;
                                        }
                                        setReactingId(c.id);
                                        if (ex?.reactedByMe && ex.myReactionId) { await deleteReaction(ex.myReactionId); }
                                        else { await publishReaction(c.id, c.hexPubkey || c.pubkey, emoji); }
                                        await loadReactions(c.id);
                                        setReactingId(null);
                                      }}
                                    >
                                      <Text style={{ fontSize: 15 }}>{emoji}</Text>
                                    </TouchableOpacity>
                                  );
                                })}
                                {/* Discussion button — inline with reactions */}
                                <TouchableOpacity
                                  style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 14, backgroundColor: 'rgba(0,204,255,0.08)', borderWidth: 1, borderColor: 'rgba(0,204,255,0.2)' }}
                                  onPress={() => {
                                    const rideForDisc = globalRides.find(r => r.id === discussId);
                                    if (rideForDisc) { setSelectedDiscussionRide(rideForDisc); }
                                    else { setSelectedDiscussionRide({ id: discussId, pubkey: c.pubkey, hexPubkey: c.hexPubkey || c.pubkey, time: c.createdAt, distance: '0', duration: '0', visibility: 'full', route: [], kind: 33301 } as any); }
                                    setDiscussionFromSocial(true);
                                    setShowDiscussion(true);
                                  }}
                                >
                                  <Text style={{ fontSize: 14 }}>💬</Text>
                                  {nestedComments.length > 0 && (
                                    <Text style={{ color: '#00ccff', fontSize: 12, fontWeight: 'bold' }}>{nestedComments.length}</Text>
                                  )}
                                </TouchableOpacity>
                              </View>
                            </View>
                          );
                        })()}

                        {/* Nested comment thread */}
                        {nestedComments.length > 0 && (
                          <View style={{ marginTop: 6, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)', paddingTop: 10 }}>
                            {visibleComments.map((comment) => {
                              const cp = profiles[comment.hexPubkey || comment.pubkey];
                              const cn = cp?.nip05 || cp?.name || (comment.hexPubkey || comment.pubkey).substring(0, 8) + '...';
                              const ca = cp?.picture;
                              return (
                                <View key={comment.id} style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                                  {ca
                                    ? <Image source={{ uri: ca }} style={{ width: 22, height: 22, borderRadius: 11, marginTop: 2 }} />
                                    : <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center', marginTop: 2 }}>
                                      <Text style={{ color: '#888', fontSize: 9, fontWeight: 'bold' }}>{cn.substring(0, 1).toUpperCase()}</Text>
                                    </View>
                                  }
                                  <View style={{ flex: 1 }}>
                                    <Text style={{ color: '#00ccff', fontSize: 11, fontWeight: 'bold', marginBottom: 1 }}>{cn}</Text>
                                    <Text style={{ color: '#bbb', fontSize: 13, lineHeight: 17 }}>{comment.content}</Text>
                                  </View>
                                </View>
                              );
                            })}
                            {nestedComments.length > 2 && (
                              <TouchableOpacity onPress={() => setExpandedComments(prev => ({ ...prev, [c.id]: !isExpanded }))} style={{ paddingVertical: 2 }}>
                                <Text style={{ color: '#00ccff', fontSize: 12 }}>
                                  {isExpanded ? '▲ Show less' : `▼ ${nestedComments.length - 2} more comment${nestedComments.length - 2 !== 1 ? 's' : ''}`}
                                </Text>
                              </TouchableOpacity>
                            )}
                          </View>
                        )}
                      </View>
                    </View>
                  );
                })
              )
            )}
            <View style={{ height: 80 }} />
          </ScrollView>

          {socialTab === 'chat' && (
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 12, alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.05)', padding: 8, borderRadius: 12 }}>
              <TextInput
                style={[styles.keyInput, { flex: 1, marginBottom: 0, backgroundColor: 'transparent', borderWidth: 0 }]}
                placeholder="Message the group..."
                placeholderTextColor="rgba(255,255,255,0.3)"
                value={newChatText}
                onChangeText={setNewChatText}
                editable={!isSendingChat}
              />
              <TouchableOpacity
                style={{ backgroundColor: '#00ccff', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8 }}
                disabled={isSendingChat || !newChatText.trim()}
                onPress={async () => {
                  if (!newChatText.trim()) return;
                  setIsSendingChat(true);
                  try {
                    await publishChannelMessage(newChatText.trim());
                    setNewChatText('');
                    const msgs = await fetchChannelMessages();
                    setGlobalMessages(msgs);
                  } catch (e: any) {
                    Alert.alert("Error", "Failed to send message: " + e.message);
                  }
                  setIsSendingChat(false);
                }}
              >
                <Text style={{ color: '#000', fontWeight: 'bold' }}>{isSendingChat ? '...' : 'SEND'}</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {/* Schedule Overlay */}
      {showSchedule && (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.historyOverlay}>
          <Text style={styles.historyTitle}>
            {schedType === 'ride' ? 'Schedule Group Ride' : (schedType === 'sponsor' ? 'Sponsor Checkpoint' : 'Create Community Challenge')}
          </Text>
          <View style={{ flexDirection: 'row', marginBottom: 16, gap: 10 }}>
            <TouchableOpacity style={{ flex: 1, backgroundColor: schedType === 'ride' ? '#00ffaa' : 'rgba(255,255,255,0.1)', paddingVertical: 10, borderRadius: 8, alignItems: 'center' }} onPress={() => setSchedType('ride')}>
              <Text style={{ color: schedType === 'ride' ? '#000' : '#fff', fontWeight: 'bold', fontSize: 10 }}>GROUP RIDE</Text>
            </TouchableOpacity>
            <TouchableOpacity style={{ flex: 1, backgroundColor: schedType === 'contest' ? '#5bd0ff' : 'rgba(255,255,255,0.1)', paddingVertical: 10, borderRadius: 8, alignItems: 'center' }} onPress={() => setSchedType('contest')}>
              <Text style={{ color: schedType === 'contest' ? '#000' : '#fff', fontWeight: 'bold', fontSize: 10 }}>CHALLENGE</Text>
            </TouchableOpacity>
            <TouchableOpacity style={{ flex: 1, backgroundColor: schedType === 'sponsor' ? '#eab308' : 'rgba(255,255,255,0.1)', paddingVertical: 10, borderRadius: 8, alignItems: 'center' }} onPress={() => setSchedType('sponsor')}>
              <Text style={{ color: schedType === 'sponsor' ? '#000' : '#fff', fontWeight: 'bold', fontSize: 10 }}>SPONSOR POI</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            <View style={styles.settingsSection}>
              <Text style={styles.settingsLabel}>
                {schedType === 'ride' ? 'RIDE NAME' : (schedType === 'sponsor' ? (isWizard ? 'CAMPAIGN NAME' : 'CHECKPOINT NAME') : 'CHALLENGE TITLE')}
              </Text>
              <TextInput style={styles.keyInput} placeholder={schedType === 'sponsor' ? "e.g. My Bike Shop" : "e.g. Morning Coffee Ride"} placeholderTextColor="rgba(255,255,255,0.3)" value={schedName} onChangeText={setSchedName} />

              <Text style={styles.settingsLabel}>DESCRIPTION</Text>
              <TextInput style={[styles.keyInput, { height: 80 }]} placeholder={schedType === 'sponsor' ? "Tell riders why they should visit..." : "Pace, expected distance..."} placeholderTextColor="rgba(255,255,255,0.3)" multiline value={schedDesc} onChangeText={setSchedDesc} />

              {schedType === 'sponsor' && (
                <View style={{ marginBottom: 16, backgroundColor: 'rgba(234,179,8,0.05)', padding: 12, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(234,179,8,0.2)' }}>
                  <Text style={[styles.settingsLabel, { color: '#eab308' }]}>CREATION MODE</Text>
                  <View style={{ flexDirection: 'row', gap: 5, marginBottom: 12 }}>
                    <TouchableOpacity style={{ flex: 1, backgroundColor: !isWizard ? '#eab308' : 'rgba(255,255,255,0.1)', paddingVertical: 10, borderRadius: 6, alignItems: 'center' }} onPress={() => setIsWizard(false)}>
                      <Text style={{ textAlign: 'center', color: !isWizard ? '#000' : '#fff', fontWeight: 'bold' }}>SINGLE POI</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={{ flex: 1, backgroundColor: isWizard ? '#eab308' : 'rgba(255,255,255,0.1)', paddingVertical: 10, borderRadius: 6, alignItems: 'center' }} onPress={() => { setIsWizard(true); setWizardStep(1); }}>
                      <Text style={{ textAlign: 'center', color: isWizard ? '#000' : '#fff', fontWeight: 'bold' }}>SCAVENGER WIZARD</Text>
                    </TouchableOpacity>
                  </View>

                  {!isWizard ? (
                    <>
                      <Text style={[styles.settingsLabel, { color: '#eab308' }]}>REWARD (SATS)</Text>
                      <TextInput style={[styles.keyInput, { borderColor: 'rgba(234,179,8,0.3)' }]} keyboardType="numeric" value={sponsorReward} onChangeText={setSponsorReward} />
                    </>
                  ) : (
                    <View style={{ backgroundColor: 'rgba(255,255,255,0.03)', padding: 10, borderRadius: 8, marginBottom: 12 }}>
                      <Text style={{ color: '#eab308', fontWeight: 'bold', fontSize: 13 }}>STEP {wizardStep} OF 3: {wizardStep === 1 ? 'CAMPAIGN SETUP' : (wizardStep === 2 ? 'SELECT POINTS' : 'SET REWARDS')}</Text>
                    </View>
                  )}

                  {/* Multi-Day Streak Bonus Section */}
                  {(!isWizard || wizardStep === 1) && (
                    <View style={{ backgroundColor: 'rgba(255,255,255,0.05)', padding: 12, borderRadius: 8, marginBottom: 16, borderLeftWidth: 3, borderLeftColor: sponsorStreak ? '#00ccff' : 'rgba(255,255,255,0.1)' }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: sponsorStreak ? 12 : 0 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <Clock size={16} color="#00ccff" />
                          <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 13 }}>Enable Multi-Day Streak Bonus</Text>
                        </View>
                        <Switch
                          value={sponsorStreak}
                          onValueChange={setSponsorStreak}
                          trackColor={{ false: "#333", true: "#00ccff" }}
                          thumbColor={sponsorStreak ? "#fff" : "#f4f3f4"}
                        />
                      </View>
                      {sponsorStreak && (
                        <View style={{ flexDirection: 'row', gap: 10 }}>
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.settingsLabel, { fontSize: 10, marginBottom: 4 }]}>STREAK DAYS</Text>
                            <TextInput style={[styles.keyInput, { height: 40, fontSize: 13 }]} keyboardType="numeric" value={sponsorDays} onChangeText={setSponsorDays} />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.settingsLabel, { fontSize: 10, marginBottom: 4 }]}>BONUS (SATS)</Text>
                            <TextInput style={[styles.keyInput, { height: 40, fontSize: 13 }]} keyboardType="numeric" value={streakReward} onChangeText={setStreakReward} />
                          </View>
                        </View>
                      )}
                    </View>
                  )}

                  {isWizard && wizardStep === 3 && (
                    <View style={{ gap: 12, marginBottom: 16 }}>
                      <View>
                        <Text style={[styles.settingsLabel, { color: '#eab308' }]}>REWARD PER CHECKPOINT (SATS)</Text>
                        <TextInput style={[styles.keyInput, { borderColor: 'rgba(234,179,8,0.3)' }]} keyboardType="numeric" value={sponsorReward} onChangeText={setSponsorReward} />
                      </View>
                      <View>
                        <Text style={[styles.settingsLabel, { color: '#00ffaa' }]}>SET COMPLETION BONUS (SATS)</Text>
                        <TextInput style={[styles.keyInput, { borderColor: 'rgba(0,255,170,0.3)' }]} keyboardType="numeric" value={setBonus} onChangeText={setSetBonus} />
                      </View>
                    </View>
                  )}

                  {!isWizard || wizardStep === 3 ? (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8, marginTop: 12 }}>
                      <Text style={{ color: '#eab308', fontWeight: 'bold', fontSize: 13 }}>TOTAL BUDGET:</Text>
                      <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 13 }}>
                        {(isWizard
                          ? ((parseInt(sponsorReward || '0') + (sponsorStreak ? parseInt(streakReward || '0') : 0)) * wizardPoints.length + parseInt(setBonus || '0')) * parseInt(sponsorLimit || '0')
                          : ((parseInt(sponsorReward || '0') + (sponsorStreak ? parseInt(streakReward || '0') : 0)) * parseInt(sponsorLimit || '0'))
                        ).toLocaleString()} SATS
                      </Text>
                    </View>
                  ) : null}

                  {/* Standard POI Fields (Only if not in Wizard select/reward steps OR if in Single POI mode) */}
                  {(!isWizard || (isWizard && wizardStep === 3)) && (
                    <>
                      <Text style={[styles.settingsLabel, { color: '#eab308' }]}>MAX USERS (TOTAL LIMIT)</Text>
                      <TextInput style={[styles.keyInput, { borderColor: 'rgba(234,179,8,0.3)' }]} keyboardType="numeric" value={sponsorLimit} onChangeText={setSponsorLimit} placeholder="e.g. 100" />

                      <Text style={[styles.settingsLabel, { color: '#eab308' }]}>REWARD FREQUENCY</Text>
                      <View style={{ flexDirection: 'row', gap: 5, marginBottom: 12 }}>
                        {[{ id: 'once', label: 'Once' }, { id: 'daily', label: 'Daily' }, { id: 'hourly', label: 'Hourly' }].map(opt => (
                          <TouchableOpacity key={opt.id} style={{ flex: 1, backgroundColor: sponsorFreq === opt.id ? '#eab308' : 'rgba(255,255,255,0.1)', paddingVertical: 8, borderRadius: 6, alignItems: 'center' }} onPress={() => setSponsorFreq(opt.id as any)}>
                            <Text style={{ color: sponsorFreq === opt.id ? '#000' : '#fff', fontWeight: 'bold', fontSize: 10 }}>{opt.label.toUpperCase()}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>

                      <Text style={[styles.settingsLabel, { color: '#eab308' }]}>SPONSORSHIP BOT</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexDirection: 'row', marginBottom: 12 }}>
                        {approvedBots.map(bot => (
                          <TouchableOpacity
                            key={bot.pubkey}
                            style={{
                              backgroundColor: (!isManualBot && sponsorBot === bot.pubkey) ? '#eab308' : 'rgba(255,255,255,0.05)',
                              paddingHorizontal: 12,
                              paddingVertical: 8,
                              borderRadius: 20,
                              marginRight: 8,
                              borderWidth: 1,
                              borderColor: (!isManualBot && sponsorBot === bot.pubkey) ? '#eab308' : 'rgba(255,255,255,0.1)'
                            }}
                            onPress={() => { setSponsorBot(bot.pubkey); setIsManualBot(false); }}
                          >
                            <Text style={{ color: (!isManualBot && sponsorBot === bot.pubkey) ? '#000' : '#fff', fontWeight: 'bold', fontSize: 11 }}>{bot.name.toUpperCase()}</Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>

                      <Text style={[styles.settingsLabel, { color: '#eab308' }]}>DURATION (DAYS)</Text>
                      <View style={{ flexDirection: 'row', gap: 5, marginBottom: 12 }}>
                        {['1d', '3d', '7d', '14d', '30d'].map(d => (
                          <TouchableOpacity key={d} style={{ flex: 1, backgroundColor: sponsorEndDays === d ? '#eab308' : 'rgba(255,255,255,0.1)', paddingVertical: 8, borderRadius: 6, alignItems: 'center' }} onPress={() => setSponsorEndDays(d)}>
                            <Text style={{ color: sponsorEndDays === d ? '#000' : '#fff', fontWeight: 'bold' }}>{d.toUpperCase()}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </>
                  )}

                  {!isWizard && (
                    <>
                      <Text style={[styles.settingsLabel, { color: '#eab308' }]}>RADIUS (METERS)</Text>
                      <TextInput style={[styles.keyInput, { borderColor: 'rgba(234,179,8,0.3)' }]} keyboardType="numeric" value={sponsorRadius} onChangeText={setSponsorRadius} />

                      <Text style={[styles.settingsLabel, { color: '#eab308' }]}>LOCATION</Text>
                      <TouchableOpacity
                        style={[styles.keyInput, { borderColor: sponsorLocation ? '#eab308' : 'rgba(234,179,8,0.3)', alignItems: 'center', justifyContent: 'center' }]}
                        onPress={() => { setIsSelectingLocation(true); setShowSchedule(false); }}
                      >
                        <Text style={{ color: sponsorLocation ? '#fff' : 'rgba(255,255,255,0.5)' }}>
                          {sponsorLocation ? `📍 ${sponsorLocation.lat.toFixed(4)}, ${sponsorLocation.lng.toFixed(4)}` : '🎯 TAP MAP TO SET'}
                        </Text>
                      </TouchableOpacity>
                    </>
                  )}
                  {isWizard && wizardStep === 2 && (
                    <View style={{ gap: 12, marginBottom: 16 }}>
                      <Text style={[styles.settingsLabel, { color: '#eab308', marginBottom: 4 }]}>SELECTED CHECKPOINTS ({wizardPoints.length})</Text>
                      {wizardPoints.map((pt, idx) => (
                        <View key={pt.id} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.05)', padding: 8, borderRadius: 8, gap: 10 }}>
                          <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: '#eab308', alignItems: 'center', justifyContent: 'center' }}>
                            <Text style={{ fontWeight: 'bold' }}>{idx + 1}</Text>
                          </View>
                          <Text style={{ color: '#fff', flex: 1 }}>{pt.title}</Text>
                          <TouchableOpacity onPress={() => setWizardPoints(prev => prev.filter(p => p.id !== pt.id))}><X size={18} color="#ff4d4f" /></TouchableOpacity>
                        </View>
                      ))}

                      {/* Dropdown for existing POIs */}
                      <Text style={[styles.settingsLabel, { color: '#00ccff', marginTop: 8 }]}>ADD EXISTING POI</Text>
                      <View style={{ gap: 6 }}>
                        {checkpoints
                          .filter(cp => cp.hexPubkey === currentHex && (cp.endTime === 0 || cp.endTime > Math.floor(Date.now() / 1000)) && !wizardPoints.find(p => p.id === cp.id))
                          .length === 0 ? (
                          <Text style={{ color: '#666', fontSize: 12, fontStyle: 'italic' }}>No other active POIs available.</Text>
                        ) : (
                          checkpoints
                            .filter(cp => cp.hexPubkey === currentHex && (cp.endTime === 0 || cp.endTime > Math.floor(Date.now() / 1000)) && !wizardPoints.find(p => p.id === cp.id))
                            .map(cp => (
                              <TouchableOpacity
                                key={cp.id}
                                style={{ padding: 10, backgroundColor: 'rgba(0,204,255,0.1)', borderRadius: 8, borderLeftWidth: 3, borderLeftColor: '#00ccff' }}
                                onPress={() => setWizardPoints(prev => [...prev, { id: cp.id, title: cp.title, lat: cp.location.lat, lng: cp.location.lng, description: cp.description, type: 'existing' }])}
                              >
                                <Text style={{ color: '#00ccff', fontWeight: 'bold', fontSize: 13 }}>+ {cp.title}</Text>
                              </TouchableOpacity>
                            ))
                        )}
                      </View>

                      <TouchableOpacity
                        style={{ padding: 12, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 8, alignItems: 'center', borderStyle: 'dashed', borderWidth: 1, borderColor: '#ccc', marginTop: 8 }}
                        onPress={() => { setIsSelectingLocation(true); setShowSchedule(false); setActiveNewPoint({ type: 'new' }); }}
                      >
                        <Text style={{ color: '#fff' }}>🎯 ADD NEW POINT VIA MAP</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  <View style={{ backgroundColor: 'rgba(255,255,255,0.05)', padding: 12, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', marginTop: 12 }}>
                    <Text style={{ color: '#fff', fontSize: 12, fontWeight: 'bold', marginBottom: 8 }}>💰 FUNDING ESTIMATE</Text>
                    {(() => {
                      const r = parseInt(sponsorReward || '0');
                      const sR = sponsorStreak ? parseInt(streakReward || '0') : 0;
                      const l = parseInt(sponsorLimit || '1');
                      const sB = isWizard ? (parseInt(setBonus || '0')) : 0;
                      const subtotal = isWizard ? ((r + sR) * wizardPoints.length + sB) * l : (r + sR) * l;
                      const bot = approvedBots.find(b => b.pubkey === sponsorBot);
                      const feePct = bot?.feePct || 5;
                      const fee = Math.ceil(subtotal * (feePct / 100));
                      return (
                        <>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                            <Text style={{ color: '#aaa', fontSize: 12 }}>Base + Streak ({wizardPoints.length > 0 && isWizard ? (r + sR) + '*' + wizardPoints.length : r + sR})</Text>
                            <Text style={{ color: '#fff', fontSize: 12 }}>{((r + sR) * (isWizard ? wizardPoints.length : 1)).toLocaleString()} sats</Text>
                          </View>
                          {isWizard && (
                            <View style={{ marginBottom: 6 }}>
                              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
                                <Text style={{ color: '#aaa', fontSize: 12 }}>Set Bonus</Text>
                                <Text style={{ color: '#fff', fontSize: 12 }}>{sB.toLocaleString()} sats</Text>
                              </View>
                              <Text style={{ color: '#888', fontSize: 10, fontStyle: 'italic', marginLeft: 4 }}>* Paid once all unique points in set are visited (any number of rides).</Text>
                            </View>
                          )}
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                            <Text style={{ color: '#aaa', fontSize: 12 }}>Total Subtotal (x{l} riders)</Text>
                            <Text style={{ color: '#fff', fontSize: 12 }}>{subtotal.toLocaleString()} sats</Text>
                          </View>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                            <Text style={{ color: '#eab308', fontSize: 12 }}>Platform Fee ({feePct}%)</Text>
                            <Text style={{ color: '#eab308', fontSize: 12 }}>{fee.toLocaleString()} sats</Text>
                          </View>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, backgroundColor: 'rgba(234,179,8,0.1)', padding: 8, borderRadius: 6 }}>
                            <Text style={{ color: '#eab308', fontWeight: 'bold', fontSize: 13 }}>TOTAL ESCROW</Text>
                            <Text style={{ color: '#eab308', fontWeight: 'bold', fontSize: 13 }}>{(subtotal + fee).toLocaleString()} SATS</Text>
                          </View>
                        </>
                      );
                    })()}
                  </View>
                </View>
              )}
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
                  <TextInput style={styles.keyInput} placeholder="e.g. 123 Main St Coffee Shop" placeholderTextColor="rgba(255,255,255,0.3)" value={schedLocation} onChangeText={setSchedLocation} />
                  
                  <View style={{ flexDirection: 'row', gap: 10, marginTop: -6, marginBottom: 16 }}>
                    <TouchableOpacity 
                      style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(0,255,170,0.1)', borderWidth: 1, borderColor: 'rgba(0,255,170,0.2)', paddingVertical: 8, borderRadius: 8 }}
                      onPress={() => {
                        setIsSelectingSchedRideLocation(true);
                        setShowSchedule(false);
                      }}
                    >
                      <Map size={14} color="#00ffaa" />
                      <Text style={{ color: '#00ffaa', fontWeight: 'bold', fontSize: 11 }}>TAP MAP</Text>
                    </TouchableOpacity>

                    <TouchableOpacity 
                      style={{ flex: 1.2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', paddingVertical: 8, borderRadius: 8 }}
                      onPress={async () => {
                        try {
                          const { status } = await Location.requestForegroundPermissionsAsync();
                          if (status !== 'granted') return;
                          const pos = await Location.getCurrentPositionAsync({});
                          const addr = await Location.reverseGeocodeAsync({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
                          if (addr.length > 0) {
                            const a = addr[0];
                            const str = [a.name, a.street, a.city].filter(Boolean).join(', ');
                            if (str) setSchedLocation(str);
                            else setSchedLocation(`${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`);
                          } else {
                            setSchedLocation(`${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`);
                          }
                        } catch (e) {}
                      }}
                    >
                      <Navigation size={14} color="#aaa" />
                      <Text style={{ color: '#aaa', fontWeight: 'bold', fontSize: 11 }}>GET CURRENT</Text>
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
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginBottom: 16 }}>
                    {[
                      { id: 'most_miles', label: 'Most Miles' },
                      { id: 'most_rides', label: 'Most Rides' },
                      { id: 'total_elevation', label: 'Total Elevation' },
                      { id: 'fastest_mile', label: 'Fastest Mile' },
                      { id: 'max_elevation', label: 'Max Elev Gain' },
                      { id: 'max_distance', label: 'Longest Ride' }
                    ].map(opt => (
                      <TouchableOpacity key={opt.id} style={{ width: '48%', backgroundColor: contestParam === opt.id ? '#00ffaa' : 'rgba(255,255,255,0.1)', paddingVertical: 10, borderRadius: 8, alignItems: 'center', borderColor: 'rgba(255,255,255,0.3)', borderWidth: 1, marginBottom: 5 }} onPress={() => setContestParam(opt.id as any)}>
                        <Text style={{ color: contestParam === opt.id ? '#000' : '#fff', fontWeight: 'bold', fontSize: 11 }}>{opt.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={[styles.settingsLabel, { marginTop: 8 }]}>ENTRY FEE (SATS)</Text>
                  <TextInput style={[styles.keyInput, { marginBottom: 16 }]} keyboardType="number-pad" value={contestFee} onChangeText={setContestFee} placeholder="e.g. 5000" />

                  <View style={{ backgroundColor: 'rgba(91,208,255,0.05)', padding: 12, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(91,208,255,0.2)', marginBottom: 16 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text style={{ color: '#5bd0ff', fontSize: 12, fontWeight: 'bold' }}>PLATFORM FEE (ONCE)</Text>
                      <Text style={{ color: '#fff', fontSize: 12, fontWeight: 'bold' }}>25 sats</Text>
                    </View>
                    <Text style={{ color: '#aaa', fontSize: 10, fontStyle: 'italic' }}>Note: Participants will pay the entry fee when joining. Fees are held by the Escrow Bot and distributed to winners.</Text>
                  </View>

                  <Text style={[styles.settingsLabel, { marginTop: 8 }]}>PRIVATE INVITES (OPTIONAL NPUBS)</Text>
                  <Text style={styles.settingsHelp}>Leave blank for Global. Comma-separated npubs to restrict entry.</Text>
                  <TextInput style={[styles.keyInput, { marginBottom: 16, marginTop: 8, height: 60 }]} multiline placeholder="npub1..., npub1..." placeholderTextColor="#666" value={contestInvites} onChangeText={setContestInvites} />
                </>
              )}

              <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
                {isWizard && (wizardStep > 1) && (
                  <TouchableOpacity
                    style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.1)', paddingVertical: 14, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' }}
                    onPress={() => setWizardStep(prev => prev - 1)}
                  >
                    <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 14, letterSpacing: 1 }}>BACK</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={[styles.saveButton, { flex: 2, marginTop: 0 }]}
                  onPress={async () => {
                    // Wizard Navigation for Steps 1 and 2
                    if (isWizard && wizardStep < 3) {
                      if (wizardStep === 2 && wizardPoints.length === 0) {
                        Alert.alert("No Points", "Please add at least one point to your scavenger hunt.");
                        return;
                      }
                      setWizardStep(prev => prev + 1);
                      return;
                    }

                    if (!schedName || !schedDate) { Alert.alert("Missing Fields", "Please fill in the Name and Date."); return; }
                    if (schedType === 'ride' && !schedLocation) { Alert.alert("Missing Fields", "Please specify a location."); return; }

                    try {
                      if (schedType === 'ride') {
                        let startUnix = Math.floor(schedDate.getTime() / 1000);
                        let eventsToCreate = schedCadence === 'none' ? 1 : schedOccurrences;
                        for (let i = 0; i < eventsToCreate; i++) {
                          await publishScheduledRide(schedName, schedCadence !== 'none' ? `${schedDesc}\n\n(Recurring Ride)` : schedDesc, startUnix, schedLocation, undefined, schedImage || undefined);
                          if (schedCadence === 'weekly') startUnix += 7 * 24 * 60 * 60;
                          else if (schedCadence === 'biweekly') startUnix += 14 * 24 * 60 * 60;
                          else if (schedCadence === 'monthly') startUnix += 28 * 24 * 60 * 60;
                        }
                        setScheduledRides(await fetchScheduledRides());
                        setFeedTab('rides');
                        Alert.alert("Success", "Published to Nostr!");
                      } else if (schedType === 'sponsor') {
                        if (!schedName || (!isWizard && !sponsorLocation)) { Alert.alert("Missing Fields", "Please provide a name and select a location."); return; }
                        setIsSponsoring(true);
                        try {
                          const rewardInt = parseInt(sponsorReward || '0', 10);
                          const limitInt = parseInt(sponsorLimit || '1', 10);
                          const sR = sponsorStreak ? parseInt(streakReward || '0', 10) : 0;
                          const sB = isWizard ? parseInt(setBonus || '0', 10) : 0;
                          const bot = approvedBots.find(b => b.pubkey === sponsorBot);
                          const feePct = bot?.feePct || 5;

                          // Total Budget including fee
                          const subtotal = isWizard ? ((rewardInt + sR) * wizardPoints.length + sB) * limitInt : (rewardInt + sR) * limitInt;
                          const totalBudget = Math.ceil(subtotal * (1 + (feePct / 100)));

                          if (!isNWCConnected) {
                            Alert.alert("Wallet Required", "Connect your Lightning Wallet in Settings to fund this sponsorship.");
                            setIsSponsoring(false);
                            return;
                          }

                          // Step 1: Confirm payment
                          const confirmed = await new Promise((resolve) => {
                            Alert.alert(
                              "Confirm Sponsorship",
                              `Sponsoring ${isWizard ? wizardPoints.length + ' points' : 'checkpoint'} for a total of ${totalBudget} sats.\n\n` +
                              `Base/Point: ${rewardInt} sats\n` +
                              (sponsorStreak ? `Streak Bonus: ${sR} sats (${sponsorDays} days)\n` : "") +
                              (isWizard ? `Set Bonus: ${sB} sats\n` : "") +
                              `Fee (${feePct}%): ${Math.ceil(subtotal * (feePct / 100))} sats`,
                              [
                                { text: "Cancel", onPress: () => resolve(false), style: "cancel" },
                                { text: `⚡ PAY ${totalBudget} SATS`, onPress: () => resolve(true) }
                              ]
                            );
                          });

                          if (!confirmed) {
                            setIsSponsoring(false);
                            return;
                          }

                          await logEvent(`💎 Sponsoring ${isWizard ? 'Campaign' : 'POI'}: ${schedName} (${totalBudget} sats)`);

                          // Ensure bot pubkey is hex
                          let botHex = sponsorBot || ESCROW_PUBKEY;
                          if (botHex.startsWith('npub')) {
                            try {
                              const { nip19 } = require('nostr-tools');
                              const decoded = nip19.decode(botHex);
                              if (decoded.type === 'npub') botHex = decoded.data;
                            } catch (e) {
                              console.error("Failed to decode bot npub", e);
                            }
                          }

                          const startUnixS = Math.floor(Date.now() / 1000);
                          const durDays = parseInt(sponsorEndDays.replace('d', '')) || 30;
                          const endUnixS = startUnixS + (durDays * 86400);

                          const pointsToPublish = isWizard ? wizardPoints : [{ title: schedName, lat: sponsorLocation?.lat || 0, lng: sponsorLocation?.lng || 0 }];

                          for (let i = 0; i < pointsToPublish.length; i++) {
                            const pt = pointsToPublish[i];
                            const event = await prepareCheckpointEvent(
                              pt.title,
                              pt.description || schedDesc || "",
                              pt.lat,
                              pt.lng,
                              rewardInt,
                              parseInt(sponsorRadius, 10),
                              startUnixS,
                              endUnixS,
                              botHex,
                              sponsorFreq,
                              limitInt,
                              (isCampaign || isWizard) ? (rsvpRequired ? 'required' : 'optional') : undefined,
                              sR > 0 ? sR : undefined,
                              i === pointsToPublish.length - 1 ? sB : 0, // only last point gets the set bonus
                              isWizard ? (cpSetName || schedName) : undefined,
                              pt.type === 'existing' ? pt.id : undefined,
                              i,
                              sponsorStreak ? parseInt(sponsorDays, 10) : 0
                            );

                            if (i === 0) {
                              // Step 3: Upfront escrow payment (once for the whole set)
                              const paid = await zapRideEvent(event.id, botHex, 33402, totalBudget, `Sponsorship Funding: ${schedName}`);
                              if (!paid) {
                                throw new Error("Payment failed or was cancelled.");
                              }
                            }

                            // Step 4: Publish funded event
                            await event.publish();
                          }

                          fetchCheckpoints().then(setCheckpoints).catch(() => { });
                          setFeedTab('sponsors');
                          Alert.alert("Success", isWizard ? "Scavenger Hunt published and funded!" : "Checkpoint sponsored and funded!");
                        } catch (e: any) {
                          Alert.alert("Publishing Failed", e.message || "Unknown error");
                          setIsSponsoring(false);
                        } finally {
                          setIsSponsoring(false);
                        }
                      } else {
                        // Challenge / Contest
                        setIsSponsoring(true);
                        try {
                          const startUnix = Math.floor(schedDate.getTime() / 1000);
                          const durStr = contestEndDays;
                          const durSeconds = durStr.endsWith('h')
                            ? parseInt(durStr) * 3600
                            : (parseInt(durStr) || 1) * 86400;
                          const endUnix = startUnix + durSeconds;
                          const feeInt = parseInt(contestFee) || 0;
                          const pubkeys = contestInvites.split(',').map(s => s.trim()).filter(s => s.startsWith('npub'));

                          const contestEvent = await prepareContestEvent(schedName, schedDesc, startUnix, endUnix, contestParam, feeInt, pubkeys);
                          await contestEvent.publish();

                          fetchContests().then(setActiveContests);
                          setFeedTab('contests');
                          Alert.alert("Success", "Challenge published!");
                        } catch (e: any) {
                          Alert.alert("Error", e.message || "Unknown error occurred");
                          setIsSponsoring(false);
                        } finally {
                          setIsSponsoring(false);
                        }
                      }

                      // Common success cleanup
                      setSchedName(''); setSchedDesc(''); setSchedLocation(''); setSchedImage(''); setSchedCadence('none'); setSchedOccurrences(2); setContestInvites('');
                      setCpSetName(''); setSetBonus('0'); setCpRouteIndex('0'); setIsCampaign(false);
                      setShowSchedule(false);
                      setShowFeed(true);
                    } catch (e: any) {
                      Alert.alert("Error", e.message || "Unknown error occurred");
                    }
                  }}>
                  <Text style={styles.saveButtonText}>
                    {isWizard && wizardStep < 3 ? 'NEXT' : (isSponsoring ? 'PROCESSING...' : (schedType === 'ride' ? 'PUBLISH SCHEDULED RIDE' : (schedType === 'sponsor' ? 'SPONSOR POI' : '⚡ PUBLISH CHALLENGE')))}
                  </Text>
                </TouchableOpacity>
              </View>
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
                  
                  <View style={{ flexDirection: 'row', gap: 10, marginTop: -6, marginBottom: 16 }}>
                    <TouchableOpacity 
                      style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(0,255,170,0.1)', borderWidth: 1, borderColor: 'rgba(0,255,170,0.2)', paddingVertical: 8, borderRadius: 8 }}
                      onPress={() => {
                        setIsSelectingPostRideLocation(true);
                        setShowPostRideModal(false);
                      }}
                    >
                      <Map size={14} color="#00ffaa" />
                      <Text style={{ color: '#00ffaa', fontWeight: 'bold', fontSize: 11 }}>TAP MAP</Text>
                    </TouchableOpacity>

                    <TouchableOpacity 
                      style={{ flex: 1.2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', paddingVertical: 8, borderRadius: 8 }}
                      onPress={async () => {
                        try {
                          const { status } = await Location.requestForegroundPermissionsAsync();
                          if (status !== 'granted') return;
                          const pos = await Location.getCurrentPositionAsync({});
                          const addr = await Location.reverseGeocodeAsync({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
                          if (addr.length > 0) {
                            const a = addr[0];
                            const str = [a.name, a.street, a.city].filter(Boolean).join(', ');
                            if (str) setPostRideLocation(str);
                            else setPostRideLocation(`${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`);
                          } else {
                            setPostRideLocation(`${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`);
                          }
                        } catch (e) {}
                      }}
                    >
                      <Navigation size={14} color="#aaa" />
                      <Text style={{ color: '#aaa', fontWeight: 'bold', fontSize: 11 }}>GET CURRENT</Text>
                    </TouchableOpacity>
                  </View>
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
              <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12, backgroundColor: 'rgba(255,255,255,0.05)', padding: 12, borderRadius: 8 }} onPress={() => setTrimTails(!trimTails)}>
                <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: trimTails ? '#00ffaa' : 'rgba(255,255,255,0.3)', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
                  {trimTails && <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#00ffaa' }} />}
                </View>
                <Text style={{ color: '#fff', flex: 1 }}>Trim 0.1 miles from Start/End of Route for Privacy</Text>
              </TouchableOpacity>
              <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8, backgroundColor: 'rgba(0,255,170,0.05)', borderWidth: 1, borderColor: 'rgba(0,255,170,0.1)', padding: 12, borderRadius: 8 }} onPress={() => setShareToFeed(!shareToFeed)}>
                <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: shareToFeed ? '#00ffaa' : 'rgba(255,255,255,0.3)', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
                  {shareToFeed && <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#00ffaa' }} />}
                </View>
                <Text style={{ color: '#fff', flex: 1 }}>Share to Global Social Feed (Kind 1)</Text>
              </TouchableOpacity>
              <TouchableOpacity style={{ display: 'none', flexDirection: 'row', alignItems: 'center', marginBottom: 16, backgroundColor: 'rgba(0,170,255,0.05)', borderWidth: 1, borderColor: 'rgba(0,170,255,0.1)', padding: 12, borderRadius: 8 }} onPress={() => setShareToChat(!shareToChat)}>
                <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: shareToChat ? '#00ccff' : 'rgba(255,255,255,0.3)', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
                  {shareToChat && <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#00ccff' }} />}
                </View>
                <Text style={{ color: '#fff', flex: 1 }}>Share to Global Bikel Chat (Kind 42)</Text>
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
                <TouchableOpacity disabled={isSponsoring} style={[styles.saveButton, { flex: 2, backgroundColor: postRideSponsorMode ? '#eab308' : '#00ffaa' }]} onPress={async () => {
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
                      await logEvent(`📅 Scheduling ride: ${postRideTitle || "Untitled"}`);
                      await publishScheduledRide(postRideTitle || "Group Ride", postRideDesc || "Join my ride!", startUnix, postRideLocation, routePoints, postRideImageUrl, distance, duration);
                      const rideEventId = await publishRide(distance, duration, routePoints, postRidePrivacy, postRideTitle, postRideDesc, postRideImageUrl, confidenceToPost, elevation, sessionCheckpointHit || undefined, logEvent);

                      if (shareToFeed && rideEventId) {
                        const profile = profiles[currentHex];
                        const nick = profile?.nip05 || profile?.name || "A rider";
                        let content = `${nick} just scheduled a ride: ${postRideTitle || "Untitled"}\n\nDistance: ${distance.toFixed(2)} mi\nMeeting: ${postRideLocation}\n\n#bikel #cycling #nostr`;
                        await publishSocialNote(content, rideEventId);
                      }

                      if (shareToChat && rideEventId) {
                        const profile = profiles[currentHex];
                        const nick = profile?.nip05 || profile?.name || "A rider";
                        let content = `${nick} scheduled a ride: ${postRideTitle || "Untitled"} 🚲\nDistance: ${distance.toFixed(2)} mi\nMeeting: ${postRideLocation}`;
                        await publishChannelMessage(content, rideEventId);
                      }

                      Alert.alert("Ride Scheduled!", "Your group ride was published.");
                    } else {
                      await logEvent(`📤 Posting ride: ${postRideTitle || "Untitled"}`);
                      const rideEventId = await publishRide(distance, duration, routePoints, postRidePrivacy, postRideTitle, postRideDesc, postRideImageUrl, confidenceToPost, elevation, sessionCheckpointHit || undefined, logEvent);

                      if (shareToFeed && rideEventId) {
                        const profile = profiles[currentHex];
                        const nick = profile?.nip05 || profile?.name || "A rider";
                        let content = `${nick} just finished a ride: ${postRideTitle || "Ride"}\n\nRode ${distance.toFixed(2)} miles in ${Math.floor(duration / 60)}m! 🚲\n\n#bikel #cycling #nostr`;
                        await publishSocialNote(content, rideEventId);
                      }

                      if (shareToChat && rideEventId) {
                        const profile = profiles[currentHex];
                        const nick = profile?.nip05 || profile?.name || "A rider";
                        let content = `${nick} finished a ride: ${postRideTitle || "Ride"} 🚲\nDistance: ${distance.toFixed(2)} mi\nTime: ${Math.floor(duration / 60)}m`;
                        await publishChannelMessage(content, rideEventId);
                      }

                      Alert.alert("Ride Published!", "Your ride was published to Nostr.");
                    }
                    setSessionCheckpointHit(null);

                    // If posting from draft, delete the draft
                    if (postingFromDraft) {
                      await deleteDraft(postingFromDraft.id);
                    }

                    setShowPostRideModal(false); setPostingFromDraft(null);
                    setDuration(0); setDistance(0); setElevation(0); setRoute([]);
                    setPostRideTitle(''); setPostRideDesc(''); setPostRideImageUrl('');
                    setPostRidePrivacy('full'); setPostRideScheduleMode(false);
                    try {
                      setMyRides(await fetchMyRides());
                      setMyClaims(await fetchMyClaims());
                      setGlobalRides(await fetchRecentRides());
                    } catch (e) { }
                  } catch (e: any) {
                    const errorMsg = e.message || "Unknown error";
                    await logEvent(`❌ PUBLISH ERROR: ${errorMsg}`);
                    Alert.alert("Failed to publish ride", errorMsg);
                    console.error("Failed to publish ride", e);
                  }
                }}>
                  <Text style={[styles.saveButtonText, { color: '#000' }]}>{isSponsoring ? 'SPONSORING...' : (postRideSponsorMode ? 'SPONSOR POI' : 'POST RIDE')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {/* Discussion Overlay */}
      {showDiscussion && selectedDiscussionRide && (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.historyOverlay, { zIndex: 2500 }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <Text style={styles.historyTitle}>Discussion</Text>
            <TouchableOpacity onPress={() => { setShowDiscussion(false); setSelectedDiscussionRide(null); setDiscussionFromSocial(false); }} style={{ padding: 4 }}><X size={24} color="#fff" /></TouchableOpacity>
          </View>
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            {comments.length === 0 ? <Text style={styles.emptyText}>No comments yet. Be the first!</Text> : comments.map(c => {
              const QUICK_C = ['🔥', '👍', '💪', '⚡'];
              const commentReactions = reactions[c.id] || [];
              const cp = profiles[c.hexPubkey || c.pubkey];
              const cn = cp?.nip05 || cp?.name || (c.hexPubkey || c.pubkey).substring(0, 10) + '...';
              const ca = cp?.picture;
              return (
                <View key={c.id} style={{ marginBottom: 12, backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' }}>
                  {/* Author row */}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <TouchableOpacity
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
                      onPress={() => {
                        const targetKey = c.hexPubkey || c.pubkey;
                        setShowDiscussion(false);
                        setViewingAuthor(targetKey);
                        setIsLoadingAuthor(true);
                        fetchUserRides(targetKey).then(setAuthorRides).finally(() => setIsLoadingAuthor(false));
                      }}
                    >
                      {ca
                        ? <Image source={{ uri: ca }} style={{ width: 24, height: 24, borderRadius: 12 }} />
                        : <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,255,170,0.15)', alignItems: 'center', justifyContent: 'center' }}>
                          <Text style={{ color: '#00ffaa', fontSize: 10, fontWeight: 'bold' }}>{cn.substring(0, 1).toUpperCase()}</Text>
                        </View>
                      }
                      <Text style={{ color: '#00ffaa', fontSize: 12, fontWeight: 'bold' }}>{cn}</Text>
                    </TouchableOpacity>
                    <Text style={{ color: '#555', fontSize: 11 }}>{new Date(c.createdAt * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })}</Text>
                  </View>
                  {/* Content */}
                  <Text style={{ color: '#eee', fontSize: 14, lineHeight: 20, marginBottom: 10 }}>{c.content}</Text>
                  {/* Reaction counts */}
                  {commentReactions.length > 0 && (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginBottom: 6 }}>
                      {commentReactions.map(r => (
                        <TouchableOpacity
                          key={r.emoji}
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: r.reactedByMe ? 'rgba(0,255,170,0.15)' : 'rgba(255,255,255,0.07)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 16, borderWidth: 1, borderColor: r.reactedByMe ? 'rgba(0,255,170,0.4)' : 'rgba(255,255,255,0.1)' }}
                          onPress={async () => {
                            if (r.reactedByMe && r.myReactionId) { await deleteReaction(r.myReactionId); }
                            else { await publishReaction(c.id, c.hexPubkey || c.pubkey, r.emoji); }
                            loadReactions(c.id);
                          }}
                        >
                          <Text style={{ fontSize: 12 }}>{r.emoji}</Text>
                          <Text style={{ color: r.reactedByMe ? '#00ffaa' : '#888', fontSize: 11, fontWeight: 'bold' }}>{r.count}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                  {/* Quick-react bar */}
                  <View style={{ flexDirection: 'row', gap: 4 }}>
                    {QUICK_C.map(emoji => {
                      const ex = commentReactions.find(r => r.emoji === emoji);
                      return (
                        <TouchableOpacity
                          key={emoji}
                          disabled={reactingId === c.id}
                          style={{ paddingHorizontal: 7, paddingVertical: 3, borderRadius: 12, backgroundColor: ex?.reactedByMe ? 'rgba(0,255,170,0.15)' : 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: ex?.reactedByMe ? 'rgba(0,255,170,0.35)' : 'transparent' }}
                          onPress={async () => {
                            if (emoji === '⚡') {
                              if (!isNWCConnected) { Alert.alert('Wallet Required', 'Connect your Lightning Wallet in Settings to send zaps.'); return; }
                              const author = c.hexPubkey || c.pubkey;
                              const displayName = profiles[author]?.nip05 || profiles[author]?.name || author.substring(0, 10) + '...';
                              Alert.alert('⚡ Send Zap', `Zap ${displayName} 21 sats?`, [
                                { text: 'Cancel', style: 'cancel' },
                                {
                                  text: 'Zap ⚡', onPress: async () => {
                                    setReactingId(c.id);
                                    try { await zapRideEvent(c.id, author, 1, 21, '⚡ Great comment!'); Alert.alert('⚡ Zapped!', `21 sats sent to ${displayName}!`); }
                                    catch (e: any) { Alert.alert('Zap Failed', e.message || 'Unknown error'); }
                                    setReactingId(null);
                                  }
                                },
                              ]);
                              return;
                            }
                            setReactingId(c.id);
                            if (ex?.reactedByMe && ex.myReactionId) { await deleteReaction(ex.myReactionId); }
                            else { await publishReaction(c.id, c.hexPubkey || c.pubkey, emoji); }
                            await loadReactions(c.id);
                            setReactingId(null);
                          }}
                        >
                          <Text style={{ fontSize: 13 }}>{emoji}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              );
            })}
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


      {/* Discussion Overlay */}
      {showDiscussion && selectedDiscussionRide && (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.historyOverlay, { zIndex: 2500 }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <Text style={styles.historyTitle}>Discussion</Text>
            <TouchableOpacity onPress={() => { setShowDiscussion(false); setSelectedDiscussionRide(null); setDiscussionFromSocial(false); }} style={{ padding: 4 }}><X size={24} color="#fff" /></TouchableOpacity>
          </View>
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            {comments.length === 0 ? <Text style={styles.emptyText}>No comments yet. Be the first!</Text> : comments.map(c => {
              const QUICK_C = ['🔥', '👍', '💪', '⚡'];
              const commentReactions = reactions[c.id] || [];
              const cp = profiles[c.hexPubkey || c.pubkey];
              const cn = cp?.nip05 || cp?.name || (c.hexPubkey || c.pubkey).substring(0, 10) + '...';
              const ca = cp?.picture;
              return (
                <View key={c.id} style={{ marginBottom: 12, backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' }}>
                  {/* Author row */}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <TouchableOpacity
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
                      onPress={() => {
                        const targetKey = c.hexPubkey || c.pubkey;
                        setShowDiscussion(false);
                        setViewingAuthor(targetKey);
                        setIsLoadingAuthor(true);
                        fetchUserRides(targetKey).then(setAuthorRides).finally(() => setIsLoadingAuthor(false));
                      }}
                    >
                      {ca
                        ? <Image source={{ uri: ca }} style={{ width: 24, height: 24, borderRadius: 12 }} />
                        : <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,255,170,0.15)', alignItems: 'center', justifyContent: 'center' }}>
                          <Text style={{ color: '#00ffaa', fontSize: 10, fontWeight: 'bold' }}>{cn.substring(0, 1).toUpperCase()}</Text>
                        </View>
                      }
                      <Text style={{ color: '#00ffaa', fontSize: 12, fontWeight: 'bold' }}>{cn}</Text>
                    </TouchableOpacity>
                    <Text style={{ color: '#555', fontSize: 11 }}>{new Date(c.createdAt * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })}</Text>
                  </View>
                  {/* Content */}
                  <Text style={{ color: '#eee', fontSize: 14, lineHeight: 20, marginBottom: 10 }}>{c.content}</Text>
                  {/* Reaction counts */}
                  {commentReactions.length > 0 && (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginBottom: 6 }}>
                      {commentReactions.map(r => (
                        <TouchableOpacity
                          key={r.emoji}
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: r.reactedByMe ? 'rgba(0,255,170,0.15)' : 'rgba(255,255,255,0.07)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 16, borderWidth: 1, borderColor: r.reactedByMe ? 'rgba(0,255,170,0.4)' : 'rgba(255,255,255,0.1)' }}
                          onPress={async () => {
                            if (r.reactedByMe && r.myReactionId) { await deleteReaction(r.myReactionId); }
                            else { await publishReaction(c.id, c.hexPubkey || c.pubkey, r.emoji); }
                            loadReactions(c.id);
                          }}
                        >
                          <Text style={{ fontSize: 12 }}>{r.emoji}</Text>
                          <Text style={{ color: r.reactedByMe ? '#00ffaa' : '#888', fontSize: 11, fontWeight: 'bold' }}>{r.count}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                  {/* Quick-react bar */}
                  <View style={{ flexDirection: 'row', gap: 4 }}>
                    {QUICK_C.map(emoji => {
                      const ex = commentReactions.find(r => r.emoji === emoji);
                      return (
                        <TouchableOpacity
                          key={emoji}
                          disabled={reactingId === c.id}
                          style={{ paddingHorizontal: 7, paddingVertical: 3, borderRadius: 12, backgroundColor: ex?.reactedByMe ? 'rgba(0,255,170,0.15)' : 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: ex?.reactedByMe ? 'rgba(0,255,170,0.35)' : 'transparent' }}
                          onPress={async () => {
                            if (emoji === '⚡') {
                              if (!isNWCConnected) { Alert.alert('Wallet Required', 'Connect your Lightning Wallet in Settings to send zaps.'); return; }
                              const author = c.hexPubkey || c.pubkey;
                              const displayName = profiles[author]?.nip05 || profiles[author]?.name || author.substring(0, 10) + '...';
                              Alert.alert('⚡ Send Zap', `Zap ${displayName} 21 sats?`, [
                                { text: 'Cancel', style: 'cancel' },
                                {
                                  text: 'Zap ⚡', onPress: async () => {
                                    setReactingId(c.id);
                                    try { await zapRideEvent(c.id, author, 1, 21, '⚡ Great comment!'); Alert.alert('⚡ Zapped!', `21 sats sent to ${displayName}!`); }
                                    catch (e: any) { Alert.alert('Zap Failed', e.message || 'Unknown error'); }
                                    setReactingId(null);
                                  }
                                },
                              ]);
                              return;
                            }
                            setReactingId(c.id);
                            if (ex?.reactedByMe && ex.myReactionId) { await deleteReaction(ex.myReactionId); }
                            else { await publishReaction(c.id, c.hexPubkey || c.pubkey, emoji); }
                            await loadReactions(c.id);
                            setReactingId(null);
                          }}
                        >
                          <Text style={{ fontSize: 13 }}>{emoji}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              );
            })}
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
  historyOverlay: { position: 'absolute', top: Platform.OS === 'ios' ? 120 : 100, left: 20, right: 20, bottom: 120, backgroundColor: 'rgba(13, 15, 18, 0.95)', borderRadius: 20, padding: 20, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.1)', zIndex: 2000 },
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