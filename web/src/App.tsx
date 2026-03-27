import { useEffect, useState, useMemo } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup, Polyline, useMap, LayerGroup } from 'react-leaflet';
import { Bike, Activity, CalendarPlus, Zap, LogIn, Info, HelpCircle, Smartphone, X, Clock, Route, CheckCircle, RefreshCw, Map as MapIcon, ChevronUp, ChevronDown, Users, Database, Download, BarChart2, Trash2, Gauge, ArrowLeft } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import { connectNDK, fetchRecentRides, fetchUserRides, fetchScheduledRides, loginNip07, publishRSVP, connectNWC, zapRideEvent, fetchComments, publishComment, fetchDMs, sendDM, deleteRide, fetchAllRidesInRange } from './lib/nostr';
import type { RideEvent, ScheduledRideEvent, RideComment, DMessage } from './lib/nostr';
import type { NDKUser } from '@nostr-dev-kit/ndk';
import './App.css';

// ── Types ──────────────────────────────────────────────
interface GridCell {
  lat: number;
  lng: number;
  count: number;
  riders: Set<string>;
}

interface CorridorSegment {
  lat1: number;
  lng1: number;
  lat2: number;
  lng2: number;
  count: number;
}

// ── Helpers ────────────────────────────────────────────
function snapToGrid(lat: number, lng: number, precision = 4): string {
  return `${lat.toFixed(precision)},${lng.toFixed(precision)}`;
}

function buildHeatmap(rides: RideEvent[]): GridCell[] {
  const grid: Map<string, GridCell> = new Map();
  for (const ride of rides) {
    for (const [lat, lng] of ride.route) {
      const key = snapToGrid(lat, lng, 3); // ~100m grid
      if (!grid.has(key)) {
        grid.set(key, { lat, lng, count: 0, riders: new Set() });
      }
      const cell = grid.get(key)!;
      cell.count++;
      cell.riders.add(ride.hexPubkey || ride.pubkey);
    }
  }
  return Array.from(grid.values()).filter(c => c.count > 0);
}

function buildCorridors(rides: RideEvent[]): CorridorSegment[] {
  const segments: Map<string, CorridorSegment> = new Map();
  for (const ride of rides) {
    for (let i = 0; i < ride.route.length - 1; i++) {
      const [lat1, lng1] = ride.route[i];
      const [lat2, lng2] = ride.route[i + 1];
      const key = `${snapToGrid(lat1, lng1, 3)}→${snapToGrid(lat2, lng2, 3)}`;
      if (!segments.has(key)) {
        segments.set(key, { lat1, lng1, lat2, lng2, count: 0 });
      }
      segments.get(key)!.count++;
    }
  }
  return Array.from(segments.values()).sort((a, b) => b.count - a.count);
}

