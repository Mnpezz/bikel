import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Dimensions, Platform, ScrollView, TextInput, Alert, KeyboardAvoidingView, ActivityIndicator, Image, RefreshControl } from 'react-native';
import * as Location from 'expo-location';
import { LeafletView, MapLayerType, MapShapeType } from 'react-native-leaflet-view';
import { Bike, Square, Play, Zap, History, Settings, CalendarPlus, X, MessageSquare, Globe, LocateFixed } from 'lucide-react-native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as Clipboard from 'expo-clipboard';
import { connectNDK, publishRide, fetchMyRides, getPrivateKeyNsec, getPublicKeyNpub, getPublicKeyHex, setPrivateKey, publishScheduledRide, publishContestEvent, fetchContests, fetchRecentRides, fetchScheduledRides, publishRSVP, connectNWC, zapRideEvent, fetchComments, publishComment, fetchDMs, sendDM, fetchRideLeaderboard, ESCROW_PUBKEY, RideEvent, ScheduledRideEvent, ContestEvent, RideComment, DMessage } from './src/lib/nostr';
import * as SecureStore from 'expo-secure-store';

export default function App() {
  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [isTracking, setIsTracking] = useState(false);
  const [duration, setDuration] = useState(0);
  const [distance, setDistance] = useState(0); // in miles
  const [route, setRoute] = useState<Location.LocationObject[]>([]);
  const [myRides, setMyRides] = useState<RideEvent[]>([]);
  const [globalRides, setGlobalRides] = useState<RideEvent[]>([]);
  const [scheduledRides, setScheduledRides] = useState<ScheduledRideEvent[]>([]);
  const [activeContests, setActiveContests] = useState<ContestEvent[]>([]);
  const [selectedContest, setSelectedContest] = useState<ContestEvent | null>(null);
  const [contestLeaderboard, setContestLeaderboard] = useState<{ pubkey: string, value: number }[]>([]);
  const [isLoadingLeaderboard, setIsLoadingLeaderboard] = useState(false);
  const [selectedRoute, setSelectedRoute] = useState<{ lat: number, lng: number }[]>([]); // To display on map
  const [mapCenter, setMapCenter] = useState<{ lat: number, lng: number } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Modals
  const [showHistory, setShowHistory] = useState(false);
  const [showFeed, setShowFeed] = useState(false);
  const [feedTab, setFeedTab] = useState<'contests' | 'rides' | 'feed'>('feed');
  const [showSettings, setShowSettings] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [currentNsec, setCurrentNsec] = useState<string>('');
  const [currentNpub, setCurrentNpub] = useState<string>('');
  const [currentHex, setCurrentHex] = useState<string>('');
  const [newKeyInput, setNewKeyInput] = useState<string>('');
  const [shareRoute, setShareRoute] = useState(true);
  const trackingStartTimeRef = React.useRef<number | null>(null);

  // Post-Ride Modal States
  const [showPostRideModal, setShowPostRideModal] = useState(false);
  const [postRideTitle, setPostRideTitle] = useState('');
  const [postRideDesc, setPostRideDesc] = useState('');
  const [postRideImageUrl, setPostRideImageUrl] = useState('');
  const [postRidePrivacy, setPostRidePrivacy] = useState<'full' | 'hidden'>('full');
  const [postRideScheduleMode, setPostRideScheduleMode] = useState(false);
  const [trimTails, setTrimTails] = useState(true);
  const [postRideDate, setPostRideDate] = useState(new Date());
  const [postRideTime, setPostRideTime] = useState(new Date());
  const [postRideLocation, setPostRideLocation] = useState('');
  const [showPostRideDate, setShowPostRideDate] = useState(false);
  const [showPostRideTime, setShowPostRideTime] = useState(false);

  // Lightning Wallet states
  const [nwcURI, setNwcURI] = useState('');
  const [isNWCConnected, setIsNWCConnected] = useState(false);
  const [isZapping, setIsZapping] = useState(false);

  // Discussion states
  const [showDiscussion, setShowDiscussion] = useState(false);
  const [selectedDiscussionRide, setSelectedDiscussionRide] = useState<RideEvent | ScheduledRideEvent | null>(null);
  const [comments, setComments] = useState<RideComment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [isPublishingComment, setIsPublishingComment] = useState(false);

  // DM states
  const [activeDMUser, setActiveDMUser] = useState<string | null>(null);
  const [dmMessages, setDmMessages] = useState<DMessage[]>([]);
  const [newDMText, setNewDMText] = useState('');
  const [isSendingDM, setIsSendingDM] = useState(false);

  // Fetch DMs when chat is opened
  useEffect(() => {
    if (activeDMUser) {
      setDmMessages([]);
      fetchDMs(activeDMUser).then(setDmMessages);
    }
  }, [activeDMUser]);

  // Scheduling Form State
  const [schedName, setSchedName] = useState('');
  const [schedDesc, setSchedDesc] = useState('');
  const [schedLocation, setSchedLocation] = useState('');

  const [schedType, setSchedType] = useState<'ride' | 'contest'>('ride');
  const [contestEndDays, setContestEndDays] = useState('7');
  const [contestParam, setContestParam] = useState<'max_distance' | 'max_elevation' | 'fastest_mile'>('max_distance');
  const [contestFee, setContestFee] = useState('5000');
  const [contestInvites, setContestInvites] = useState('');

  const [schedCadence, setSchedCadence] = useState<'none' | 'weekly' | 'biweekly' | 'monthly'>('none');
  const [schedOccurrences, setSchedOccurrences] = useState(2);
  const [schedDate, setSchedDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [isGettingLocation, setIsGettingLocation] = useState(false);

  useEffect(() => {
    let mounted = true;
    // Initialize NDK on startup
    connectNDK().then(async () => {
      if (mounted) console.log('[NDK] Connected on load.');
    });

    (async () => {
      // Connect pending NWC URI
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

      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      let loc = await Location.getCurrentPositionAsync({});
      setLocation(loc);
      setMapCenter({ lat: loc.coords.latitude, lng: loc.coords.longitude });
    })();

    return () => { mounted = false; };
  }, []);

  // Fetch comments when a ride discussion is triggered
  useEffect(() => {
    if (showDiscussion && selectedDiscussionRide) {
      setComments([]);
      fetchComments(selectedDiscussionRide.id).then(setComments);
    }
  }, [showDiscussion, selectedDiscussionRide]);

  const loadFeeds = async () => {
    try {
      const personalRides = await fetchMyRides();
      setMyRides(personalRides);
    } catch (e: any) {
      console.error("fetchMyRides error:", e);
      Alert.alert("fetchMyRides error", e.message || String(e));
    }

    try {
      const recentRides = await fetchRecentRides();
      setGlobalRides(recentRides);
    } catch (e: any) {
      console.error("fetchRecentRides error:", e);
      Alert.alert("fetchRecentRides error", e.message || String(e));
    }

    try {
      const groupEvents = await fetchScheduledRides();
      setScheduledRides(groupEvents);
    } catch (e: any) {
      console.error("fetchScheduledRides error:", e);
      Alert.alert("fetchScheduledRides error", e.message || String(e));
    }

    try {
      const contests = await fetchContests();
      setActiveContests(contests);
    } catch (e) {
      console.error("fetchContests error:", e);
    }
  };

  const handleRefreshFeeds = async () => {
    setIsRefreshing(true);
    await loadFeeds();
    setIsRefreshing(false);
  };

  // Load My Rides, Global Feed, and Scheduled Rides
  useEffect(() => {
    loadFeeds();
  }, [showHistory, showFeed, showSchedule]); // Reload when these modals are opened

  // Distance Calc (Haversine in miles)
  const getDistanceMiles = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 3958.8; // Earth radius miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  };

  useEffect(() => {
    let interval: NodeJS.Timeout;
    let locationSubscription: Location.LocationSubscription | null = null;

    if (isTracking) {
      interval = setInterval(() => {
        if (trackingStartTimeRef.current) {
          setDuration(Math.floor((Date.now() - trackingStartTimeRef.current) / 1000));
        } else {
          setDuration(d => d + 1);
        }
      }, 1000);

      (async () => {
        locationSubscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            distanceInterval: 1,
            timeInterval: 1000,
          },
          (newLoc) => {
            setLocation(newLoc);
            setMapCenter({ lat: newLoc.coords.latitude, lng: newLoc.coords.longitude });
            setRoute(prevRoute => {
              const newRoute = [...prevRoute, newLoc];
              if (prevRoute.length > 0) {
                const lastLoc = prevRoute[prevRoute.length - 1];
                setDistance(d => d + getDistanceMiles(
                  lastLoc.coords.latitude, lastLoc.coords.longitude,
                  newLoc.coords.latitude, newLoc.coords.longitude
                ));
              }
              return newRoute;
            });
          }
        );
      })();
    }

    return () => {
      clearInterval(interval);
      if (locationSubscription) {
        locationSubscription.remove();
      }
    };
  }, [isTracking]);

  const toggleTracking = async () => {
    if (isTracking) {
      setIsTracking(false);
      trackingStartTimeRef.current = null;

      // Publish ride on finish
      if (route.length > 1 && distance >= 0.02) {
        setShowPostRideModal(true);
      } else {
        if (duration > 0 || route.length > 0) {
          Alert.alert("Stationary Ride Detected", "Not enough distance was covered. Make sure location services are enabled and you are actually moving to record a valid ride.");
        }
        setDuration(0);
        setDistance(0);
        setRoute([]);
      }
    } else {
      setDuration(0);
      setDistance(0);
      setRoute([]);
      setIsTracking(true);
      trackingStartTimeRef.current = Date.now();
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <View style={styles.container}>
      <View style={styles.map}>
        <LeafletView
          mapCenterPosition={
            mapCenter || (location ? { lat: location.coords.latitude, lng: location.coords.longitude } : { lat: 51.505, lng: -0.09 })
          }
          zoom={selectedRoute.length > 0 ? 12 : 13}
          mapLayers={[
            {
              baseLayerName: 'DarkMode',
              baseLayerIsChecked: true,
              layerType: MapLayerType.TILE_LAYER,
              baseLayer: true,
              url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            }
          ]}
          mapMarkers={location ? [{
            position: { lat: location.coords.latitude, lng: location.coords.longitude },
            icon: '🚴',
            size: [32, 32]
          }] : []}
          mapShapes={selectedRoute.length > 0 ? [
            {
              shapeType: MapShapeType.POLYLINE,
              positions: selectedRoute,
              color: "#00ccff",
            }
          ] : []}
        />
      </View>

      <TouchableOpacity
        style={{ position: 'absolute', bottom: 180, right: 20, backgroundColor: 'rgba(0,0,0,0.6)', padding: 12, borderRadius: 30 }}
        onPress={async () => {
          try {
            let loc = await Location.getLastKnownPositionAsync();
            if (!loc) loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
            if (loc) {
              setLocation(loc);
              setMapCenter({ lat: loc.coords.latitude, lng: loc.coords.longitude });
              setSelectedRoute([]);
            }
          } catch (e) { }
        }}
      >
        <LocateFixed size={24} color="#00ffaa" />
      </TouchableOpacity>

      {/* Header */}
      <View style={styles.headerPanel}>
        <View style={styles.logoContainer}>
          <Image source={require('./assets/bikelLogo.jpg')} style={{ width: 32, height: 32, borderRadius: 16 }} />
          <Text style={styles.headerText}>Bikel</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center' }}>
          <TouchableOpacity onPress={() => {
            setShowSettings(false);
            setShowHistory(false);
            setShowFeed(false);
            setShowSchedule(!showSchedule);
          }}>
            <CalendarPlus size={24} color={showSchedule ? "#00ffaa" : "#fff"} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => {
            setShowSettings(false);
            setShowSchedule(false);
            setShowHistory(false);
            setShowFeed(!showFeed);
          }}>
            <Globe size={24} color={showFeed ? "#00ffaa" : "#fff"} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => {
            setShowSettings(false);
            setShowSchedule(false);
            setShowFeed(false);
            setShowHistory(!showHistory);
          }}>
            <History size={24} color={showHistory ? "#00ffaa" : "#fff"} />
          </TouchableOpacity>
          <TouchableOpacity onPress={async () => {
            setShowHistory(false);
            setShowSchedule(false);
            setShowFeed(false);
            if (!showSettings) {
              try {
                const nsec = await getPrivateKeyNsec();
                const npub = await getPublicKeyNpub();
                const hex = await getPublicKeyHex();
                if (nsec) setCurrentNsec(nsec);
                if (npub) setCurrentNpub(npub);
                if (hex) setCurrentHex(hex);
              } catch (e) {
                console.error("Settings keys load error:", e);
              }
            }
            setShowSettings(!showSettings);
          }}>
            <Settings size={24} color={showSettings ? "#00ffaa" : "#fff"} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Settings Overlay View */}
      {showSettings && (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.historyOverlay}>
          <Text style={styles.historyTitle}>Settings</Text>
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            <View style={styles.settingsSection}>
              <Text style={styles.settingsLabel}>YOUR NPUB (PUBLIC IDENTITY)</Text>
              <Text style={styles.settingsKeyText} selectable={true}>{currentNpub}</Text>
              <Text style={styles.settingsLabel}>YOUR NSEC (SECRET KEY)</Text>
              <TouchableOpacity onPress={async () => {
                await Clipboard.setStringAsync(currentNsec);
                Alert.alert("Copied", "Secret key copied to clipboard.");
              }}>
                <Text style={styles.settingsKeyText}>
                  {currentNsec ? '•'.repeat(Math.min(currentNsec.length, 63)) : ''}
                </Text>
              </TouchableOpacity>
              <Text style={styles.settingsHelp}>Save your nsec somewhere safe. Never share it. Tap to copy.</Text>
            </View>

            <View style={styles.settingsSection}>
              <Text style={styles.settingsLabel}>IMPORT EXISTING KEY</Text>
              <TextInput
                style={styles.keyInput}
                placeholder="Paste nsec1... or hex key here"
                placeholderTextColor="rgba(255,255,255,0.3)"
                value={newKeyInput}
                onChangeText={setNewKeyInput}
                autoCapitalize="none"
              />
              <TouchableOpacity style={styles.saveButton} onPress={async () => {
                if (!newKeyInput) return;
                try {
                  await setPrivateKey(newKeyInput);
                  const newNsec = await getPrivateKeyNsec();
                  const newNpub = await getPublicKeyNpub();
                  const newHex = await getPublicKeyHex();
                  if (newNsec) setCurrentNsec(newNsec);
                  if (newNpub) setCurrentNpub(newNpub);
                  if (newHex) setCurrentHex(newHex);
                  setNewKeyInput('');
                  Alert.alert("Success", "Private key updated! It will be used for your next ride.");
                } catch (e: any) {
                  Alert.alert("Error", e.message);
                }
              }}>
                <Text style={styles.saveButtonText}>SAVE KEY</Text>
              </TouchableOpacity>
            </View>

            <View style={[styles.settingsSection, { marginBottom: 60 }]}>
              <Text style={styles.settingsLabel}>NOSTR WALLET CONNECT (NIP-47)</Text>
              <TextInput
                style={styles.keyInput}
                placeholder="nostr+walletconnect://..."
                placeholderTextColor="rgba(255,255,255,0.3)"
                value={nwcURI}
                onChangeText={setNwcURI}
                autoCapitalize="none"
              />
              <TouchableOpacity style={[styles.saveButton, { backgroundColor: '#eab308' }]} onPress={async () => {
                if (!nwcURI) return;
                try {
                  const success = await connectNWC(nwcURI);
                  if (success) {
                    await SecureStore.setItemAsync('bikel_nwc_uri', nwcURI);
                    setIsNWCConnected(true);
                    Alert.alert("Success", "Lightning Wallet Connected!");
                  } else {
                    Alert.alert("Error", "Could not connect. Check NWC URI.");
                  }
                } catch (e: any) {
                  Alert.alert("Error", e.message);
                }
              }}>
                <Text style={[styles.saveButtonText, { color: '#000' }]}>CONNECT WALLET</Text>
              </TouchableOpacity>
              {isNWCConnected && (
                <TouchableOpacity style={{ marginTop: 12, alignItems: 'center' }} onPress={async () => {
                  await SecureStore.deleteItemAsync('bikel_nwc_uri');
                  setNwcURI('');
                  setIsNWCConnected(false);
                }}>
                  <Text style={{ color: '#ff4d4f', fontWeight: 'bold' }}>Disconnect Wallet</Text>
                </TouchableOpacity>
              )}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {/* Ride History Overlay */}
      {showHistory && (
        <View style={styles.historyOverlay}>
          <Text style={styles.historyTitle}>My Rides</Text>
          <ScrollView style={{ flex: 1 }} refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefreshFeeds} tintColor="#fff" />}>
            {myRides.length === 0 ? (
              <Text style={styles.emptyText}>No rides recorded yet.</Text>
            ) : (
              myRides.map(r => (
                <View key={r.id} style={styles.historyCard}>
                  <Image source={r.image ? { uri: r.image } : require('./assets/bikelLogo.jpg')} style={{ width: '100%', height: 120, borderRadius: 8, marginBottom: 8 }} />
                  <Text style={styles.historyTime}>
                    {r.title || new Date(r.time * 1000).toLocaleDateString()}
                  </Text>
                  {r.description ? <Text style={{ color: '#ccc', fontSize: 13, marginBottom: 8 }}>{r.description}</Text> : null}
                  <View style={styles.historyStats}>
                    <Text style={styles.historyStat}>{r.distance} mi</Text>
                    <Text style={styles.historyStat}>{r.duration}</Text>
                  </View>
                </View>
              ))
            )}
          </ScrollView>
        </View>
      )}

      {/* Global & Scheduled Feed Overlay */}
      {showFeed && (
        <View style={styles.historyOverlay}>
          <Text style={styles.historyTitle}>Global Feed</Text>

          {/* Tab Switcher */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 8, padding: 4, marginBottom: 16 }}>
            <TouchableOpacity style={{ flex: 1, paddingVertical: 8, alignItems: 'center', backgroundColor: feedTab === 'contests' ? '#eab308' : 'transparent', borderRadius: 6 }} onPress={() => setFeedTab('contests')}>
              <Text style={{ color: feedTab === 'contests' ? '#000' : '#fff', fontWeight: 'bold', fontSize: 12 }}>CONTESTS</Text>
            </TouchableOpacity>
            <TouchableOpacity style={{ flex: 1, paddingVertical: 8, alignItems: 'center', backgroundColor: feedTab === 'rides' ? '#00ffaa' : 'transparent', borderRadius: 6 }} onPress={() => setFeedTab('rides')}>
              <Text style={{ color: feedTab === 'rides' ? '#000' : '#fff', fontWeight: 'bold', fontSize: 12 }}>GROUP RIDES</Text>
            </TouchableOpacity>
            <TouchableOpacity style={{ flex: 1, paddingVertical: 8, alignItems: 'center', backgroundColor: feedTab === 'feed' ? '#00ccff' : 'transparent', borderRadius: 6 }} onPress={() => setFeedTab('feed')}>
              <Text style={{ color: feedTab === 'feed' ? '#000' : '#fff', fontWeight: 'bold', fontSize: 12 }}>RECENT RIDES</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefreshFeeds} tintColor="#fff" />}>

            {feedTab === 'contests' && (
              <>
                <Text style={{ color: '#00ffaa', fontSize: 16, fontWeight: 'bold', marginBottom: 12 }}>Active Community Contests</Text>
                {activeContests.length === 0 ? (
                  <Text style={styles.emptyText}>No active contests. Create one!</Text>
                ) : (
                  activeContests.map(c => {
                    const isGlobal = c.invitedPubkeys.length === 0;
                    return (
                      <View key={c.id} style={[styles.historyCard, { borderColor: '#eab308', borderWidth: 1 }]}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                          <Text style={{ color: '#eab308', fontWeight: 'bold', fontSize: 16 }}>🏆 {c.name}</Text>
                          <Text style={{ color: isGlobal ? '#00ccff' : '#ff4d4f', fontSize: 10, fontWeight: 'bold', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10, borderWidth: 1, borderColor: isGlobal ? '#00ccff' : '#ff4d4f' }}>
                            {isGlobal ? 'GLOBAL' : 'PRIVATE'}
                          </Text>
                        </View>
                        <Text style={{ color: '#aaa', fontSize: 12, marginBottom: 8 }}>
                          Ends: {new Date(c.endTime * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                        </Text>
                        <Text style={{ color: '#fff', fontSize: 13, marginBottom: 8 }}>{c.description}</Text>

                        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
                          <View style={{ backgroundColor: 'rgba(255,255,255,0.05)', padding: 8, borderRadius: 6, flex: 1, alignItems: 'center' }}>
                            <Text style={{ color: '#9ba1a6', fontSize: 10, fontWeight: 'bold' }}>METRIC</Text>
                            <Text style={{ color: '#fff', fontSize: 12 }}>{c.parameter.replace('max_', '').toUpperCase()}</Text>
                          </View>
                          <View style={{ backgroundColor: 'rgba(255,255,255,0.05)', padding: 8, borderRadius: 6, flex: 1, alignItems: 'center' }}>
                            <Text style={{ color: '#9ba1a6', fontSize: 10, fontWeight: 'bold' }}>ENTRY FEE</Text>
                            <Text style={{ color: '#eab308', fontSize: 12, fontWeight: 'bold' }}>{c.feeSats} sats</Text>
                          </View>
                        </View>

                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <TouchableOpacity onPress={async () => {
                            setSelectedContest(c);
                            setShowFeed(false);
                            setIsLoadingLeaderboard(true);
                            const lb = await fetchRideLeaderboard(c.attendees, c.startTime, c.endTime, c.parameter);
                            setContestLeaderboard(lb);
                            setIsLoadingLeaderboard(false);
                          }}>
                            <Text style={{ color: '#00ccff', fontSize: 12, textDecorationLine: 'underline' }}>View Leaderboard ({c.attendees.length} Joined)</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={{ backgroundColor: c.attendees.includes(currentHex) ? 'rgba(234, 179, 8, 0.2)' : '#eab308', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, flexDirection: 'row', alignItems: 'center', gap: 4 }}
                            disabled={c.attendees.includes(currentHex)}
                            onPress={async () => {
                              if (!isNWCConnected && c.feeSats > 0) {
                                Alert.alert("Wallet Required", "You must connect your Lightning Wallet in Settings to pay the entry fee.");
                                return;
                              }

                              try {
                                if (c.feeSats > 0) {
                                  await zapRideEvent(c.id, ESCROW_PUBKEY, c.kind, Math.floor(c.feeSats), "Contest Entry Fee");
                                  Alert.alert("Payment Verified", `Joined contest for ${c.feeSats} sats!`);
                                }
                                const joined = await publishRSVP(c);
                                if (joined) {
                                  Alert.alert("Success", "You are entered into the contest!");
                                  // Optimistic UI update
                                  setActiveContests(prev => prev.map(contest =>
                                    contest.id === c.id
                                      ? { ...contest, attendees: [...contest.attendees, currentHex] }
                                      : contest
                                  ));
                                  const newContests = await fetchContests();
                                  setActiveContests(newContests);
                                }
                              } catch (e: any) {
                                Alert.alert("Error", e.message || "Failed to enter contest");
                              }
                            }}
                          >
                            <Zap size={14} color={c.attendees.includes(currentHex) ? "#eab308" : "#000"} />
                            <Text style={{ color: c.attendees.includes(currentHex) ? '#eab308' : '#000', fontWeight: 'bold' }}>
                              {c.attendees.includes(currentHex) ? 'ENTERED' : 'ENTER CONTEST'}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    );
                  })
                )}
              </>
            )}

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
                        {upcomingRides.length === 0 && <Text style={styles.emptyText}>No upcoming rides.</Text>}
                        {upcomingRides.map(r => (
                          <View key={r.id} style={styles.historyCard}>
                            <Image source={r.image ? { uri: r.image } : require('./assets/bikelLogo.jpg')} style={{ width: '100%', height: 150, borderRadius: 8, marginBottom: 12 }} />
                            <Text style={{ color: '#00ffaa', fontWeight: 'bold', marginBottom: 4 }}>{r.name}</Text>
                            <Text style={{ color: '#aaa', fontSize: 12, marginBottom: 8 }}>
                              {new Date(r.startTime * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                              {r.timezone ? ` (${r.timezone})` : ""}
                            </Text>
                            <Text style={{ color: '#fff', fontSize: 13, marginBottom: 8 }}>{r.description}</Text>
                            <Text style={{ color: '#888', fontSize: 12, marginBottom: 12 }}>📍 {r.locationStr}</Text>

                            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                              <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                                {r.route && r.route.length > 0 && (
                                  <TouchableOpacity onPress={() => {
                                    setShowFeed(false);
                                    setShowHistory(false);
                                    setSelectedRoute(r.route!.map(pt => ({ lat: pt[0], lng: pt[1] })));
                                  }}>
                                    <Text style={{ color: '#00ffaa', fontSize: 11, fontWeight: 'bold' }}>🗺️ Map</Text>
                                  </TouchableOpacity>
                                )}
                                <TouchableOpacity onPress={() => {
                                  setSelectedDiscussionRide(r);
                                  setShowDiscussion(true);
                                }}>
                                  <Text style={{ color: '#00ccff', fontSize: 11, fontWeight: 'bold' }}>💬 Discuss</Text>
                                </TouchableOpacity>
                                <TouchableOpacity onPress={() => setActiveDMUser(r.pubkey)}>
                                  <Text style={{ color: '#00ccff', fontSize: 11, textDecorationLine: 'underline' }}>Message Org</Text>
                                </TouchableOpacity>
                                {isNWCConnected && (
                                  <TouchableOpacity disabled={isZapping} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }} onPress={async () => {
                                    if (isZapping) return;
                                    setIsZapping(true);
                                    try {
                                      await zapRideEvent(r.id, r.hexPubkey, r.kind, 21, "Thanks for organizing this ride!");
                                      Alert.alert("Zap Sent", "21 sats sent to organizer!");
                                    } catch (e: any) {
                                      Alert.alert("Zap Failed", e.message || "Unknown error");
                                    }
                                    setIsZapping(false);
                                  }}>
                                    <Zap size={14} color={isZapping ? "#ccc" : "#eab308"} />
                                    <Text style={{ color: '#eab308', fontSize: 12, fontWeight: 'bold' }}>21</Text>
                                  </TouchableOpacity>
                                )}
                              </View>
                              <TouchableOpacity
                                style={{ backgroundColor: r.attendees.includes(currentHex) ? 'rgba(0, 255, 170, 0.1)' : 'rgba(255,255,255,0.1)', borderColor: r.attendees.includes(currentHex) ? '#00ffaa' : 'transparent', borderWidth: 1, paddingHorizontal: 16, paddingVertical: 6, borderRadius: 20 }}
                                disabled={r.attendees.includes(currentHex)}
                                onPress={async () => {
                                  const joined = await publishRSVP(r);
                                  if (joined) {
                                    Alert.alert("Success", "You've successfully RSVP'd to this ride! An event has been published.");
                                    const newEvents = await fetchScheduledRides();
                                    setScheduledRides(newEvents);
                                  } else {
                                    Alert.alert("Error", "Could not RSVP. Please make sure you have generated a Nostr key in settings.");
                                  }
                                }}
                              >
                                <Text style={{ color: r.attendees.includes(currentHex) ? '#00ffaa' : '#fff', fontSize: 12, fontWeight: 'bold' }}>
                                  {r.attendees.includes(currentHex) ? 'Attending' : 'RSVP'}
                                </Text>
                              </TouchableOpacity>
                            </View>
                          </View>
                      </View >
                    </View>
                  ))}

            {pastRides.length > 0 && (
              <>
                <Text style={{ color: '#888', fontSize: 16, fontWeight: 'bold', marginTop: 24, marginBottom: 12 }}>Past Community Rides</Text>
                {pastRides.map(r => (
                  <View key={r.id} style={[styles.historyCard, { opacity: 0.6 }]}>
                    <Image source={r.image ? { uri: r.image } : require('./assets/bikelLogo.jpg')} style={{ width: '100%', height: 150, borderRadius: 8, marginBottom: 12 }} />
                    <Text style={{ color: '#888', fontWeight: 'bold', marginBottom: 4 }}>{r.name}</Text>
                    <Text style={{ color: '#666', fontSize: 12, marginBottom: 8 }}>
                      {new Date(r.startTime * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                      {r.timezone ? ` (${r.timezone})` : ""}
                    </Text>
                    <Text style={{ color: '#888', fontSize: 13, marginBottom: 8 }}>{r.description}</Text>
                    <Text style={{ color: '#666', fontSize: 12, marginBottom: 12 }}>📍 {r.locationStr}</Text>

                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                        {r.route && r.route.length > 0 && (
                          <TouchableOpacity onPress={() => {
                            setShowFeed(false);
                            setShowHistory(false);
                            setSelectedRoute(r.route!.map(pt => ({ lat: pt[0], lng: pt[1] })));
                          }}>
                            <Text style={{ color: '#00ffaa', fontSize: 11, fontWeight: 'bold' }}>🗺️ Map</Text>
                          </TouchableOpacity>
                        )}
                        <TouchableOpacity onPress={() => {
                          setSelectedDiscussionRide(r);
                          setShowDiscussion(true);
                        }}>
                          <Text style={{ color: '#00ccff', fontSize: 11, fontWeight: 'bold' }}>💬 Discuss</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
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

      {feedTab === 'feed' && (
        <>
          <Text style={{ color: '#00ffaa', fontSize: 16, fontWeight: 'bold', marginBottom: 12 }}>Recent Public Rides</Text>
          {globalRides.length === 0 ? (
            <Text style={styles.emptyText}>No public rides found.</Text>
          ) : (
            globalRides.map(r => (
              <View key={r.id} style={[styles.historyCard, { borderColor: 'rgba(255,255,255,0.05)' }]}>
                <Image source={r.image ? { uri: r.image } : require('./assets/bikelLogo.jpg')} style={{ width: '100%', height: 150, borderRadius: 8, marginBottom: 12 }} />
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: '#888', fontSize: 12 }}>{r.pubkey.substring(0, 10)}...</Text>
                  <Text style={styles.historyTime}>
                    {r.title || new Date(r.time * 1000).toLocaleDateString()}
                  </Text>
                </View>
                {r.description ? <Text style={{ color: '#ccc', fontSize: 13, marginBottom: 12 }}>{r.description}</Text> : null}
                <View style={[styles.historyStats, { justifyContent: 'flex-start', gap: 16 }]}>
                  <Text style={styles.historyStat}>{r.distance} mi</Text>
                  <Text style={styles.historyStat}>{r.duration}</Text>

                  {isNWCConnected && (
                    <TouchableOpacity disabled={isZapping} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 'auto', backgroundColor: 'rgba(234, 179, 8, 0.1)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(234, 179, 8, 0.3)' }} onPress={async () => {
                      if (isZapping) return;
                      setIsZapping(true);
                      try {
                        await zapRideEvent(r.id, r.hexPubkey, r.kind, 21, "Great ride!");
                        Alert.alert("Zap Sent", "21 sats sent to rider!");
                      } catch (e: any) {
                        Alert.alert("Zap Failed", e.message || "Unknown error");
                      }
                      setIsZapping(false);
                    }}>
                      <Zap size={12} color={isZapping ? "#ccc" : "#eab308"} />
                      <Text style={{ color: '#eab308', fontSize: 12, fontWeight: 'bold' }}>21</Text>
                    </TouchableOpacity>
                  )}
                </View>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                  <TouchableOpacity style={{ backgroundColor: 'rgba(0, 204, 255, 0.1)', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6, alignItems: 'center', flex: 1 }} onPress={() => {
                    setSelectedDiscussionRide(r);
                    setShowDiscussion(true);
                  }}>
                    <Text style={{ color: '#00ccff', fontWeight: 'bold', fontSize: 12 }}>💬 DISCUSS</Text>
                  </TouchableOpacity>
                  {r.route && r.route.length > 0 && (
                    <TouchableOpacity
                      style={{ backgroundColor: 'rgba(0, 255, 170, 0.1)', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6, alignItems: 'center', flex: 1 }}
                      onPress={() => {
                        setShowFeed(false);
                        setShowHistory(false);
                        setSelectedRoute(r.route!.map(pt => ({ lat: pt[0], lng: pt[1] })));
                      }}
                    >
                      <Text style={{ color: '#00ffaa', fontWeight: 'bold', fontSize: 12 }}>🗺️ MAP</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            ))
          )}
        </>
      )}
    </ScrollView>
        </View >
      )
}

{/* Schedule Group Ride / Contest Overlay */ }
{
  showSchedule && (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.historyOverlay}>
      <Text style={styles.historyTitle}>{schedType === 'ride' ? 'Schedule Group Ride' : 'Create Community Contest'}</Text>

      <View style={{ flexDirection: 'row', marginBottom: 16, gap: 10 }}>
        <TouchableOpacity style={{ flex: 1, backgroundColor: schedType === 'ride' ? '#00ffaa' : 'rgba(255,255,255,0.1)', paddingVertical: 10, borderRadius: 8, alignItems: 'center' }} onPress={() => setSchedType('ride')}>
          <Text style={{ color: schedType === 'ride' ? '#000' : '#fff', fontWeight: 'bold' }}>GROUP RIDE</Text>
        </TouchableOpacity>
        <TouchableOpacity style={{ flex: 1, backgroundColor: schedType === 'contest' ? '#eab308' : 'rgba(255,255,255,0.1)', paddingVertical: 10, borderRadius: 8, alignItems: 'center' }} onPress={() => setSchedType('contest')}>
          <Text style={{ color: schedType === 'contest' ? '#000' : '#fff', fontWeight: 'bold' }}>CONTEST</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        <View style={styles.settingsSection}>
          <Text style={styles.settingsLabel}>{schedType === 'ride' ? 'RIDE NAME' : 'CONTEST TITLE'}</Text>
          <TextInput
            style={styles.keyInput}
            placeholder="e.g. Saturday Morning Coffee Ride"
            placeholderTextColor="rgba(255,255,255,0.3)"
            value={schedName}
            onChangeText={setSchedName}
          />
          <Text style={styles.settingsLabel}>DESCRIPTION</Text>
          <TextInput
            style={[styles.keyInput, { height: 80 }]}
            placeholder="Pace, expected distance, drop/no-drop..."
            placeholderTextColor="rgba(255,255,255,0.3)"
            multiline
            value={schedDesc}
            onChangeText={setSchedDesc}
          />
          <Text style={styles.settingsLabel}>START TIME/DATE</Text>
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
            <TouchableOpacity style={[styles.keyInput, { flex: 1, alignItems: 'center', justifyContent: 'center' }]} onPress={() => setShowDatePicker(true)}>
              <Text style={{ color: '#fff' }}>{schedDate.toLocaleDateString()}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.keyInput, { flex: 1, alignItems: 'center', justifyContent: 'center' }]} onPress={() => setShowTimePicker(true)}>
              <Text style={{ color: '#fff' }}>{schedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
            </TouchableOpacity>
          </View>

          {showDatePicker && (
            <DateTimePicker
              value={schedDate}
              mode="date"
              display="default"
              onChange={(event: DateTimePickerEvent, selectedDate?: Date) => {
                setShowDatePicker(Platform.OS === 'ios');
                if (selectedDate) setSchedDate(selectedDate);
              }}
            />
          )}
          {showTimePicker && (
            <DateTimePicker
              value={schedDate}
              mode="time"
              display="default"
              onChange={(event: DateTimePickerEvent, selectedDate?: Date) => {
                setShowTimePicker(Platform.OS === 'ios');
                if (selectedDate) setSchedDate(selectedDate);
              }}
            />
          )}

          {schedType === 'ride' && (
            <>
              <Text style={styles.settingsLabel}>MEETING LOCATION</Text>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <TextInput
                  style={[styles.keyInput, { flex: 1, marginBottom: 0 }]}
                  placeholder="e.g. 123 Main St Coffee Shop"
                  placeholderTextColor="rgba(255,255,255,0.3)"
                  value={schedLocation}
                  onChangeText={setSchedLocation}
                />
                <TouchableOpacity
                  style={{ backgroundColor: 'rgba(255,255,255,0.1)', paddingHorizontal: 16, borderRadius: 8, justifyContent: 'center', borderColor: 'rgba(255,255,255,0.3)', borderWidth: 1 }}
                  disabled={isGettingLocation}
                  onPress={async () => {
                    setIsGettingLocation(true);
                    try {
                      let loc = await Location.getLastKnownPositionAsync();
                      if (!loc) loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
                      if (loc) {
                        setSchedLocation(`geo:${loc.coords.latitude.toFixed(5)},${loc.coords.longitude.toFixed(5)}`);
                      }
                    } catch (e) {
                      Alert.alert("Location Error", "Could not fetch current GPS location.");
                    }
                    setIsGettingLocation(false);
                  }}
                >
                  {isGettingLocation ? <ActivityIndicator color="#00ffaa" size="small" /> : <Text style={{ color: '#00ffaa' }}>Use GPS</Text>}
                </TouchableOpacity>
              </View>

              <Text style={[styles.settingsLabel, { marginTop: 16 }]}>REPEAT CADENCE</Text>
              <View style={{ flexDirection: 'row', gap: 5, marginBottom: 16 }}>
                {[
                  { id: 'none', label: 'None' },
                  { id: 'weekly', label: 'Weekly' },
                  { id: 'biweekly', label: 'Bi-Weekly' },
                  { id: 'monthly', label: 'Monthly' }
                ].map(opt => (
                  <TouchableOpacity
                    key={opt.id}
                    style={{
                      flex: 1, backgroundColor: schedCadence === opt.id ? '#00ffaa' : 'rgba(255,255,255,0.1)',
                      paddingVertical: 12, borderRadius: 8, alignItems: 'center', borderColor: 'rgba(255,255,255,0.3)', borderWidth: 1
                    }}
                    onPress={() => setSchedCadence(opt.id as any)}
                  >
                    <Text style={{ color: schedCadence === opt.id ? '#000' : '#fff', fontWeight: 'bold', fontSize: 12 }}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {schedCadence !== 'none' && (
                <View style={{ marginBottom: 16 }}>
                  <Text style={styles.settingsLabel}>NUMBER OF EVENTS (MAX 6)</Text>
                  <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                    {[2, 3, 4, 5, 6].map(num => (
                      <TouchableOpacity
                        key={num}
                        style={{
                          flex: 1, backgroundColor: schedOccurrences === num ? '#00ffaa' : 'rgba(255,255,255,0.1)',
                          paddingVertical: 12, borderRadius: 8, alignItems: 'center', borderColor: 'rgba(255,255,255,0.3)', borderWidth: 1
                        }}
                        onPress={() => setSchedOccurrences(num)}
                      >
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
              <Text style={[styles.settingsLabel, { marginTop: 16 }]}>CONTEST DURATION (DAYS)</Text>
              <TextInput
                style={[styles.keyInput, { marginBottom: 16 }]}
                keyboardType="number-pad"
                value={contestEndDays}
                onChangeText={setContestEndDays}
              />

              <Text style={[styles.settingsLabel, { marginTop: 8 }]}>WINNING METRIC</Text>
              <View style={{ flexDirection: 'row', gap: 5, marginBottom: 16 }}>
                {[
                  { id: 'max_distance', label: 'Furthest' },
                  { id: 'max_elevation', label: 'Elevation' },
                  { id: 'fastest_mile', label: 'Fastest' }
                ].map(opt => (
                  <TouchableOpacity
                    key={opt.id}
                    style={{
                      flex: 1, backgroundColor: contestParam === opt.id ? '#00ffaa' : 'rgba(255,255,255,0.1)',
                      paddingVertical: 12, borderRadius: 8, alignItems: 'center', borderColor: 'rgba(255,255,255,0.3)', borderWidth: 1
                    }}
                    onPress={() => setContestParam(opt.id as any)}
                  >
                    <Text style={{ color: contestParam === opt.id ? '#000' : '#fff', fontWeight: 'bold', fontSize: 12 }}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={[styles.settingsLabel, { marginTop: 8 }]}>ENTRY FEE (SATS - ZAP TO ENTER)</Text>
              <TextInput
                style={[styles.keyInput, { marginBottom: 16 }]}
                keyboardType="number-pad"
                value={contestFee}
                onChangeText={setContestFee}
                placeholder="e.g. 5000"
              />

              <Text style={[styles.settingsLabel, { marginTop: 8 }]}>PRIVATE INVITES (OPTIONAL NPUBS)</Text>
              <Text style={styles.settingsHelp}>Leave blank for a Global Contest. Comma separated npubs to restrict entry.</Text>
              <TextInput
                style={[styles.keyInput, { marginBottom: 16, marginTop: 8, height: 60 }]}
                multiline
                placeholder="npub1..., npub1..."
                placeholderTextColor="#666"
                value={contestInvites}
                onChangeText={setContestInvites}
              />
            </>
          )}

          <TouchableOpacity style={[styles.saveButton, { marginTop: 8 }]} onPress={async () => {
            if (!schedName || !schedDate) {
              Alert.alert("Missing Fields", "Please fill in the Name and Date.");
              return;
            }

            if (schedType === 'ride' && !schedLocation) {
              Alert.alert("Missing Fields", "Please specify a location for the ride.");
              return;
            }

            try {
              let startUnix = Math.floor(schedDate.getTime() / 1000);

              if (schedType === 'ride') {
                let eventsToCreate = schedCadence === 'none' ? 1 : schedOccurrences;

                for (let i = 0; i < eventsToCreate; i++) {
                  await publishScheduledRide(schedName, schedCadence !== 'none' ? `${schedDesc}\n\n(Recurring Ride)` : schedDesc, startUnix, schedLocation);

                  if (schedCadence === 'weekly') {
                    startUnix += 7 * 24 * 60 * 60;
                  } else if (schedCadence === 'biweekly') {
                    startUnix += 14 * 24 * 60 * 60;
                  } else if (schedCadence === 'monthly') {
                    startUnix += 28 * 24 * 60 * 60;
                  }
                }
              } else {
                // Contest Publishing
                const endDaysInt = parseInt(contestEndDays) || 1;
                const endUnix = startUnix + endDaysInt * 24 * 60 * 60;
                const feeInt = parseInt(contestFee) || 0;
                const pubkeys = contestInvites.split(',').map(s => s.trim()).filter(s => s.startsWith('npub')); // rudimentary filter

                // In a real app we'd decode npubs to hex here. Assuming decode helper exists or is added soon.
                await publishContestEvent(schedName, schedDesc, startUnix, endUnix, contestParam, feeInt, pubkeys);
              }

              // Clear form BEFORE fetching feeds to ensure it closes even if relays are slow or error out.
              setSchedName('');
              setSchedDesc('');
              setSchedLocation('');
              setSchedCadence('none');
              setSchedOccurrences(2);
              setContestInvites('');
              setShowSchedule(false);

              Alert.alert("Success", `Published to Nostr!`);

              // Refresh feeds!
              try {
                if (schedType === 'ride') {
                  const groupEvents = await fetchScheduledRides();
                  setScheduledRides(groupEvents);
                  setShowFeed(true); // Switch to feed to see it immediately
                } else {
                  const contests = await fetchContests();
                  setActiveContests(contests);
                  setShowFeed(true);
                }
              } catch (fetchErr) {
                console.error("Failed to refresh feeds after publish", fetchErr);
              }
            } catch (e: any) {
              Alert.alert("Error", e.message);
            }
          }}>
            <Text style={styles.saveButtonText}>{schedType === 'ride' ? 'PUBLISH SCHEDULED RIDE' : 'CREATE CONTEST'}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

{/* Contest Leaderboard Overlay */ }
{
  selectedContest && (
    <View style={styles.historyOverlay}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <Text style={styles.historyTitle}>{selectedContest.name} UI</Text>
        <TouchableOpacity onPress={() => { setSelectedContest(null); setShowFeed(true); }} style={{ padding: 4 }}>
          <X size={24} color="#fff" />
        </TouchableOpacity>
      </View>
      <Text style={{ color: '#aaa', fontSize: 12, marginBottom: 16 }}>
        Winner calculated using: {selectedContest.parameter.replace('max_', '').toUpperCase()}
      </Text>

      {isLoadingLeaderboard ? (
        <ActivityIndicator size="large" color="#00ffaa" style={{ marginTop: 40 }} />
      ) : (
        <ScrollView style={{ flex: 1 }}>
          {contestLeaderboard.length === 0 ? (
            <Text style={styles.emptyText}>No rides submitted yet for this contest.</Text>
          ) : (
            contestLeaderboard.map((lb, index) => (
              <View key={lb.pubkey} style={[styles.historyCard, index === 0 ? { borderColor: '#eab308', borderWidth: 1 } : {}]}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ color: index === 0 ? '#eab308' : '#fff', fontWeight: 'bold', fontSize: 16 }}>
                    #{index + 1} {lb.pubkey.substring(0, 8)}...
                  </Text>
                  <Text style={{ color: '#00ffaa', fontSize: 16, fontWeight: 'bold' }}>
                    {lb.value.toFixed(1)} {selectedContest.parameter.includes('distance') ? 'mi' : ''}
                  </Text>
                </View>
              </View>
            ))
          )}
        </ScrollView>
      )}
    </View>
  )
}

{/* Stats Overlay when tracking */ }
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


{/* Bottom Controls */ }
{
  !showPostRideModal && (
    <View style={styles.bottomPanel}>
      <TouchableOpacity
        style={[styles.recordButton, isTracking && styles.stopButton]}
        onPress={toggleTracking}
        activeOpacity={0.8}
      >
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
  )
}

{/* Post-Ride Modal Overlay */ }
{
  showPostRideModal && (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.historyOverlay, { zIndex: 2000 }]}>
      <Text style={styles.historyTitle}>Finish Ride</Text>
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        <View style={styles.settingsSection}>
          <Text style={styles.settingsLabel}>TITLE (OPTIONAL)</Text>
          <TextInput
            style={styles.keyInput}
            placeholder="Morning Ride, Personal Record, etc."
            placeholderTextColor="rgba(255,255,255,0.3)"
            value={postRideTitle}
            onChangeText={setPostRideTitle}
          />
          <Text style={styles.settingsLabel}>DESCRIPTION (OPTIONAL)</Text>
          <TextInput
            style={[styles.keyInput, { height: 80 }]}
            placeholder="How was the ride? Any notes?"
            placeholderTextColor="rgba(255,255,255,0.3)"
            multiline
            value={postRideDesc}
            onChangeText={setPostRideDesc}
          />
          <Text style={styles.settingsLabel}>IMAGE URL (OPTIONAL)</Text>
          <TextInput
            style={styles.keyInput}
            placeholder="https://..."
            placeholderTextColor="rgba(255,255,255,0.3)"
            value={postRideImageUrl}
            onChangeText={setPostRideImageUrl}
            keyboardType="url"
            autoCapitalize="none"
          />
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
          <TouchableOpacity
            style={{ backgroundColor: postRideScheduleMode ? '#00ffaa' : 'rgba(255,255,255,0.1)', paddingVertical: 12, borderRadius: 8, alignItems: 'center', marginBottom: postRideScheduleMode ? 16 : 24 }}
            onPress={() => setPostRideScheduleMode(!postRideScheduleMode)}
          >
            <Text style={{ color: postRideScheduleMode ? '#000' : '#fff', fontWeight: 'bold' }}>
              {postRideScheduleMode ? 'Yes, Schedule Future Ride' : 'No, Post as Past Ride'}
            </Text>
          </TouchableOpacity>

          {postRideScheduleMode && (
            <View style={{ marginBottom: 16 }}>
              <Text style={styles.settingsLabel}>MEETING LOCATION</Text>
              <TextInput
                style={styles.keyInput}
                placeholder="E.g., Central Park Entrance"
                placeholderTextColor="rgba(255,255,255,0.3)"
                value={postRideLocation}
                onChangeText={setPostRideLocation}
              />

              <Text style={styles.settingsLabel}>DATE & TIME</Text>
              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
                <TouchableOpacity style={[styles.keyInput, { flex: 1, paddingVertical: 12 }]} onPress={() => setShowPostRideDate(true)}>
                  <Text style={{ color: '#fff', textAlign: 'center' }}>{postRideDate.toLocaleDateString()}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.keyInput, { flex: 1, paddingVertical: 12 }]} onPress={() => setShowPostRideTime(true)}>
                  <Text style={{ color: '#fff', textAlign: 'center' }}>{postRideTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
                </TouchableOpacity>
              </View>

              {showPostRideDate && (
                <DateTimePicker
                  value={postRideDate}
                  mode="date"
                  onChange={(event: DateTimePickerEvent, selectedDate?: Date) => {
                    setShowPostRideDate(Platform.OS === 'ios');
                    if (selectedDate) setPostRideDate(selectedDate);
                  }}
                />
              )}
              {showPostRideTime && (
                <DateTimePicker
                  value={postRideTime}
                  mode="time"
                  onChange={(event: DateTimePickerEvent, selectedDate?: Date) => {
                    setShowPostRideTime(Platform.OS === 'ios');
                    if (selectedDate) setPostRideTime(selectedDate);
                  }}
                />
              )}
            </View>
          )}

          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16, backgroundColor: 'rgba(255,255,255,0.05)', padding: 12, borderRadius: 8 }}
            onPress={() => setTrimTails(!trimTails)}
          >
            <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: trimTails ? '#00ffaa' : 'rgba(255,255,255,0.3)', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
              {trimTails && <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#00ffaa' }} />}
            </View>
            <Text style={{ color: '#fff', flex: 1 }}>Trim 0.1 miles from Start/End of Route for Privacy</Text>
          </TouchableOpacity>

          <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
            <TouchableOpacity style={[styles.saveButton, { flex: 1, backgroundColor: 'rgba(255, 255, 255, 0.1)' }]} onPress={() => {
              Alert.alert("Discard Ride", "Are you sure you want to discard this ride?", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Discard", style: "destructive", onPress: () => {
                    setShowPostRideModal(false);
                    setDuration(0);
                    setDistance(0);
                    setRoute([]);
                    setPostRideTitle('');
                    setPostRideDesc('');
                    setPostRideImageUrl('');
                    setPostRidePrivacy('full');
                    setPostRideScheduleMode(false);
                    setTrimTails(true);
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
                  const TRIM_MILES = 0.1;

                  // Trim Start
                  let startTrimIndex = 0;
                  let accumulatedStartDist = 0;
                  for (let i = 0; i < routePoints.length - 1; i++) {
                    accumulatedStartDist += getDistanceMiles(
                      routePoints[i].lat, routePoints[i].lng,
                      routePoints[i + 1].lat, routePoints[i + 1].lng
                    );
                    if (accumulatedStartDist >= TRIM_MILES) {
                      startTrimIndex = i + 1;
                      break;
                    }
                  }

                  // If the whole route is less than 0.2 miles, trimming both ends would delete it entirely!
                  if (startTrimIndex < routePoints.length - 1) {
                    routePoints = routePoints.slice(startTrimIndex);

                    // Trim End
                    let endTrimIndex = routePoints.length - 1;
                    let accumulatedEndDist = 0;
                    for (let i = routePoints.length - 1; i > 0; i--) {
                      accumulatedEndDist += getDistanceMiles(
                        routePoints[i].lat, routePoints[i].lng,
                        routePoints[i - 1].lat, routePoints[i - 1].lng
                      );
                      if (accumulatedEndDist >= TRIM_MILES) {
                        endTrimIndex = i - 1;
                        break;
                      }
                    }
                    // ensure we don't slice backwards into negative indices
                    if (endTrimIndex > 0) {
                      routePoints = routePoints.slice(0, endTrimIndex + 1);
                    } else {
                      // edge case where route is so short removing the tail destroyed what was left
                      routePoints = [];
                    }
                  } else {
                    // Route too short to survive a front trim
                    routePoints = [];
                  }
                }

                if (postRideScheduleMode) {
                  if (!postRideLocation) {
                    Alert.alert("Missing Fields", "Please specify a meeting location for the scheduled ride.");
                    return;
                  }
                  const startUnix = Math.floor(
                    new Date(
                      postRideDate.getFullYear(), postRideDate.getMonth(), postRideDate.getDate(),
                      postRideTime.getHours(), postRideTime.getMinutes()
                    ).getTime() / 1000
                  );
                  await publishScheduledRide(postRideTitle || "Group Ride", postRideDesc || "Join my ride!", startUnix, postRideLocation, routePoints);

                  // Dual-publish public scheduled rides to the global feed & RunSTR
                  if (postRidePrivacy === 'full') {
                    await publishRide(distance, duration, routePoints, postRidePrivacy, postRideTitle, postRideDesc, postRideImageUrl);
                  }

                  Alert.alert("Ride Scheduled!", "Your group ride was successfully published.");

                  // Immediately close UI before fetching
                  setShowPostRideModal(false);
                  setDuration(0);
                  setDistance(0);
                  setRoute([]);
                  setPostRideTitle('');
                  setPostRideDesc('');
                  setPostRideImageUrl('');
                  setPostRidePrivacy('full');
                  setPostRideScheduleMode(false);

                  try {
                    const updatedSchedules = await fetchScheduledRides();
                    setScheduledRides(updatedSchedules);
                  } catch (e) { }
                } else {
                  await publishRide(distance, duration, routePoints, postRidePrivacy, postRideTitle, postRideDesc, postRideImageUrl);
                  Alert.alert("Ride Published!", "Your ride was successfully published to Nostr.");

                  // Immediately close UI before fetching
                  setShowPostRideModal(false);
                  setDuration(0);
                  setDistance(0);
                  setRoute([]);
                  setPostRideTitle('');
                  setPostRideDesc('');
                  setPostRideImageUrl('');
                  setPostRidePrivacy('full');
                  setPostRideScheduleMode(false);

                  try {
                    const updatedRides = await fetchMyRides();
                    setMyRides(updatedRides);
                    const newGlobal = await fetchRecentRides();
                    setGlobalRides(newGlobal);
                  } catch (e) { }
                }
              } catch (e: any) {
                Alert.alert("Failed to publish ride", e.message || "Unknown error occurred.");
                console.error("Failed to publish ride", e);
              }
            }}>
              <Text style={[styles.saveButtonText, { color: '#000' }]}>POST RIDE</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

{/* Discussion Overlay */ }
{
  showDiscussion && selectedDiscussionRide && (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.historyOverlay, { zIndex: 1000 }]}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <Text style={styles.historyTitle}>Discussion</Text>
        <TouchableOpacity onPress={() => { setShowDiscussion(false); setSelectedDiscussionRide(null); }} style={{ padding: 4 }}>
          <X size={24} color="#fff" />
        </TouchableOpacity>
      </View>
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        {comments.length === 0 ? (
          <Text style={styles.emptyText}>No comments yet. Be the first!</Text>
        ) : (
          comments.map(c => (
            <View key={c.id} style={[styles.historyCard, { backgroundColor: 'rgba(0,0,0,0.3)', borderColor: 'rgba(255,255,255,0.05)' }]}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text style={{ color: '#00ffaa', fontSize: 12, fontWeight: 'bold' }}>{c.pubkey.substring(0, 10)}...</Text>
                <Text style={{ color: '#888', fontSize: 12 }}>
                  {new Date(c.createdAt * 1000).toLocaleDateString()}
                </Text>
              </View>
              <Text style={{ color: '#eee', fontSize: 14 }}>{c.content}</Text>
            </View>
          ))
        )}
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 12, alignItems: 'center' }}>
        <TextInput
          style={[styles.keyInput, { flex: 1, marginBottom: 0 }]}
          placeholder="Write a comment..."
          placeholderTextColor="rgba(255,255,255,0.3)"
          value={newComment}
          onChangeText={setNewComment}
          editable={!isPublishingComment}
        />
        <TouchableOpacity
          style={{ backgroundColor: '#00ffaa', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8 }}
          disabled={isPublishingComment || !newComment.trim()}
          onPress={async () => {
            if (!newComment.trim()) return;
            setIsPublishingComment(true);
            const success = await publishComment(selectedDiscussionRide.id, newComment.trim());
            if (success) {
              setNewComment('');
              fetchComments(selectedDiscussionRide.id).then(setComments);
            } else {
              Alert.alert("Error", "Failed to publish comment");
            }
            setIsPublishingComment(false);
          }}
        >
          <Text style={{ color: '#000', fontWeight: 'bold' }}>{isPublishingComment ? '...' : 'POST'}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  )
}

{/* Direct Messaging Overlay */ }
{
  activeDMUser && (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.historyOverlay, { zIndex: 1000 }]}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <Text style={styles.historyTitle}>
          Chat with {activeDMUser.substring(0, 8)}...
        </Text>
        <TouchableOpacity onPress={() => setActiveDMUser(null)} style={{ padding: 4 }}>
          <X size={24} color="#fff" />
        </TouchableOpacity>
      </View>
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        {dmMessages.length === 0 ? (
          <Text style={styles.emptyText}>No messages yet. Say hello!</Text>
        ) : (
          dmMessages.map(msg => {
            const isMe = msg.sender !== activeDMUser; // if we are not the activeDMUser, then sender is us
            return (
              <View key={msg.id} style={{
                maxWidth: '80%',
                alignSelf: isMe ? 'flex-end' : 'flex-start',
                backgroundColor: isMe ? 'rgba(0, 204, 255, 0.2)' : 'rgba(255, 255, 255, 0.1)',
                padding: 12,
                borderRadius: 12,
                borderBottomRightRadius: isMe ? 2 : 12,
                borderBottomLeftRadius: isMe ? 12 : 2,
                marginBottom: 12,
              }}>
                <Text style={{ color: '#fff', fontSize: 14 }}>{msg.text}</Text>
                <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, marginTop: 4, textAlign: isMe ? 'right' : 'left' }}>
                  {new Date(msg.createdAt * 1000).toLocaleDateString()} {new Date(msg.createdAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>
            );
          })
        )}
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 12, alignItems: 'center' }}>
        <TextInput
          style={[styles.keyInput, { flex: 1, marginBottom: 0 }]}
          placeholder="Type a message..."
          placeholderTextColor="rgba(255,255,255,0.3)"
          value={newDMText}
          onChangeText={setNewDMText}
          editable={!isSendingDM}
        />
        <TouchableOpacity
          style={{ backgroundColor: '#00ccff', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8 }}
          disabled={isSendingDM || !newDMText.trim()}
          onPress={async () => {
            if (!newDMText.trim()) return;
            setIsSendingDM(true);
            const success = await sendDM(activeDMUser, newDMText.trim());
            if (success) {
              setNewDMText('');
              fetchDMs(activeDMUser).then(setDmMessages);
            } else {
              Alert.alert("Error", "Failed to send message");
            }
            setIsSendingDM(false);
          }}
        >
          <Text style={{ color: '#000', fontWeight: 'bold' }}>{isSendingDM ? '...' : 'SEND'}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  )
}
    </View >
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d0f12',
  },
  map: {
    position: 'absolute',
    top: 110,
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#161a1f'
  },
  headerPanel: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 60 : 40,
    left: 20,
    right: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(22, 26, 31, 0.85)',
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  logoContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  statsOverlay: {
    position: 'absolute',
    top: 140,
    left: 20,
    right: 20,
    flexDirection: 'row',
    backgroundColor: 'rgba(22, 26, 31, 0.85)',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(0, 255, 170, 0.3)',
  },
  statBox: {
    flex: 1,
    alignItems: 'center',
  },
  statDivider: {
    width: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  statValue: {
    color: '#00ffaa',
    fontSize: 32,
    fontWeight: '800',
  },
  statLabel: {
    color: '#9aa5b1',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
    letterSpacing: 1,
  },
  bottomPanel: {
    position: 'absolute',
    bottom: 40,
    left: 20,
    right: 20,
  },
  recordButton: {
    backgroundColor: '#00ffaa',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    borderRadius: 20,
    gap: 12,
    shadowColor: '#00ffaa',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 8,
  },
  stopButton: {
    backgroundColor: '#161a1f',
    borderColor: '#ff4d4f',
    borderWidth: 2,
    shadowColor: '#ff4d4f',
  },
  recordButtonText: {
    color: '#000',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 1,
  },
  historyOverlay: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 120 : 100,
    left: 20,
    right: 20,
    bottom: 120,
    backgroundColor: 'rgba(13, 15, 18, 0.95)',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  historyTitle: {
    color: '#00ffaa',
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 16,
  },
  historyCard: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
  },
  historyTime: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  historyStats: {
    flexDirection: 'row',
    gap: 16,
  },
  historyStat: {
    color: '#9ba1a6',
    fontSize: 14,
  },
  emptyText: {
    color: '#9ba1a6',
    textAlign: 'center',
    marginTop: 40,
  },
  settingsSection: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    padding: 16,
    borderRadius: 12,
    marginBottom: 20,
  },
  settingsLabel: {
    color: '#00ffaa',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 12,
  },
  settingsKeyText: {
    color: '#fff',
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    padding: 12,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 8,
    marginBottom: 8,
  },
  settingsHelp: {
    color: '#9ba1a6',
    fontSize: 12,
    fontStyle: 'italic',
  },
  keyInput: {
    color: '#fff',
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  saveButton: {
    backgroundColor: '#ff4d4f',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  saveButtonText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: 1,
  },
  privacyToggle: {
    backgroundColor: 'rgba(22, 26, 31, 0.85)',
    padding: 12,
    borderRadius: 16,
    marginBottom: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  privacyToggleText: {
    color: '#00ffaa',
    fontWeight: '700',
    fontSize: 14,
  }
});