function downloadCSV(filename: string, rows: string[][], headers: string[]) {
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatDistance(ride: RideEvent, isMetric: boolean) {
  if (ride.distanceKm !== undefined && ride.distanceMiles !== undefined) {
    return isMetric ? `${ride.distanceKm.toFixed(1)} km` : `${ride.distanceMiles.toFixed(1)} mi`;
  }
  return isMetric ? `${(parseFloat(ride.distance || '0') / 0.621371).toFixed(1)} km` : `${ride.distance} mi`;
}

function formatSpeed(ride: RideEvent, isMetric: boolean) {
  if (!ride.rawDuration || ride.rawDuration === 0) return '0.0';
  let distMi = parseFloat(ride.distance || '0');
  if (ride.distanceMiles !== undefined) distMi = ride.distanceMiles;
  const speed = distMi / (ride.rawDuration / 3600);
  return isMetric ? `${(speed / 0.621371).toFixed(1)} km/h` : `${speed.toFixed(1)} mph`;
}

function formatElevation(elevationStr: string | undefined, isMetric: boolean) {
  if (!elevationStr) return null;
  const val = parseFloat(elevationStr);
  if (isNaN(val)) return elevationStr;
  return isMetric ? `${Math.round(val * 0.3048)} m` : `${Math.round(val)} ft`;
}

// ── Main App ───────────────────────────────────────────
function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [rides, setRides] = useState<RideEvent[]>([]);
  const [myRides, setMyRides] = useState<RideEvent[]>([]);
  const [authorRides, setAuthorRides] = useState<RideEvent[]>([]);
  const [scheduledRides, setScheduledRides] = useState<ScheduledRideEvent[]>([]);
  const [user, setUser] = useState<NDKUser | null>(null);
  const [selectedRide, setSelectedRide] = useState<RideEvent | null>(null);
  const [lastSelectedRideId, setLastSelectedRideId] = useState<string | null>(null);
  const [viewingAuthor, setViewingAuthor] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'global' | 'personal' | 'scheduled' | 'author' | 'data'>('global');
  const [isSidebarExpanded, setIsSidebarExpanded] = useState(false);
  const [profiles, setProfiles] = useState<Record<string, any>>({});

  const [showNWCModal, setShowNWCModal] = useState(false);
  const [nwcURI, setNwcURI] = useState('');
  const [isNWCConnected, setIsNWCConnected] = useState(false);
  const [zappingEventId, setZappingEventId] = useState<string | null>(null);

  const [showAbout, setShowAbout] = useState(false);
  const [showHowTo, setShowHowTo] = useState(false);
  const [showAppPromo, setShowAppPromo] = useState(false);

  const [comments, setComments] = useState<RideComment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [mapFocus, setMapFocus] = useState<[number, number] | null>(null);
  const [isDiscussionExpanded, setIsDiscussionExpanded] = useState(false);

  const [activeDMUser, setActiveDMUser] = useState<string | null>(null);
  const [dmMessages, setDmMessages] = useState<DMessage[]>([]);
  const [newDMText, setNewDMText] = useState('');
  const [isSendingDM, setIsSendingDM] = useState(false);

  // Data panel
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [deletingRideId, setDeletingRideId] = useState<string | null>(null);

  const [minerSinceDate, setMinerSinceDate] = useState('');
  const [minerUntilDate, setMinerUntilDate] = useState('');
  const [isMining, setIsMining] = useState(false);
  const [minedCount, setMinedCount] = useState(0);

  const [isMetric, setIsMetric] = useState(false);
  const [timeFilter, setTimeFilter] = useState<'miner' | '7d' | '30d' | 'today'>('30d');
  const [isSyncingFilter, setIsSyncingFilter] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Confidence-filtered global feed (>= 0.7, or no confidence tag = include)
  const filteredGlobalRides = useMemo(() => {
    let filtered = rides.filter(r => r.confidence === undefined || r.confidence >= 0.7);
    if (timeFilter === 'miner') return filtered;

    const now = Math.floor(Date.now() / 1000);
    let cutoff = 0;
    if (timeFilter === 'today') cutoff = now - 86400;
    else if (timeFilter === '7d') cutoff = now - 7 * 86400;
    else if (timeFilter === '30d') cutoff = now - 30 * 86400;

    if (cutoff > 0) {
      filtered = filtered.filter(r => r.time >= cutoff);
    }
    return filtered;
  }, [rides, timeFilter]);

  const heatmapCells = useMemo(() => showHeatmap ? buildHeatmap(filteredGlobalRides) : [], [filteredGlobalRides, showHeatmap]);
  const corridors = useMemo(() => buildCorridors(filteredGlobalRides), [filteredGlobalRides]);
  const globalFilteredRides = filteredGlobalRides;

  const dataStats = useMemo(() => {
    const allPoints = filteredGlobalRides.flatMap(r => r.route);
    const uniqueRiders = new Set(filteredGlobalRides.map(r => r.hexPubkey || r.pubkey)).size;
    const totalDistance = filteredGlobalRides.reduce((acc, r) => acc + (isMetric && r.distanceKm !== undefined ? r.distanceKm : (r.distanceMiles !== undefined ? r.distanceMiles : parseFloat(r.distance || '0'))), 0);
    const dates = filteredGlobalRides.map(r => r.time).filter(Boolean).sort();
    return {
      totalRides: filteredGlobalRides.length,
      totalPoints: allPoints.length,
      uniqueRiders,
      totalDistance: totalDistance.toFixed(1),
      dateRange: dates.length > 0
        ? `${format(new Date(dates[0] * 1000), 'MMM d, yyyy')} – ${format(new Date(dates[dates.length - 1] * 1000), 'MMM d, yyyy')}`
        : 'N/A',
    };
  }, [rides, filteredGlobalRides, isMetric]);

  useEffect(() => {
    if (!selectedRide && lastSelectedRideId) {
      setTimeout(() => {
        const element = document.getElementById(`ride-${lastSelectedRideId}`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }, 100);
    }
  }, [selectedRide, lastSelectedRideId]);

  useEffect(() => {
    if (activeDMUser) {
      setDmMessages([]);
      fetchDMs(activeDMUser).then(setDmMessages);
    }
  }, [activeDMUser]);

  useEffect(() => {
    console.log(`[Bikel] Timeframe updated to: ${timeFilter}`);
    setIsSyncingFilter(true);
    const timer = setTimeout(() => setIsSyncingFilter(false), 800);
    return () => clearTimeout(timer);
  }, [timeFilter]);

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
      console.error("Failed to load web author profiles:", e);
    }
  };

  const loadFeeds = async () => {
    try {
      const now = Math.floor(Date.now() / 1000);
      let since = now - (30 * 86400); // Default 30d
      if (timeFilter === 'today') since = now - 86400;
      else if (timeFilter === '7d') since = now - 7 * 86400;
      else if (timeFilter === 'miner') since = 0;

      // 1. Map Data (STREAMING LOAD)
      // fetchRecentRides now accepts an onUpdate callback and a since timestamp.
      fetchRecentRides((incrementalRides) => {
        if (incrementalRides.length > 0) {
          setRides(prev => {
            const merged = [...prev, ...incrementalRides];
            return merged
              .filter((v, i, a) => a.findIndex(r => r.id === v.id) === i)
              .sort((a, b) => b.time - a.time);
          });
          // Start loading profiles for the first batch immediately
          loadAuthorProfiles(incrementalRides.slice(0, 20).map(r => r.hexPubkey || r.pubkey)).catch(() => { });
        }
      }, undefined, since).then(finalRides => {
        if (finalRides.length > 0) {
          setRides(prev => {
            const merged = [...prev, ...finalRides];
            return merged
              .filter((v, i, a) => a.findIndex(r => r.id === v.id) === i)
              .sort((a, b) => b.time - a.time);
          });
          loadAuthorProfiles(finalRides.map(r => r.hexPubkey || r.pubkey)).catch(() => { });
        }
      }).catch(console.error);

      // 2. Secondary Feeds (Independent streams)
      fetchScheduledRides().then(fetchedScheduled => {
        setScheduledRides(prev => {
          const merged = [...prev, ...fetchedScheduled];
          return merged.filter((v, i, a) => a.findIndex(r => r.id === v.id) === i).sort((a, b) => a.startTime - b.startTime);
        });
        loadAuthorProfiles(fetchedScheduled.map(r => r.hexPubkey || r.pubkey)).catch(() => { });
      }).catch(console.error);

      if (user) {
        fetchUserRides(user.pubkey).then(personalRides => {
          setMyRides(prev => {
            const merged = [...prev, ...personalRides];
            return merged.filter((v, i, a) => a.findIndex(r => r.id === v.id) === i).sort((a, b) => b.time - a.time);
          });
          loadAuthorProfiles(personalRides.map(r => r.hexPubkey || r.pubkey)).catch(() => { });
        }).catch(console.error);
      }

      if (viewMode === 'author' && viewingAuthor) {
        fetchUserRides(viewingAuthor).then(authoredRides => {
          setAuthorRides(prev => {
            const merged = [...prev, ...authoredRides];
            return merged.filter((v, i, a) => a.findIndex(r => r.id === v.id) === i).sort((a, b) => b.time - a.time);
          });
          loadAuthorProfiles(authoredRides.map(r => r.hexPubkey || r.pubkey)).catch(() => { });
        }).catch(console.error);
      }
    } catch (e) {
      console.error("Failed to load feeds:", e);
    }
  };

  const loadMoreRides = async () => {
    setIsLoadingMore(true);
    try {
      if (viewMode === 'personal' && user) {
        if (!myRides.length) return;
        const oldestTime = myRides[myRides.length - 1].time;
        const more = await fetchUserRides(user.pubkey, oldestTime);
        setMyRides(prev => [...prev, ...more].filter((v, i, a) => a.findIndex(r => r.id === v.id) === i).sort((a, b) => b.time - a.time));
      } else if (viewMode === 'author' && viewingAuthor) {
        if (!authorRides.length) return;
        const oldestTime = authorRides[authorRides.length - 1].time;
        const more = await fetchUserRides(viewingAuthor, oldestTime);
        setAuthorRides(prev => [...prev, ...more].filter((v, i, a) => a.findIndex(r => r.id === v.id) === i).sort((a, b) => b.time - a.time));
      } else if (viewMode === 'global' || viewMode === 'data') {
        if (!rides.length) {
          console.log("[Bikel] No initial rides to paginate from.");
          return;
        }
        const oldestTime = rides[rides.length - 1].time;
        console.log(`[Bikel] Deep dive: searching for rides older than ${new Date(oldestTime * 1000).toLocaleString()}...`);
        const more = await fetchRecentRides(undefined, oldestTime);
        console.log(`[Bikel] Found ${more.length} older rides.`);
        setRides(prev => [...prev, ...more].filter((v, i, a) => a.findIndex(r => r.id === v.id) === i).sort((a, b) => b.time - a.time));
      }
    } catch (e) {
      console.error("Failed to load more rides:", e);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const startMining = async () => {
    if (!minerSinceDate || !minerUntilDate) {
      alert("Please select both a start and end date.");
      return;
    }
    const sinceTimestamp = Math.floor(new Date(minerSinceDate).getTime() / 1000);
    const untilTimestamp = Math.floor(new Date(minerUntilDate).getTime() / 1000) + 86399; // Include full end day
    if (sinceTimestamp >= untilTimestamp) {
      alert("Start date must be before end date.");
      return;
    }
    setIsMining(true);
    setMinedCount(0);
    try {
      const harvested = await fetchAllRidesInRange(sinceTimestamp, untilTimestamp, (count) => setMinedCount(count));
      setRides(prev => [...prev, ...harvested].filter((v, i, a) => a.findIndex(r => r.id === v.id) === i).sort((a, b) => b.time - a.time));
      alert(`Successfully harvested ${harvested.length} records!\nThey are now loaded into the global dataset.`);
    } catch (e: any) {
      alert("Mining failed: " + (e.message || "Unknown error"));
    } finally {
      setIsMining(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      console.log("[Bikel] Mounting app...");
      await connectNDK();
      if (mounted) setIsConnected(true);

      const savedNwc = localStorage.getItem('bikel_nwc_uri');
      if (savedNwc) {
        setNwcURI(savedNwc);
        const success = await connectNWC(savedNwc);
        if (mounted && success) setIsNWCConnected(true);
      }

      await loadFeeds();
    })();
    return () => { mounted = false; };
  }, []); // Run ONLY once on mount

  useEffect(() => {
    if (user) {
      console.log("[Bikel] User session active. Fetching personal history...");
      fetchUserRides(user.pubkey).then(setMyRides);
    }
  }, [user]); // Re-run only when user logs in/out

  useEffect(() => {
    if (selectedRide) {
      setComments([]);
      fetchComments(selectedRide.id).then(setComments);
    }
  }, [selectedRide]);

  const handleLogin = async () => {
    const nip07user = await loginNip07();
    if (nip07user) {
      setUser(nip07user);
      const personalRides = await fetchUserRides(nip07user.pubkey);
      setMyRides(personalRides);
      setViewMode('personal');
      setSelectedRide(null);
    }
  };

  const toggleViewMode = () => {
    setViewMode(prev => prev === 'global' ? 'personal' : 'global');
    setSelectedRide(null);
  };

  const loadAuthorProfile = async (npub: string) => {
    setSelectedRide(null);
    setViewingAuthor(npub);
    setViewMode('author');
    setAuthorRides([]);
    const ridesForAuthor = await fetchUserRides(npub);
    setAuthorRides(ridesForAuthor);
  };

  const handleRSVP = async (ride: ScheduledRideEvent) => {
    if (!user) return;
    const success = await publishRSVP(ride);
    if (success) {
      setScheduledRides(prev => prev.map(r =>
        r.id === ride.id ? { ...r, attendees: [...r.attendees, user.pubkey] } : r
      ));
    }
  };

  const handleDeleteRide = async (rideId: string) => {
    if (!user) { alert("Please sign in to delete rides."); return; }
    if (!confirm("Delete this ride? This publishes a kind 5 deletion event — most relays will remove it, but some may retain the original.")) return;
    setDeletingRideId(rideId);
    const success = await deleteRide(rideId);
    if (success) {
      setMyRides(prev => prev.filter(r => r.id !== rideId));
      if (selectedRide?.id === rideId) setSelectedRide(null);
    } else {
      alert("Failed to delete ride. Check console for details.");
    }
    setDeletingRideId(null);
  };

  const downloadRawPoints = () => {
    const rows = rides.flatMap(ride => {
      const date = new Date(ride.time * 1000);
      return ride.route.map(([lat, lng]) => [
        lat.toString(), lng.toString(),
        date.toISOString(),
        ride.distance || '0',
        (ride.hexPubkey || ride.pubkey).substring(0, 16),
        date.getHours().toString(),
        date.toLocaleDateString('en-US', { weekday: 'long' }),
      ]);
    });
    downloadCSV('bikel_raw_gps_points.csv', rows, ['latitude', 'longitude', 'timestamp', 'ride_distance_mi', 'rider_id_anon', 'hour_of_day', 'day_of_week']);
  };

  const downloadCorridors = () => {
    const rows = corridors.slice(0, 2000).map(c => [
      c.lat1.toFixed(6), c.lng1.toFixed(6), c.lat2.toFixed(6), c.lng2.toFixed(6), c.count.toString()
    ]);
    downloadCSV('bikel_corridors.csv', rows, ['start_lat', 'start_lng', 'end_lat', 'end_lng', 'ride_count']);
  };

  const downloadRiderStats = () => {
    const rows = rides.map(r => {
      const date = new Date(r.time * 1000);
      return [
        date.toISOString(), r.distance || '0', r.duration || '0', r.elevation || '0',
        r.route.length.toString(), (r.hexPubkey || r.pubkey).substring(0, 16),
        date.getHours().toString(), date.toLocaleDateString('en-US', { weekday: 'long' }),
      ];
    });
    downloadCSV('bikel_ride_stats.csv', rows, ['timestamp', 'distance_mi', 'duration', 'elevation_ft', 'gps_points', 'rider_id_anon', 'hour_of_day', 'day_of_week']);
  };

  const maxHeat = useMemo(() => Math.max(...heatmapCells.map(c => c.count), 1), [heatmapCells]);
  const heatColor = (count: number) => {
    const t = Math.min(count / maxHeat, 1);
    if (t < 0.33) return '#00ffaa';
    if (t < 0.66) return '#eab308';
    return '#ff4d4f';
  };

  // Interpolate ride color from fresh green → aged yellow → old dim based on age
  const rideAgeColor = (rideTime: number): { color: string; opacity: number } => {
    const ageMs = Date.now() - rideTime * 1000;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    // 0–1 days: full green; 1–14 days: green→yellow; 14+ days: yellow→dim
    if (ageDays <= 1) return { color: '#00ffaa', opacity: 0.7 };
    if (ageDays <= 14) {
      const t = (ageDays - 1) / 13; // 0→1 over days 1–14
      // Lerp #00ffaa → #eab308
      const r = Math.round(0x00 + t * (0xea - 0x00));
      const g = Math.round(0xff + t * (0xb3 - 0xff));
      const b = Math.round(0xaa + t * (0x08 - 0xaa));
      return { color: `rgb(${r},${g},${b})`, opacity: 0.6 - t * 0.2 };
    }
    // 14–60 days: yellow→very dim
    const t = Math.min((ageDays - 14) / 46, 1);
    const r = Math.round(0xea + t * (0x3a - 0xea));
    const g = Math.round(0xb3 + t * (0x32 - 0xb3));
    const b = Math.round(0x08 + t * (0x00 - 0x08));
    return { color: `rgb(${r},${g},${b})`, opacity: 0.4 - t * 0.25 };
  };

  return (
    <div className="app-container">
      <header className="header animate-fade-in">
        <div className="logo">
          <Bike size={28} color="var(--accent-primary)" strokeWidth={2.5} />
          Bikel<span>.</span>ink
        </div>
        <div className="relay-status">
          <div className={`status-indicator ${isConnected ? 'connected' : ''}`}></div>
          <span className="relay-text">{isConnected ? 'Connected to Relays' : 'Connecting...'}</span>
        </div>
        <div className="header-actions">
          <button className="btn btn-surface" style={{ padding: '8px', color: viewMode === 'global' ? '#00ffaa' : '#555' }} onClick={() => { setViewMode('global'); setSelectedRide(null); }} title="View Recent Rides"><Activity size={20} /></button>
          <button className="btn btn-surface" style={{ padding: '8px', color: viewMode === 'scheduled' ? '#00ffaa' : '#555' }} onClick={() => { setViewMode('scheduled'); setSelectedRide(null); }} title="Upcoming Group Rides"><CalendarPlus size={20} /></button>
          <button className="btn btn-surface" style={{ padding: '8px', color: viewMode === 'data' ? '#00ccff' : '#555' }} onClick={() => { setViewMode('data'); setSelectedRide(null); }} title="Open Data / City Planner View"><Database size={20} /></button>
          <button className="btn btn-surface" style={{ padding: '8px', color: isNWCConnected ? '#eab308' : '#555' }} onClick={() => setShowNWCModal(true)} title="Connect Lightning Wallet"><Zap size={20} /></button>
          <button className="btn btn-surface" style={{ padding: '8px', color: '#555' }} onClick={() => setShowAbout(true)} title="About Bikel"><Info size={20} /></button>
          <button className="btn btn-surface" style={{ padding: '8px', color: '#555' }} onClick={() => setShowHowTo(true)} title="How to Use Bikel"><HelpCircle size={20} /></button>
          <button className="btn btn-surface" style={{ padding: '8px', color: '#555', fontWeight: 'bold', fontSize: '12px' }} onClick={() => setIsMetric(!isMetric)} title="Toggle Units (Metric/Imperial)">{isMetric ? 'KM' : 'MI'}</button>
          <button className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold' }} onClick={() => setShowAppPromo(true)}><Smartphone size={16} /> Get App</button>
          {user ? (
            <div className="user-profile" style={{ display: 'flex', alignItems: 'center', gap: '8px', color: viewMode === 'personal' ? '#00ffaa' : '#fff', cursor: 'pointer', padding: '6px 12px', background: 'rgba(255,255,255,0.05)', borderRadius: '20px' }} onClick={toggleViewMode}>
              <div className="avatar-mini" style={{ width: '28px', height: '28px', background: viewMode === 'personal' ? '#00ffaa' : '#fff' }}></div>
              <span>{user.profile?.name || user.pubkey.substring(0, 8)}</span>
            </div>
          ) : (
            <button className="btn btn-primary" style={{ color: '#000', display: 'flex', alignItems: 'center', gap: '6px' }} onClick={handleLogin}><LogIn size={16} /> Sign In</button>
          )}
        </div>
      </header>

      <main className="main-content">
        <aside className={`sidebar ${isSidebarExpanded ? 'expanded' : ''}`}>
          <div className="mobile-sidebar-toggle" onClick={() => setIsSidebarExpanded(!isSidebarExpanded)}>
            {isSidebarExpanded ? <ChevronDown size={24} color="#888" /> : <ChevronUp size={24} color="#888" />}
          </div>

          {/* ── DATA PANEL ── */}
          {viewMode === 'data' && !selectedRide ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%', overflowY: 'auto' }}>

              <div className="widget glass-panel animate-fade-in" style={{ borderColor: 'rgba(0,204,255,0.3)', background: 'rgba(0,20,40,0.8)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Database size={18} color="#00ccff" />
                    <h2 style={{ margin: 0, color: '#00ccff', fontSize: '14px', letterSpacing: '1px', textTransform: 'uppercase' }}>Open Cycling Data</h2>
                  </div>
                  <select value={timeFilter} onChange={e => setTimeFilter(e.target.value as any)} style={{ background: 'rgba(0,204,255,0.1)', border: '1px solid rgba(0,204,255,0.3)', color: '#00ccff', padding: '4px 8px', borderRadius: '4px', fontSize: '12px', outline: 'none', cursor: 'pointer' }}>
                    <option value="today">Today</option>
                    <option value="7d">Last 7 Days</option>
                    <option value="30d">Last 30 Days</option>
                    <option value="miner">Full Dataset</option>
                  </select>
                </div>
                <p style={{ color: '#9ba1a6', fontSize: '12px', lineHeight: 1.6, margin: 0 }}>
                  Anonymous GPS data from cyclists publishing to the Nostr network. All rides are opt-in and publicly broadcast. Rider IDs are truncated pubkey prefixes — no personal data is stored or sold.
                </p>
              </div>

              <div className="widget glass-panel animate-fade-in" style={{ animationDelay: '0.1s' }}>
                <h3 style={{ color: '#fff', fontSize: '12px', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <BarChart2 size={14} color="#00ffaa" /> Dataset Summary
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  {[
                    { label: 'Total Rides', value: dataStats.totalRides },
                    { label: 'Unique Riders', value: dataStats.uniqueRiders },
                    { label: isMetric ? 'Total Distance' : 'Total Miles', value: `${dataStats.totalDistance} ${isMetric ? 'km' : 'mi'}` },
                    { label: 'GPS Points', value: dataStats.totalPoints.toLocaleString() },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ background: 'rgba(0,0,0,0.4)', borderRadius: '8px', padding: '12px', border: '1px solid rgba(255,255,255,0.05)' }}>
                      <div style={{ color: '#00ffaa', fontSize: '20px', fontWeight: 'bold', fontFamily: 'monospace' }}>{value}</div>
                      <div style={{ color: '#888', fontSize: '11px', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: '12px', padding: '8px 12px', background: 'rgba(0,0,0,0.3)', borderRadius: '6px', color: '#666', fontSize: '11px' }}>
                  📅 Date range: {dataStats.dateRange}
                </div>
              </div>

              <div className="widget glass-panel animate-fade-in" style={{ animationDelay: '0.12s' }}>
                <h3 style={{ color: '#00ccff', fontSize: '12px', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Database size={14} color="#00ccff" /> Historical Data Miner
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: '10px', color: '#888', textTransform: 'uppercase', marginBottom: '4px' }}>From</label>
                      <input type="date" value={minerSinceDate} onChange={e => setMinerSinceDate(e.target.value)} disabled={isMining} style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(0,204,255,0.2)', color: '#fff', padding: '8px', borderRadius: '4px', fontSize: '12px', outline: 'none' }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: '10px', color: '#888', textTransform: 'uppercase', marginBottom: '4px' }}>To</label>
                      <input type="date" value={minerUntilDate} onChange={e => setMinerUntilDate(e.target.value)} disabled={isMining} style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(0,204,255,0.2)', color: '#fff', padding: '8px', borderRadius: '4px', fontSize: '12px', outline: 'none' }} />
                    </div>
                  </div>
                  <button onClick={startMining} disabled={isMining} style={{ width: '100%', background: isMining ? 'rgba(0,204,255,0.1)' : 'rgba(0,204,255,0.2)', color: '#00ccff', border: '1px solid rgba(0,204,255,0.4)', padding: '10px', borderRadius: '6px', fontSize: '12px', fontWeight: 'bold', cursor: isMining ? 'wait' : 'pointer', transition: 'all 0.2s', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px' }}>
                    {isMining ? <><RefreshCw size={14} className="spin" /> Crawling {minedCount} records...</> : <><Download size={14} /> Crawl Network</>}
                  </button>
                </div>
              </div>

              <div className="widget glass-panel animate-fade-in" style={{ animationDelay: '0.15s' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold' }}>Density Heatmap</div>
                    <div style={{ color: '#666', fontSize: '11px', marginTop: '2px' }}>Visualize high-traffic corridors on the map</div>
                  </div>
                  <button
                    onClick={() => setShowHeatmap(h => !h)}
                    style={{ background: showHeatmap ? 'rgba(0,255,170,0.2)' : 'rgba(255,255,255,0.05)', border: `1px solid ${showHeatmap ? '#00ffaa' : 'rgba(255,255,255,0.1)'}`, borderRadius: '20px', padding: '6px 16px', color: showHeatmap ? '#00ffaa' : '#888', fontSize: '12px', cursor: 'pointer', fontWeight: 'bold', transition: 'all 0.2s' }}
                  >
                    {showHeatmap ? 'ON' : 'OFF'}
                  </button>
                </div>
                {showHeatmap && (
                  <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#888' }}>
                    <span>Low</span>
                    <div style={{ flex: 1, height: '6px', borderRadius: '3px', background: 'linear-gradient(to right, #00ffaa, #eab308, #ff4d4f)' }} />
                    <span>High</span>
                  </div>
                )}
              </div>

              <div className="widget glass-panel animate-fade-in" style={{ animationDelay: '0.2s' }}>
                <h3 style={{ color: '#fff', fontSize: '12px', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Route size={14} color="#eab308" /> Top Corridors
                </h3>
                {corridors.slice(0, 8).map((c, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <div
                      style={{ fontSize: '11px', color: '#9ba1a6', fontFamily: 'monospace', cursor: 'pointer', borderBottom: '1px dashed rgba(155, 161, 166, 0.4)' }}
                      onClick={() => setMapFocus([c.lat1, c.lng1])}
                      title="Click to focus map"
                    >
                      {c.lat1.toFixed(4)},{c.lng1.toFixed(4)}
                    </div>
                    <div style={{ background: 'rgba(234,179,8,0.15)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: '10px', padding: '2px 8px', fontSize: '11px', color: '#eab308', fontWeight: 'bold' }}>{c.count}×</div>
                  </div>
                ))}
              </div>

              <div className="widget glass-panel animate-fade-in" style={{ animationDelay: '0.25s', borderColor: 'rgba(0,204,255,0.2)' }}>
                <h3 style={{ color: '#fff', fontSize: '12px', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Download size={14} color="#00ccff" /> Download Data
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {[
                    { onClick: downloadRawPoints, bg: 'rgba(0,255,170,0.08)', bgHover: 'rgba(0,255,170,0.15)', border: 'rgba(0,255,170,0.25)', color: '#00ffaa', title: 'Raw GPS Points', desc: `lat, lng, timestamp, distance, rider_id — ${dataStats.totalPoints.toLocaleString()} rows` },
                    { onClick: downloadCorridors, bg: 'rgba(234,179,8,0.08)', bgHover: 'rgba(234,179,8,0.15)', border: 'rgba(234,179,8,0.25)', color: '#eab308', title: 'Aggregated Corridors', desc: 'start/end coords + ride count per segment — ideal for GIS / QGIS' },
                    { onClick: downloadRiderStats, bg: 'rgba(0,204,255,0.08)', bgHover: 'rgba(0,204,255,0.15)', border: 'rgba(0,204,255,0.25)', color: '#00ccff', title: 'Ride Statistics', desc: `timestamp, distance, duration per ride — ${dataStats.totalRides} rows` },
                  ].map(({ onClick, bg, bgHover, border, color, title, desc }) => (
                    <button key={title} onClick={onClick}
                      style={{ display: 'flex', alignItems: 'center', gap: '10px', background: bg, border: `1px solid ${border}`, borderRadius: '8px', padding: '12px', cursor: 'pointer', textAlign: 'left', transition: 'all 0.2s' }}
                      onMouseEnter={e => (e.currentTarget.style.background = bgHover)}
                      onMouseLeave={e => (e.currentTarget.style.background = bg)}
                    >
                      <Download size={16} color={color} style={{ flexShrink: 0 }} />
                      <div>
                        <div style={{ color, fontSize: '13px', fontWeight: 'bold' }}>{title}</div>
                        <div style={{ color: '#666', fontSize: '11px', marginTop: '2px' }}>{desc}</div>
                      </div>
                    </button>
                  ))}
                </div>
                <div style={{ marginTop: '16px', padding: '10px 12px', background: 'rgba(0,0,0,0.3)', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ color: '#555', fontSize: '11px', lineHeight: 1.6 }}>
                    📋 Data sourced live from public Nostr relays. All rider IDs are anonymized pubkey prefixes. No names, emails, or personal data included. Licensed CC0 — free for any use including municipal planning.
                  </div>
                </div>
              </div>
            </div>

          ) : (
            /* ── NORMAL SIDEBAR ── */
            <>
              {!selectedRide && viewMode === 'personal' && (
                <div className="widget glass-panel animate-fade-in" style={{ animationDelay: '0.05s', marginBottom: '16px', borderColor: 'rgba(0, 255, 170, 0.3)' }}>
                  <h2 className="widget-title" style={{ color: '#00ffaa' }}><Activity size={16} /> My Riding Stats</h2>
                  <div className="global-stats" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                    <div className="stat-box" style={{ background: 'rgba(0, 255, 170, 0.05)' }}>
                      <div className="stat-value" style={{ color: '#fff' }}>{myRides.length}</div>
                      <div className="stat-label" style={{ color: '#00ffaa' }}>Rides</div>
                    </div>
                    <div className="stat-box" style={{ background: 'rgba(0, 255, 170, 0.05)' }}>
                      <div className="stat-value" style={{ color: '#fff' }}>
                        {myRides.reduce((acc, r) => acc + (isMetric && r.distanceKm !== undefined ? r.distanceKm : (r.distanceMiles !== undefined ? r.distanceMiles : parseFloat(r.distance || '0'))), 0).toFixed(1)}
                      </div>
                      <div className="stat-label" style={{ color: '#00ffaa' }}>{isMetric ? 'Total KM' : 'Total Miles'}</div>
                    </div>
                    <div className="stat-box" style={{ background: 'rgba(0, 255, 170, 0.05)' }}>
                      <div className="stat-value" style={{ color: '#fff' }}>
                        {(() => {
                          const dist = myRides.reduce((acc, r) => acc + (isMetric && r.distanceKm !== undefined ? r.distanceKm : (r.distanceMiles !== undefined ? r.distanceMiles : parseFloat(r.distance || '0'))), 0);
                          const secs = myRides.reduce((acc, r) => acc + (r.rawDuration || 0), 0);
                          return secs > 0 ? (dist / (secs / 3600)).toFixed(1) : '0.0';
                        })()}
                      </div>
                      <div className="stat-label" style={{ color: '#00ffaa' }}>Avg {isMetric ? 'km/h' : 'mph'}</div>
                    </div>
                  </div>
                </div>
              )}

              {!selectedRide && (
                <div className="widget glass-panel animate-fade-in" style={{ animationDelay: '0.1s', marginBottom: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <h2 className="widget-title" style={{ margin: 0 }}><Zap size={16} /> Global Stats</h2>
                  </div>
                  <div className="global-stats">
                    <div className="stat-box">
                      <div className={`stat-value ${isSyncingFilter ? 'animate-pulse' : ''}`} style={{ transition: 'all 0.3s' }}>
                        {globalFilteredRides.reduce((acc, r) => acc + (isMetric && r.distanceKm !== undefined ? r.distanceKm : (r.distanceMiles !== undefined ? r.distanceMiles : parseFloat(r.distance || '0'))), 0).toFixed(1)}
                      </div>
                      <div className="stat-label">{isMetric ? 'KM Ridden' : 'Miles Ridden'}</div>
                    </div>
                    <div className="stat-box">
                      <div className={`stat-value ${isSyncingFilter ? 'animate-pulse' : ''}`} style={{ transition: 'all 0.3s' }}>{new Set(globalFilteredRides.map(r => r.hexPubkey || r.pubkey)).size}</div>
                      <div className="stat-label">Active Riders</div>
                    </div>
                  </div>
                </div>
              )}

              <div className="widget glass-panel animate-fade-in" style={{ flex: 1, animationDelay: '0.2s' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <h2 className="widget-title" style={{ margin: 0 }}>
                      {viewMode === 'scheduled' ? <><CalendarPlus size={16} /> Upcoming Group Rides</> :
                        viewMode === 'author' ? <><Activity size={16} /> Rides by {viewingAuthor?.substring(0, 10)}...</> :
                          <><Activity size={16} /> {viewMode === 'personal' ? 'My Recent Rides' : 'Recent Public Rides'}</>}
                    </h2>
                    <button className="btn btn-surface" style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => loadFeeds()} title="Refresh Feeds"><RefreshCw size={14} /></button>
                  </div>
                  {viewMode === 'author' && user && viewingAuthor !== user.pubkey && (
                    <button className="btn btn-primary" style={{ padding: '6px 12px', fontSize: '13px', background: '#00ccff', color: '#000', fontWeight: 'bold' }} onClick={() => setActiveDMUser(viewingAuthor)}>Message</button>
                  )}
                </div>
                <div className="ride-feed">
                  {selectedRide ? (
                    <div className="ride-detail-view animate-fade-in">
                      <div className="detail-header" style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
                        <button onClick={() => setSelectedRide(null)} className="btn btn-surface" style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
                          <ArrowLeft size={16} /> Back
                        </button>
                        <h2 style={{ margin: 0, fontSize: '1.2rem', color: '#00ffaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                          {selectedRide.title || "Ride Details"}
                        </h2>
                      </div>

                      <div className="detail-card glass-panel" style={{ padding: '16px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.1)' }}>
                        <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
                          <div className="avatar-mini" style={{ width: '40px', height: '40px' }}></div>
                          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                            <span style={{ fontWeight: 'bold', color: '#fff' }}>{profiles[selectedRide.hexPubkey || selectedRide.pubkey]?.nip05 || profiles[selectedRide.hexPubkey || selectedRide.pubkey]?.name || `${selectedRide.pubkey.substring(0, 10)}...`}</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span style={{ fontSize: '12px', color: '#888' }}>{formatDistanceToNow(selectedRide.time * 1000, { addSuffix: true })}</span>
                              <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', background: selectedRide.route.length > 0 ? 'rgba(0,255,170,0.1)' : 'rgba(0,204,255,0.1)', color: selectedRide.route.length > 0 ? '#00ffaa' : '#00ccff', display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 'bold' }}>
                                {selectedRide.route.length > 0 ? <><Route size={10} /> GPS ROUTE</> : <><Database size={10} /> DATA ONLY</>}
                              </span>
                            </div>
                          </div>
                        </div>

                        {selectedRide.image && selectedRide.image !== '/bikelLogo.jpg' && (
                          <img src={selectedRide.image} alt="Ride Media" style={{ width: '100%', height: '160px', objectFit: 'cover', borderRadius: '8px', marginBottom: '16px' }} />
                        )}

                        {selectedRide.description && <div style={{ fontSize: '14px', color: '#eee', marginBottom: '16px', lineHeight: 1.5 }}>{selectedRide.description}</div>}

                        <div className="ride-stats" style={{ background: 'rgba(0,0,0,0.3)', marginBottom: '16px' }}>
                          <div className="stat-item"><Route size={16} className="icon" style={{ color: '#00ffaa' }} /> {formatDistance(selectedRide, isMetric)}</div>
                          <div className="stat-item"><Clock size={16} className="icon" style={{ color: '#00ffaa' }} /> {selectedRide.duration}</div>
                          {selectedRide.rawDuration > 0 && parseFloat(selectedRide.distance || '0') > 0 && (
                            <div className="stat-item"><Gauge size={16} className="icon" style={{ color: '#00ccff' }} /> {formatSpeed(selectedRide, isMetric)}</div>
                          )}
                          {selectedRide.elevation && <div className="stat-item"><ChevronUp size={16} className="icon" style={{ color: '#00ffaa' }} /> {formatElevation(selectedRide.elevation, isMetric)}</div>}
                        </div>

                        <div className="modal-comments" style={{ padding: '0', borderTop: 'none', background: 'transparent' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', marginBottom: '12px' }} onClick={() => setIsDiscussionExpanded(!isDiscussionExpanded)}>
                            <h3 style={{ margin: 0, color: '#fff', fontSize: '15px' }}>Discussion ({comments.length})</h3>
                            {isDiscussionExpanded ? <ChevronDown size={18} color="#fff" /> : <ChevronUp size={18} color="#fff" />}
                          </div>
                          {isDiscussionExpanded && (
                            <>
                              <div style={{ maxHeight: '300px', overflowY: 'auto', marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '12px', paddingRight: '4px' }}>
                                {comments.length === 0 ? <div style={{ color: '#666', fontSize: '13px', fontStyle: 'italic' }}>No comments yet.</div> : comments.map(c => (
                                  <div key={c.id} style={{ background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                      <span style={{ color: '#00ffaa', fontSize: '11px', fontWeight: 'bold' }}>{profiles[c.hexPubkey || c.pubkey]?.name || 'Anon'}</span>
                                      <span style={{ color: '#888', fontSize: '10px' }}>{formatDistanceToNow(c.createdAt * 1000)}</span>
                                    </div>
                                    <div style={{ color: '#eee', fontSize: '13px', lineHeight: '1.4' }}>{c.content}</div>
                                  </div>
                                ))}
                              </div>
                              {user ? (
                                <div style={{ display: 'flex', gap: '8px' }}>
                                  <input type="text" value={newComment} onChange={(e) => setNewComment(e.target.value)} placeholder="Say something..." style={{ flex: 1, padding: '8px 12px', fontSize: '13px', borderRadius: '6px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff' }} onKeyDown={async (e) => { if (e.key === 'Enter' && newComment.trim()) { await publishComment(selectedRide!.id, newComment.trim()); setNewComment(''); fetchComments(selectedRide!.id).then(setComments); } }} />
                                  <button className="btn btn-primary" style={{ padding: '6px 12px', fontSize: '13px' }} onClick={async () => { await publishComment(selectedRide!.id, newComment.trim()); setNewComment(''); fetchComments(selectedRide!.id).then(setComments); }}>Post</button>
                                </div>
                              ) : (
                                <div style={{ color: '#666', fontSize: '12px', textAlign: 'center' }}>Sign in to comment</div>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      {viewMode === 'global' && rides.length === 0 && <div className="ride-stat" style={{ padding: '12px' }}>No public rides found. Be the first!</div>}
                      {viewMode === 'personal' && myRides.length === 0 && <div className="ride-stat" style={{ padding: '12px' }}>You haven't recorded any rides yet.</div>}
                      {viewMode === 'scheduled' && scheduledRides.length === 0 && <div className="ride-stat" style={{ padding: '12px' }}>No upcoming group rides scheduled right now.</div>}
                      {viewMode === 'author' && authorRides.length === 0 && <div className="ride-stat" style={{ padding: '12px' }}>Loading author rides...</div>}

                      {viewMode === 'scheduled' ? (() => {
                        const nowSeconds = Math.floor(Date.now() / 1000);
                        const upcomingRides = scheduledRides.filter(r => r.startTime >= nowSeconds).sort((a, b) => a.startTime - b.startTime);
                        return (
                          <>
                            {upcomingRides.map((event) => (
                              <div className="ride-card" key={event.id} style={{ cursor: 'default' }}>
                                <img src={event.image || '/bikelLogo.jpg'} alt="Ride Map" style={{ width: '100%', height: '120px', objectFit: 'cover', borderRadius: '8px', marginBottom: '12px' }} />
                                <div className="ride-header"><div style={{ fontWeight: 'bold', color: '#00ffaa' }}>{event.name}</div></div>
                                <div style={{ fontSize: '12px', color: '#aaa', marginTop: '4px', marginBottom: '8px' }}>{format(new Date(event.startTime * 1000), "EEEE, MMM d 'at' h:mm a")}{event.timezone ? ` (${event.timezone})` : ""}</div>
                                <div style={{ fontSize: '13px', marginBottom: '12px', lineHeight: 1.4 }}>{event.description}</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px', padding: '10px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#888' }}>
                                    <span style={{ flexShrink: 0 }}>📍</span>
                                    <span style={{ flex: 1 }}>{event.locationStr}</span>
                                  </div>
                                  {event.attendees && event.attendees.length > 0 && (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#00ffaa', fontWeight: 'bold' }}>
                                      <span>👤</span>
                                      <span>{event.attendees.length} attending</span>
                                    </div>
                                  )}
                                </div>

                                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' }}>
                                  {user && (
                                    <button className="btn btn-surface" style={{ padding: '6px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', background: event.attendees?.includes(user.pubkey) ? 'rgba(0,255,170,0.1)' : undefined, color: event.attendees?.includes(user.pubkey) ? '#00ffaa' : undefined, borderColor: event.attendees?.includes(user.pubkey) ? '#00ffaa' : undefined }} onClick={(e) => { e.stopPropagation(); handleRSVP(event); }} disabled={event.attendees?.includes(user.pubkey)}>
                                      <CheckCircle size={14} /> {event.attendees?.includes(user.pubkey) ? 'Attending' : 'RSVP'}
                                    </button>
                                  )}
                                </div>
                                <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', marginTop: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                    <span>Org: <span style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={(e) => { e.stopPropagation(); loadAuthorProfile(event.pubkey); }}>{profiles[event.hexPubkey || event.pubkey]?.nip05 || profiles[event.hexPubkey || event.pubkey]?.name || `${event.pubkey.substring(0, 10)}...`}</span></span>
                                    {event.route && event.route.length > 0 && <button className="btn btn-surface" style={{ padding: '2px 8px', fontSize: '11px', background: 'rgba(0,255,170,0.1)', color: '#00ffaa' }} onClick={(e) => { e.stopPropagation(); setSelectedRide({ id: event.id, pubkey: event.pubkey, hexPubkey: event.hexPubkey, time: event.startTime, distance: event.distance || '0', distanceKm: 0, distanceMiles: 0, duration: event.duration || '0', rawDuration: 0, visibility: 'full', route: event.route!, kind: 33301, image: event.image }); }}>🗺️ Map</button>}
                                  </div>
                                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                                    {isNWCConnected && <button onClick={async (e) => { e.stopPropagation(); if (zappingEventId) return; const amtStr = window.prompt("Enter amount to Zap in sats:", "21"); if (!amtStr) return; const amt = parseInt(amtStr, 10); if (isNaN(amt) || amt <= 0) return; setZappingEventId(event.id); try { await zapRideEvent(event.id, event.hexPubkey, event.kind, amt, "Thanks for organizing this ride!"); alert(`Successfully sent ${amt} sats!`); } catch (e: any) { alert("Zap failed: " + (e.message || "Unknown error")); } setZappingEventId(null); }} style={{ background: 'none', border: 'none', color: '#eab308', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}><Zap size={14} fill={zappingEventId === event.id ? "#eab308" : "none"} /> Zap</button>}
                                    <button className="btn btn-primary" style={{ padding: '6px 12px', fontSize: '13px', background: '#00ccff', color: '#000', fontWeight: 'bold' }} onClick={() => setActiveDMUser(event.pubkey)}>Message Organizer</button>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </>
                        );
                      })() : null}

                      {viewMode === 'scheduled' && scheduledRides.length > 0 && (() => {
                        const nowSeconds = Math.floor(Date.now() / 1000);
                        const pastRides = scheduledRides.filter(r => r.startTime < nowSeconds).sort((a, b) => b.startTime - a.startTime);
                        if (pastRides.length === 0) return null;
                        return (
                          <div style={{ marginTop: '24px' }}>
                            <h3 style={{ color: '#888', marginBottom: '16px', fontSize: '14px', textTransform: 'uppercase', letterSpacing: '1px' }}>Past Rides</h3>
                            {pastRides.map((event) => (
                              <div className="ride-card" key={event.id} style={{ cursor: 'default', opacity: 0.6 }}>
                                <img src={event.image || '/bikelLogo.jpg'} alt="Ride Map" style={{ width: '100%', height: '120px', objectFit: 'cover', borderRadius: '8px', marginBottom: '12px', filter: 'grayscale(50%)' }} />
                                <div className="ride-header"><div style={{ fontWeight: 'bold', color: '#888' }}>{event.name}</div></div>
                                <div style={{ fontSize: '12px', color: '#666', marginTop: '4px', marginBottom: '8px' }}>{format(new Date(event.startTime * 1000), "EEEE, MMM d 'at' h:mm a")}{event.timezone ? ` (${event.timezone})` : ""}</div>
                                <div style={{ fontSize: '13px', marginBottom: '12px', lineHeight: 1.4, color: '#888' }}>{event.description}</div>
                                <div className="ride-stats" style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <div className="stat-item" style={{ color: '#888' }}><Users size={14} className="icon" /> {event.attendees.length} Past Riders</div>
                                    {event.route && event.route.length > 0 && <button className="stat-item" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); setSelectedRide({ id: event.dTag, pubkey: event.hexPubkey, hexPubkey: event.hexPubkey, time: event.startTime, distance: "0", distanceKm: 0, distanceMiles: 0, duration: "0", rawDuration: 0, visibility: "full", route: event.route!, kind: 33301 }); }}>🗺️ Map</button>}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      })()}

                      {viewMode !== 'scheduled' && (viewMode === 'personal' ? myRides : viewMode === 'author' ? authorRides : filteredGlobalRides).map((ride) => (
                        <div className="ride-card" key={ride.id} id={`ride-${ride.id}`} onClick={() => { setSelectedRide(ride); setLastSelectedRideId(ride.id); }}>
                          <img src={ride.image || ((ride.client?.toLowerCase() === 'runstr' || ride.kind === 1301 || ride.kind === 1) && ride.client?.toLowerCase() !== 'bikel' ? '/runstrLogo.jpg' : '/bikelLogo.jpg')} alt="Ride Map" style={{ width: '100%', height: '120px', objectFit: 'cover', borderRadius: '8px', marginBottom: '12px' }} />
                          <div className="ride-header">
                            <div className="ride-pubkey" title={ride.pubkey}>
                              <div className="avatar-mini"></div>
                              <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <span onClick={(e) => { e.stopPropagation(); loadAuthorProfile(ride.pubkey); }} style={{ cursor: 'pointer' }}>{profiles[ride.hexPubkey || ride.pubkey]?.nip05 || profiles[ride.hexPubkey || ride.pubkey]?.name || `${ride.pubkey.substring(0, 10)}...`}</span>
                                {ride.client && ride.client !== 'bikel' && (
                                  <span style={{ color: '#00ccff', fontSize: '10px', fontWeight: 'bold' }}>via {ride.client}</span>
                                )}
                              </div>
                            </div>
                            <div className="ride-time" style={{ textAlign: 'right' }}>
                              <div>{formatDistanceToNow(ride.time * 1000, { addSuffix: true })}</div>
                              <span style={{ fontSize: '9px', padding: '1px 4px', borderRadius: '3px', background: ride.route.length > 0 ? 'rgba(0,255,170,0.1)' : 'rgba(0,204,255,0.1)', color: ride.route.length > 0 ? '#00ffaa' : '#00ccff', fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', gap: '3px', marginTop: '4px' }}>
                                {ride.route.length > 0 ? <><Route size={8} /> GPS</> : <><Database size={8} /> DATA</>}
                              </span>
                            </div>
                          </div>
                          {ride.title && <div style={{ fontSize: '15px', fontWeight: 'bold', color: '#00ffaa', marginBottom: '4px' }}>{ride.title}</div>}
                          {ride.description && <div style={{ fontSize: '13px', color: '#ddd', marginBottom: '12px', lineHeight: 1.4 }}>{ride.description}</div>}
                          <div className="ride-stats-container">
                            <div className="ride-stats">
                              <div className="stat-item"><Route size={16} className="icon" style={{ color: '#00ffaa' }} /> {formatDistance(ride, isMetric)}</div>
                              <div className="stat-item"><Clock size={16} className="icon" style={{ color: '#00ffaa' }} /> {ride.duration}</div>
                              {ride.rawDuration > 0 && parseFloat(ride.distance || '0') > 0 && (
                                <div className="stat-item"><Gauge size={16} className="icon" style={{ color: '#00ccff' }} /> {formatSpeed(ride, isMetric)}</div>
                              )}
                              {ride.elevation && <div className="stat-item"><ChevronUp size={16} className="icon" style={{ color: '#00ffaa' }} /> {formatElevation(ride.elevation, isMetric)}</div>}
                            </div>
                            <div className="stat-meta">
                              {ride.confidence !== undefined && (
                                <div className="stat-meta-item" style={{ color: ride.confidence >= 0.7 ? '#00ffaa' : '#ff4d4f' }}>
                                  ●  {(ride.confidence * 100).toFixed(0)}% Confidence
                                </div>
                              )}
                              <div className="stat-meta-item" style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
                                <span style={{ opacity: 0.6 }}>{ride.client || 'Bikel'}</span>
                                {isNWCConnected && viewMode !== 'personal' && (
                                  <button onClick={async (e) => { e.stopPropagation(); if (zappingEventId) return; const amtStr = window.prompt("Enter amount to Zap in sats:", "21"); if (!amtStr) return; const amt = parseInt(amtStr, 10); if (isNaN(amt) || amt <= 0) return; setZappingEventId(ride.id); try { await zapRideEvent(ride.id, ride.hexPubkey, ride.kind, amt, "Great ride!"); alert(`Successfully sent ${amt} sats!`); } catch (e: any) { alert("Zap failed: " + (e.message || "Unknown error")); } setZappingEventId(null); }} className="btn btn-surface" style={{ padding: '2px 8px', color: '#eab308', borderRadius: '12px', fontSize: '11px', border: '1px solid rgba(234,179,8,0.3)' }}>
                                    <Zap size={11} fill={zappingEventId === ride.id ? "#eab308" : "none"} /> Zap
                                  </button>
                                )}
                                {viewMode === 'personal' && user && ride.hexPubkey === user.pubkey && (
                                  <button
                                    onClick={async (e) => { e.stopPropagation(); if (window.confirm("Delete this ride?")) await handleDeleteRide(ride.id); }}
                                    disabled={deletingRideId === ride.id}
                                    style={{ background: 'none', border: 'none', color: '#ff4d4f', cursor: 'pointer', padding: '2px', display: 'flex', alignItems: 'center', opacity: 0.8 }}
                                    title="Delete this ride"
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                      {viewMode !== 'scheduled' && (
                        <button onClick={loadMoreRides} disabled={isLoadingMore} className="btn btn-surface" style={{ width: '100%', padding: '12px', marginTop: '16px', fontWeight: 'bold', color: '#00ccff', border: '1px solid rgba(0,204,255,0.3)', cursor: isLoadingMore ? 'wait' : 'pointer' }}>
                          {isLoadingMore ? 'Loading Older Rides...' : 'Load Older Rides'}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </aside>

        <section className="map-wrapper animate-fade-in" style={{ animationDelay: '0.3s' }}>
          <MapContainer center={[51.505, -0.09]} zoom={13} scrollWheelZoom={true} zoomControl={false}>
            <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />
            {!showHeatmap && (viewMode === 'personal' ? myRides : filteredGlobalRides).map(ride => {
              if (ride.route.length === 0) return null;
              const startCoords: [number, number] = [ride.route[0][0], ride.route[0][1]];
              const { color: rideColor, opacity: rideOpacity } = rideAgeColor(ride.time);
              return (
                <LayerGroup key={ride.id}>
                  <CircleMarker center={startCoords} radius={5} pathOptions={{ color: rideColor, fillColor: rideColor, fillOpacity: rideOpacity + 0.1, weight: 2 }} eventHandlers={{ click: () => setSelectedRide(ride) }}>
                    <Popup><div style={{ color: '#000', fontSize: '13px' }}><strong>{ride.pubkey.substring(0, 12)}...</strong><br />{formatDistance(ride, isMetric)} in {ride.duration}</div></Popup>
                  </CircleMarker>
                  <Polyline positions={ride.route as [number, number][]} pathOptions={{ color: rideColor, weight: 3, opacity: rideOpacity }} eventHandlers={{ click: () => setSelectedRide(ride) }} />
                </LayerGroup>
              );
            })}
            {showHeatmap && heatmapCells.map((cell, i) => (
              <CircleMarker key={i} center={[cell.lat, cell.lng]} radius={Math.min(3 + cell.count * 1.5, 14)} pathOptions={{ color: heatColor(cell.count), fillColor: heatColor(cell.count), fillOpacity: 0.5, weight: 0 }}>
                <Popup><div style={{ color: '#000', fontSize: '12px' }}><strong>{cell.count} passes</strong><br />{cell.riders.size} unique rider{cell.riders.size !== 1 ? 's' : ''}</div></Popup>
              </CircleMarker>
            ))}

            {selectedRide && selectedRide.route.length > 0 && (
              <>
                <Polyline positions={selectedRide.route as [number, number][]} pathOptions={{ color: '#00ccff', weight: 6, opacity: 1, lineJoin: 'round' }} />
                <CircleMarker center={[selectedRide.route[0][0], selectedRide.route[0][1]]} radius={8} pathOptions={{ color: '#00ffaa', fillOpacity: 1, weight: 3, fillColor: '#000' }}>
                  <Popup><div style={{ color: '#000' }}>Start</div></Popup>
                </CircleMarker>
                <CircleMarker center={[selectedRide.route[selectedRide.route.length - 1][0], selectedRide.route[selectedRide.route.length - 1][1]]} radius={8} pathOptions={{ color: '#ff4d4f', fillOpacity: 1, weight: 3, fillColor: '#000' }}>
                  <Popup><div style={{ color: '#000' }}>End</div></Popup>
                </CircleMarker>
                <SetMapBounds route={selectedRide.route} />
              </>
            )}
            <MapFocusHandler focus={mapFocus} />
          </MapContainer>
        </section>
      </main>

      {/* Ride Detail Modal REMOVED - integrated into sidebar */}
      {activeDMUser && (
        <div className="modal-overlay">
          <div className="modal-content animate-fade-in glass-panel" style={{ width: '90%', maxWidth: '500px', display: 'flex', flexDirection: 'column' }}>
            <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
              <h2 style={{ margin: 0, color: '#00ccff' }}>Chat with {activeDMUser.substring(0, 8)}...</h2>
              <button onClick={() => setActiveDMUser(null)} className="btn btn-surface" style={{ padding: '8px' }}><X size={24} /></button>
            </div>
            <div className="modal-comments" style={{ padding: '20px' }}>
              <div style={{ height: '300px', overflowY: 'auto', marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {dmMessages.length === 0 ? <div style={{ color: '#666', fontSize: '14px', fontStyle: 'italic', textAlign: 'center', marginTop: '20px' }}>No messages found. Say Hello!</div> : dmMessages.map(msg => {
                  const isMe = msg.sender === user?.pubkey;
                  return <div key={msg.id} style={{ maxWidth: '80%', alignSelf: isMe ? 'flex-end' : 'flex-start', background: isMe ? 'rgba(0,204,255,0.2)' : 'rgba(255,255,255,0.1)', padding: '12px', borderRadius: '12px', borderBottomRightRadius: isMe ? '2px' : '12px', borderBottomLeftRadius: isMe ? '12px' : '2px' }}>
                    <div style={{ color: '#fff', fontSize: '14px', lineHeight: '1.4' }}>{msg.text}</div>
                    <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '10px', marginTop: '4px', textAlign: isMe ? 'right' : 'left' }}>{formatDistanceToNow(msg.createdAt * 1000, { addSuffix: true })}</div>
                  </div>;
                })}
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input type="text" value={newDMText} onChange={(e) => setNewDMText(e.target.value)} placeholder="Type a message..." disabled={isSendingDM} style={{ flex: 1, padding: '12px', borderRadius: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff' }} onKeyDown={async (e) => { if (e.key === 'Enter' && !isSendingDM && newDMText.trim()) { setIsSendingDM(true); const success = await sendDM(activeDMUser, newDMText.trim()); if (success) { setNewDMText(''); fetchDMs(activeDMUser).then(setDmMessages); } else { alert("Failed to send message."); } setIsSendingDM(false); } }} />
                <button className="btn btn-primary" style={{ background: '#00ccff', color: '#000', fontWeight: 'bold' }} disabled={isSendingDM || !newDMText.trim()} onClick={async () => { if (!newDMText.trim()) return; setIsSendingDM(true); const success = await sendDM(activeDMUser, newDMText.trim()); if (success) { setNewDMText(''); fetchDMs(activeDMUser).then(setDmMessages); } else { alert("Failed to send message."); } setIsSendingDM(false); }}>SEND</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* NWC Modal */}
      {showNWCModal && (
        <div className="modal-overlay">
          <div className="modal-content animate-fade-in glass-panel" style={{ width: '90%', maxWidth: '500px', display: 'flex', flexDirection: 'column' }}>
            <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
              <h2 style={{ margin: 0, color: '#eab308', display: 'flex', alignItems: 'center', gap: '8px' }}><Zap size={24} /> Wallet Connect</h2>
              <button onClick={() => setShowNWCModal(false)} className="btn btn-surface" style={{ padding: '8px' }}><X size={24} /></button>
            </div>
            <div style={{ padding: '20px' }}>
              <p style={{ color: '#ccc', marginBottom: '16px', lineHeight: 1.5 }}>Connect your Lightning Wallet using <strong>NWC (NIP-47)</strong> to instantly send Zaps to ride organizers and fellow cyclists.</p>
              <input type="password" placeholder="nostr+walletconnect://..." value={nwcURI} onChange={(e) => setNwcURI(e.target.value)} style={{ width: '100%', padding: '12px', borderRadius: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff', marginBottom: '16px' }} />
              <button className="btn btn-primary" style={{ width: '100%', background: '#eab308', color: '#000', fontWeight: 'bold' }} onClick={async () => { if (!nwcURI) return; const success = await connectNWC(nwcURI); if (success) { localStorage.setItem('bikel_nwc_uri', nwcURI); setIsNWCConnected(true); setShowNWCModal(false); } else { alert("Failed to connect wallet."); } }}>Connect Wallet</button>
              {isNWCConnected && <button className="btn btn-surface" style={{ width: '100%', marginTop: '12px', color: '#ff4d4f' }} onClick={() => { localStorage.removeItem('bikel_nwc_uri'); setNwcURI(''); setIsNWCConnected(false); setShowNWCModal(false); }}>Disconnect Wallet</button>}
            </div>
          </div>
        </div>
      )}

      {/* About Panel */}
      <div className={`side-panel ${showAbout ? 'open' : ''}`}>
        <div className="side-panel-header">
          <h2 className="side-panel-title">
            <Info size={24} color="#00ffaa" /> About Bikel
          </h2>
          <button className="close-panel-btn" onClick={() => setShowAbout(false)}>
            <X size={20} />
          </button>
        </div>

        <div style={{ color: '#ccc', lineHeight: 1.6 }}>

          <p style={{ marginBottom: '16px' }}>
            <strong style={{ color: '#fff' }}>Bikel</strong> is an open, decentralized cycling platform built on the Nostr network.
            Track rides, publish them to the public network, and contribute to a global open dataset of where people actually bike.
          </p>

          <p style={{ marginBottom: '16px' }}>
            Traditional fitness apps lock your GPS data into corporate silos. Bikel flips that model by publishing rides as
            NIP-52 time-based events on Nostr, meaning your ride history belongs to your cryptographic identity and can be used
            across any compatible client forever.
          </p>

          <p style={{ marginBottom: '16px' }}>
            All rides are opt-in and anonymized. The aggregated GPS data forms an open cycling dataset that anyone can use —
            from researchers and developers to cities planning better cycling infrastructure.
          </p>

          <p style={{ marginBottom: '16px' }}>
            Bikel also enables community ride challenges, group discovery, and optional Lightning micropayments using Nostr Wallet Connect.
          </p>

          <div style={{
            padding: '16px',
            background: 'rgba(0,255,170,0.1)',
            border: '1px solid rgba(0,255,170,0.3)',
            borderRadius: '8px',
            marginTop: '24px'
          }}>
            <h3 style={{
              color: '#00ffaa',
              fontSize: '16px',
              marginBottom: '8px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}>
              <Zap size={16} /> Open Source
            </h3>

            <p style={{ fontSize: '14px', margin: 0 }}>
              Bikel is fully open-source software. Anyone can audit the code, build their own clients, or run their own relays.
              The goal is a permanent, open network for cycling data — owned by riders, not platforms.
            </p>
          </div>

        </div>
      </div>

      {/* How To Panel */}
      <div className={`side-panel ${showHowTo ? 'open' : ''}`}>
        <div className="side-panel-header">
          <h2 className="side-panel-title"><HelpCircle size={24} color="#00ffaa" /> How It Works</h2>
          <button className="close-panel-btn" onClick={() => setShowHowTo(false)}><X size={20} /></button>
        </div>
        <div style={{ color: '#ccc', lineHeight: 1.6 }}>

          {/* What is Nostr */}
          <div style={{ background: 'rgba(0,255,170,0.05)', border: '1px solid rgba(0,255,170,0.15)', borderRadius: '10px', padding: '16px', marginBottom: '24px', marginTop: '8px' }}>
            <h3 style={{ color: '#00ffaa', fontSize: '14px', letterSpacing: '1px', textTransform: 'uppercase', margin: '0 0 8px 0' }}>What is Nostr?</h3>
            <p style={{ margin: 0, fontSize: '13px', color: '#aaa' }}>
              Nostr is an open protocol where your identity is a cryptographic key pair — not a username owned by a company. Your <strong style={{ color: '#fff' }}>nsec</strong> (private key) signs your data, and your <strong style={{ color: '#fff' }}>npub</strong> (public key) is your address. No accounts, no servers, no lock-in.
            </p>
          </div>

          {/* Step 1 */}
          <div style={{ display: 'flex', gap: '14px', marginBottom: '20px' }}>
            <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: 'rgba(0,255,170,0.15)', border: '1px solid #00ffaa', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#00ffaa', fontWeight: 'bold', fontSize: '14px', flexShrink: 0, marginTop: '2px' }}>1</div>
            <div>
              <h3 style={{ color: '#fff', fontSize: '16px', margin: '0 0 6px 0' }}>Download the Bikel App</h3>
              <p style={{ margin: '0 0 10px 0', fontSize: '13px' }}>
                The easiest way to get started. The Android app automatically generates a Nostr key pair for you — no setup needed. Your keys are stored locally on your device.
              </p>
              <button
                onClick={() => { setShowHowTo(false); setShowAppPromo(true); }}
                style={{ background: 'rgba(0,255,170,0.15)', border: '1px solid rgba(0,255,170,0.4)', borderRadius: '8px', padding: '8px 16px', color: '#00ffaa', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <Smartphone size={14} /> Get the Android APK →
              </button>
            </div>
          </div>

          {/* Step 2 */}
          <div style={{ display: 'flex', gap: '14px', marginBottom: '20px' }}>
            <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: 'rgba(0,255,170,0.15)', border: '1px solid #00ffaa', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#00ffaa', fontWeight: 'bold', fontSize: '14px', flexShrink: 0, marginTop: '2px' }}>2</div>
            <div>
              <h3 style={{ color: '#fff', fontSize: '16px', margin: '0 0 6px 0' }}>Record & Publish Rides</h3>
              <p style={{ margin: 0, fontSize: '13px' }}>
                Open the app, tap <strong style={{ color: '#fff' }}>Start Ride</strong>, and go. GPS tracking runs in the background. When you stop, your route is compressed and broadcast to the Nostr network — visible on this map within seconds.
              </p>
            </div>
          </div>

          {/* Step 3 */}
          <div style={{ display: 'flex', gap: '14px', marginBottom: '20px' }}>
            <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: 'rgba(0,255,170,0.15)', border: '1px solid #00ffaa', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#00ffaa', fontWeight: 'bold', fontSize: '14px', flexShrink: 0, marginTop: '2px' }}>3</div>
            <div>
              <h3 style={{ color: '#fff', fontSize: '16px', margin: '0 0 6px 0' }}>Sign In to This Site <span style={{ color: '#888', fontWeight: 'normal', fontSize: '13px' }}>(optional)</span></h3>
              <p style={{ margin: '0 0 8px 0', fontSize: '13px' }}>
                To comment, RSVP to group rides, or send Zaps from the web, you'll need a browser extension that holds your Nostr key:
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {[
                  { name: 'Alby', desc: 'Browser extension + Lightning wallet', url: 'https://getalby.com' },
                  { name: 'nos2x', desc: 'Lightweight key signer for Chrome', url: 'https://chrome.google.com/webstore/detail/nos2x/kpgefcfmnafjgpblomihpgmejjdanjjp' },
                  { name: 'Nostore', desc: 'Key signer for Safari / iOS', url: 'https://apps.apple.com/app/nostore/id1666553677' },
                ].map(ext => (
                  <a key={ext.name} href={ext.url} target="_blank" rel="noopener noreferrer"
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '8px 12px', textDecoration: 'none' }}>
                    <div>
                      <div style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold' }}>{ext.name}</div>
                      <div style={{ color: '#666', fontSize: '11px' }}>{ext.desc}</div>
                    </div>
                    <span style={{ color: '#555', fontSize: '12px' }}>↗</span>
                  </a>
                ))}
              </div>
            </div>
          </div>

          {/* Step 4 */}
          <div style={{ display: 'flex', gap: '14px', marginBottom: '8px' }}>
            <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: 'rgba(234,179,8,0.15)', border: '1px solid #eab308', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#eab308', fontWeight: 'bold', fontSize: '14px', flexShrink: 0, marginTop: '2px' }}>⚡</div>
            <div>
              <h3 style={{ color: '#fff', fontSize: '16px', margin: '0 0 6px 0' }}>Zap Riders with Bitcoin</h3>
              <p style={{ margin: 0, fontSize: '13px' }}>
                Connect a Lightning wallet via <strong style={{ color: '#fff' }}>NWC</strong> (tap the ⚡ icon in the header) to send instant micropayments to riders and event organizers you want to support.
              </p>
            </div>
          </div>

        </div>
      </div>

      {/* App Promo Panel */}
      <div className={`side-panel ${showAppPromo ? 'open' : ''}`}>
        <div className="side-panel-header">
          <h2 className="side-panel-title"><Smartphone size={24} color="#00ffaa" /> Get Bikel Mobile</h2>
          <button className="close-panel-btn" onClick={() => setShowAppPromo(false)}><X size={20} /></button>
        </div>
        <div style={{ color: '#ccc', lineHeight: 1.6, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ width: '100%', aspectRatio: '1', background: 'linear-gradient(135deg, rgba(0,255,170,0.2) 0%, rgba(0,0,0,0.8) 100%)', borderRadius: '16px', border: '1px solid rgba(0,255,170,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '24px', overflow: 'hidden', position: 'relative' }}>
            <MapIcon size={120} color="rgba(0,255,170,0.3)" style={{ position: 'absolute', opacity: 0.5 }} />
            <div style={{ zIndex: 10, textAlign: 'center', background: 'rgba(0,0,0,0.6)', padding: '16px 24px', borderRadius: '30px', backdropFilter: 'blur(5px)', border: '1px solid rgba(255,255,255,0.1)' }}>
              <Bike size={32} color="#00ffaa" style={{ margin: '0 auto 8px auto' }} />
              <div style={{ color: '#fff', fontWeight: 'bold', fontSize: '18px' }}>Tracking Live</div>
              <div style={{ color: '#00ffaa', fontFamily: 'monospace' }}>12.4 mi • 1:04:22</div>
            </div>
          </div>
          <p style={{ textAlign: 'center', fontSize: '16px', marginBottom: '32px' }}>Download the official Android APK to passively record maps, upload photos, and broadcast rides securely to any Nostr relay!</p>
          <a href="https://github.com/Mnpezz/bikel/releases/download/v1.4.0/app-release.apk" download className="btn btn-primary" style={{ width: '100%', padding: '16px', fontSize: '18px', justifyContent: 'center', background: '#00ffaa', color: '#000', fontWeight: '900', textTransform: 'uppercase', letterSpacing: '1px', boxShadow: '0 0 20px rgba(0,255,170,0.4)' }}>Download Android APK</a>
          <div style={{ marginTop: '24px', fontSize: '12px', color: 'rgba(255,255,255,0.4)', textAlign: 'center' }}>Requires Android 10.0 or higher.</div>
        </div>
      </div>
    </div>
  );
}

function SetMapBounds({ route }: { route: number[][] }) {
  const map = useMap();
  useEffect(() => {
    if (route.length > 0) {
      const bounds = route.map(p => [p[0], p[1]] as [number, number]);
      map.fitBounds(bounds, { padding: [20, 20] });
    }
  }, [route, map]);
  return null;
}

function MapFocusHandler({ focus }: { focus: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (focus) {
      map.flyTo(focus, 16, { duration: 1.5 });
    }
  }, [focus, map]);
  return null;
}

export default App;